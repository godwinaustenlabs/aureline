# Aureline

Autonomous textile design intelligence.

Aureline turns a textile design concept, something like "art deco paisley with fine linework", into a production ready design. It does that with **engines**: small, independently deployable Cloudflare Workers that each own one part of the problem.

One engine exists today. **`agent-helios`** is the Pattern Engine. It runs a two model pipeline: a planner model distills a concept into structured pattern parameters, and an image model renders those parameters faithfully. Helios produces **black and white patterns only**, with no colour parameter of any kind, because colour is entirely the responsibility of Iris, the future Chromatic Engine.

Everything beyond Helios (orchestration, an API gateway) is deliberately deferred. [architecture.md](docs/architecture.md) says what and why.

## Documentation

Start with [docs/](docs/). The six files there describe the engine shape in general, using Helios as the worked example, because `agent-helios` is the template every future engine copies.

| Doc | The question it answers |
|---|---|
| [architecture.md](docs/architecture.md) | How does an engine work, and why is it built this way? |
| [spec.md](docs/spec.md) | What is the stack, and which exact object does each job? |
| [database.md](docs/database.md) | How is data stored, in which store, and for how long? |
| [flows.md](docs/flows.md) | What happens between a request arriving and a response going out? |
| [directory-structure.md](docs/directory-structure.md) | What is in each file, and why does it exist? |
| [running-locally.md](docs/running-locally.md) | How do I run it, and how do I know it works? |

[AGENTS.md](AGENTS.md) sits at the repo root rather than in `docs/`, because it is rules rather than explanation: the conventions everyone writing code here follows, human or agent. Read it before your first change.

Two other kinds of doc live there. [docs/adr/](docs/adr/) holds the Architecture Decision Records, which are the *why* behind individual decisions. **Read them before changing architecture**, because several apply repo-wide rather than to Helios alone. [docs/helios-runs-conventions.md](docs/helios-runs-conventions.md) is for writing queries against the audit table.

## Repo layout

```
aureline/
├── apps/                  Independently deployable Cloudflare Workers
│   └── agent-helios/      The one engine that exists today
├── packages/              Shared, non-deployable code, symlinked by npm workspaces
│   ├── shared-types/      Zod schemas and the types inferred from them
│   └── shared-utils/      Model-calling helpers (text, image, AI Gateway)
├── infrastructure/        Cloudflare resource definitions
│   └── d1/migrations/     Generated D1 migrations for the audit table
├── docs/                  Documentation and ADRs
├── tests/                 Scratch harnesses, not the test suite
├── .scratch/              Sprint tickets as markdown
├── package.json           npm workspaces root (apps/*, packages/*)
├── LICENSE                Apache 2.0
└── README.md              This file
```

Plain npm workspaces. There is no `tsconfig.base.json`, no `turbo.json` and no `.github/` yet, and deploys are manual.

## Quickstart

```bash
npm install                                   # from the repo root
npm test                                      # 101 tests, no model calls, free
cd apps/agent-helios && npx tsc --noEmit      # typecheck
npm run dev                                   # http://localhost:8787
```

```bash
curl localhost:8787/
# Helios Agent is running
```

Two things to know before you go further:

- **`wrangler dev` bills your real Cloudflare account.** Everything else is simulated locally, but the `AI` binding has no simulator, so `POST /generate` makes a real billed model call on localhost exactly as in production. About $0.0029 a run. Never put one in a loop.
- **Run `npx tsc --noEmit` from inside `apps/agent-helios`**, not the repo root, where `npx` resolves a TypeScript version that rejects this project's module resolution.

Full setup, the scripts, and a runbook for proving it works: [running-locally.md](docs/running-locally.md).

## Status

| | |
|---|---|
| Helios pipeline, planner and image, end to end | Built |
| DO-local persistence, D1 export, retention pruning | Built |
| R2 image storage and serving | Built |
| Failure handling and manual resume | Built |
| Runtime config from KV | Built |
| Playground UI | Not started |
| Iris, Atlas, Athena, and the rest | Not started |

## License

Apache 2.0. See [LICENSE](LICENSE).