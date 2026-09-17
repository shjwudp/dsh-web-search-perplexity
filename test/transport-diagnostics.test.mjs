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
import { describeErrorCause, describeProcess, describeRuntime, isAbortError, redactProxyValue, requestJson } from '../src/shared.js'

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

// ── 3b. A bounded attempt must still report its failure, not a cancellation ──
// `AbortSignal.timeout()` aborts with a DOMException named `TimeoutError`, not
// `AbortError`. That signal is how a probe bounds one attempt while keeping the
// underlying connection error as the thing reported; if `isAbortError` treated a
// timeout as a cancellation, every dead-address probe below would report
// "aborted" instead of a code, its endpoint, and its cause — losing the
// diagnosis this suite exists to guarantee. Callers that need a timeout-shaped
// abort to mean cancellation check for it themselves.
console.log('\n3b. a TimeoutError is NOT swallowed as a cancellation')
{
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const timedOut = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  check('an AbortError is an abort', isAbortError(abort) === true)
  check('a TimeoutError is left to report its own failure', isAbortError(timedOut) === false,
    String(isAbortError(timedOut)))
  check('an unrelated failure is not an abort',
    isAbortError(Object.assign(new Error('boom'), { name: 'Error' })) === false)
  check('an undefined value is not an abort', isAbortError(undefined) === false)
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

// ── 4b. A poll failure names GET, because that is what was attempted ────────
// The same transport serves the background poll, which is a GET. A hardcoded
// method in the message would misdescribe every poll failure, and polling is
// precisely where a dropped connection shows up.
console.log('\n4b. the reported method is the one actually used')
{
  let error
  try {
    await requestJson(
      'https://203.0.113.7/v1/agent/resp_probe',
      'test-key',
      undefined,
      AbortSignal.timeout(3000),
      WebError,
      'Perplexity search',
      0,
      'GET',
    )
  } catch (caught) {
    error = caught
  }
  check('a bodyless GET poll is reported as GET',
    String(error?.message).includes('[GET https://203.0.113.7/v1/agent/resp_probe]'),
    String(error?.message).slice(0, 200))
  check('it is not reported as a POST',
    !String(error?.message).includes('[POST '), String(error?.message).slice(0, 200))
}

// ── 5. The runtime line reports what only this process can see ─────────────
// A fetch failure that happens in one process and not another on the same
// machine is decided by state the process holds, not by the request: the runtime
// version, the process's own identity and age, and the proxy variables it
// actually sees. Node's fetch ignores the proxy environment, but a long-lived
// host can have those names written at runtime, and no external observer can
// read them.
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

    // The host process is a variable, not a constant: the same request
    // succeeded a minute after a host started and failed four minutes later in
    // the very same process. Every failure therefore has to say which process
    // and how old it was, or a per-process state bug reads as a network fault.
    check('the process id is named', clean.includes(`pid=${process.pid}`), clean)
    check('the process age is named', / uptime=[\d.]+s/.test(clean), clean)
    // `started` was written as a number with a Date method called on it, so it
    // silently fell into its catch and printed a placeholder — a diagnostic that
    // reports "unavailable" for the very field this task added. A shape-only
    // regex passes on that, so assert the value is a real, current timestamp.
    const started = clean.match(/ started=(\S+)/)?.[1]
    const startedMs = Date.parse(String(started))
    check('the process start time is a real timestamp', Number.isFinite(startedMs), String(started))
    check('the process start time is not a placeholder',
      !String(started).includes('unavailable'), String(started))
    check('the start time agrees with the reported uptime',
      Number.isFinite(startedMs) && (Date.now() - startedMs) / 1000 <= Number(clean.match(/uptime=([\d.]+)/)?.[1]) + 60,
      `started=${String(started)} uptime=${clean.match(/uptime=([\d.]+)/)?.[1]}s`)
    // Uptime and the derived start time both move between two calls (the start
    // time by a few milliseconds), so compare the one field that identifies the
    // process and cannot change: its id.
    const standalone = describeProcess()
    const standalonePid = standalone.match(/pid=\d+/)?.[0]
    check('describeRuntime carries the process the standalone line names',
      standalonePid !== undefined && clean.includes(standalonePid),
      `runtime=${clean} standalone=${standalone}`)

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

// ── 6. The transport does not leave a reusable socket behind ───────────────
// The host failed with `UND_ERR_SOCKET: other side closed` four minutes into a
// process that had just succeeded — undici handing a new POST a keep-alive
// socket the peer had already closed. The fix is to not reuse the socket, which
// needs no retry: `UND_ERR_SOCKET` does not prove the request went unprocessed,
// so resending a long agent task could duplicate work. This pins the wire-level
// half of that fix against a real local server, so the run stays offline.
console.log('\n6. the request opts out of connection reuse')
{
  const { createServer } = await import('node:http')
  let seen
  let delivered = 0
  let sockets = 0
  const server = createServer((req, res) => {
    seen = req.headers
    delivered += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  server.on('connection', () => { sockets += 1 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const call = () => requestJson(
      `http://127.0.0.1:${port}/v1/agent`,
      'test-key',
      { preset: 'medium', input: 'x' },
      AbortSignal.timeout(5000),
      WebError,
      'Perplexity search',
      0,
    )

    const first = await call()
    check('the request still succeeds end to end', first?.ok === true, JSON.stringify(first))
    check('the request asks the server to close the connection',
      seen?.connection === 'close', String(seen?.connection))
    check('the request was delivered exactly once (no retry was invented)',
      delivered === 1, `delivered=${delivered}`)

    // The reused-socket failure was a keep-alive connection the peer had
    // already closed. Proving the header is present is only a proxy for that;
    // the claim is that the connection is not handed to the next request, so
    // assert the next request arrives on a new socket.
    await call()
    check('the second request did not reuse the first socket',
      sockets === 2 && delivered === 2, `sockets=${sockets} delivered=${delivered}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ── 7. The diagnostic survives a process that sees nothing at all ──────────
// Acceptance criterion 2: a deliberately dead address and an empty environment
// must still produce a readable cause. This is the regression guard for the
// transport change — a fix that silenced connection errors, or that let a
// diagnostic field throw, would drop exactly the evidence that made this bug
// findable. Uses TEST-NET-3 again so it stays off the public network.
console.log('\n7. a bad address in a stripped environment still explains itself')
{
  const stripped = ['PERPLEXITY_API_KEY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'no_proxy']
  const previous = {}
  for (const name of stripped) {
    previous[name] = process.env[name]
    delete process.env[name]
  }
  let error
  try {
    await requestJson(
      'https://203.0.113.7/v1/agent',
      'test-key',
      { input: 'x' },
      AbortSignal.timeout(2500),
      WebError,
      'Perplexity search',
      0,
    )
  } catch (caught) {
    error = caught
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const message = String(error?.message)
  check('no API key in the process is still a provider error, not a crash',
    error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
  check('the message still names a machine-readable cause',
    /code=|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|TimeoutError|UND_ERR/.test(message), message)
  check('the message names the endpoint', message.includes('POST https://203.0.113.7/v1/agent'), message)
  check('the message names the process and its age',
    /pid=\d+ uptime=[\d.]+s/.test(message), message)
  check('no diagnostic field degraded to a placeholder',
    !message.includes('unavailable'), message)
  console.log(`        (message: ${message.slice(0, 200)})`)
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
