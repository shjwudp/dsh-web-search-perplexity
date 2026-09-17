# Development

```bash
npm run check          # syntax-check the host, client, and generated skill module
npm test               # offline host tests, then the settings card's suites
npm run build:skill    # regenerate src/skill.js from the markdown skill source
npm run build:diagram  # regenerate the light and dark architecture SVGs
npm run sync:profile   # copy this working tree into every DSH profile that depends on it
```

`npm test` runs ten suites, all offline: every one stubs `globalThis.fetch` (or the
browser half's module loader) and none consumes API quota.

- `test/soft-deadline.test.mjs` loads the host module from this checkout when its
  `dsh-web` / `schemastery` peers resolve (a `node_modules` linked to a DSH install),
  and otherwise from an installed DSH profile copy. Set `PPLX_PLUGIN_ENTRY` to test a
  different built copy.
- `test/agent-model-failure.test.mjs` drives the shared Agent runner directly to pin
  the model-stage no-output failure class and its separation from the 429 and
  connection-failure paths.
- `test/package-metadata.test.mjs` pins `USER_AGENT` and the README's install tag to
  `package.json`, checks that every relative link and image reference in the docs
  resolves, and regenerates the two diagram variants to prove they are current. Each of
  those had drifted in practice before anything caught it.
- `test/client-locale.test.mjs` stubs `window.__ModuleLoader__` and drives the real
  browser half, checking that the `zh`/`en` dictionaries stay complete and that
  `apply` registers them.

## Installing this checkout into a profile while developing

A `file:` dependency is not reliably live. pnpm may hardlink the package into the
profile, in which case an in-place edit propagates — but an editor that writes by
replacing a file (temp file plus rename) breaks that link, and the installed copy then
silently goes stale. `pnpm add file:<repo>` does not help afterwards: once the
specifier and lockfile entry match, it is a no-op and does not refresh contents.

So after changing `src/`, run:

```bash
npm run sync:profile                 # every profile depending on this package
npm run sync:profile -- web          # one profile, by name or directory path
```

It copies the published file set into each profile's `node_modules`, then imports the
installed package the way DSH does and compares hashes, so a broken peer resolution or
a stale copy fails the command instead of surfacing at the next DSH start. Set
`DSH_PROFILES_DIR` to override the profile root (default `$DSH_HOME/profiles`, then
`~/.dsh/profiles`).

`link:` is not an alternative: a symlink makes the plugin resolve from this repository,
where `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web` cannot be found, and it
fails to load with `ERR_MODULE_NOT_FOUND`.

A change to `src/index.js` needs a DSH restart, because the host half is loaded per
process. `src/client.js` is re-served to the browser, so a reload is enough.

## Localization

The settings card follows the harness language setting. Its copy lives in the `DICTS`
object in `src/client.js` and is registered through
`ctx.locale.register('web-search-perplexity', { zh, en })`, which requires both shipped
locales to carry the same key set. Option values that are identifiers (preset names,
`day`/`month`, Agent API model ids) are deliberately not translated. The README, the
docs, and the embedded skill are English-only.

## The skill exists in two places

The embedded `perplexity-research` skill is authored as plain markdown at
`skills/perplexity-research/SKILL.md`. `src/skill.js` is generated from that file; edit
the markdown, then run `npm run build:skill` (also run automatically before
packing/publishing via `prepack`).

A deployment that also mounts `@deepseek-ai/dsh-skill-filesystem` serves whatever sits
under `$DSH_HOME/skills/`. Those are two independent copies of the same skill name, and
an edit lands in only one of them:

| Edited | Takes effect in |
|---|---|
| `skills/…/SKILL.md` + `npm run build:skill` | the plugin's embedded copy, after the host restarts |
| `$DSH_HOME/skills/perplexity-research/SKILL.md` | that filesystem copy, immediately (its watcher is on by default) |

A deployment that publishes the skill to `$DSH_HOME/skills/` therefore keeps serving
the published file however many times the repository copy is rebuilt, and the two drift
silently: a session can load instructions that no longer match the plugin. After
changing the markdown, publish it to both places:

```powershell
npm run build:skill
Copy-Item skills\perplexity-research\SKILL.md $env:USERPROFILE\.dsh\skills\perplexity-research\SKILL.md -Force
```

Skill bodies are read at load time and the filesystem provider watches its roots, so a
skill change needs no DSH restart either way — unlike the host half, which only loads at
process start.
