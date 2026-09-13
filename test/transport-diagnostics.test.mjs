/**
 * Tests for connection-failure diagnostics in the shared transport.
 *
 * `fetch` reports every connection-layer failure as the same
 * `TypeError: fetch failed`; the actionable part lives in `cause` (or
 * `cause.errors[]` for an aggregate). A provider that only prints
 * `String(error)` hands the caller an undiagnosable message, which is exactly
 * what happened in the host process. These tests pin the rendering, and they
 * exercise the real transport against a deliberately unroutable address to
 * prove a code actually reaches the message.
 *
 * Run: npm test
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { describeErrorCause, describeRuntime, redactProxyValue, requestJson } from '../src/shared.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. The chain is walked, not just the wrapper ───────────────────────────
console.log('\n1. the cause chain reaches the message')
{
  const inner = Object.assign(new Error('getaddrinfo ENOTFOUND api.perplexity.ai'), {
    code: 'ENOTFOUND',
    errno: -3008,
    syscall: 'getaddrinfo',
    hostname: 'api.perplexity.ai',
  })
  const wrapper = new TypeError('fetch failed', { cause: inner })
  const rendered = describeErrorCause(wrapper)
  check('the wrapper is named', rendered.includes('TypeError: fetch failed'), rendered)
  check('the cause is named', rendered.includes('ENOTFOUND'), rendered)
  check('the cause code is shown', rendered.includes('code=ENOTFOUND'), rendered)
  check('the syscall and host are shown',
    rendered.includes('syscall=getaddrinfo') && rendered.includes('hostname=api.perplexity.ai'), rendered)
  check('the chain is marked as a chain', rendered.includes('<-'), rendered)
}

// ── 2. An aggregate fetch failure lists every attempted address ────────────
console.log('\n2. an aggregate failure lists each attempt')
{
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' })
  const timedOut = Object.assign(new Error('connect ETIMEDOUT 142.250.0.1:443'), { code: 'ETIMEDOUT' })
  const aggregate = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(''), { errors: [refused, timedOut] }),
  })
  const rendered = describeErrorCause(aggregate)
  check('both attempts appear', rendered.includes('ECONNREFUSED') && rendered.includes('ETIMEDOUT'), rendered)
}

// ── 3. Odd values never throw the formatter ────────────────────────────────
console.log('\n3. the formatter is total')
{
  check('undefined is named', describeErrorCause(undefined) === '(no value)')
  check('null is named', describeErrorCause(null) === '(no value)')
  check('a thrown string passes through', describeErrorCause('boom') === 'boom')
  const cyclic = new Error('self')
  cyclic.cause = cyclic
  check('a self-referential cause terminates', typeof describeErrorCause(cyclic) === 'string')
  let deep = new Error('leaf')
  for (let i = 0; i < 10; i += 1) deep = new Error(`layer ${i}`, { cause: deep })
  check('a deep chain is truncated rather than unbounded',
    describeErrorCause(deep).includes('truncated'), describeErrorCause(deep).slice(-60))
}

// ── 4. The real transport surfaces a code, proven against a dead address ───
// `203.0.113.0/24` is TEST-NET-3: reserved, so the connection cannot succeed.
// The point is not which code appears but that one does.
console.log('\n4. a real connection failure carries a machine-readable code')
{
  let error
  const started = Date.now()
  try {
    await requestJson(
      'https://203.0.113.7/v1/agent',
      'test-key',
      { input: 'x' },
      AbortSignal.timeout(3000),
      WebError,
      'Perplexity search',
      0,
    )
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  check('the call rejected as a provider error', error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
  check('the message no longer stops at "fetch failed"',
    String(error?.message).length > 'Perplexity search request failed: TypeError: fetch failed'.length,
    String(error?.message).slice(0, 160))
  check('the message names the endpoint that was attempted',
    String(error?.message).includes('POST https://203.0.113.7/v1/agent'), String(error?.message).slice(0, 200))
  check('the underlying cause is preserved for callers',
    error?.cause !== undefined, String(error?.cause))
  console.log(`        (message: ${String(error?.message).slice(0, 220)})`)
  console.log(`        (elapsed: ${elapsed}ms)`)
}

// ── 5. The runtime line reports what only this process can see ─────────────
// A fetch failure that happens in one process and not another on the same
// machine is decided by state the process holds, not by the request: the runtime
// version and the proxy variables it actually sees. Node's fetch ignores the
// proxy environment, but a long-lived host can have those names written at
// runtime, and no external observer can read them.
console.log('\n5. the failure message reports the runtime it ran in')
{
  const previous = {}
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'no_proxy']) {
    previous[name] = process.env[name]
    delete process.env[name]
  }
  try {
    const clean = describeRuntime()
    check('the runtime version is named', clean.includes(`node/${process.version}`), clean)
    check('an unset proxy is stated, not omitted', clean.includes('proxy=(none set)'), clean)

    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    const withProxy = describeRuntime()
    check('a set proxy is reported with its name',
      withProxy.includes('HTTPS_PROXY=http://127.0.0.1:7890'), withProxy)

    // A credentialed proxy URL must not leak the credential into the message.
    process.env.HTTPS_PROXY = 'http://user:secret@proxy.example:8080'
    const redacted = describeRuntime()
    check('a credentialed proxy URL is redacted',
      redacted.includes('***@proxy.example') && !redacted.includes('secret'), redacted)
    check('redaction keeps a plain value intact',
      redactProxyValue('http://127.0.0.1:7890') === 'http://127.0.0.1:7890')
    check('redaction handles an unparseable value with an @',
      redactProxyValue('://@broken') === '***@(unparseable)', redactProxyValue('://@broken'))
    check('a schemeless credential form is still redacted',
      !redactProxyValue('user:pw@proxy.example:8080').includes('pw'),
      redactProxyValue('user:pw@proxy.example:8080'))
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
