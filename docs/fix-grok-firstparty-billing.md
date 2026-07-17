# Fix: Grok (mandatory-effort models) mis-billed to API pool

## Problem

Selecting `cursor/cursor-grok-4.5` with **thinking OFF** debits the Cursor
**API usage pool** instead of the **First-party models pool**.

## Root cause (confirmed)

- Cursor's live `GetUsableModels` advertises grok only as **mandatory-effort**
  ids: `cursor-grok-4.5-{low,medium,high}` (+ `-fast`). There is **no bare**
  `cursor-grok-4.5`.
- `processModels()` (`index.ts:~475`) collapses effort variants into a single
  synthetic picker id `cursor-grok-4.5` with `supportsReasoningEffort: true` and
  a `reasoningEffortMap`.
- pi's `ThinkingLevel` = `minimal|low|medium|high|xhigh` — there is **no `off`**.
  When thinking is OFF, pi sends **no** `reasoning_effort`.
- `resolveModelId(body.model, body.reasoning_effort)` (`proxy.ts:955`) short
  circuits: `if (!reasoningEffort) return model` → sends bare `cursor-grok-4.5`.
- `modelDetails.modelId = "cursor-grok-4.5"` (`proxy.ts:1824`) → an id Cursor
  never advertised → server fallback / wrong pool attribution → API debit.

Composer is unaffected: bare `composer-2.5` IS a real usable id (has the `""`
variant). Grok has no `""` variant, so effort is mandatory and the bare id is
invalid.

Any concrete grok variant (`-low/-medium/-high`) lands First-party; pool is
per-family, not per-effort. So flooring to any valid effort fixes billing.

## Why the fix must live in the proxy

pi's model-config compat surface exposes only `supportsReasoningEffort` and
`reasoningEffortMap?: Partial<Record<ThinkingLevel, string>>`. There is **no
`defaultReasoningEffort`** and **no `"off"` key** available. The registration
layer therefore has no lever for the thinking-off case. The proxy — which sees
the final wire request downstream of the omission — is the only place that can
guarantee a real usable id is sent.

## Fix design (proxy guard, catch-all)

### T1 — Repro harness
Add debug warn in `handleChatCompletion` when the resolved `modelId` is not in
the known usable-id set. Confirm grok + thinking-off emits `cursor-grok-4.5`
(absent from set). Establish baseline.

### T2 — Core fix
Introduce a usable-id–aware resolver:

```
resolveUsableModelId(model, effort, usableIds): string
  1. candidate = resolveModelId(model, effort)          // existing behavior
  2. if usableIds.has(candidate) -> return candidate
  3. if !effort AND base(model) is "mandatory-effort":   // usableIds has
                                                          // `${base}-<eff>` but
                                                          // not bare `${base}`
        floored = resolveModelId(model, DEFAULT_FLOOR)    // e.g. "low" (cheapest
                                                          // valid) or "medium"
        if usableIds.has(floored) -> return floored
        // else pick lowest available real variant for base+fast+thinking
  4. return candidate + warn("non-usable modelId sent")  // last resort
```

Wiring:
- The proxy already fetches + caches usable models
  (`discoverCursorModelsOnce` -> `normalizeCursorModels`, `proxy.ts:806`;
  cache `cursor-models-cache.json`). Expose the set of real usable ids to
  `handleChatCompletion` and pass into `resolveUsableModelId`.
- Replace `const modelId = resolveModelId(...)` at `proxy.ts:983` with the new
  resolver. Keep `resolveModelId` pure/unchanged (still unit-tested directly).

Decisions:
- `DEFAULT_FLOOR`: `low` (cheapest valid) unless we prefer `medium` to match the
  collapsed representative. Billing pool identical either way. **Pick: `low`.**
- Mandatory-effort detection is data-driven off `usableIds` (not a hardcoded
  family list) so future models (claude-opus-*, etc.) are covered automatically.

### T4 — Tests (`index.test.ts` / new proxy test)
- grok thinking-off -> `cursor-grok-4.5-low`
- grok `-fast` thinking-off -> `cursor-grok-4.5-low-fast`
- grok thinking medium -> `cursor-grok-4.5-medium` (unchanged path)
- composer-2.5 thinking-off -> `composer-2.5` (bare stays, it's usable)
- unknown/non-usable id -> returns candidate + warn (no crash)

### T5 — Cleanup (low priority)
`cursor-models-raw.json` in repo is stale (grok-4-20 era; no cursor-grok-4.5).
Refresh via `npm run refresh-models`. Fallback-only drift; not the billing bug.

### T6 — Ship
1. Commit on `~/git/pi-cursor-provider` (dev clone), push `cartwmic/main`.
2. Installed clone `~/.pi/agent/git/github.com/cartwmic/pi-cursor-provider`
   (currently `cd53cff`, dirty `M package-lock.json`) — stash/clean, `git pull`.
3. Restart pi (extensions load at startup).
4. Verify: run grok with thinking off, confirm usage row lands First-party.

## Scope guard (KISS)
Single local user, single provider. No multi-user/config surface. One resolver
fn + wiring + tests. No behavior change for already-valid ids.
