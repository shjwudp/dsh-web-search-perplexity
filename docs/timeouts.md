# Timeouts and degradation

`web_search` runs under a harness deadline (`dsh-tool-web`'s `searchTimeoutMs`,
**default 30000**; the shipped agent presets raise it to 60000, so 60 s is not a
safe assumption), and the Perplexity Agent API preset decides how long a search
actually takes. Measured against the Agent API from an ordinary desktop connection:

| preset | measured latency |
|---|---|
| `fast` | ~4 s |
| `low` | ~5 s |
| `medium` | ~25 s for a narrow query, >180 s for a broad one |
| `wide-research` | minutes; an asynchronous workflow, not a synchronous search |

A broad query on `medium` therefore outlives even a 60 s tool budget. Two guards
keep that from surfacing as the harness's opaque `tool call timed out after <ms>ms`.

## 1. The soft deadline (this plugin)

`softTimeoutMs` bounds one request. When it expires the provider makes exactly one
bounded retry on `fallbackPreset` (default `fast`) and returns that answer marked as
degraded. Worst case is about `softTimeoutMs` + 15 s, and that sum must stay below
the tool budget. `softTimeoutMs: 0` restores the original single-request behavior.

The retry is synchronous: no background request, no pending-task table, and no
promise outliving the tool call.

When unset, the deadline is **derived from the configured `preset`** rather than
being one preset-independent constant, because no single value can suit presets that
differ by two orders of magnitude in latency:

| `preset` | default `softTimeoutMs` | why |
|---|---|---|
| `fast`, `low` | `12000` | ~4–5 s measured, so 12 s leaves >2x headroom and still fits the 30 s component budget (`12 + 15 ≤ 30`) |
| `medium`, `high`, `xhigh`, `wide-research`, unset | `40000` | `medium` needs ~25 s (25.3 s measured) for a narrow query, so anything at or below that would degrade *every* narrow query; 40 s is the largest value that still leaves the 15 s retry inside the 60 s preset budget |

A flat default is what made degradation the norm: the previous `25000` sat below
`medium`'s own measured 25.3 s narrow latency, so every `medium` narrow query spent
25 s and was then answered by a `fast` retry — strictly worse than either lowering
the preset or raising the deadline. `medium` and slower genuinely cannot fit a 30 s
budget, so under one, lower the preset rather than the deadline.

When both attempts exceed their budgets, the provider raises a `WebError` naming the
soft deadline and suggesting a narrower query, instead of letting the caller see only
the harness's timeout.

## 2. The tool budget lives in an agent preset

A session's model-facing `tool-web` row is supplied by the agent preset that session
joins, and falls back to the 30 s component default when nothing sets it. Raising
`searchTimeoutMs` in the profile patch alone therefore does not change the deadline a
preset-composed session enforces.

To change it, copy the shipped composition to
`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`, change `tool-web.searchTimeoutMs`
there, and select that preset in `settings.yaml`. Editing the profile patch alone is
verified ineffective.

## Degradation is machine-readable

A degraded answer is marked twice, so no consumer has to read prose:

1. **`degradation` on the seam result** (`ctx.web.search`), present on every result
   this provider returns:

   ```json
   {
     "degraded": true,
     "requestedPreset": "medium",
     "actualPreset": "fast",
     "softTimeoutMs": 40000,
     "fallbackTimeoutMs": 15000
   }
   ```

   `degraded` is `false` with `actualPreset === requestedPreset` for a full-depth
   answer, and `fallbackTimeoutMs` is `0` unless a retry ran.

2. **A `[DEGRADED] {json}` line** as the first line of `content`, carrying the same
   object. `dsh-tool-web` re-projects the seam result into its own closed
   `web_search` output schema (`content` / `sources` / `truncated`,
   `additionalProperties: false`), so `content` is the only field that reaches the
   model; this line is what survives that boundary.

Treat a result with `degraded: true` as a shallower source: re-verify material claims
or re-ask narrowly instead of citing it as full-depth research.

An image-bearing search gets the text deadline plus a fixed 12 s analysis margin,
capped where the degraded retry still fits the tool budget — see [images](images.md).
