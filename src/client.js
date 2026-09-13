/**
 * Browser half of @shjwudp/dsh-web-search-perplexity.
 *
 * Registers an editable `Perplexity web search` card in
 * Settings → Plugins → Plugin configuration, keyed by the
 * `web-search-perplexity` settings namespace. The card edits baseURL, preset,
 * model, maxTokens, searchRecency, the Agent-mode soft deadline and its fallback
 * preset, and the image settings through the settings scope; the API key is a
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
      /**
       * UI copy for the settings card. `zh` is complete and `en` mirrors it, as
       * `ctx.locale.register` requires every shipped locale for a namespace.
       * Values that are themselves identifiers (preset names, `day`/`month`,
       * Agent API model ids) stay literal in the option tables and are not
       * dictionary entries.
       */
      const DICTS = {
        zh: {
          'card.title': 'Perplexity 网络搜索',
          'card.subtitle': 'ctx.web 的独立 Perplexity 搜索提供方（id: perplexity）。',
          'card.unsaved': '有未保存的修改',
          'field.baseURL': '接入地址（baseURL）',
          'field.searchProvider': '搜索后端',
          'field.preset': '预设',
          'field.model': '模型',
          'field.maxTokens': '最大 token 数',
          'field.searchRecency': '搜索时效',
          'field.softTimeoutMs': '软截止时间（毫秒）',
          'field.fallbackPreset': '降级预设',
          'field.imageInput': '图片输入',
          'field.imageMaxBytes': '单图字节上限',
          'field.imageRoots': '允许读取的图片目录',
          'field.apiKey': 'API 密钥',
          'advanced.toggle': '高级设置',
          'note.advanced': '以下通常无需改动。',
          'field.searchType': '搜索类型',
          'field.searchDomains': '域名过滤（最多 20 个）',
          'field.searchLanguages': '语言过滤（ISO 639-1，最多 20 个）',
          'field.searchCountry': '国家/地区（ISO 3166-1）',
          'field.searchContextSize': '内容抽取体量',
          'field.searchMaxTokensPerPage': '每页最大 token',
          'field.searchAfterDate': '发布于该日期之后（MM/DD/YYYY）',
          'field.searchBeforeDate': '发布于该日期之前（MM/DD/YYYY）',
          'backend.agent': 'Agent API — 生成答案 + 引用',
          'backend.search': 'Search API — 结构化结果，无生成答案',
          'searchType.web': 'web — 网页搜索',
          'searchType.people': 'people — 人物搜索',
          'contextSize.low': 'low — 简短片段',
          'contextSize.medium': 'medium — 均衡',
          'contextSize.high': 'high — 详细内容',
          'note.searchDomains': '逗号分隔，最多 20 个域名或 URL；留空表示不过滤。',
          'note.searchLanguages': '逗号分隔的两字母 ISO 639-1 代码，例如 en, zh；留空表示不过滤。',
          'note.searchCountry': '两字母 ISO 3166-1 代码，例如 US、GB、JP；留空表示不限定地域。',
          'note.searchContextSize': '决定每条结果抽取多少正文返给模型。people 搜索不接受该参数，'
            + '所以人物搜索不会发送它。',
          'note.searchDate': '按发布时间窗口收窄结果，格式 MM/DD/YYYY；留空表示不限。',
          'imageMode.on': '开启',
          'imageMode.off': '关闭',
          'note.imageInput': '开启后，把本地图片的绝对路径或公开的 https 图片地址当作一条查询传给 web_search，'
            + '该请求会把图片连同文字问题一并发给 Perplexity 做联网研究。只有扩展名为图片、且字节确实是 '
            + 'PNG/JPEG/GIF/WEBP 的文件才会被读取；其它文件一律拒绝，不会外发。',
          'note.imageRoots': '逗号分隔的目录白名单；留空表示不限制。填了以后，只有这些目录内的图片会被读取。',
          'note.imageModelFollows': '图片沿用你配置的预设（或模型）。预设自带的模型本身就能识图；'
            + '若未配置预设，请确保所选模型能看图，否则带图请求会答错而不是报错。',
          'placeholder.imageMaxBytes': '10485760',
          'placeholder.imageRoots': '留空 = 不限制',
          'placeholder.commaList': 'a.example, b.example',
          'placeholder.optional': '默认值',
          'recency.none': '默认（不限）',
          'preset.none': '无（手动选择模型）',
          'preset.fast': 'fast — 单事实检索',
          'preset.low': 'low — 日常研究',
          'preset.medium': 'medium — 多跳浏览',
          'preset.high': 'high — 穷尽覆盖',
          'preset.xhigh': 'xhigh — 开放式自主研究',
          'preset.wide-research': 'wide-research — 大规模资料收集',
          'group.anthropic': 'Anthropic',
          'group.openai': 'OpenAI',
          'group.google': 'Google',
          'group.xai': 'xAI',
          'group.other': 'Perplexity 及其他',
          'note.presetModel': '模型由「{preset}」预设管理。',
          'note.softDeadline': '留空则按预设推导截止时间（fast/low 为 12000；medium 及更慢为 40000）。'
            + '当 agent 搜索超过该时间，提供方会用降级预设重试一次并标注该结果较浅，'
            + '而不是让外层工具调用直接超时：内容以 [DEGRADED] 加 JSON 开头，结果中也带有 degradation 字段。'
            + '填 0 表示关闭。请让「截止时间 + 15 秒」低于 web_search 的工具预算'
            + '（随附 agent 预设为 60000；dsh-tool-web 组件默认为 30000）。',
          'placeholder.presetDefault': '预设默认值',
          'placeholder.maxTokens': '1024',
          'select.current': '选择…',
          'apiKey.notConfigured': '未配置',
          'apiKey.configured': '已配置',
          'apiKey.placeholderStored': '留空则保留当前密钥',
          'apiKey.noteStored': '存储在设置文件之外，从不回显。',
          'status.invalid': '取值无效',
          'action.save': '保存',
          'action.saving': '保存中…',
          'action.discard': '放弃修改',
          'status.saveFailed': '保存失败；草稿已保留。',
        },
        en: {
          'card.title': 'Perplexity web search',
          'card.subtitle': 'Standalone Perplexity provider for ctx.web (id: perplexity).',
          'card.unsaved': 'Unsaved changes',
          'field.baseURL': 'Endpoint (baseURL)',
          'field.searchProvider': 'Search backend',
          'field.preset': 'Preset',
          'field.model': 'Model',
          'field.maxTokens': 'Max tokens',
          'field.searchRecency': 'Search recency',
          'field.softTimeoutMs': 'Soft deadline (ms)',
          'field.fallbackPreset': 'Fallback preset',
          'field.imageInput': 'Image input',
          'field.imageMaxBytes': 'Max bytes per image',
          'field.imageRoots': 'Allowed image directories',
          'field.apiKey': 'API key',
          'advanced.toggle': 'Advanced settings',
          'note.advanced': 'Not usually needed.',
          'field.searchType': 'Search type',
          'field.searchDomains': 'Domain filter (max 20)',
          'field.searchLanguages': 'Language filter (ISO 639-1, max 20)',
          'field.searchCountry': 'Country (ISO 3166-1)',
          'field.searchContextSize': 'Content extraction size',
          'field.searchMaxTokensPerPage': 'Max tokens per page',
          'field.searchAfterDate': 'Published after (MM/DD/YYYY)',
          'field.searchBeforeDate': 'Published before (MM/DD/YYYY)',
          'backend.agent': 'Agent API — generated answer + citations',
          'backend.search': 'Search API — ranked results, no generated answer',
          'searchType.web': 'web — general web search',
          'searchType.people': 'people — people search',
          'contextSize.low': 'low — short passages',
          'contextSize.medium': 'medium — balanced',
          'contextSize.high': 'high — detailed content',
          'note.searchDomains': 'Comma-separated, up to 20 domains or URLs; empty means no filter.',
          'note.searchLanguages': 'Comma-separated two-letter ISO 639-1 codes, e.g. en, zh; empty means no filter.',
          'note.searchCountry': 'Two-letter ISO 3166-1 code, e.g. US, GB, JP; empty means no region preference.',
          'note.searchContextSize': 'How much page content each result returns to the model. A people search does '
            + 'not accept this parameter, so people searches omit it.',
          'note.searchDate': 'Narrow results by publication window, MM/DD/YYYY; empty means no bound.',
          'imageMode.on': 'Enabled',
          'imageMode.off': 'Disabled',
          'note.imageInput': 'When enabled, a query that is an absolute local image path or a public https image '
            + 'URL is sent to Perplexity as that image plus the text question, for web-grounded analysis. Only files '
            + 'whose extension names an image and whose bytes really are PNG/JPEG/GIF/WEBP are read; anything else is '
            + 'refused rather than sent.',
          'note.imageRoots': 'Comma-separated directory allowlist; empty means no restriction.',
          'note.imageModelFollows': 'Images use your configured preset (or model); a preset\''
            + 's own model already reads images. With no preset set, pick a model that can read images, '
            + 'or an image request answers badly rather than failing.',
          'placeholder.imageMaxBytes': '10485760',
          'placeholder.imageRoots': 'empty = no restriction',
          'placeholder.commaList': 'a.example, b.example',
          'placeholder.optional': 'default',
          'recency.none': 'Default (none)',
          'preset.none': 'None (choose model manually)',
          'preset.fast': 'fast — single-fact lookups',
          'preset.low': 'low — everyday research',
          'preset.medium': 'medium — multi-hop browsing',
          'preset.high': 'high — exhaustive coverage',
          'preset.xhigh': 'xhigh — open-ended agentic',
          'preset.wide-research': 'wide-research — large collections',
          'group.anthropic': 'Anthropic',
          'group.openai': 'OpenAI',
          'group.google': 'Google',
          'group.xai': 'xAI',
          'group.other': 'Perplexity & others',
          'note.presetModel': 'Model is managed by the "{preset}" preset.',
          'note.softDeadline': 'Leave blank to derive the deadline from the preset (fast/low 12000; medium and '
            + 'slower 40000). When an agent search passes it the provider retries once on the fallback preset and '
            + 'marks the shallower answer instead of letting the outer tool call time out: the content starts with '
            + '[DEGRADED] plus JSON, and the result carries a degradation field. 0 disables it. Keep the deadline + '
            + '15s below the web_search tool budget (60000 under the shipped agent presets; the dsh-tool-web '
            + 'component default is 30000).',
          'placeholder.presetDefault': 'preset default',
          'placeholder.maxTokens': '1024',
          'select.current': 'Select…',
          'apiKey.notConfigured': 'Not configured',
          'apiKey.configured': 'Configured',
          'apiKey.placeholderStored': 'Leave blank to keep the current key',
          'apiKey.noteStored': 'Stored outside the settings file; never echoed back.',
          'status.invalid': 'Invalid value',
          'action.save': 'Save',
          'action.saving': 'Saving…',
          'action.discard': 'Discard',
          'status.saveFailed': 'Save failed; drafts kept.',
        },
      }
      /** English copy, used verbatim when the locale service is unavailable. */
      const EN = DICTS.en
      /** Option tables carry translation keys; the card resolves them at render. */
      const RECENCY_OPTIONS = [
        { value: '', labelKey: 'recency.none' },
        { value: 'day', label: 'day' },
        { value: 'week', label: 'week' },
        { value: 'month', label: 'month' },
        { value: 'year', label: 'year' },
      ]
      /**
       * Recency windows for the Search API, which additionally accepts `hour`.
       * The Agent API's `web_search` tool filter does not.
       */
      const SEARCH_RECENCY_OPTIONS = [
        { value: '', labelKey: 'recency.none' },
        { value: 'hour', label: 'hour' },
        ...RECENCY_OPTIONS.slice(1),
      ]
      /** Blank enables image input; only an explicit "off" disables it. */
      const IMAGE_INPUT_OPTIONS = [
        { value: '', labelKey: 'imageMode.on' },
        { value: 'off', labelKey: 'imageMode.off' },
      ]
      /** Which of the plugin's two backends serves searches; blank = Agent API. */
      const BACKEND_OPTIONS = [
        { value: '', labelKey: 'backend.agent' },
        { value: 'perplexity-search', labelKey: 'backend.search' },
      ]
      const SEARCH_TYPE_OPTIONS = [
        { value: 'web', labelKey: 'searchType.web' },
        { value: 'people', labelKey: 'searchType.people' },
      ]
      const CONTEXT_SIZE_OPTIONS = [
        { value: 'low', labelKey: 'contextSize.low' },
        { value: 'medium', labelKey: 'contextSize.medium' },
        { value: 'high', labelKey: 'contextSize.high' },
      ]
      const PRESET_OPTIONS = [
        { value: '', labelKey: 'preset.none' },
        { value: 'fast', labelKey: 'preset.fast' },
        { value: 'low', labelKey: 'preset.low' },
        { value: 'medium', labelKey: 'preset.medium' },
        { value: 'high', labelKey: 'preset.high' },
        { value: 'xhigh', labelKey: 'preset.xhigh' },
        { value: 'wide-research', labelKey: 'preset.wide-research' },
      ]
      /**
       * Presets usable as a degraded retry. `wide-research` is excluded: it is a
       * minutes-long background workflow, not a latency fallback.
       */
      const FALLBACK_PRESET_OPTIONS = PRESET_OPTIONS.filter(
        (option) => option.value !== '' && option.value !== 'wide-research',
      )
      /**
       * Agent API models by vendor. Group headings carry `labelKey` so they
       * follow the active locale; the model ids stay literal.
       * @param t - translate function bound to this plugin's namespace.
       */
      function agentModelGroups(t) {
        return [
        {
          label: t('group.anthropic'),
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
          label: t('group.openai'),
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
          label: t('group.google'),
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
          label: t('group.xai'),
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
          label: t('group.other'),
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
      }

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
        advanced: { padding: '4px 0' },
        summary: {
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 13,
          padding: '4px 0',
        },
        advancedBody: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderLeft: '.5px solid var(--dsw-alias-border-l2)',
          paddingLeft: 12,
          marginTop: 4,
        },
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

      /**
       * Comma-separated directory list, stored as a settings array. A comma is
       * the separator because a Windows or POSIX path may not contain one.
       */
      function listField(field) {
        return {
          field,
          format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
          parse: (text) => {
            const roots = String(text ?? '')
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry !== '')
            return roots.length === 0 ? { kind: 'clear' } : { kind: 'set', value: roots }
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
            selectField('preset', PRESET_OPTIONS),
            textField('model'),
            numberField('maxTokens'),
            selectField('searchRecency', RECENCY_OPTIONS),
            nonNegativeNumberField('softTimeoutMs'),
            selectField('fallbackPreset', FALLBACK_PRESET_OPTIONS),
            selectField('imageInput', IMAGE_INPUT_OPTIONS),
            numberField('imageMaxBytes'),
            listField('imageRoots'),
            selectField('searchProvider', BACKEND_OPTIONS),
            selectField('searchType', SEARCH_TYPE_OPTIONS),
            listField('searchDomains'),
            listField('searchLanguages'),
            textField('searchCountry'),
            selectField('searchContextSize', CONTEXT_SIZE_OPTIONS),
            numberField('searchMaxTokensPerPage'),
            textField('searchAfterDate'),
            textField('searchBeforeDate'),
          ].map((spec) => [spec.field, spec]))
          this.staged = new Map()
          this.listeners = new Set()
          this.saving = false
          this.failed = false
          /** Message from the most recent failed write, shown beside the buttons. */
          this.lastError = ''
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
            lastError: this.lastError,
            baseURL: this.field('baseURL'),
            preset: this.field('preset'),
            model: this.field('model'),
            maxTokens: this.field('maxTokens'),
            searchRecency: this.field('searchRecency'),
            softTimeoutMs: this.field('softTimeoutMs'),
            fallbackPreset: this.field('fallbackPreset'),
            imageInput: this.field('imageInput'),
            imageMaxBytes: this.field('imageMaxBytes'),
            imageRoots: this.field('imageRoots'),
            searchProvider: this.field('searchProvider'),
            searchType: this.field('searchType'),
            searchDomains: this.field('searchDomains'),
            searchLanguages: this.field('searchLanguages'),
            searchCountry: this.field('searchCountry'),
            searchContextSize: this.field('searchContextSize'),
            searchMaxTokensPerPage: this.field('searchMaxTokensPerPage'),
            searchAfterDate: this.field('searchAfterDate'),
            searchBeforeDate: this.field('searchBeforeDate'),
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
              this.lastError = ''
              this.publish()
            },
            resetField: (field) => {
              const spec = this.specs.get(field)
              if (spec === undefined) return
              this.staged.set(field, { text: spec.format(this.baseValue(field)), clear: true })
              this.failed = false
              this.lastError = ''
              this.publish()
            },
            save: () => this.save(),
            discard: () => {
              if (this.staged.size === 0 && !this.failed && !this.saving) return
              this.staged.clear()
              this.failed = false
              this.lastError = ''
              // Clearing `saving` here is deliberate: it gates the Save button, so a
              // `save` that somehow failed to clear it would otherwise leave the card
              // with no usable control at all.
              this.saving = false
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
          this.lastError = ''
          this.publish()
          let landed = true
          try {
            // Each write is attempted even when an earlier one rejects: the settings
            // scope can refuse one field while accepting another, and the user needs
            // the writes that did land to be reflected rather than abandoned.
            for (const write of writes) landed = (await this.run(write)) && landed
          } finally {
            // `saving` gates the Save button, so it must clear on every path. A `save`
            // that could leave it set would strand the card with no way to retry.
            this.saving = false
            this.failed = !landed
            if (landed) this.staged.clear()
            this.publish()
          }
        }

        /**
         * Attempt one write, recording what went wrong instead of aborting the save.
         * @param write - one planned write action.
         * @returns true when the write landed.
         */
        async run(write) {
          try {
            return (await write()) === true
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error)
            return false
          }
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
          state.invalid ? h('span', { style: styles.error }, props.t('status.invalid')) : null,
        )
      }

      /**
       * Resolve one option table entry to its display text. Entries carry either a
       * `labelKey` for localized copy or a literal `label` for identifiers that are
       * not translated (model ids, `day`/`week`).
       * @param option - one entry from an option table or model group.
       * @param t - translate function bound to this plugin's namespace.
       * @returns the text to render for the option.
       */
      function optionLabel(option, t) {
        return option.labelKey !== undefined ? t(option.labelKey) : option.label
      }

      function SelectField(props) {
        const state = props.state
        const groups = props.groups ?? (props.options ? [{ label: null, options: props.options }] : [])
        const flat = groups.flatMap((group) => group.options)
        const known = flat.some((option) => option.value === state.text)
        const withCurrent = known
          ? groups
          : [{
            label: null,
            options: [{ value: state.text, label: state.text === '' ? props.t('select.current') : state.text }],
          }, ...groups]
        return h('div', { style: styles.field },
          h('label', { style: styles.label }, props.label),
          h('select', {
            style: styles.input,
            value: state.text,
            disabled: props.disabled,
            onChange: (event) => props.edit(props.field, event.target.value),
          },
            withCurrent.map((group) => group.label
              ? h('optgroup', { label: group.label }, group.options.map((option) => h('option', { value: option.value }, optionLabel(option, props.t))))
              : group.options.map((option) => h('option', { value: option.value }, optionLabel(option, props.t)))),
          ),
          state.invalid ? h('span', { style: styles.error }, props.t('status.invalid')) : null,
        )
      }

      /**
       * One collapsed disclosure for the settings an ordinary deployment never
       * touches. The card opens on the choices that decide behaviour — which
       * backend, which preset or search type, whether images are read — and the
       * tuning lives one click away instead of competing for attention.
       *
       * @param props - `t` for the summary label, and the children to disclose.
       * @returns the disclosure element.
       */
      function AdvancedSection(props) {
        return h('details', { style: styles.advanced },
          h('summary', { style: styles.summary }, props.t('advanced.toggle')),
          h('div', { style: styles.advancedBody }, props.children),
        )
      }

      function SecretField(props) {        const state = props.state
        return h('div', { style: styles.field },
          h('label', { style: styles.label }, props.t('field.apiKey')),
          h('div', { style: styles.row },
            h('input', {
              style: { ...styles.input, flex: '1 1 auto' },
              type: 'password',
              value: state.apiKeyText,
              disabled: props.disabled || !state.apiKeyWritable,
              placeholder: props.t('apiKey.placeholderStored'),
              autoComplete: 'off',
              onChange: (event) => props.edit('apiKey', event.target.value),
            }),
            h('span', { style: styles.note }, state.apiKeyConfigured ? props.t('apiKey.configured') : props.t('apiKey.notConfigured')),
          ),
          h('span', { style: styles.note }, props.t('apiKey.noteStored')),
        )
      }

      function PerplexityCard(props) {
        const state = props.usePerplexityCard((snapshot) => snapshot)
        const [expanded, setExpanded] = useState(false)
        // The card's locale seat is supplied by the slot container; the English
        // dictionary keeps the card readable if this seam ever stops forwarding it.
        const t = typeof props.t === 'function' ? props.t : (key) => EN[key] ?? key
        const disabled = !state.available || !state.writable || state.saving
        const isSearchApi = state.searchProvider.text === 'perplexity-search'
        const configuredModel = state.model.text.includes('/')
          ? state.model.text
          : AGENT_DEFAULT_MODEL
        const modelState = state.model.text.includes('/')
          ? state.model
          : { ...state.model, text: AGENT_DEFAULT_MODEL }
        const summary = [
          isSearchApi ? 'perplexity-search' : 'agent',
          isSearchApi ? state.searchType.text || 'web' : state.preset.text || configuredModel,
          state.baseURL.text || 'https://api.perplexity.ai',
        ].join(' · ')

        return h('div', { style: expanded ? { ...styles.card, ...styles.cardOpen } : styles.card },
          h('button', {
            style: styles.header,
            'aria-expanded': expanded,
            onClick: () => setExpanded(!expanded),
          },
            h('div', { style: styles.headText },
              h('div', { style: styles.title }, t('card.title')),
              h('div', { style: styles.dim }, t('card.subtitle')),
              expanded ? null : h('div', { style: styles.note },
                summary + (state.dirty ? ` · ${t('card.unsaved')}` : ''),
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
            h(Field, { t, label: t('field.baseURL'), field: 'baseURL', state: state.baseURL, disabled, edit: props.edit }),
            h(SelectField, { t, label: t('field.searchProvider'), field: 'searchProvider', state: state.searchProvider, disabled, edit: props.edit, options: BACKEND_OPTIONS }),
            h(SecretField, { t, state, disabled, edit: props.edit }),
            // Essential tuning stays visible; everything an ordinary deployment
            // never touches lives behind one disclosure, so the card opens on
            // the choices that actually decide behaviour.
            isSearchApi
              ? h('div', null,
                h(SelectField, { t, label: t('field.searchType'), field: 'searchType', state: state.searchType, disabled, edit: props.edit, options: SEARCH_TYPE_OPTIONS }),
                h(SelectField, { t, label: t('field.searchRecency'), field: 'searchRecency', state: state.searchRecency, disabled, edit: props.edit, options: SEARCH_RECENCY_OPTIONS }),
                h(SelectField, { t, label: t('field.searchContextSize'), field: 'searchContextSize', state: state.searchContextSize, disabled, edit: props.edit, options: CONTEXT_SIZE_OPTIONS }),
                h('div', { style: styles.note }, t('note.searchContextSize')),
              )
              : h('div', null,
                h(SelectField, { t, label: t('field.preset'), field: 'preset', state: state.preset, disabled, edit: props.edit, options: PRESET_OPTIONS }),
                state.preset.text !== ''
                  ? h('div', { style: styles.note }, t('note.presetModel', { preset: state.preset.text }))
                  : h(SelectField, { t, label: t('field.model'), field: 'model', state: modelState, disabled, edit: props.edit, groups: agentModelGroups(t) }),
                h(SelectField, { t, label: t('field.searchRecency'), field: 'searchRecency', state: state.searchRecency, disabled, edit: props.edit, options: RECENCY_OPTIONS }),
                h(SelectField, { t, label: t('field.imageInput'), field: 'imageInput', state: state.imageInput, disabled, edit: props.edit, options: IMAGE_INPUT_OPTIONS }),
              ),
            h(AdvancedSection, { t },
              h('div', null,
                h('div', { style: styles.note }, t('note.advanced')),
                isSearchApi
                  ? h('div', null,
                    h(Field, { t, label: t('field.searchDomains'), field: 'searchDomains', state: state.searchDomains, disabled, edit: props.edit, placeholder: t('placeholder.commaList') }),
                    h('div', { style: styles.note }, t('note.searchDomains')),
                    h(Field, { t, label: t('field.searchLanguages'), field: 'searchLanguages', state: state.searchLanguages, disabled, edit: props.edit, placeholder: t('placeholder.commaList') }),
                    h('div', { style: styles.note }, t('note.searchLanguages')),
                    h(Field, { t, label: t('field.searchCountry'), field: 'searchCountry', state: state.searchCountry, disabled, edit: props.edit, placeholder: 'US' }),
                    h('div', { style: styles.note }, t('note.searchCountry')),
                    h(Field, { t, label: t('field.searchAfterDate'), field: 'searchAfterDate', state: state.searchAfterDate, disabled, edit: props.edit, placeholder: '3/1/2025' }),
                    h(Field, { t, label: t('field.searchBeforeDate'), field: 'searchBeforeDate', state: state.searchBeforeDate, disabled, edit: props.edit, placeholder: '3/31/2025' }),
                    h('div', { style: styles.note }, t('note.searchDate')),
                    h(Field, { t, label: t('field.searchMaxTokensPerPage'), field: 'searchMaxTokensPerPage', state: state.searchMaxTokensPerPage, disabled, edit: props.edit, placeholder: t('placeholder.optional') }),
                  )
                  : h('div', null,
                    h(Field, { t, label: t('field.maxTokens'), field: 'maxTokens', state: state.maxTokens, disabled, edit: props.edit, placeholder: t('placeholder.maxTokens') }),
                    h(Field, { t, label: t('field.softTimeoutMs'), field: 'softTimeoutMs', state: state.softTimeoutMs, disabled, edit: props.edit, placeholder: t('placeholder.presetDefault') }),
                    h('div', { style: styles.note }, t('note.softDeadline')),
                    h(SelectField, { t, label: t('field.fallbackPreset'), field: 'fallbackPreset', state: state.fallbackPreset, disabled, edit: props.edit, options: FALLBACK_PRESET_OPTIONS }),
                    state.imageInput.text !== 'off'
                      ? h('div', null,
                        h('div', { style: styles.note }, t('note.imageModelFollows')),
                        h(Field, { t, label: t('field.imageMaxBytes'), field: 'imageMaxBytes', state: state.imageMaxBytes, disabled, edit: props.edit, placeholder: t('placeholder.imageMaxBytes') }),
                        h(Field, { t, label: t('field.imageRoots'), field: 'imageRoots', state: state.imageRoots, disabled, edit: props.edit, placeholder: t('placeholder.imageRoots') }),
                        h('div', { style: styles.note }, t('note.imageInput')),
                        h('div', { style: styles.note }, t('note.imageRoots')),
                      )
                      : null,
                  ),
              ),
            ),
            h('div', { style: styles.row },
              h('button', {
                style: styles.buttonPrimary,
                disabled: disabled || !state.dirty || state.invalid,
                onClick: () => props.save(),
              }, state.saving ? t('action.saving') : t('action.save')),
              h('button', {
                style: styles.button,
                disabled: disabled || (!state.dirty && !state.failed),
                onClick: () => props.discard(),
              }, t('action.discard')),
              state.failed
                ? h('span', { style: styles.error },
                  state.lastError !== '' ? `${t('status.saveFailed')} ${state.lastError}` : t('status.saveFailed'))
                : null,
            ),
          ) : null,
        )
      }

      /**
       * Register this card's copy with the locale service.
       *
       * The card's `t` seat comes from being a locale-namespaced settings item, so
       * this registration is what makes the card follow the active language. A
       * missing locale service (or a registration failure) leaves the English
       * dictionary in place rather than breaking the card, so this never throws
       * into `apply`'s caller.
       * @param ctx - client context, whose `locale` service may be absent.
       */
      function registerDictionaries(ctx) {
        const locale = ctx.locale
        if (locale === undefined || typeof locale.register !== 'function') return
        const register = () => locale.register(NS, { zh: DICTS.zh, en: DICTS.en })
        if (typeof ctx.effect === 'function') ctx.effect(register, 'web-search-perplexity: dictionaries')
        else register()
      }

      function apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return

        try {
          registerDictionaries(ctx)
        } catch (error) {
          console.warn('[dsh-web-search-perplexity] locale dictionaries unavailable', error)
        }

        try {
          const scope = ctx.settingsScope.bind({ namespace: NS })
          const card = new PerplexityCardController(scope, ctx)
          ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
            name: 'settings.plugin.item',
            key: NS,
            // Binds this card to the NS dictionary registered above, which is how
            // the container supplies the `t` seat the card renders with.
            locale: NS,
            inject: () => card.inject(),
          }, PerplexityCard))
        } catch (error) {
          console.warn('[dsh-web-search-perplexity] settings card unavailable', error)
        }
      }

      exports.apply = apply
      exports.inject = ['slots', 'settingsScope', 'remote.credentials', 'locale']
    } catch (error) {
      console.warn('[dsh-web-search-perplexity] client init failed', error)
      exports.apply = function () {}
      exports.inject = []
    }
    return module.exports
  },
})
