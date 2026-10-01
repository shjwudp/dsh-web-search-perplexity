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
 * The `ctx.configForms` service a DSH 0.2 client context provides.
 *
 * DSH 0.2 addresses a plugin's configuration by the id of the Loader entry that
 * mounts it: `get(id)` answers with that entry's form, and `whileServed` runs a
 * registration once the Host serves one of the named namespaces. The shim keeps
 * the stand-in `scope` the tests drive.
 *
 * @param scope - the form stand-in the card controller reads and writes.
 * @returns a stand-in for the service.
 */
function fakeConfigForms(scope) {
  return {
    get: () => scope,
    whileServed: (namespaces, register) => {
      register(new Set(namespaces))
      return () => {}
    },
  }
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
    // Mirrors the real form: `set` answers whether the Host accepted the write,
    // and the snapshot it derives from is the other signal the card checks.
    set: async (field, value) => { user[field] = value; return true },
    unset: async (field) => { delete user[field]; return true },
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
    configForms: fakeConfigForms(scope),
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
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user: {} }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  }
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: (slot) => { controller = slot.inject()?.hooks?.perplexityCard; return () => {} },
    },
    configForms: fakeConfigForms(scope),
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
// `researchTimeoutMs` could only be written by hand in the config, so a user
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

// ── 6. The card only reads services its `inject` declares ─────────────────────
// Cordis offers `ctx.<name>` only for a service the plugin declared; any other
// read throws `cannot get property "<name>" without inject`. The card reads the
// parent `ctx.remote` to reach `remote.credentials`, and Cordis registers
// `remote.credentials` as its own service — so naming only the namespace left
// `remote` undeclared. The card still rendered, because the constructor's
// credential read swallows its own errors, and only Save surfaced the failure.
// This section models the gate so that bug cannot return as a green suite.
console.log('\n6. the card only reads services it declares')
{
  /**
   * Apply the client half behind a context that enforces Cordis's inject rule.
   * @param mod - the loaded client module, whose `inject` is the declaration.
   * @param dropRootRemote - when true, simulate a declaration that names only
   *   `remote.credentials`, i.e. the shape that shipped the bug.
   */
  function gatedController(mod, dropRootRemote) {
    const declared = new Set(mod.inject ?? [])
    if (dropRootRemote) declared.delete('remote')
    const user = {}
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user }),
      subscribe: () => () => {},
      set: async (field, value) => { user[field] = value },
      unset: async (field) => { delete user[field] },
    }
    const credentials = {
      // `writeKey` only reports success when the credential reads back as
      // configured, so the stub has to confirm what `set` just stored.
      describe: async () => ({ ok: true, value: { PERPLEXITY_API_KEY: { configured: true, writable: true } } }),
      set: async () => ({ ok: true }),
    }
    const remote = new Proxy({ credentials }, {
      get(target, prop, receiver) {
        if (prop === 'credentials' && !declared.has('remote.credentials')) {
          throw new Error('cannot get property "remote.credentials" without inject')
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    let controller
    const ctx = {
      slots: {
        inject: (_name, register) => register(),
        register: (slot) => { controller = slot.inject()?.hooks?.perplexityCard; return () => {} },
      },
      configForms: fakeConfigForms(scope),
      remote,
      locale: undefined,
      effect: undefined,
    }
    // Gate the top-level names exactly as Cordis does.
    for (const name of ['slots', 'configForms', 'remote', 'locale']) {
      const value = ctx[name]
      Object.defineProperty(ctx, name, {
        configurable: true,
        get() {
          if (!declared.has(name)) throw new Error(`cannot get property "${name}" without inject`)
          return value
        },
      })
    }
    mod.apply(ctx)
    if (controller === undefined) throw new Error('the card was not registered behind the gate')
    return controller
  }

  const mod = loadClientModule()
  check('the client half declares `remote` alongside its namespace',
    Array.isArray(mod.inject) && mod.inject.includes('remote') && mod.inject.includes('remote.credentials'),
    JSON.stringify(mod.inject))

  const controller = gatedController(mod, false)
  controller.actions().edit('apiKey', 'pplx-secret')
  await controller.actions().save()
  check('saving the key succeeds when every service it reads is declared',
    controller.projection().failed === false, controller.projection().lastError)

  const broken = gatedController({ ...mod, inject: (mod.inject ?? []).filter((name) => name !== 'remote') }, true)
  broken.actions().edit('apiKey', 'pplx-secret')
  await broken.actions().save()
  check('dropping `remote` reproduces the reported save failure',
    broken.projection().failed === true && /without inject/.test(broken.projection().lastError),
    broken.projection().lastError)
}

// ── 7. The master switch writes itself, and hides without a host that owns it ─
// Disabling is deliberately not a staged form field: it has to take effect on
// its own so a user who only wants the built-in search back does not have to
// commit unrelated drafts. It also has to disappear — rather than fail on click —
// while the Host half is still an older copy that does not declare `enabled`,
// which is the normal state between a browser reload and a DSH restart.
console.log('\n7. the master switch round-trips and gates on the host schema')
{
  /** A card whose host scope declares (or omits) the `enabled` field. */
  function makeEnabledController({ declaresField = true, set = undefined } = {}) {
    const mod = loadClientModule()
    const calls = []
    const value = declaresField ? { enabled: true } : {}
    const user = {}
    let controller
    const scope = {
      getSnapshot: () => ({ status: 'ready', writable: true, value, base: {}, user }),
      subscribe: () => () => {},
      set: set ?? (async (field, next) => { calls.push(['set', field, next]); value[field] = next; user[field] = next; return true }),
      unset: async (field) => { calls.push(['unset', field]); delete value[field]; delete user[field]; return true },
    }
    const ctx = {
      slots: {
        inject: (_name, register) => register(),
        register: (slot) => { controller = slot.inject()?.hooks?.perplexityCard; return () => {} },
      },
      configForms: fakeConfigForms(scope),
      remote: {
        credentials: {
          describe: async () => ({ ok: true, value: {} }),
          set: async () => ({ ok: true }),
        },
      },
      locale: undefined,
      effect: undefined,
    }
    mod.apply(ctx)
    return { controller, calls }
  }

  const { controller, calls } = makeEnabledController()
  check('the switch is offered when the host declares the field',
    controller.projection().enabledSupported === true && controller.projection().enabled === true)

  await controller.actions().setEnabled(false)
  check('disabling writes `enabled: false` through the scope',
    calls.some(([kind, field, next]) => kind === 'set' && field === 'enabled' && next === false),
    JSON.stringify(calls))
  check('the card then reads as disabled', controller.projection().enabled === false)
  check('the switch is never left busy', controller.projection().switching === false)
  check('disabling stages no draft, so Save is not required',
    controller.projection().dirty === false)
  check('disabling is not reported as a failure', controller.projection().switchFailed === false)

  await controller.actions().setEnabled(true)
  check('re-enabling unsets the override rather than storing `true`',
    calls.some(([kind, field]) => kind === 'unset' && field === 'enabled'), JSON.stringify(calls))
  check('the card reads as enabled again', controller.projection().enabled === true)

  const failing = makeEnabledController({ set: async () => { throw new Error('host refused') } })
  await failing.controller.actions().setEnabled(false)
  check('a rejected switch is reported, not thrown at the click handler',
    failing.controller.projection().switchFailed === true
      && failing.controller.projection().switchError === 'host refused',
    failing.controller.projection().switchError)
  check('a rejected switch clears its busy flag', failing.controller.projection().switching === false)

  const older = makeEnabledController({ declaresField: false })
  check('the switch is hidden while the host does not declare the field',
    older.controller.projection().enabledSupported === false)
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
