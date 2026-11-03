# Contributing

Thanks for looking at **fde-console / Super Workbench** — a local-first workbench plugin for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) that makes the AI coding agents already running on your machine observable and accountable.

Issues and pull requests are welcome. Bug reports with a reproduction are worth more than feature requests with a specification, but both are read.

## Before you write code

Read [`AGENTS.md`](AGENTS.md). It states the architecture invariants this project will not trade away — zero third-party runtime dependencies, no build chain, the Node ≥ 22.13 floor, the CommonJS/ESM bridge — plus the config and documentation contracts. A pull request that breaks one of those is declined even with green tests.

## Prerequisites

| | |
|---|---|
| Node.js | **≥ 22.13** (built-in `node:sqlite`; Node 18/20 have no fallback for the session reader) |
| DSH | `@deepseek-ai/dsh` 0.2.1-rc.2 |
| pnpm | on `PATH` (plugin installation forwards to it) |

## Local development

```bash
git clone https://github.com/ningL32/agent-workbench.git
cd agent-workbench

npm test                                        # the gate: node --test, offline, 500+ cases
dsh plugin --profile dev add "$PWD"             # install this checkout as a plugin
dsh --profile dev --port 38082                  # start it; open the printed ?token= URL
```

- Frontend changes (`web/`) take effect on page refresh — there is no build step.
- Backend changes (`lib/`, `plugin/`) require restarting the DSH instance.
- Runtime data lives in `<DSH_HOME|~/.dsh>/fde-console/`, outside the repository. Nothing in `data/`, `config.json`, `agents.json` or `members.json` is versioned — that is deliberate, because `config.json` can hold downstream webhook tokens.

## Repository map

| Path | Contents |
|---|---|
| `plugin/` | DSH plugin entry (ESM) and client bundle |
| `lib/` | Backend logic in CommonJS — adapters, storage, attribution, reports |
| `web/` | The SPA: hand-written JS, CSS, no framework, no bundler |
| `scripts/` | Migration, backup, demo seed, MCP server (stdio) |
| `docs/` | Contract documents; `SPEC.md` is the functional source of truth |
| `test/` | `node --test` suites plus `helpers/appAssembler.js` |

## Tests

- `npm test` must be green before you push. Zero network: fixtures are synthetic and injected via `GITEA_FIXTURE` / `DSH_FIXTURE`.
- Never point a test or script at a real user data directory — use a temp directory.
- Assert on the response contract, not only the status code.
- One test case, one assertion theme; arrange–act–assert.

## Pull requests

1. Keep the change focused; unrelated refactors go in their own PR.
2. Add or update tests for behaviour changes.
3. Sync the docs the change touches: `docs/SPEC.md` (functional), `docs/DISTRIBUTION.md` (install/env), `locale/en.json` + `locale/zh.json` (manifest surface).
4. For changes to a `lib/` contract, the data model, a new session-source adapter, or `plugin/` / `cordis.patch.yml`, open an issue first — those ripple across every consumer.
5. `npm test` green, CI green, then request review.

Commits authored by an AI agent can self-attach to a task with a `task/<id>` branch, a `[#<id>]` marker in the message, or by binding the task to a project directory — see [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md).

## Security

Please do not open a public issue for a vulnerability. Use GitHub's [private vulnerability reporting](https://github.com/ningL32/agent-workbench/security/advisories/new).

## License

MIT. By contributing you agree your contribution is released under the same license.
