/**
 * Deterministic tests for the settings card's save path.
 *
 * The browser half is a `window.__ModuleLoader__.load({ factory })` bundle, so
 * these tests stub that global, evaluate the real `src/client.js`, and drive the
 * real card controller with a fake settings scope. No DOM, bundler, or network.
 *
 * Run: npm test
 *
 * The host settings scope is `set(field, value): Promise<void>` and can reject,
 * and the credential write is a remote call that can fail too. A write failure
 * must leave the card usable: the Save button is disabled while `saving` is true,
 * so a `saving` flag that is never cleared strands the user with no way to retry
 * or discard short of reloading the page.
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

/** Load the real browser half behind a stubbed module loader. */
function loadClientModule() {
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
  return loaded
}

/**
 * Build the card controller the card component receives.
 *
 * `slots.register(def, Component)` carries the component the settings tab renders;
 * the controller is the component's `inject()` return value, which the slot
 * container exposes on the component's props.
 * @param scopeOverrides - settings-scope methods to replace, e.g. a rejecting `set`.
 */
function makeController(scopeOverrides = {}) {
  const mod = loadClientModule()
  let component
  let controller
  /** The user settings layer the fake host persists into. */
  const user = {}
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      value: { preset: 'medium', maxTokens: 100, apiKeyEnv: 'PERPLEXITY_API_KEY', ...user },
      base: {},
      user,
    }),
    subscribe: () => () => {},
    // Mirrors the real scope: `set` resolves `void`, so the only proof a write
    // landed is the updated snapshot.
    set: async (field, value) => { user[field] = value },
    unset: async (field) => { delete user[field] },
    ...scopeOverrides,
  }
  const ctx = {
    slots: {
      // The slot definition carries `inject()`, whose return value the settings tab
      // merges into the component's props; capture it the same way.
      inject: (_name, register) => register(),
      register: (slot, registeredComponent) => {
        component = registeredComponent
        // `inject()` returns the card's props: the controller rides in `hooks`.
        controller = slot.inject()?.hooks?.perplexityCard
        return () => {}
      },
    },
    settingsScope: { bind: () => scope },
    remote: {
      credentials: {
        describe: async () => ({ ok: true, value: { PERPLEXITY_API_KEY: { configured: false, writable: true } } }),
        set: async () => ({ ok: true }),
      },
    },
    locale: undefined,
    effect: undefined,
  }
  mod.apply(ctx)
  if (component === undefined) throw new Error('the card component was not registered')
  if (controller === undefined) throw new Error('the card slot injected no controller')
  return controller
}

// ── 1. A failing settings write must not strand the card in `saving` ───────────
console.log('\n1. a rejected settings write leaves the card recoverable')
{
  const controller = makeController({ set: async () => { throw new Error('host rejected the write') } })
  controller.actions().edit('maxTokens', '321')
  let threw = null
  try {
    await controller.actions().save()
  } catch (error) {
    threw = error.message
  }

  check('save does not reject into the caller', threw === null, String(threw))
  check('the saving flag was cleared', controller.projection().saving === false,
    `saving=${controller.projection().saving}`)
  check('the failure is reported to the user', controller.projection().failed === true,
    `failed=${controller.projection().failed}`)
  check('the draft is kept so the user can retry', controller.field('maxTokens').text === '321',
    controller.field('maxTokens').text)
  check('the draft is still dirty, so Save is offered again', controller.projection().dirty === true)
}

// ── 2. A failing credential write behaves the same way ────────────────────────
console.log('\n2. a rejected credential write leaves the card recoverable')
{
  const mod = loadClientModule()
  let controller
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: (slot) => { controller = slot.inject()?.hooks?.perplexityCard; return () => {} },
    },
    settingsScope: {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user: {} }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }),
    },
    remote: {
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => { throw new Error('credential store unavailable') },
      },
    },
    locale: undefined,
    effect: undefined,
  }
  mod.apply(ctx)

  controller.actions().edit('apiKey', 'pplx-secret')
  let threw = null
  try {
    await controller.actions().save()
  } catch (error) {
    threw = error.message
  }
  check('save does not reject into the caller', threw === null, String(threw))
  check('the saving flag was cleared', controller.projection().saving === false,
    `saving=${controller.projection().saving}`)
  check('the failure is reported', controller.projection().failed === true)
}

// ── 3. Discard is always able to release a stuck card ─────────────────────────
console.log('\n3. discard releases the card')
{
  const controller = makeController({ set: async () => { throw new Error('nope') } })
  controller.actions().edit('maxTokens', '999')
  await controller.actions().save()
  controller.actions().discard()
  check('discard clears the saving flag', controller.projection().saving === false,
    `saving=${controller.projection().saving}`)
  check('discard clears the failure', controller.projection().failed === false)
  check('discard drops the draft', controller.projection().dirty === false)
}

// ── 4. A successful save still clears the draft ───────────────────────────────
console.log('\n4. a successful save still behaves')
{
  const written = []
  const controller = makeController()
  const baseSet = controller.scope.set.bind(controller.scope)
  controller.scope.set = async (field, value) => { written.push([field, value]); return baseSet(field, value) }
  controller.actions().edit('maxTokens', '777')
  await controller.actions().save()
  check('the write reached the scope', written.length === 1 && written[0][0] === 'maxTokens',
    JSON.stringify(written))
  check('the draft was cleared', controller.projection().dirty === false)
  check('no failure was reported', controller.projection().failed === false)
  check('the saving flag was cleared', controller.projection().saving === false)
}

// ── 5. The research settings are card fields, and clearing unsets them ────────
// Before this the card had no research control at all: `researchDepth` and
// `researchTimeoutMs` could only be written by hand in settings.yaml, so a user
// could not see or change the default research cost from the UI. These pin that
// both are projected, that a chosen value is written as the host expects (the
// budget as a number, not the string the input holds), and that clearing the
// field *unsets* the key — blank means "use the built-in default", so storing an
// empty string would be a different thing.
console.log('\n5. the research settings round-trip through the card')
{
  const controller = makeController()
  const projected = controller.projection()
  check('both research fields are projected into the card',
    projected.researchDepth !== undefined && projected.researchTimeoutMs !== undefined,
    JSON.stringify(Object.keys(projected).filter((key) => key.startsWith('research'))))
  check('an unset depth and budget read as blank',
    projected.researchDepth.text === '' && projected.researchTimeoutMs.text === '',
    `${projected.researchDepth.text}/${projected.researchTimeoutMs.text}`)
  check('the depth control offers every depth plus the built-in default',
    projected.researchDepth !== undefined && typeof controller.specs.get('researchDepth')?.parse === 'function',
    JSON.stringify([...controller.specs.keys()].filter((key) => key.startsWith('research'))))

  const written = []
  const unsets = []
  const baseSet = controller.scope.set.bind(controller.scope)
  const baseUnset = controller.scope.unset.bind(controller.scope)
  controller.scope.set = async (field, value) => { written.push([field, value]); return baseSet(field, value) }
  controller.scope.unset = async (field) => { unsets.push(field); return baseUnset(field) }

  controller.actions().edit('researchDepth', 'high')
  controller.actions().edit('researchTimeoutMs', '600000')
  await controller.actions().save()
  check('the chosen depth reaches the host as a string',
    written.some(([field, value]) => field === 'researchDepth' && value === 'high'), JSON.stringify(written))
  check('the chosen budget reaches the host as a number, not the input text',
    written.some(([field, value]) => field === 'researchTimeoutMs' && value === 600_000),
    JSON.stringify(written))
  check('the card is clean after saving', controller.projection().dirty === false)

  // 0 is meaningful for the budget — it declares no deadline — so it must be a
  // set, not a clear, and must survive the round trip.
  controller.actions().edit('researchTimeoutMs', '0')
  await controller.actions().save()
  check('0 declares no deadline rather than clearing the field',
    written.some(([field, value]) => field === 'researchTimeoutMs' && value === 0)
      && !unsets.includes('researchTimeoutMs'),
    `written=${JSON.stringify(written)} unsets=${JSON.stringify(unsets)}`)

  // Clearing returns the field to the built-in default, which is an unset.
  controller.actions().edit('researchDepth', '')
  await controller.actions().save()
  check('clearing the depth unsets it instead of storing an empty value',
    unsets.includes('researchDepth'), JSON.stringify(unsets))

  // A value outside the enum must be refused rather than sent to the host.
  controller.actions().edit('researchDepth', 'unlimited')
  check('an unknown depth is invalid, so Save is blocked',
    controller.projection().invalid === true, String(controller.projection().invalid))
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
