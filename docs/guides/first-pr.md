# Your First Pull Request

> **Audience:** New contributors who want to make their first contribution to
> the Soroban Smart Block Explorer.
> **Goal:** Go from zero to an opened pull request using only this guide — no
> Discord or Slack questions needed.

---

## Table of Contents

1. [Fork and Clone the Repository](#1-fork-and-clone-the-repository)
2. [Set Up Your Development Environment](#2-set-up-your-development-environment)
3. [Find a Good First Issue](#3-find-a-good-first-issue)
4. [Create a Branch](#4-create-a-branch)
5. [Make Your Changes](#5-make-your-changes)
6. [Run Quality Checks](#6-run-quality-checks)
7. [Commit Your Changes](#7-commit-your-changes)
8. [Push and Open a Pull Request](#8-push-and-open-a-pull-request)
9. [After You Open Your PR](#9-after-you-open-your-pr)

---

## 1. Fork and Clone the Repository

### Fork on GitHub

1. Go to [github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block).
2. Click the **Fork** button in the top-right corner.
3. Wait for GitHub to create your fork (usually < 30 seconds).

### Clone your fork locally

```bash
git clone https://github.com/<YOUR_USERNAME>/Soroban-Smart-Block.git
cd Soroban-Smart-Block
```

### Add the upstream remote

```bash
git remote add upstream https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block.git
```

Verify your remotes:

```bash
git remote -v
# origin    https://github.com/<YOUR_USERNAME>/Soroban-Smart-Block.git (fetch)
# origin    https://github.com/<YOUR_USERNAME>/Soroban-Smart-Block.git (push)
# upstream  https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block.git (fetch)
# upstream  https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block.git (push)
```

---

## 2. Set Up Your Development Environment

You have two options. Choose whichever you prefer.

### Option A — Dev Container (recommended)

This provides Rust, Node 20, `wasm32-unknown-unknown`, and PostgreSQL with no
local installation required.

1. Open the repo in **GitHub Codespaces** (click the green **Code** button →
   **Codespaces** tab → **Create codespace on main**) **OR** in **VS Code**
   with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
   and choose **Reopen in Container**.
2. Wait for the `postCreateCommand` to finish (visible in the terminal panel).
   This installs all dependencies and fetches Cargo crates.
3. Copy `.env.example` to `.env`:
   ```bash
   cp -n .env.example .env
   ```
4. Start the full stack:
   ```bash
   make dev
   ```
   Frontend runs at `http://localhost:5173` · API at `http://localhost:3001`.

### Option B — Local Setup

You need **Node.js 20+**, **Rust** (with `wasm32-unknown-unknown` target), and
**PostgreSQL 16+**.

1. Install dependencies for the package you are changing:
   ```bash
   # Root dependencies
   npm install

   # Indexer (if touching indexer/)
   cd indexer && npm install

   # Frontend (if touching frontend/)
   cd frontend && npm install
   ```
2. Copy `.env.example` to `.env` and update the `DATABASE_URL` if needed.
3. Start the stack:
   ```bash
   make dev
   ```

---

## 3. Find a Good First Issue

Look for issues labeled **good first issue** on the
[issue tracker](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

These issues are scoped to be approachable for new contributors. Common types:

| Label | What it means |
|-------|---------------|
| `good first issue` | Small, well-defined task suitable for newcomers |
| `documentation` | Writing or improving docs (no code changes) |
| `bug` | Something broken that needs a fix |
| `enhancement` | A new feature or improvement |

If you are unsure which issue to pick, open a
[Discussion](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/discussions)
and ask — maintainers are happy to suggest a good starting point.

---

## 4. Create a Branch

Branch names must follow this convention (enforced by CI):

```
<type>/<short-description>
```

Allowed types: `feature`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
`hotfix`, `release`.

```bash
# Sync your local main with upstream
git fetch upstream
git checkout main
git merge upstream/main

# Create your branch
git checkout -b docs/update-readme
```

**Examples of valid branch names:**

| Branch | Purpose |
|--------|---------|
| `docs/update-readme` | Documentation improvements |
| `fix/ws-reconnect` | Bug fix for WebSocket reconnection |
| `feature/event-search` | New feature for event search |
| `test/decoder-edge-cases` | Adding test coverage |

---

## 5. Make Your Changes

### Project structure reminder

```
contracts/          Smart contracts (Rust / Soroban SDK)
  explorer/         ABI registry contract
  ticket/           Sample ticket contract (testing)

indexer/            Node.js indexer — API server + event processor
  src/              Source code
    api.js          Express HTTP server (all routes)
    decoder.js      Event decoder pipeline
    db.js           Database module (single file — do not split)
  migrations/       SQL migration files
  test/             Unit tests (node:test)

frontend/           React + TypeScript (Vite)
  src/
    pages/          One file per route (must add <Route> in App.tsx)
    components/     Shared React components
    hooks/          Custom React hooks
    services/       API client helpers

docs/               Documentation
  guides/           Developer guides (Markdown)
  api/              OpenAPI spec + playground HTML
```

### Architecture rules to preserve

- **`indexer/src/db.js`** is the single database module. Do not create a `db/`
  subdirectory or split it.
- **`indexer/src/api.js`** owns all HTTP route definitions. The only exception
  is `indexer/src/routes/admin.js`. Do not add more files to `routes/`.
- Every new page in `frontend/src/pages/` must have a corresponding `<Route>`
  in `frontend/src/App.tsx`.
- SQL changes belong in a new numbered migration file under `indexer/migrations/`.

---

## 6. Run Quality Checks

Run these **before** committing to avoid a red CI build. Only run checks for
the layer you changed.

### Rust contracts (required if touching `contracts/`)

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo build --target wasm32-unknown-unknown --release -p soroban-explorer-contract
cargo test -p soroban-explorer-contract
cd contracts/ticket && cargo test --features testutils --release
```

### Indexer (required if touching `indexer/`)

```bash
cd indexer
npx eslint --max-warnings 0 src/
npm test
```

### Frontend (required if touching `frontend/`)

```bash
cd frontend
npx eslint --max-warnings 0 src/
npm run build   # also runs tsc for type checking
```

### Formatting (run from repo root)

```bash
npx prettier --check "indexer/src/**/*.{js,json}" "frontend/src/**/*.{ts,tsx}" "**/*.md"
```

### API documentation (if you changed endpoints)

```bash
npx -y @redocly/cli lint docs/api/openapi.yaml --format=stylish
npm run generate:postman && git diff --exit-code docs/api/postman_collection.json
```

> **Tip:** The `.husky/pre-push` hook runs the contract checks automatically
> when you `git push`.

---

## 7. Commit Your Changes

This project follows [Conventional Commits](https://www.conventionalcommits.org/).
Your commit message (and PR title) must use this format:

```
<type>(<optional scope>): <description>
```

**Common types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`.

**Examples:**

```
docs(guide): add rate-limit tier upgrade documentation
fix(frontend): handle empty wallet history gracefully
feat(decoder): add Blend lending protocol decoder
test(indexer): add edge cases for decoder fallback
```

### Stage and commit

```bash
# Stage specific files (preferred)
git add docs/guides/rate-limit-tiers.md

# Or stage all changed files
git add .

# Commit with a descriptive message
git commit -m "docs(guide): add rate-limit tier upgrade documentation

- Document all four tiers (unauthenticated, free, pro, enterprise)
- Include RPM, burst, concurrent, and daily limits per tier
- Explain the upgrade path from unauthenticated to enterprise
- Add monitoring tips and FAQ section

Closes #783"
```

### What NOT to commit

- `.env` files (use `.env.example` as the template)
- `node_modules/` or `target/` directories (gitignored)
- `.kiro/`, `update_issues/`, or similar AI-agent scratch directories
- Generated `dist/` or `build/` directories

---

## 8. Push and Open a Pull Request

### Push your branch

```bash
git push origin docs/update-readme
```

If this is your first push, Git may prompt you to set the upstream:

```bash
git push -u origin docs/update-readme
```

### Open the PR on GitHub

1. Go to your fork on GitHub. You should see a yellow banner: **"Compare &
   pull request"** — click it.
2. Set the **base repository** to `Soroban-Smart-Block-Explorer/Soroban-Smart-Block`
   and **base** to `main`.
3. Set the **head repository** to your fork and **compare** to your branch.
4. Fill in the PR template:

**Title** (must follow Conventional Commits):

```
docs(guide): add rate-limit tier upgrade documentation
```

**Description** (include):

```markdown
## What

- Briefly describe what this PR does.

## Why

- Explain why this change is needed (link the issue).

## How

- Describe how the change works (implementation details).

## Testing

- How did you verify the changes work?

## Checklist

- [ ] Branch name follows `<type>/<description>` convention
- [ ] PR title follows Conventional Commits
- [ ] Relevant quality checks pass (see AGENTS.md)
- [ ] Documentation is updated (if applicable)
- [ ] No secrets or `.env` values are committed

Closes #783
```

5. Click **Create pull request**.

---

## 9. After You Open Your PR

### CI checks

GitHub Actions will automatically run the quality gates defined in
`.github/workflows/ci.yml`:

| Check | What it does |
|-------|-------------|
| **Test** | Runs Rust contract tests, indexer tests, and frontend build |
| **Build** | Builds the Rust WASM contract and Docker images |
| **Security** | Runs Trivy vulnerability scan |

If any check fails, see the [Troubleshooting](#troubleshooting) section below.

### Code review

A maintainer will review your PR. Common feedback:

- **"Please address the review comment"** — Push a follow-up commit to the
  same branch. Do not force-push during review.
- **"LGTM"** — Your PR is approved and will be merged.

### Responding to review feedback

```bash
# Make the requested changes
# ...

# Commit the follow-up
git add .
git commit -m "docs: address review feedback"

# Push to the same branch
git push origin docs/update-readme
```

The PR will automatically update with your new commit.

### Merging

Once approved and all CI checks pass, a maintainer will merge your PR. You
will receive a GitHub notification.

**Congratulations — you are now a contributor! 🎉**

---

## Troubleshooting

### CI check failed

Click the **Details** link next to the failing check in the PR to see the
full log. Common issues:

| Failure | Fix |
|---------|-----|
| `Branch name does not follow the naming convention` | Rename your branch to `<type>/<description>` |
| `cargo clippy` warnings | Fix the warnings listed in the log |
| `eslint` errors | Fix the lint errors in your code |
| `prettier` check failed | Run `npx prettier --write .` to auto-format |
| `npm run build` failed in frontend | Check TypeScript errors in the log |

### Merge conflicts

If your branch has conflicts with `main`:

```bash
git fetch upstream
git checkout docs/update-readme
git merge upstream/main
# Fix conflicts in your editor
git add .
git commit -m "chore: resolve merge conflicts with main"
git push origin docs/update-readme
```

### My PR was closed without merging

Don't worry! PRs are sometimes closed if they are out of scope or duplicated.
Maintainers will leave a comment explaining why. You can always open a new PR
with revised changes.

---

## Quick Reference

| Step | Command / Action |
|------|-----------------|
| Fork | Click **Fork** on GitHub |
| Clone | `git clone https://github.com/<YOU>/Soroban-Smart-Block.git` |
| Upstream | `git remote add upstream <REPO_URL>` |
| Branch | `git checkout -b docs/my-change` |
| Check (contracts) | `cargo fmt --check && cargo clippy -- -D warnings && cargo test -p soroban-explorer-contract` |
| Check (indexer) | `cd indexer && npx eslint --max-warnings 0 src/ && npm test` |
| Check (frontend) | `cd frontend && npm run build` |
| Format | `npx prettier --check "**/*.md"` |
| Commit | `git commit -m "docs(scope): description"` |
| Push | `git push -u origin docs/my-change` |
| Open PR | Set base to upstream `main`, reference the issue |

---

## Further Reading

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — Full contribution guidelines
- [AGENTS.md](../../AGENTS.md) — Architecture rules and verification commands
- [Decoder Guide](./adding-a-decoder.md) — How to write a protocol decoder
- [Architecture Deep Dive](./architecture-deep-dive.md) — System architecture
- [Rate-Limit Tiers](./rate-limit-tiers.md) — API tier limits and upgrade path
