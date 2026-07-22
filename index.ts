/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.js";
import {
  cleanupSessionState,
  getCursorModels,
  hydrateConversationForSession,
  inferContextWindow,
  invalidateSessionState,
  loadCachedModels,
  noteSessionLeaf,
  persistSessionState,
  startProxy,
  summarizeSessionAndGetSummary,
  type CursorModel,
} from "./proxy.js";

// ── Cost estimation ──

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let extensionDebugLogFilePath: string | undefined;

function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured =
    process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(
    tmpdir(),
    `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`,
  );
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value: string, max = 240): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return {
          type: "text",
          text: truncateDebugValue(String(typed.text ?? "")),
        };
      case "thinking":
        return {
          type: "thinking",
          thinking: truncateDebugValue(String(typed.thinking ?? "")),
        };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return {
          type: "image",
          mimeType: typed.mimeType,
          data: `<redacted base64 ${String(typed.data ?? "").length} chars>`,
        };
      default:
        return typed;
    }
  });
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

function summarizeBranchTail(
  ctx: {
    sessionManager?: {
      getBranch?: () => unknown[];
      getLeafId?: () => string | null;
      getSessionId?: () => string;
    };
  },
  limit = 6,
): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const typed = payload as Record<string, unknown>;
  const messages = Array.isArray(typed.messages)
    ? typed.messages.map((message) => summarizeMessage(message)).slice(-8)
    : undefined;
  return {
    model: typed.model,
    stream: typed.stream,
    pi_session_id: typed.pi_session_id,
    messageCount: Array.isArray(typed.messages)
      ? typed.messages.length
      : undefined,
    messages,
    toolCount: Array.isArray(typed.tools) ? typed.tools.length : undefined,
  };
}

function debugExtensionLog(
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isExtensionDebugEnabled()) return;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: "extension",
    event,
    ...data,
  });
  appendFileSync(getExtensionDebugLogFilePath(), `${payload}\n`, "utf8");
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.7-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.8-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-2.5-flash": {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-fast": { input: 2.5, output: 20, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4-3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const MODEL_COST_PATTERNS: Array<{
  match: (id: string) => boolean;
  cost: ModelCost;
}> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  {
    match: (id) => /claude.*opus/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus"]!,
  },
  {
    match: (id) => /claude.*haiku/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.5-haiku"]!,
  },
  {
    match: (id) => /claude.*sonnet/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"]!,
  },
  {
    match: (id) => /composer/i.test(id),
    cost: MODEL_COST_TABLE["composer-1"]!,
  },
  {
    match: (id) => /gpt-5\.5/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.5"]!,
  },
  {
    match: (id) => /gpt-5\.4.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-mini"]!,
  },
  {
    match: (id) => /gpt-5\.4.*nano/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-nano"]!,
  },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"]! },
  {
    match: (id) => /gpt-5\.3/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.3-codex"]!,
  },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"]! },
  {
    match: (id) => /gpt-5.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5-mini"]!,
  },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"]! },
  {
    match: (id) => /gemini.*3\.1/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"]!,
  },
  {
    match: (id) => /gemini.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-2.5-flash"]!,
  },
  {
    match: (id) => /gemini/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3-pro"]!,
  },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 0,
};

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview|fast)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return (
    MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST
  );
}

// ── Effort-level dedup ──

const EFFORT_LEVELS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
]);

interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
  }

  const lastDash = remaining.lastIndexOf("-");
  if (lastDash >= 0) {
    const suffix = remaining.slice(lastDash + 1);
    if (EFFORT_LEVELS.has(suffix)) {
      return {
        base: remaining.slice(0, lastDash),
        effort: suffix,
        fast,
        thinking,
      };
    }
  }

  return { base: remaining, effort: "", fast, thinking };
}

interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: Record<string, string>;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default") return true;
  return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/i.test(base);
}

/**
 * Ordered effort levels from lowest to highest.
 * "" = default (no effort suffix in model ID).
 */
const EFFORT_ORDER = [
  "none",
  "low",
  "",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Build a reasoning-effort map from the set of available effort suffixes.
 * For each pi effort level (minimal/low/medium/high/xhigh), picks the closest
 * available cursor effort, falling back to the lowest available.
 */
export function buildEffortMap(efforts: Set<string>): Record<string, string> {
  const sorted = EFFORT_ORDER.filter((e) => efforts.has(e));
  if (sorted.length === 0) return {};
  const lowest = sorted[0]!;

  const pick = (...targets: string[]) => {
    for (const t of targets) if (efforts.has(t)) return t;
    return lowest;
  };

  return {
    minimal: pick("none", "low", ""),
    low: pick("low", "none", ""),
    medium: pick("medium", "", "low"),
    high: pick("high", "medium", ""),
    xhigh: pick("max", "xhigh", "high"),
  };
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
export function processModels(raw: CursorModel[]): ProcessedModel[] {
  // Group by (base, fast, thinking)
  const groups = new Map<
    string,
    {
      base: string;
      fast: boolean;
      thinking: boolean;
      efforts: Map<string, CursorModel>;
    }
  >();

  for (const model of raw) {
    const p = parseModelId(model.id);
    const key = `${p.base}|${p.fast}|${p.thinking}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        base: p.base,
        fast: p.fast,
        thinking: p.thinking,
        efforts: new Map(),
      };
      groups.set(key, g);
    }
    g.efforts.set(p.effort, model);
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    // Dedup when there are multiple effort variants, OR a single variant
    // whose effort is non-empty (e.g. claude-4.5-opus-high — strip the
    // mandatory effort suffix so the model appears as claude-4.5-opus
    // with effort mapping).
    const hasOnlyEffortVariants = g.efforts.size === 1 && !g.efforts.has("");
    if (g.efforts.size >= 2 || hasOnlyEffortVariants) {
      // Pick representative: prefer "medium" or default ("") for name/metadata
      const rep =
        g.efforts.get("medium") ??
        g.efforts.get("") ??
        [...g.efforts.values()][0]!;

      // Build deduped model ID: base + thinking/fast suffix (no effort)
      let id = g.base;
      if (g.thinking) id += "-thinking";
      if (g.fast) id += "-fast";

      const effortMap = buildEffortMap(new Set(g.efforts.keys()));

      result.push({ ...rep, id, supportsEffort: true, effortMap });
    } else {
      // Keep single entries as-is (base model without effort variants)
      for (const model of g.efforts.values()) {
        result.push({ ...model, supportsEffort: false });
      }
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m: ProcessedModel) {
  return {
    id: m.id,
    name: m.name,
    reasoning: m.supportsEffort || supportsReasoningModelId(m.id),
    input: ["text", "image"] as ("text" | "image")[],
    cost: estimateModelCost(m.id),
    contextWindow: inferContextWindow(m.id),
    maxTokens: m.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: m.supportsEffort,
      ...(m.supportsEffort &&
        m.effortMap && {
          reasoningEffortMap: m.effortMap,
        }),
      maxTokensField: "max_tokens" as const,
    },
  };
}

export const FALLBACK_MODELS: CursorModel[] = (
  rawFallbackModels as CursorModel[]
).map((model) => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id),
}));

// ── Extension ──

type LifecycleCtx = {
  sessionManager: { getSessionId(): string; getLeafId?: () => string | null };
};

export function registerSessionLifecycleCleanup(pi: ExtensionAPI): void {
  const leafOf = (ctx: LifecycleCtx): string | null =>
    ctx.sessionManager.getLeafId?.() ?? null;

  // shutdown / switch / fork: the current session's checkpoint remains valid
  // for its current leaf, so persist it (stamped with that leaf) before
  // dropping in-memory state. A later resume rehydrates the exact branch. Fork
  // creates a NEW session file (new sessionId => new convKey), so the child
  // starts fresh and never inherits the parent's sidecar.
  const persistAndCleanup = (_event: unknown, ctx: LifecycleCtx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    debugExtensionLog("session.persist_cleanup", { sessionId, leafId: leafOf(ctx) });
    try {
      persistSessionState(sessionId, leafOf(ctx));
    } catch (err) {
      debugExtensionLog("session.persist_cleanup_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    cleanupSessionState(sessionId);
  };

  // tree navigation stays in the SAME session file (same sessionId/convKey) but
  // moves to a different leaf, so the current checkpoint no longer matches the
  // active message path. Invalidate the sidecar (and drop in-memory state) so
  // the new branch starts fresh and cannot re-adopt the abandoned checkpoint.
  const invalidateAndCleanup = (_event: unknown, ctx: LifecycleCtx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    debugExtensionLog("session.invalidate_cleanup", { sessionId, leafId: leafOf(ctx) });
    try {
      invalidateSessionState(sessionId);
    } catch (err) {
      debugExtensionLog("session.invalidate_cleanup_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    cleanupSessionState(sessionId);
  };

  pi.on("session_before_switch", persistAndCleanup);
  pi.on("session_before_fork", persistAndCleanup);
  pi.on("session_shutdown", persistAndCleanup);
  pi.on("session_before_tree", invalidateAndCleanup);

  // Keep the persisted leaf id fresh so shutdown/switch/fork stamp the current
  // branch even if the debounced write races the leaf advancing.
  const noteLeaf = (_event: unknown, ctx: LifecycleCtx) => {
    try {
      noteSessionLeaf(ctx.sessionManager.getSessionId(), leafOf(ctx));
    } catch {
      /* best-effort leaf stamp */
    }
  };
  pi.on("turn_end", noteLeaf);
  pi.on("agent_end", noteLeaf);

  // On (re)start, warm the durable Cursor checkpoint from disk so a resumed
  // session can run native summarizeAction immediately — including a manual
  // /compact before any new turn. Adoption is gated on the persisted leaf id
  // matching pi's current leaf, so a stale/branched sidecar is ignored. No-op
  // for brand-new sessions (no sidecar).
  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const hydrated = hydrateConversationForSession(sessionId, leafOf(ctx));
      debugExtensionLog("session.start_hydrate", {
        sessionId,
        leafId: leafOf(ctx),
        hydrated,
      });
    } catch (err) {
      debugExtensionLog("session.start_hydrate_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Cursor compaction is server-authoritative. On `session_before_compact` we
  // run Cursor's native `summarizeAction` (verified to cut usedTokens ~50-80%),
  // then hand pi the resulting durable summary as an extension-supplied
  // CompactionResult. pi records a normal compaction entry WITHOUT running its
  // own summarizer — eliminating the old dual-compaction + continuation race
  // that ran summarizeAction on `session_compact` after pi had already
  // committed its own summary.
  //
  // Non-Cursor providers: return undefined so pi uses its default summarizer.
  //
  // Failure policy: never fall through to pi's summarizer for Cursor (a
  // summarization inference through the stateful proxy would pollute the live
  // checkpoint). On any native failure we cancel; the auto-compaction
  // circuit breaker is the loop backstop.
  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const preparation = (event as { preparation?: CompactionPreparationShape })
      .preparation;
    const customInstructions = (
      event as { customInstructions?: string }
    ).customInstructions?.trim();
    const reason = (event as { reason?: string }).reason;
    debugExtensionLog("session.before_compact", {
      sessionId,
      reason,
      hasCustomInstructions: !!customInstructions,
    });

    // Cursor's SummarizeAction protobuf has no custom-instructions field, so we
    // cannot honor `/compact <instructions>`. Refuse rather than silently
    // ignore. Only reachable from manual /compact (threshold/overflow never
    // set customInstructions).
    if (customInstructions) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Cursor native compaction does not support custom /compact instructions; compaction skipped.",
          "warning",
        );
      }
      return { cancel: true };
    }

    if (!preparation?.firstKeptEntryId) {
      debugExtensionLog("session.before_compact_no_preparation", { sessionId });
      return { cancel: true };
    }

    try {
      const result = await summarizeSessionAndGetSummary(sessionId);
      // Require a FRESH native summary: ok (2xx) + field-6 summary content that
      // actually changed as a result of this action. A checkpoint can mutate
      // (tokenDetails, an appended summarize turn, counters) without producing
      // a new summary; in that case the decoded field-6 text is the PREVIOUS
      // compaction's summary, and committing it against the new
      // firstKeptEntryId would silently discard everything added since. So we
      // gate on `summaryChanged`, not on whole-checkpoint `mutated`.
      if (!result.ok || !result.summary || !result.summaryChanged) {
        debugExtensionLog("session.before_compact_native_failed", {
          sessionId,
          ok: result.ok,
          mutated: result.mutated,
          summaryChanged: result.summaryChanged,
          hasSummary: !!result.summary,
        });
        // If the checkpoint mutated but no fresh summary was produced, the live
        // checkpoint may be polluted (e.g. by the loopback summarize turn) or
        // ambiguous. Invalidate the sidecar and drop in-memory state so the
        // next turn rebuilds a clean checkpoint from pi's messages rather than
        // persisting/continuing an ambiguous one. If nothing mutated, the
        // existing checkpoint is still valid, so leave it untouched.
        if (result.mutated) {
          invalidateSessionState(sessionId);
          cleanupSessionState(sessionId);
        }
        if (ctx.hasUI) {
          ctx.ui.notify(
            result.mutated
              ? "Cursor native compaction did not produce a new summary; compaction skipped."
              : "Cursor native compaction failed; compaction skipped.",
            "warning",
          );
        }
        return { cancel: true };
      }
      const summary = result.summary + buildFileOpsFooter(preparation);
      debugExtensionLog("session.before_compact_done", {
        sessionId,
        summaryLength: summary.length,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: buildCompactionDetails(preparation),
        },
      };
    } catch (err) {
      debugExtensionLog("session.before_compact_error", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Cursor native compaction error: ${err instanceof Error ? err.message : String(err)}; compaction skipped.`,
          "warning",
        );
      }
      return { cancel: true };
    }
  });
}

/** Minimal shape of pi's CompactionPreparation we consume. */
interface CompactionPreparationShape {
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps?: {
    read?: Set<string> | string[];
    written?: Set<string> | string[];
    edited?: Set<string> | string[];
  };
}

function toArray(value: Set<string> | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : Array.from(value);
}

/** readFiles = read-only files; modifiedFiles = written ∪ edited. */
function computeFileLists(prep: CompactionPreparationShape): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const read = new Set(toArray(prep.fileOps?.read));
  const written = toArray(prep.fileOps?.written);
  const edited = toArray(prep.fileOps?.edited);
  const modified = new Set([...written, ...edited]);
  for (const f of modified) read.delete(f);
  return { readFiles: [...read], modifiedFiles: [...modified] };
}

function buildCompactionDetails(prep: CompactionPreparationShape): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  return computeFileLists(prep);
}

/** Append pi's standard file-operation footer so the stored summary matches
 *  the shape pi's own summarizer produces. */
function buildFileOpsFooter(prep: CompactionPreparationShape): string {
  const { readFiles, modifiedFiles } = computeFileLists(prep);
  if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
  const parts: string[] = ["\n"];
  if (readFiles.length > 0) {
    parts.push(`<files_read>\n${readFiles.join("\n")}\n</files_read>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(
      `<files_modified>\n${modifiedFiles.join("\n")}\n</files_modified>`,
    );
  }
  return parts.join("\n");
}

function registerExtensionDebugHooks(pi: ExtensionAPI) {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      message?: unknown;
      assistantMessageEvent?: Record<string, unknown>;
    };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(
              String(
                (typedEvent.assistantMessageEvent as Record<string, unknown>)
                  .delta ??
                  (typedEvent.assistantMessageEvent as Record<string, unknown>)
                    .content ??
                  "",
              ),
            ),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.length
        : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages
            .slice(-8)
            .map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      turnIndex?: number;
      message?: unknown;
      toolResults?: unknown[];
    };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath(),
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";

  // Start proxy eagerly — it just binds a port, no auth needed until a request arrives.
  // The getAccessToken callback reads currentToken at request time.
  const proxyReady = startProxy(async () => {
    if (!currentToken)
      throw new Error("Not logged in to Cursor. Run /login cursor");
    return currentToken;
  });

  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;

  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    debugLogFile: isExtensionDebugEnabled()
      ? getExtensionDebugLogFilePath()
      : undefined,
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && ctx.model?.provider === "cursor") {
      payload.pi_session_id = ctx.sessionManager.getSessionId();
      debugExtensionLog("before_provider_request", {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId?.(),
        model: ctx.model?.id,
        payload: summarizeProviderPayload(payload),
        branch: summarizeBranchTail(ctx),
      });
    }
    return payload;
  });

  // Await proxy so models are registered before pi proceeds with model resolution.
  // Prefer the on-disk cache from the last successful discovery so a fresh
  // process registers current models (e.g. Opus 4.8) synchronously — before Pi
  // resolves enabledModels — instead of the stale bundled snapshot.
  const port = await proxyReady;
  register(pi, port, loadCachedModels() ?? FALLBACK_MODELS);

  // Discovery only happens on OAuth login/refresh, which may not fire when a
  // stored token is still valid. Trigger it once as soon as we have a token so
  // the model list refreshes every session, not just on auth changes.
  let startupDiscoveryDone = false;
  async function ensureStartupDiscovery(token: string): Promise<void> {
    if (startupDiscoveryDone || !token) return;
    startupDiscoveryDone = true;
    try {
      const discovered = await getCursorModels(token);
      if (discovered.length > 0) register(pi, await proxyReady, discovered);
    } catch {
      startupDiscoveryDone = false;
    }
  }

  function register(pi: ExtensionAPI, port: number, rawModels: CursorModel[]) {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const processed = skipDedup
      ? rawModels.map(
          (m) => ({ ...m, supportsEffort: false }) as ProcessedModel,
        )
      : processModels(rawModels);

    pi.registerProvider("cursor", {
      baseUrl,
      api: "openai-completions",
      models: processed.map(modelConfig),
      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(
            uuid,
            verifier,
          );
          currentToken = accessToken;

          // Discover real models and re-register
          const realPort = await proxyReady;
          const discovered = await getCursorModels(accessToken);
          if (discovered.length > 0) register(pi, realPort, discovered);

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(
          credentials: OAuthCredentials,
        ): Promise<OAuthCredentials> {
          const refreshed = await refreshCursorToken(credentials.refresh);
          currentToken = refreshed.access;

          // Discover real models on refresh too
          const realPort = await proxyReady;
          const discovered = await getCursorModels(refreshed.access);
          if (discovered.length > 0) register(pi, realPort, discovered);

          return refreshed;
        },

        getApiKey(credentials: OAuthCredentials): string {
          currentToken = credentials.access;
          void ensureStartupDiscovery(credentials.access);
          return "cursor-proxy";
        },
      },
    });
  }
}
