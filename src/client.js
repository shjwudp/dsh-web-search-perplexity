/**
 * Browser half of @shjwudp/dsh-web-search-perplexity.
 *
 * Adds one read-only UI surface: a "Perplexity web search" card in
 * Settings → Plugins → Plugin configuration (keyed by the
 * `web-search-perplexity` settings namespace).
 *
 * Defensive: if the slot is unavailable in a given deployment, the card is
 * skipped rather than breaking the client.
 */

window.__ModuleLoader__.load({
  id: '@shjwudp/dsh-web-search-perplexity',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    try {
      const { createElement: h } = require('react')

      const cardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
        fontSize: 13,
        lineHeight: 1.5,
      }

      const cardTitle = {
        fontWeight: 700,
      }

      const dim = {
        opacity: 0.62,
      }

      function PerplexitySettingsCard() {
        return h('div', { style: cardStyle },
          h('div', { style: cardTitle }, 'Perplexity web search'),
          h('div', { style: dim }, 'Standalone Perplexity provider for ctx.web (id: perplexity).'),
          h('div', null, 'Endpoint: https://api.perplexity.ai'),
          h('div', null, 'API key: read from the PERPLEXITY_API_KEY environment variable.'),
          h('div', { style: dim }, 'Active when web.searchProvider is "perplexity".'),
        )
      }

      function apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return

        try {
          ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'web-search-perplexity',
            inject: () => ({}),
          }, PerplexitySettingsCard))
        } catch (error) {
          console.warn('[dsh-web-search-perplexity] settings card unavailable', error)
        }
      }

      exports.apply = apply
      exports.inject = ['slots']
    } catch (error) {
      console.warn('[dsh-web-search-perplexity] client init failed', error)
      exports.apply = function () {}
      exports.inject = []
    }
    return module.exports
  },
})
