# Development

```sh
npm run check
npm run build
npm run smoke:jev
npm run smoke:opencode
```

`npm ci` installs the local pre-commit hook through [Lefthook](https://lefthook.dev/usage/commands/install/).
The hook is configured in `lefthook.yml`. On each commit,
`lint-staged` formats staged TypeScript, JavaScript, JSON, Markdown, and YAML,
then runs ESLint on staged code. Fixable changes are included in the commit;
remaining lint errors block it. Partially staged files retain their unstaged edits.

```sh
npm run lint          # Check the repo with ESLint
npm run lint:fix      # Apply safe lint fixes
npm run format       # Format the repo with Prettier
npm run format:check # Check formatting without changing files
npm run check        # Lint, formatting, typecheck, and tests
```

The root `tsconfig.json` loads Node types and checks source, tests, and TypeScript
scripts. `tsconfig.build.json` emits only `src/` into `dist/`.

The hook does not run models, tests, or provider requests. Run `npm run check`
before submitting changes. ESLint checks TypeScript syntax throughout the repo
and adds type-aware promise checks for `src/`. Explicit `any` remains permitted
for existing dynamic schemas, legacy migrations, and host mocks.

Unit tests use deterministic external-service mocks, including dispatch failure,
restart reconciliation, migration, cancellation, and oversized output regressions.
Seeded property tests generate output merges, event traces, and dependency graphs. The OpenCode smoke test
uses real models and Jev in disposable projects: a non-software workflow with
an injected one-time failure, the default software workflow, and human
pause/resume across a host restart. It consumes provider resources; set
`FOREMAN_SMOKE_MODEL` to an available model if needed. Results and redacted
transcripts are retained under the printed temporary directory and `artifacts/`.

The core keeps workflow transitions (`src/core/runtime/engine.ts`) separate from the controller’s network and filesystem work,
compiles and caches validated workflow contracts, and shares graph semantics
between the runtime and checker. Persisted state has one discriminated phase
and one producer-scoped output store.

## Repository layout

```text
src/
  core/
    workflow/       YAML loading, schema, compiler, graph, and checker
    runtime/        Workflow transitions, controller, decisions, and outputs
    persistence/    Durable state store, validation, and migrations
    types.ts        Shared host-independent contracts
    models.ts       Model reference parsing
    security.ts     Credential redaction
  jev/              Jev transport and usage accounting
  opencode/         OpenCode configuration and plugin hooks
  workflows/        Bundled Foreman engineering YAML
scripts/
  build/            Clean output and copy workflow assets
  cli/              Workflow checker and usage reporting
  smoke/            Live Jev and OpenCode smoke tests
  install.mjs       Local OpenCode plugin installer
tests/
  core/             Workflow, runtime, and persistence tests
  jev/              Transport, retries, and accounting tests
  opencode/         Plugin hooks and host recovery tests
  support/          Shared fixtures
docs/
  architecture/     Runtime design and integration overview
  workflows.md      Workflow authoring contract
```

See the [architecture overview](architecture/overview.md) and
[runtime design](architecture/runtime.md).
