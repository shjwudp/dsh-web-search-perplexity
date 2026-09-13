/**
 * Probe: what exactly is "TypeError: fetch failed"?
 *
 * Dumps the full cause chain (code, errno, syscall, address, and any aggregate
 * `errors[]`) for a POST to the configured endpoint, so the connection-layer
 * root cause is visible instead of the bare wrapper message. Never prints the
 * key: only its length.
 *
 * Usage: node scripts/probe-fetch-cause.mjs [url]
 */

const key = process.env.PERPLEXITY_API_KEY
if (typeof key !== 'string' || key.length === 0) {
  console.error('PERPLEXITY_API_KEY is not set in THIS shell.')
  process.exit(2)
}
const url = process.argv[2] ?? 'https://api.perplexity.ai/v1/agent'
console.log(`key length=${key.length} | url=${url}`)

/** Render one thrown value's full cause chain. */
function describe(error, depth = 0) {
  const pad = '  '.repeat(depth)
  if (error === undefined || error === null) {
    console.log(`${pad}(no value)`)
    return
  }
  if (!(error instanceof Error)) {
    console.log(`${pad}${typeof error}: ${String(error)}`)
    return
  }
  console.log(`${pad}${error.name}: ${error.message}`)
  for (const field of ['code', 'errno', 'syscall', 'address', 'port', 'hostname']) {
    if (error[field] !== undefined) console.log(`${pad}  ${field}=${String(error[field])}`)
  }
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    console.log(`${pad}  errors[] (${error.errors.length}):`)
    for (const inner of error.errors) describe(inner, depth + 2)
  }
  if (error.cause !== undefined && error.cause !== error) describe(error.cause, depth + 1)
}

console.log('\n--- proxy-related environment in THIS shell ---')
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
  const value = process.env[name]
  console.log(`  ${name}=${value === undefined ? '(unset)' : value}`)
}
console.log(`  NODE_OPTIONS=${process.env.NODE_OPTIONS ?? '(unset)'}`)
console.log(`  NODE_TLS_REJECT_UNAUTHORIZED=${process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '(unset)'}`)

console.log('\n--- fetch attempt ---')
const started = Date.now()
try {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ preset: 'medium', input: 'Reply with the single word: ok' }),
  })
  const text = await response.text()
  console.log(`HTTP ${response.status} in ${Date.now() - started}ms`)
  console.log(text.slice(0, 300))
} catch (error) {
  console.log(`THREW after ${Date.now() - started}ms`)
  describe(error)
}
