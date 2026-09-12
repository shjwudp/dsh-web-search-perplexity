/**
 * Deterministic tests for the settings card's locale dictionaries.
 *
 * The browser half is a `window.__ModuleLoader__.load({ factory })` bundle, so
 * these tests stub that global, evaluate the real `src/client.js`, and drive its
 * `apply` with a fake client context. No bundler, DOM, or network is involved.
 *
 * Run: npm test
 *
 * `ctx.locale.register` requires every shipped locale for a namespace (bilingual
 * balance), and a key referenced by the card but absent from a dictionary renders
 * as the raw key. Both are checked here, statically for the dictionaries and
 * through the real registration for the wiring.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(resolve(repoRoot, 'src/client.js'), 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Extract the `DICTS` object literal from the client source. The bundle is not a
 * module, so the literal is evaluated on its own rather than importing the file.
 */
function readDicts() {
  const start = clientSource.indexOf('const DICTS = {')
  if (start === -1) throw new Error('src/client.js no longer declares DICTS')
  const open = clientSource.indexOf('{', start)
  let depth = 0
  for (let i = open; i < clientSource.length; i += 1) {
    if (clientSource[i] === '{') depth += 1
    else if (clientSource[i] === '}') {
      depth -= 1
      if (depth === 0) return eval(`(${clientSource.slice(open, i + 1)})`)
    }
  }
  throw new Error('DICTS literal is unterminated')
}

const DICTS = readDicts()
const zh = Object.keys(DICTS.zh)
const en = Object.keys(DICTS.en)
/** Keys the card asks for directly, plus those resolved through `optionLabel`. */
const directKeys = [...new Set([...clientSource.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]))]
const optionKeys = [...new Set([...clientSource.matchAll(/labelKey:\s*'([^']+)'/g)].map((m) => m[1]))]
const referenced = [...new Set([...directKeys, ...optionKeys])]

// ── 1. The declared dictionaries satisfy the locale contract ───────────────────
console.log('\n1. dictionary completeness')
{
  check('both shipped locales are declared', zh.length > 0 && en.length > 0, `zh=${zh.length} en=${en.length}`)
  check('zh and en carry the same key set', zh.length === en.length,
    `zh=${zh.length} en=${en.length}`)
  check('zh has no key missing from en', zh.every((key) => key in DICTS.en))
  check('en has no key missing from zh', en.every((key) => key in DICTS.zh))
  check('every referenced key resolves in zh', referenced.every((key) => key in DICTS.zh),
    referenced.filter((key) => !(key in DICTS.zh)).join(', '))
  check('every referenced key resolves in en', referenced.every((key) => key in DICTS.en),
    referenced.filter((key) => !(key in DICTS.en)).join(', '))
  check('no defined key is unreferenced', zh.every((key) => referenced.includes(key)),
    zh.filter((key) => !referenced.includes(key)).join(', '))
  check('no dictionary value is empty', [...zh, ...en].every((key) => String(DICTS.zh[key] ?? DICTS.en[key]).length > 0))
}

// ── 2. `apply` registers the dictionaries through the real bundle ──────────────
console.log('\n2. registration wiring')
{
  const react = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
  let loaded
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { loaded = factory((id) => (id === 'react' ? react : {})) } },
  }
  // eslint-disable-next-line no-new-func
  new Function(clientSource)()
  const mod = loaded

  check('the bundle loads and exposes apply', typeof mod?.apply === 'function')
  check('locale is declared as an injected service', Array.isArray(mod?.inject) && mod.inject.includes('locale'),
    JSON.stringify(mod?.inject))

  const registrations = []
  const effectLabels = []
  const makeCtx = (overrides = {}) => ({
    slots: { inject() {}, register: () => () => {} },
    settingsScope: {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true }),
        subscribe() {},
        get: () => undefined,
      }),
    },
    remote: { credentials: { describe: async () => ({ value: {} }) } },
    locale: {
      register(ns, dicts) {
        registrations.push({ ns, locales: Object.keys(dicts), dicts })
        return () => {}
      },
    },
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    ...overrides,
  })

  mod.apply(makeCtx())

  check('exactly one namespace was registered', registrations.length === 1, `count=${registrations.length}`)
  const registration = registrations[0]
  check('the namespace is the plugin settings namespace', registration?.ns === 'web-search-perplexity', String(registration?.ns))
  check('both shipped locales were registered together',
    registration !== undefined
      && registration.locales.includes('zh')
      && registration.locales.includes('en'),
    JSON.stringify(registration?.locales))
  check('the registered zh dictionary is the declared one',
    registration?.dicts?.zh?.['card.title'] === DICTS.zh['card.title'])
  check('registration rides ctx.effect so it is disposed with the plugin', effectLabels.length === 1, JSON.stringify(effectLabels))

  // A missing locale service must leave the card working, not throw.
  let threw = null
  try {
    mod.apply(makeCtx({ locale: undefined, effect: undefined }))
  } catch (error) {
    threw = error.message
  }
  check('apply survives a missing locale service', threw === null, String(threw))
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
