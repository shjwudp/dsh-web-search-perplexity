/**
 * Browser half of @shjwudp/dsh-web-search-perplexity.
 *
 * Registers an editable `Perplexity web search` card in
 * Settings → Plugins → Plugin configuration, keyed by the
 * `web-search-perplexity` settings namespace. The card edits baseURL, model,
 * maxTokens, and searchRecency through the settings scope; the API key is a
 * write-only secret field backed by the credentials domain (never echoed).
 *
 * Defensive: if a required service or slot is unavailable in a given
 * deployment, the card is skipped rather than breaking the client.
 */

window.__ModuleLoader__.load({
  id: '@shjwudp/dsh-web-search-perplexity',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    try {
      const { createElement: h, useState } = require('react')

      const NS = 'web-search-perplexity'
      const DEFAULT_API_KEY_REF = 'PERPLEXITY_API_KEY'
      const AGENT_DEFAULT_MODEL = 'openai/gpt-5.6-luna'
      const RECENCY_OPTIONS = [
        { value: '', label: 'Default (none)' },
        { value: 'day', label: 'day' },
        { value: 'week', label: 'week' },
        { value: 'month', label: 'month' },
        { value: 'year', label: 'year' },
      ]
      const MODEL_OPTIONS = [
        { value: 'sonar', label: 'sonar' },
        { value: 'sonar-pro', label: 'sonar-pro' },
        { value: 'sonar-reasoning-pro', label: 'sonar-reasoning-pro' },
        { value: 'sonar-deep-research', label: 'sonar-deep-research' },
      ]
      const API_MODE_OPTIONS = [
        { value: 'sonar', label: 'Sonar Chat Completions' },
        { value: 'agent', label: 'Agent API' },
      ]
      const PRESET_OPTIONS = [
        { value: '', label: 'None (choose model manually)' },
        { value: 'fast', label: 'fast — single-fact lookups' },
        { value: 'low', label: 'low — everyday research' },
        { value: 'medium', label: 'medium — multi-hop browsing' },
        { value: 'high', label: 'high — exhaustive coverage' },
        { value: 'xhigh', label: 'xhigh — open-ended agentic' },
        { value: 'wide-research', label: 'wide-research — large collections' },
      ]
      /**
       * Presets usable as a degraded retry. `wide-research` is excluded: it is a
       * minutes-long background workflow, not a latency fallback.
       */
      const FALLBACK_PRESET_OPTIONS = PRESET_OPTIONS.filter(
        (option) => option.value !== '' && option.value !== 'wide-research',
      )
      const AGENT_MODEL_GROUPS = [
        {
          label: 'Anthropic',
          options: [
            { value: 'anthropic/claude-opus-5', label: 'claude-opus-5' },
            { value: 'anthropic/claude-opus-4-8', label: 'claude-opus-4-8' },
            { value: 'anthropic/claude-opus-4-7', label: 'claude-opus-4-7' },
            { value: 'anthropic/claude-opus-4-6', label: 'claude-opus-4-6' },
            { value: 'anthropic/claude-opus-4-5', label: 'claude-opus-4-5' },
            { value: 'anthropic/claude-fable-5', label: 'claude-fable-5' },
            { value: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5' },
            { value: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
            { value: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
            { value: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5' },
          ],
        },
        {
          label: 'OpenAI',
          options: [
            { value: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol' },
            { value: 'openai/gpt-5.6-terra', label: 'gpt-5.6-terra' },
            { value: 'openai/gpt-5.6-luna', label: 'gpt-5.6-luna' },
            { value: 'openai/gpt-5.5', label: 'gpt-5.5' },
            { value: 'openai/gpt-5.4', label: 'gpt-5.4' },
            { value: 'openai/gpt-5.4-mini', label: 'gpt-5.4-mini' },
            { value: 'openai/gpt-5.4-nano', label: 'gpt-5.4-nano' },
            { value: 'openai/gpt-5.2', label: 'gpt-5.2' },
            { value: 'openai/gpt-5.1', label: 'gpt-5.1' },
            { value: 'openai/gpt-5', label: 'gpt-5' },
            { value: 'openai/gpt-5-mini', label: 'gpt-5-mini' },
          ],
        },
        {
          label: 'Google',
          options: [
            { value: 'google/gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
            { value: 'google/gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite' },
            { value: 'google/gemini-3.5-flash', label: 'gemini-3.5-flash' },
            { value: 'google/gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite' },
            { value: 'google/gemini-3.6-flash', label: 'gemini-3.6-flash' },
            { value: 'google/gemini-3.7-flash', label: 'gemini-3.7-flash' },
            { value: 'google/gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
          ],
        },
        {
          label: 'xAI',
          options: [
            { value: 'xai/grok-4.6', label: 'grok-4.6' },
            { value: 'xai/grok-4.5', label: 'grok-4.5' },
            { value: 'xai/grok-4.3', label: 'grok-4.3' },
            { value: 'xai/grok-4.20-reasoning', label: 'grok-4.20-reasoning' },
            { value: 'xai/grok-4.20-non-reasoning', label: 'grok-4.20-non-reasoning' },
            { value: 'xai/grok-4.20-multi-agent', label: 'grok-4.20-multi-agent' },
          ],
        },
        {
          label: 'Perplexity & others',
          options: [
            { value: 'perplexity/sonar', label: 'perplexity/sonar' },
            { value: 'perplexity/deepseek-v4-flash-0731', label: 'deepseek-v4-flash-0731' },
            { value: 'perplexity/glm-5.2', label: 'glm-5.2' },
            { value: 'perplexity/glm-5.3', label: 'glm-5.3' },
            { value: 'perplexity/kimi-k3', label: 'kimi-k3' },
            { value: 'perplexity/kimi-k2.7-code', label: 'kimi-k2.7-code' },
            { value: 'perplexity/nemotron-3.5-lightning-30b-a3b', label: 'nemotron-3.5-lightning-30b-a3b' },
            { value: 'perplexity/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b-a55b' },
          ],
        },
      ]

      const styles = {
        card: {
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 16,
          border: '.5px solid var(--dsw-alias-border-l4)',
          background: 'var(--dsw-alias-bg-layer-3)',
          fontSize: 13,
          lineHeight: 1.5,
        },
        cardOpen: {
          borderColor: 'var(--dsw-alias-label-dimmed)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        header: {
          appearance: 'none',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'transparent',
          border: 0,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
        },
        headText: {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          gap: 4,
          minWidth: 0,
        },
        title: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontSize: 15, lineHeight: 1.4 },
        dim: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 },
        chevron: {
          color: 'var(--dsw-alias-label-tertiary)',
          flex: 'none',
          display: 'inline-flex',
          transition: 'transform .16s',
        },
        chevronOpen: { transform: 'rotate(180deg)' },
        body: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderTop: '.5px solid var(--dsw-alias-border-l2)',
          margin: '0 16px',
          paddingBottom: 8,
        },
        field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' },
        label: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 500 },
        input: {
          font: 'inherit',
          fontSize: 13,
          height: 34,
          padding: '0 12px',
          borderRadius: 8,
          border: '.5px solid var(--dsw-alias-border-l4)',
          background: 'var(--dsw-alias-bg-layer-3)',
          color: 'var(--dsw-alias-label-primary)',
        },
        row: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 4 },
        button: {
          font: 'inherit',
          fontSize: 13,
          padding: '5px 14px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
        },
        buttonPrimary: {
          font: 'inherit',
          fontSize: 13,
          padding: '5px 14px',
          borderRadius: 8,
          border: '1px solid transparent',
          background: 'var(--dsw-alias-label-primary)',
          color: 'var(--dsw-alias-bg-layer-3)',
          cursor: 'pointer',
        },
        note: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
        error: { color: 'var(--dsw-alias-label-error)' },
      }

      function textField(field) {
        return {
          field,
          format: (value) => (typeof value === 'string' ? value : ''),
          parse: (text) => {
            const trimmed = String(text ?? '').trim()
            return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
          },
        }
      }

      function numberField(field) {
        return {
          field,
          format: (value) => (typeof value === 'number' ? String(value) : ''),
          parse: (text) => {
            const trimmed = String(text ?? '').trim()
            if (trimmed === '') return { kind: 'clear' }
            const parsed = Number(trimmed)
            return Number.isInteger(parsed) && parsed > 0 ? { kind: 'set', value: parsed } : undefined
          },
        }
      }

      /** Like {@link numberField}, but 0 is meaningful: it disables the deadline. */
      function nonNegativeNumberField(field) {
        return {
          field,
          format: (value) => (typeof value === 'number' ? String(value) : ''),
          parse: (text) => {
            const trimmed = String(text ?? '').trim()
            if (trimmed === '') return { kind: 'clear' }
            const parsed = Number(trimmed)
            return Number.isInteger(parsed) && parsed >= 0 ? { kind: 'set', value: parsed } : undefined
          },
        }
      }

      function selectField(field, options) {
        return {
          field,
          format: (value) => (typeof value === 'string' ? value : ''),
          parse: (text) => {
            const trimmed = String(text ?? '').trim()
            if (trimmed === '') return { kind: 'clear' }
            return options.some((option) => option.value === trimmed)
              ? { kind: 'set', value: trimmed }
              : undefined
          },
        }
      }

      class PerplexityCardController {
        constructor(scope, ctx) {
          this.scope = scope
          this.ctx = ctx
          this.specs = new Map([
            textField('baseURL'),
            selectField('apiMode', API_MODE_OPTIONS),
            selectField('preset', PRESET_OPTIONS),
            textField('model'),
            numberField('maxTokens'),
            selectField('searchRecency', RECENCY_OPTIONS),
            nonNegativeNumberField('softTimeoutMs'),
            selectField('fallbackPreset', FALLBACK_PRESET_OPTIONS),
          ].map((spec) => [spec.field, spec]))
          this.staged = new Map()
          this.listeners = new Set()
          this.saving = false
          this.failed = false
          this.credential = { ref: '', configured: false, writable: true }
          this.snapshot = this.projection()
          scope.subscribe(() => this.publish())
          this.readCredential()
        }

        subscribe = (listener) => {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        }

        getSnapshot = () => this.snapshot

        publish() {
          this.snapshot = this.projection()
          for (const listener of this.listeners) listener()
        }

        projection() {
          return {
            available: this.scope.getSnapshot().status === 'ready',
            writable: this.scope.getSnapshot().writable,
            dirty: this.staged.size > 0,
            invalid: this.plan().some((item) => item.run === undefined),
            saving: this.saving,
            failed: this.failed,
            baseURL: this.field('baseURL'),
            apiMode: this.field('apiMode'),
            preset: this.field('preset'),
            model: this.field('model'),
            maxTokens: this.field('maxTokens'),
            searchRecency: this.field('searchRecency'),
            softTimeoutMs: this.field('softTimeoutMs'),
            fallbackPreset: this.field('fallbackPreset'),
            apiKeyText: this.staged.get('apiKey')?.text ?? '',
            apiKeyConfigured: this.credential.configured,
            apiKeyWritable: this.credential.writable,
          }
        }

        inject() {
          return {
            hooks: { perplexityCard: this },
            ...this.actions(),
          }
        }

        actions() {
          return {
            edit: (field, text) => {
              this.staged.set(field, { text, clear: false })
              this.failed = false
              this.publish()
            },
            resetField: (field) => {
              const spec = this.specs.get(field)
              if (spec === undefined) return
              this.staged.set(field, { text: spec.format(this.baseValue(field)), clear: true })
              this.failed = false
              this.publish()
            },
            save: () => this.save(),
            discard: () => {
              if (this.staged.size === 0 && !this.failed) return
              this.staged.clear()
              this.failed = false
              this.publish()
            },
          }
        }

        async save() {
          const plan = this.plan()
          const writes = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]))
          if (plan.length === 0 || this.saving || writes.length !== plan.length) return
          this.saving = true
          this.failed = false
          this.publish()
          let landed = true
          for (const write of writes) landed = (await write()) && landed
          if (landed) this.staged.clear()
          this.saving = false
          this.failed = !landed
          this.publish()
        }

        plan() {
          const plan = []
          for (const [field, staged] of this.staged) {
            if (field === 'apiKey') {
              const value = String(staged.text ?? '').trim()
              if (value !== '') plan.push({ field, run: () => this.writeKey(value) })
              continue
            }
            const spec = this.specs.get(field)
            if (spec === undefined) continue
            if (staged.clear) {
              if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
              continue
            }
            if (staged.text === spec.format(this.sectionValue(field))) continue
            const write = spec.parse(staged.text)
            if (write === undefined) plan.push({ field, run: undefined })
            else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
            else plan.push({ field, run: () => this.store(field, write.value) })
          }
          return plan
        }

        field(name) {
          const spec = this.specs.get(name)
          if (spec === undefined) return { text: '', overridden: false, invalid: false }
          const staged = this.staged.get(name)
          if (staged === undefined) {
            return {
              text: spec.format(this.sectionValue(name)),
              overridden: this.stored(name),
              invalid: false,
            }
          }
          const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
          return {
            text: staged.text,
            overridden: write?.kind === 'set',
            invalid: write === undefined,
          }
        }

        sectionValue(field) {
          return this.scope.getSnapshot().value?.[field]
        }

        baseValue(field) {
          return this.scope.getSnapshot().base?.[field]
        }

        userLayer() {
          return this.scope.getSnapshot().user
        }

        stored(field) {
          const user = this.userLayer()
          return user !== undefined && Object.hasOwn(user, field)
        }

        async store(field, value) {
          await this.scope.set(field, value)
          return this.userLayer()?.[field] === value
        }

        async clear(field) {
          await this.scope.unset(field)
          return !this.stored(field)
        }

        refOf(snapshot) {
          const declared = snapshot.value?.apiKeyEnv
          return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
        }

        async readCredential() {
          const ref = this.refOf(this.scope.getSnapshot())
          if (ref !== this.credential.ref) {
            this.credential = { ref, configured: false, writable: true }
            this.publish()
          }
          try {
            const response = await this.ctx.remote.credentials.describe([ref])
            if (!response.ok || ref !== this.refOf(this.scope.getSnapshot())) return
            const view = response.value[ref]
            const next = {
              ref,
              configured: view?.configured ?? false,
              writable: view?.writable ?? true,
            }
            if (next.configured !== this.credential.configured || next.writable !== this.credential.writable) {
              this.credential = next
              this.publish()
            }
          } catch {
            // credential read is best-effort; the field stays with its last known state
          }
        }

        async writeKey(value) {
          await this.ctx.remote.credentials.set(this.refOf(this.scope.getSnapshot()), value)
          await this.readCredential()
          return this.credential.configured
        }
      }

      function Field(props) {
        const state = props.state
        return h('div', { style: styles.field },
          h('label', { style: styles.label }, props.label),
          h('input', {
            style: styles.input,
            value: state.text,
            disabled: props.disabled,
            placeholder: props.placeholder ?? '',
            onChange: (event) => props.edit(props.field, event.target.value),
          }),
          state.invalid ? h('span', { style: styles.error }, 'Invalid value') : null,
        )
      }

      function SelectField(props) {
        const state = props.state
        const groups = props.groups ?? (props.options ? [{ label: null, options: props.options }] : [])
        const flat = groups.flatMap((group) => group.options)
        const known = flat.some((option) => option.value === state.text)
        const withCurrent = known
          ? groups
          : [{ label: null, options: [{ value: state.text, label: state.text === '' ? 'Select…' : state.text }] }, ...groups]
        return h('div', { style: styles.field },
          h('label', { style: styles.label }, props.label),
          h('select', {
            style: styles.input,
            value: state.text,
            disabled: props.disabled,
            onChange: (event) => props.edit(props.field, event.target.value),
          },
            withCurrent.map((group) => group.label
              ? h('optgroup', { label: group.label }, group.options.map((option) => h('option', { value: option.value }, option.label)))
              : group.options.map((option) => h('option', { value: option.value }, option.label))),
          ),
          state.invalid ? h('span', { style: styles.error }, 'Invalid value') : null,
        )
      }

      function SecretField(props) {
        const state = props.state
        return h('div', { style: styles.field },
          h('label', { style: styles.label }, 'API key'),
          h('div', { style: styles.row },
            h('input', {
              style: { ...styles.input, flex: '1 1 auto' },
              type: 'password',
              value: state.apiKeyText,
              disabled: props.disabled || !state.apiKeyWritable,
              placeholder: 'Leave blank to keep the current key',
              autoComplete: 'off',
              onChange: (event) => props.edit('apiKey', event.target.value),
            }),
            h('span', { style: styles.note }, state.apiKeyConfigured ? 'Configured' : 'Not configured'),
          ),
          h('span', { style: styles.note }, 'Stored outside the settings file; never echoed back.'),
        )
      }

      function PerplexityCard(props) {
        const state = props.usePerplexityCard((snapshot) => snapshot)
        const [expanded, setExpanded] = useState(false)
        const disabled = !state.available || !state.writable || state.saving
        const isAgent = state.apiMode.text === 'agent'
        const agentModelText = isAgent && !state.model.text.includes('/')
          ? AGENT_DEFAULT_MODEL
          : state.model.text
        const modelState = isAgent && !state.model.text.includes('/')
          ? { ...state.model, text: AGENT_DEFAULT_MODEL }
          : state.model
        const summary = [
          state.apiMode.text || 'agent',
          state.preset.text || agentModelText || 'sonar',
          state.baseURL.text || 'https://api.perplexity.ai',
        ].join(' · ')

        return h('div', { style: expanded ? { ...styles.card, ...styles.cardOpen } : styles.card },
          h('button', {
            style: styles.header,
            'aria-expanded': expanded,
            onClick: () => setExpanded(!expanded),
          },
            h('div', { style: styles.headText },
              h('div', { style: styles.title }, 'Perplexity web search'),
              h('div', { style: styles.dim }, 'Standalone Perplexity provider for ctx.web (id: perplexity).'),
              expanded ? null : h('div', { style: styles.note },
                summary + (state.dirty ? ' · Unsaved changes' : ''),
              ),
            ),
            h('span', {
              style: expanded ? { ...styles.chevron, ...styles.chevronOpen } : styles.chevron,
            },
              h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                h('polyline', { points: '6 9 12 15 18 9' }),
              ),
            ),
          ),
          expanded ? h('div', { style: styles.body },
            h(Field, { label: 'Endpoint (baseURL)', field: 'baseURL', state: state.baseURL, disabled, edit: props.edit }),
            h(SelectField, { label: 'API mode', field: 'apiMode', state: state.apiMode, disabled, edit: props.edit, options: API_MODE_OPTIONS }),
            state.apiMode.text === 'agent'
              ? h(SelectField, { label: 'Preset', field: 'preset', state: state.preset, disabled, edit: props.edit, options: PRESET_OPTIONS })
              : null,
            isAgent && state.preset.text !== ''
              ? h('div', { style: styles.note }, `Model is managed by the "${state.preset.text}" preset.`)
              : isAgent
                ? h(SelectField, { label: 'Model', field: 'model', state: modelState, disabled, edit: props.edit, groups: AGENT_MODEL_GROUPS })
                : h(SelectField, { label: 'Model', field: 'model', state: state.model, disabled, edit: props.edit, options: MODEL_OPTIONS }),
            h(Field, { label: 'Max tokens', field: 'maxTokens', state: state.maxTokens, disabled, edit: props.edit, placeholder: '1024' }),
            state.apiMode.text === 'sonar'
              ? h(SelectField, { label: 'Search recency', field: 'searchRecency', state: state.searchRecency, disabled, edit: props.edit, options: RECENCY_OPTIONS })
              : null,
            isAgent
              ? h('div', null,
                h(Field, { label: 'Soft deadline (ms)', field: 'softTimeoutMs', state: state.softTimeoutMs, disabled, edit: props.edit, placeholder: '25000' }),
                h(SelectField, { label: 'Fallback preset', field: 'fallbackPreset', state: state.fallbackPreset, disabled, edit: props.edit, options: FALLBACK_PRESET_OPTIONS }),
                h('div', { style: styles.note },
                  'When an agent search passes the soft deadline it retries once on this preset and labels the '
                  + 'shallower answer instead of letting the outer tool call time out. 0 disables it. Keep '
                  + 'soft deadline + 15s below the web_search tool budget.'),
              )
              : null,
            h(SecretField, { state, disabled, edit: props.edit }),
            h('div', { style: styles.row },
              h('button', {
                style: styles.buttonPrimary,
                disabled: disabled || !state.dirty || state.invalid,
                onClick: () => props.save(),
              }, state.saving ? 'Saving…' : 'Save'),
              h('button', {
                style: styles.button,
                disabled: disabled || (!state.dirty && !state.failed),
                onClick: () => props.discard(),
              }, 'Discard'),
              state.failed ? h('span', { style: styles.error }, 'Save failed; drafts kept.') : null,
            ),
          ) : null,
        )
      }

      function apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return

        try {
          const scope = ctx.settingsScope.bind({ namespace: NS })
          const card = new PerplexityCardController(scope, ctx)
          ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
            name: 'settings.plugin.item',
            key: NS,
            inject: () => card.inject(),
          }, PerplexityCard))
        } catch (error) {
          console.warn('[dsh-web-search-perplexity] settings card unavailable', error)
        }
      }

      exports.apply = apply
      exports.inject = ['slots', 'settingsScope', 'remote.credentials']
    } catch (error) {
      console.warn('[dsh-web-search-perplexity] client init failed', error)
      exports.apply = function () {}
      exports.inject = []
    }
    return module.exports
  },
})
