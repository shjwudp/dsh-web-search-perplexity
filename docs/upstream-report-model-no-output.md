# Report draft: Agent API runs that finish retrieval and return no answer

A minimal, self-contained reproduction package for Perplexity. Everything below
is observable from stored responses (`store` left at its default `true`), so the
evidence does not expire. Nothing here asserts that the fault is on the client
side; §5 lists what is deliberately *not* claimed.

Related in-repo record: `model-stage-no-output.md` (diagnosis and the decision
not to add a client-side fallback).

## 1. Summary

Five consecutive `POST /v1/agent` runs (presets `high` and `medium`) reached
`status: failed` **after completing their entire retrieval stage** and produced
**zero `message` items**. All five report `usage: null`. The error codes are
`model_error` (message ends `… (reasoning_only)`) and `invalid_request`.

Because the retrieval stage demonstrably ran to completion in every case, we
read `invalid_request` as a model-stage code rather than a rejection of the
request body — but we would like that confirmed (§5). We have since found that
all five runs also carried a **client-side output cap far below the preset's own
budget**, which reproduces the zero-answer shape on demand (§5a). So this report
is about how the API **reports** a run that ran out of output budget before
answering — it is not a claim that the client is blameless.

## 2. How the runs were made

- Endpoint: `POST https://api.perplexity.ai/v1/agent`
- Body shape: `{"input": "<question>", "preset": "high" | "medium", "tools": [{"type": "web_search"}], "max_output_tokens": 2048, "background": true}`
- Polled with `GET https://api.perplexity.ai/v1/agent/{id}` until terminal.
- `model` in the stored response echoes the preset name (`high` / `medium`), so
  the preset was applied.
- `store` was not set, so it defaults to `true` and every run is still
  retrievable.

## 3. The five runs

| run id | preset | `error.code` | `usage` | `output` |
|---|---|---|---|---|
| `resp_a15e2273-3b8c-4ace-b020-840d5366e027` | high | `invalid_request` | `null` | 12 × `search_results` (15 each) + `fetch_url_results`, **no `message`** |
| `resp_fca3947a-ca26-4e44-88ad-dc354b4b440e` | high | `model_error` | `null` | 12 × `search_results` (15 each) + `fetch_url_results`, **no `message`** |
| `resp_f7c6c900-f0d6-4d6a-8178-a25f914edd16` | high | `model_error` | `null` | 9 × `search_results` (15 each) + 5 × `fetch_url_results`, **no `message`** |
| `resp_08f5e990-b980-4d6b-9aaf-a9dfa23e6c1f` | medium | `invalid_request` | `null` | 9 × `search_results` (15 each) + 5 × `fetch_url_results`, **no `message`** |
| `resp_0f9b7afc-ba54-4d3d-baf7-d9e94f0b74d5` | medium | `model_error` | `null` | 6 × `search_results` (15 each) + 3 × `fetch_url_results`, **no `message`** |

Full `error` object for the `model_error` runs, verbatim:

```json
{
  "code": "model_error",
  "message": "echolot: model produced no usable answer: no usable answer (reasoning_only)"
}
```

Retrieve any of them with:

```bash
curl https://api.perplexity.ai/v1/agent/resp_fca3947a-ca26-4e44-88ad-dc354b4b440e \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY"
node scripts/probe-failed-run.mjs resp_fca3947a-ca26-4e44-88ad-dc354b4b440e
```

The script prints `status`, `model`, the whole `error` object, `usage`, and the
`output` item types, which is the whole reproduction: `status=failed`,
`usage=null`, and an `output` array with retrieval items and no `message`.

## 4. Timeline

Local (UTC+08:00) times at which each failure reached the client:

| run id | failure delivered to the client |
|---|---|
| `resp_a15e2273-…` | 2026-09-16 21:26:55 |
| `resp_fca3947a-…` | 2026-09-16 22:20:52 |
| `resp_f7c6c900-…` | 2026-09-16 22:28:31 |
| `resp_08f5e990-…` | 2026-09-16 22:31:50 |
| `resp_0f9b7afc-…` | 2026-09-16 22:41:42 |

**Please disregard `created_at` on these snapshots as a submission time.** When
retrieved, all five report `created_at` inside one 11-second window
(`2026-09-16T14:47:04Z`–`14:47:15Z` = 22:47:04–22:47:15 local), i.e. *after* the
failures were already delivered, and strictly increasing in the order of our five
sequential GETs, which ran 22:47:04.1 → 22:47:16.8 local. So for these `failed`
snapshots `created_at` appears to be stamped at retrieval rather than at
creation. That may itself be worth checking (§5, item 4).

Each run cost nothing (`usage: null`), and each was re-submitted once by the
client (an unbilled failure is safe to repeat); we do not have the id of the
first attempt of each pair, so the five ids above are the second attempts.

## 5. What we are not claiming

- **Not** a rate limit: no HTTP 429 on any of the five; neither the submit nor
  the polls were throttled.
- **Not** a connection failure: the runs were accepted, ran for minutes, and
  their snapshots are retrievable.
- **Not** a client-side request-validation problem: `invalid_request` appears on
  runs that completed 9–12 search batches, i.e. after admission. We have **not**
  changed the request body in response to it, and we are not asking you to
  assume the body is at fault.
- **Not** a claim that the five runs' *error codes* were caused by our request
  body. We have, however, since measured that our own output cap is a
  contributing factor, and we are fixing that on our side — §5a.
- **Not** a request for you to debug our configuration. The five runs' snapshots
  above are the evidence we are asking about; the A/B below is our own finding
  and our own change to make.

## 5a. A/B: does removing our output cap change the outcome?

We recovered the exact questions behind the failures and ran each twice through
the documented background flow — once with the cap this client actually sends,
once with `max_output_tokens` omitted so the preset's own budget applies. Live,
billable runs, 2026-09-16:

| question | preset | arm | status | answer chars | output tokens (reasoning) | search batches |
|---|---|---|---|---|---|---|
| A (1322 ch) | high | cap 2048 | **`incomplete`** | **0** | none reported | 20 |
| A (1322 ch) | high | no cap | `completed` | 24 496 | 11 054 (2 718) | 27 |
| C (898 ch) | high | cap 2048 | **`failed` + `model_error` (reasoning_only)** | **0** | none reported | 16 |
| C (898 ch) | high | no cap | `completed` | 14 894 | 8 343 (2 096) | 22 |
| D (577 ch) | medium | cap 2048 | `completed` | 3 098 | 2 679 (977) | 9 |
| D (577 ch) | medium | no cap | `completed` | 11 095 | 4 196 (647) | 13 |
| B (524 ch) | medium | cap 2048 | `completed` | 2 120 | 2 514 (839) | 13 |
| B (524 ch) | medium | no cap | `completed` | 11 809 | 4 443 (692) | 10 |

Two observations we would like confirmed or corrected:

1. A 2 048-token cap on a `high` run produces the same zero-answer shape as the
   incident. One capped run here reproduced the incident's error exactly —
   `failed` with `code: model_error` and the upstream sentence `echolot: model
   produced no usable answer: no usable answer (reasoning_only)` — with 16
   completed search batches and **no** `message`, while the same question
   uncapped answered fully. A second capped `high` run ended `incomplete`
   instead, with the same zero-answer outcome. Is `incomplete` the intended
   signal for "output budget exhausted before the final message", and why do
   some of these report `failed`/`model_error` instead? Note that in every case
   `usage` was absent, so no client can account for the work those runs did.
2. The cap is not enforced as a hard ceiling (a `medium` arm reported 2 514
   output tokens against a 2 048 cap) yet it clearly binds (2 120 characters
   under the cap vs 11 809 without). Is a soft cap intended, and is there a
   recommended way to size `max_output_tokens` for a multi-step research loop?

## 6. Questions

1. Is a run that ends `status: failed`, `usage: null`, with retrieval items but
   no `message` item meant to be retried by the client, or is retrieving the run
   by id the only recourse? Is there a recommended retry policy for
   `reasoning_only`?
2. Does the `models` fallback chain
   ([Model Fallback](https://docs.perplexity.ai/docs/agent-api/model-fallback.md))
   cover this failure class — i.e. does "fails or is unavailable" include "the
   model produced no answer"? And may `models` be combined with `preset` to
   override the preset's model?
3. Does `max_output_tokens` bound reasoning tokens as well as answer tokens? Our
   own A/B (§5a) says it covers both, and that a small cap can leave a research
   run with no answer at all. Is overriding a preset's own value (128000 for
   `medium`/`high`) a supported request, and what is the recommended sizing for
   a multi-step research loop?
4. Why does a retrieved `failed` run report `created_at` at retrieval time
   rather than at creation? (See §4 — this is what made an 11-second window out
   of calls an hour apart.)
5. Could the API expose "retrieval completed, model emitted nothing" as a
   distinct status or error code, so clients need not infer it from the absence
   of a `message` item in `output`?

## 7. What we changed on our side

Diagnosis, not a fix of the model stage: we added a distinct client-side failure
class so this fault stops arriving as undifferentiated upstream prose —
`error.code`, the upstream code, every attempt's run id, the retrieval counts,
`0 message items`, and whether anything was billed.

Separately, and on the strength of the A/B in §5a, we have **removed our own
2 048-token output cap from research requests** so the preset's budget applies.
That is a change to our request, made for reasons we measured ourselves; it does
not explain away the reporting questions in §6.
