# Contributing to Soroban Smart Block Explorer

Thanks for helping make Soroban contract activity readable. This guide covers the
workflow, conventions, and quality gates enforced by CI.

For background, read the [developer documentation](docs/site/index.html) and the
[architecture deep dive](docs/guides/architecture-deep-dive.md).

## Getting set up

### Option A — GitHub Codespaces / VS Code Dev Container (recommended)

The repo ships a fully configured dev container that provides Rust, Node 20,
`wasm32-unknown-unknown`, and PostgreSQL with no local installation required.

1. Open the repo in GitHub Codespaces **or** VS Code with the
   [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
   extension and choose **Reopen in Container**.
2. The `postCreateCommand` automatically installs all dependencies and fetches
   Cargo crates. Wait for it to finish (visible in the terminal panel).
3. Copy `.env.example` to `.env` if it wasn't copied automatically:
   ```bash
   cp .env.example .env
   ```
4. Start the full stack:
   ```bash
   make dev
   ```
   Frontend: http://localhost:5173 · API: http://localhost:3001

### Option B — Local setup

1. Fork the repository and clone your fork.
2. Follow [Getting started](docs/guides/getting-started.md) to run the stack.
3. Install dependencies for the package you are changing
   (`indexer/` or `frontend/`) with `npm install`.

## Branch naming convention

CI validates branch names against this pattern:

```
<type>/<short-description>
```

Allowed types: `feature`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
`hotfix`, `release`.

Examples: `feature/event-search`, `fix/ws-reconnect`, `docs/api-reference`.

## Branch protection rules for `main`

The `main` branch is protected to keep CI green and maintain review quality.
Required settings:

- Require pull request reviews before merge
- Require status checks to pass before merge:
  - `Test`
  - `Build`
  - `Security`
- Disallow force pushes to `main`
- Enforce administrators

Maintainers can apply these settings manually in GitHub branch protection
configuration, or run the repository helper:

```bash
GITHUB_TOKEN=$GH_TOKEN npm run configure-branch-protection
```

This helper uses the GitHub API to configure protection for `main`.

## Commit and PR title conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/).
The pull request title is checked by CI and must use the form:

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`. Examples:

```
feat(indexer): decode SEP-41 burn events
fix(frontend): handle empty wallet history
docs(api): add try-it console
```

Reference the issue your work closes in the PR description, for example
`Closes #202`.

## Quality gates (run before pushing)

CI runs the following. Reproduce them locally to avoid a red build:

```bash
# Rust workspace (run from repo root)
cargo fmt --check
cargo clippy
cargo test -p soroban-explorer-contract

# Indexer
cd indexer && npx eslint --max-warnings 0 src/ && npm test

# Frontend
cd frontend && npx eslint --max-warnings 0 src/ && npm run build

# Formatting (run from repo root)
npx prettier --check "indexer/src/**/*.{js,json}" "frontend/src/**/*.{ts,tsx}" "**/*.md"
```

## Pull request checklist

- [ ] Branch name follows the convention.
- [ ] PR title follows Conventional Commits.
- [ ] Rust: `cargo fmt --check`, `cargo clippy`, `cargo test` pass.
- [ ] Indexer: `eslint` zero warnings and `npm test` pass.
- [ ] Frontend: `eslint` zero warnings and `npm run build` pass.
- [ ] Prettier formatting passes.
- [ ] OpenAPI specification (`docs/api/openapi.yaml`) is updated and in sync with any endpoint changes.
- [ ] Documentation is updated for user-facing or API changes.
- [ ] The PR description explains the change and links the issue it closes.
- [ ] No secrets or `.env` values are committed.

## Code review standards

Keep pull requests focused on a single concern. Reviewers look for correctness,
test coverage, readability, and consistency with the surrounding code. Respond to
comments with follow-up commits rather than force-pushing over an in-progress
review.

## Contribution scoring

To recognize ongoing contribution, the project uses a transparent points rubric.
Points are tallied from merged activity and can drive a leaderboard and badges
(see the project board for the live tally).

| Action                 | Points |
| ---------------------- | ------ |
| PR merged              | +50    |
| Documentation improved | +30    |
| Review given           | +20    |
| Issue filed            | +10    |

### Levels

| Level    | Points  |
| -------- | ------- |
| Bronze   | 0–99    |
| Silver   | 100–299 |
| Gold     | 300–699 |
| Platinum | 700+    |

### Badges

- **First PR** — your first merged pull request.
- **Documentation Hero** — sustained documentation contributions.
- **Bug Hunter** — multiple confirmed bug fixes.

> The rubric is the source of truth for scoring. Automated tallying and the public
> leaderboard are tracked separately on the project board.

## Reporting issues

Open issues on the
[upstream repository](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/issues)
with reproduction steps, expected versus actual behavior, and environment details.
