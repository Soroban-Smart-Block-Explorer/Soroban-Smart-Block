# Local Development Troubleshooting Guide

When setting up or running the Soroban Smart Block Explorer locally, you may encounter environment or dependency issues that prevent the project from starting. This guide walks you through diagnosing and fixing common problems using the built-in **environment doctor** tool.

## Quick Diagnostics: Run the Doctor

Before diving into individual fixes, run the environment diagnostic tool:

```bash
npm run doctor
```

This script (located at `scripts/doctor.js`) performs automated checks on your development environment and reports any issues it finds. The output is color-coded:

- **✓ Green** — Check passed
- **⚠ Yellow** — Warning (feature may not work, but not critical)
- **✗ Red** — Check failed (must be fixed before proceeding)

**Example output:**

```
🩺  Soroban Explorer Environment Doctor

─ Runtimes ───────────────────────────
  ✓ NODE: Node.js 20+ detected
  ✗ RUST: Rust compiler (rustc) not found. Install from https://rustup.rs/
  ✓ NPM: npm 10+ detected

─ Database Connection ────────────────
  ✗ Failed to connect to PostgreSQL: connect ECONNREFUSED 127.0.0.1:5432

─ Environment Variables ───────────────
  ⚠ SOROBAN_RPC_URL: Not set
  ✗ DATABASE_URL: Not set

─ Service Ports ───────────────────────
  ✓ Port 5173: available
  ✗ Port 5432: free (PostgreSQL is likely NOT running!)

─ System Metrics ──────────────────────
  ✓ Disk: 150.45 GB disk space free (required > 1 GB)
  ✓ Memory: 16.0 GB total memory, 8.23 GB free (required > 2 GB)

─ Git Hooks ───────────────────────────
  ⚠ Missing Git hooks: pre-commit, pre-push

─ Docker Infrastructure ───────────────
  ✓ Docker & Compose detected

❌ Doctor found issues in your environment. Fix them before running the project.
```

## Failure Modes and Fixes

### Node.js version is too old

**Doctor output:**
```
✗ NODE: Node.js 20+ required
```

**Fix:**

```bash
# Check your current version
node --version

# Option 1: Using nvm (recommended for development)
nvm install 20
nvm use 20
node --version  # Should now show v20.x.x

# Option 2: Using Homebrew (macOS)
brew install node@20
# Then link it as the default
brew unlink node
brew link node@20

# Option 3: Direct download
# Visit https://nodejs.org/ and install Node.js 20 LTS
```

### Rust or wasm32 target missing

**Doctor output:**
```
✗ RUST: Rust compiler (rustc) not found
✗ WASM32: wasm32-unknown-unknown target missing
```

**Fix:**

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add wasm32 target for Soroban contract compilation
rustup target add wasm32-unknown-unknown

# Verify
rustc --version
rustup target list --installed | grep wasm32
```

### PostgreSQL not running

**Doctor output:**
```
✗ Port 5432: free (PostgreSQL is likely NOT running!)
✗ Failed to connect to PostgreSQL: connect ECONNREFUSED 127.0.0.1:5432
✗ DATABASE_URL: Not set
```

**Fix:**

Choose one approach based on your setup:

**Option 1: Docker Compose (recommended)**

```bash
# Start PostgreSQL via Docker Compose (from repo root)
docker compose up postgres -d

# Verify it's running
docker compose ps
# Should show: postgres ... Up ...

# Check port 5432 is listening
nc -zv localhost 5432
# Should return: Connection to localhost port 5432 [tcp/postgresql] succeeded!
```

**Option 2: Local PostgreSQL (macOS with Homebrew)**

```bash
# Install PostgreSQL
brew install postgresql@15

# Start the service
brew services start postgresql@15

# Verify
psql --version
# Should return: psql (PostgreSQL) 15.x
```

**Option 3: Local PostgreSQL (Linux — Debian/Ubuntu)**

```bash
# Install PostgreSQL
sudo apt update
sudo apt install -y postgresql postgresql-contrib

# Start the service
sudo systemctl start postgresql
sudo systemctl status postgresql

# Verify
psql --version
```

**After PostgreSQL is running:**

Set your `DATABASE_URL` environment variable if not already set:

```bash
# In your .env file (repo root)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/soroban_explorer
```

Then test the connection:

```bash
npm run doctor
# DATABASE_URL should now show "✓ Successfully connected to PostgreSQL"
```

### Database migrations not applied

**Error when starting the indexer:**
```
Error: relation "api_keys" does not exist
```

**Fix:**

Run the database migrations:

```bash
# From the repo root
cd indexer

# Ensure DATABASE_URL is set
echo $DATABASE_URL

# Run migrations (creates schema, tables, partitions)
npm run migrate

# Verify migrations completed
# Should see: ✓ Migration 001_initial_schema.js
# Should see: ✓ Migration 002_api_keys_table.js
# ... etc
```

### PORT 3001 already in use (indexer API)

**Error:**
```
Error: listen EADDRINUSE :::3001
```

**Fix:**

```bash
# Find what's using port 3001
lsof -i :3001
# or on Linux: sudo netstat -tulpn | grep 3001

# Option 1: Kill the process
kill -9 <PID>

# Option 2: Use a different port
export PORT=3002
npm start

# Option 3: Wait for the process to finish naturally
# (if it's a prior indexer instance still shutting down)
```

### PORT 5173 already in use (frontend dev server)

**Error:**
```
VITE_PORT:5173 is already in use
```

**Fix:**

```bash
# Find what's using port 5173
lsof -i :5173

# Option 1: Kill the process
kill -9 <PID>

# Option 2: Use a different port
# In frontend/.env:
VITE_PORT=5174

cd frontend && npm run dev
```

### Missing environment variables

**Doctor output:**
```
✗ DATABASE_URL: Not set
⚠ SOROBAN_RPC_URL: Not set
```

**Fix:**

```bash
# Create environment files from templates (if not already done)
cp .env.example .env
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env

# Edit .env with your local values
cat .env

# Critical variables for local dev:
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/soroban_explorer
# SOROBAN_RPC_URL=https://soroban-testnet.stellar.org (or local quickstart)
```

### Missing Git hooks

**Doctor output:**
```
⚠ Missing Git hooks: pre-commit, pre-push, commit-msg
```

**Fix:**

```bash
# Install Git hooks (Husky is already configured)
npm run prepare

# Verify they're installed
ls .git/hooks/ | grep -E "pre-commit|pre-push|commit-msg"
# Should see: pre-commit, pre-push, commit-msg
```

### Out-of-date npm dependencies

**Error when running tests or building:**
```
Cannot find module '@stellar/...
```

**Fix:**

```bash
# Clear npm cache
npm cache clean --force

# Reinstall all dependencies
npm ci  # or: npm install

# In indexer and frontend directories too
cd indexer && npm ci
cd ../frontend && npm ci
```

## Verification Checklist

After fixing issues, run the doctor again to confirm all checks pass:

```bash
npm run doctor
```

Expected output should show:

- ✓ **Node.js** 20+
- ✓ **npm** 10+
- ✓ **Rust** 1.80+
- ✓ **wasm32 target** installed
- ✓ **Database** connected (PostgreSQL on port 5432)
- ✓ **DATABASE_URL** configured
- ✓ **Ports** 5173, 3001, 5432 in expected state
- ✓ **Disk** > 1 GB free
- ✓ **Memory** > 2 GB available
- ✓ **Git hooks** installed
- ✓ **Docker** (and `docker compose`) available

Once all checks pass (or only warnings remain), you can proceed with:

```bash
# Start the full local stack
npm run dev
```

## Getting Help

If the doctor found an issue that doesn't match any fix above, or if you're stuck:

1. **Check the full error output** from `npm run doctor` — often includes suggestions
2. **Review the Getting Started guide** — `docs/guides/getting-started.md`
3. **Check GitHub issues** — search for your error message at https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/issues
4. **Open a new issue** — include the full output of `npm run doctor` and your OS details

## See Also

- `scripts/doctor.js` — the doctor script itself
- `indexer/src/doctor-lib.js` — implementation of the checks
- `docs/guides/getting-started.md` — full local setup from scratch
