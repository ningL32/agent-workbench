# AGENTS.md — rules for anyone (human or AI) editing this repo

**fde-console / Super Workbench** is a local-first workbench plugin for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh): it turns the AI coding agents already running on your machine into an observable, accountable team.

Contract docs: functional spec [`docs/SPEC.md`](docs/SPEC.md) · plugin conformance [`docs/SPEC-PLUGIN.md`](docs/SPEC-PLUGIN.md) · storage [`docs/SPEC-STORAGE.md`](docs/SPEC-STORAGE.md) · install [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

If you are an AI assistant: read this file before your first edit, and follow it over your own defaults.

## 1. Architecture invariants

These are load-bearing. A change that violates one is rejected even if the tests pass.

1. **Zero third-party runtime dependencies.** `lib/` and `plugin/` use Node built-ins only. Adding a runtime `require`/`import` of an external package needs a prior discussion, not a drive-by commit.
2. **Engine floor: Node ≥ 22.13.** Six-source session observation relies on the built-in `node:sqlite`; on Node 18/20 the session reader has no fallback. Do not lower this claim in docs, and do not add compatibility shims for older Node.
3. **No build chain.** The frontend is a hand-written JS SPA — no framework, no TypeScript, no bundler. That is a deliberate trade-off: a build step is the most likely thing to break a self-hosted install. Edit `web/` and refresh; no compile step exists.
4. **Module shape.** `lib/` is CommonJS and is bridged into the ESM entry `plugin/index.mjs` via `createRequire`. The root `package.json` **must not** set `"type": "module"` — that reclassifies `lib/` as ESM and breaks it at load time.
5. **Storage.** Owned data lives in SQLite (`node:sqlite`, WAL); JSON is an export/interop format only. Writes are atomic (transaction for SQLite, tmp+rename for JSON). Runtime state lives in `<DSH_HOME>/fde-console/` and is **never** committed — see `.gitignore`.
6. **No credentials on disk.** Gitea/GitHub/Gitee tokens are read at runtime from `git config --global http.<baseUrl>/.extraheader` into memory only: never written to a file, never passed through a child process env, never logged. Everything that leaves the process goes through `lib/redact.js` first.
7. **Egress guard.** Every outbound URL passes `lib/ssrfGuard.js` (protocol allowlist, exact host allowlist, dangerous-literal rejection). A new data source must bring its hosts into the allowlist config.
8. **A failing source must leave a trace.** Adapters return `{ ok: false, detail }` plus per-source health (`lastError`, `lastScanAt`). No silent `catch` — a source that quietly disappears is a bug, not a graceful degradation.
9. **Personal cockpit, not a server.** One instance per person, data on that person's machine. Multi-user collaboration, shared hosted instances and centralised storage are out of scope by design.

## 2. Config contract

A new config section has to be registered in three places, or the runtime silently strips it at merge time:

1. `DEFAULT_CONFIG` in `lib/store.js`
2. `mergeConfigDefaults` in `lib/store.js` — an explicit key list, not a spread
3. `DEFAULTS` in `lib/giteaClient.js`

Changing a key that filters output (vocabularies, enums) also requires read-time normalisation: existing users' `config.json` files live outside the repo and will not migrate by themselves.

## 3. Development and tests

```bash
npm test                                        # node --test test/*.test.js — offline, must be green before you commit
dsh plugin --profile <profile> add <repo-path>   # install/update this repo as a DSH plugin
dsh --profile <profile> --port <port>            # start it (there is no `dsh web` subcommand)
```

- **Tests are the gate.** Full suite green, zero network: fixtures are synthetic (`GITEA_FIXTURE` / `DSH_FIXTURE`), and any test that writes files uses a temp directory — never a real user data directory.
- **Assertions target contracts, not just status codes** (a 200 with the wrong body is still a failure).
- One test case, one assertion theme. Arrange–act–assert. Tolerate Windows `EPERM` on temp cleanup.
- Do not build fixtures with `node:sqlite` write hooks; inject dependencies instead.

## 4. Documentation is part of the change

- New/changed functional behaviour → update the changelog header of `docs/SPEC.md`.
- Install/environment changes → update `docs/DISTRIBUTION.md` (its version must match `package.json`).
- Changes to the plugin manifest surface (`package.json` `dsh` field, `icon`, title/description) → update `meta.title` / `meta.description` in `locale/en.json` and `locale/zh.json`.
- User-visible strings come from the `ctx.get('locale')` namespace dictionaries, never literals in client code.

## 5. Commits and review

- Keep `npm test` green in every commit you push.
- Prefer explicit `git add <paths>` over `git add -A`.
- Substantive changes to `lib/` contracts, the data model, a new session-source adapter, or `plugin/` / `cordis.patch.yml` deserve an issue or discussion first — they ripple across every consumer of the workbench.
- AI-authored commits can self-attach to a task with a `task/<id>` branch, a `[#<id>]` marker in the message, or by binding the task to a project directory; see [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md).

## 6. License

MIT. By contributing you agree that your contribution is released under the same license.
