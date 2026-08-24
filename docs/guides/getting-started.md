# Getting Started — Run the Full Stack Locally

This guide takes you from a fresh clone to a running explorer on your local
machine — no GitHub Codespaces or cloud dev container required. By the end you
will have:

- A **PostgreSQL** database with migrated schemas
- A **Soroban contract** deployed to Stellar testnet
- An **indexer daemon** polling Soroban RPC, decoding events, and exposing a
  REST + WebSocket API on `http://localhost:3001`
- A **React frontend** served by Vite on `http://localhost:5173`

> ⏱ **Target time**: A developer on macOS can reach the running frontend in
> under 20 minutes by following this guide.

---

## Prerequisites

Install and verify these tools **before** cloning the repo.

| Tool                                                                                     | Version            | Check command                                   |
| ---------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/)                        | Latest stable      | `docker --version && docker compose version`    |
| [Node.js](https://nodejs.org/)                                                           | 20 LTS or newer    | `node --version` (should be ≥ 20.x)             |
| [npm](https://www.npmjs.com/)                                                            | Ships with Node 20 | `npm --version` (should be ≥ 10.x)              |
| [Rust](https://rustup.rs/)                                                               | Stable (1.80+)     | `rustc --version`                               |
| `wasm32-unknown-unknown` target                                                          | —                  | `rustup target list --installed \| grep wasm32` |
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) | 23.x or newer      | `stellar --version`                             |

### macOS specifics

```bash
# Install Docker Desktop from https://www.docker.com/products/docker-desktop/
# or via Homebrew:
brew install --cask docker

# Install Node 20 via Homebrew or nvm:
brew install node@20
# or: nvm install 20

# Install Rust:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add wasm32 target:
rustup target add wasm32-unknown-unknown

# Install Stellar CLI:
brew install stellar-cli
```

### Linux specifics

```bash
# Install Docker Engine: https://docs.docker.com/engine/install/

# Install Node.js 20 (Debian/Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Rust:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add wasm32 target:
rustup target add wasm32-unknown-unknown

# Install Stellar CLI:
# See https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli
```

---

## 1. Clone and configure

```bash
git clone https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block
cd Soroban-Smart-Block
```

Create the root environment file from the template:

```bash
cp .env.example .env
```

Then create the indexer and frontend environment files:

```bash
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env
```

### What to configure in `.env`

The most critical variables are:

| Variable               | Default                                                        | When to change                                                                       |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SOROBAN_RPC_URL`      | `https://soroban-testnet.stellar.org`                          | Set to your local quickstart container (`http://localhost:8000`) for offline testing |
| `DATABASE_URL`         | `postgres://postgres:postgres@localhost:5432/soroban_explorer` | Match your Docker or local PostgreSQL credentials                                    |
| `EXPLORER_CONTRACT_ID` | pre-filled default                                             | Update after `make deploy` prints a new contract ID                                  |

The indexer `.env` and frontend `.env` files are pre-configured with sensible
defaults that point to the same values — edit them only if you need
customisation.

---

## 2. Start PostgreSQL

The stack requires a running PostgreSQL instance. The easiest way is via Docker
Compose, which starts only the database service:

```bash
docker compose up -d postgres
```

This starts a `postgres:15-alpine` container on port `5432` with:

- **User**: `postgres`
- **Password**: `postgres`
- **Database**: `soroban_explorer`

Verify it is healthy:

```bash
docker compose ps postgres
# Name                      State   Ports
# soroban-postgres          Up      0.0.0.0:5432->5432/tcp

# Quick connection check:
docker exec soroban-postgres pg_isready -U postgres -d soroban_explorer
# /var/run/postgresql:5432 - accepting connections
```

> **Alternative**: If you already have PostgreSQL running locally, update
> `DATABASE_URL` in your `.env` file to point to your instance and skip the
> Docker step.

---

## 3. Install dependencies

Install the indexer and frontend npm packages:

```bash
# Indexer (Node.js API + event daemon)
cd indexer && npm ci && cd ..

# Frontend (React + Vite)
cd frontend && npm ci && cd ..
```

> `npm ci` performs a clean install from the lockfile. Use `npm install` only
> when you are intentionally upgrading dependencies.

### Rust dependencies

Fetch Cargo crate dependencies (this is also done automatically on first build):

```bash
cargo fetch
```

---

## 4. Build and deploy the contract

Build the Soroban explorer contract to WebAssembly:

```bash
make build
```

This compiles `contracts/explorer` to a `.wasm` binary and places it at
`target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm`.

Run the contract unit tests to verify the build is sound:

```bash
make test
```

Deploy the contract to Stellar testnet:

```bash
make deploy
```

The deploy command will:

1. Optimise the WASM binary with `stellar contract optimize`
2. Deploy to testnet using the `default` Stellar CLI identity
3. Print the new **contract ID** to the terminal

Copy the printed contract ID into your root `.env` file:

```bash
# Edit .env and set:
EXPLORER_CONTRACT_ID=<the-printed-contract-id>
```

Also update it in `indexer/.env`:

```bash
EXPLORER_CONTRACT_ID=<the-printed-contract-id>
```

> **First time deploying?** If you don't have a Stellar CLI identity set up,
> `make deploy` will guide you. You may need to fund the account via the
> [Stellar testnet Friendbot](https://friendbot.stellar.org/).
>
> Alternatively, the default contract ID in `.env.example` already points to a
> pre-deployed testnet contract — you can skip this step for evaluation.

---

## 5. Run database migrations

The indexer needs its database schema to be created and migrated:

```bash
cd indexer
node src/migrate.js
cd ..
```

This applies all migration files from `indexer/migrations/` in order. On
success, you should see output like:

```
✓ Migration 001_initial_schema applied
✓ Migration 002_core_schema applied
✓ Migration 003_invocations_and_verifications applied
```

---

## 6. Start the full stack

Now start both the indexer API and the frontend development server in parallel:

```bash
make dev
```

This runs:

- **Indexer** → `http://localhost:3001` (Express REST API + WebSocket)
- **Frontend** → `http://localhost:5173` (Vite dev server with HMR)

> Or start them individually in separate terminals:
>
> **Terminal 1 — Indexer:**
>
> ```bash
> cd indexer && npm start
> ```
>
> **Terminal 2 — Frontend:**
>
> ```bash
> cd frontend && npm run dev
> ```

---

## 7. Verify everything is running

### API health check

```bash
curl http://localhost:3001/api/health
```

Expected response (HTTP 200):

```json
{
  "status": "ok",
  "indexer": {
    "latest_ledger": 4521983,
    "status": "indexing"
  }
}
```

### Events endpoint

```bash
curl http://localhost:3001/api/events?limit=3
```

Expected response: a JSON array of decoded events (may be empty if no contracts
have emitted events yet). An empty array `[]` is also valid — it indicates the
indexer is running but the network has no recent contract activity matching the
configured contract ID.

### Frontend

Open **http://localhost:5173** in your browser. You should see:

- The Soroban Smart Block Explorer home page
- A paginated event feed (or a "No events yet" state)
- Navigation to contract, wallet, and event detail pages

---

## 8. Optional: Run the setup wizard

The project includes an interactive setup wizard that automates most of the
steps above:

```bash
npm run setup
```

The wizard will:

1. Check system requirements (Node, Rust, wasm32, PostgreSQL)
2. Create `.env` files from templates
3. Prompt for RPC URL, database URL, and poll interval
4. Create the database and run migrations
5. Install all dependencies
6. Build the contract and frontend
7. Verify service health

---

## Docker-only workflow

If you prefer to run everything in containers (including the indexer and
frontend), use the Docker Compose stack:

```bash
# Start the full dev stack with hot-reload
docker compose up -d

# Check status
docker compose ps

# Tail logs
docker compose logs -f

# Stop everything
docker compose down

# Rebuild a specific service
make docker-rebuild indexer
docker compose up -d
```

This uses `Dockerfile.dev` for the indexer and frontend, which mount source
directories for live code changes (hot-reload via nodemon and Vite).

---

## Troubleshooting

### 1. PostgreSQL connection refused

**Symptom**: Indexer exits with `ECONNREFUSED` or `DATABASE_URL` connection
errors.

**Causes & fixes**:

| Cause                            | Fix                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| PostgreSQL container not running | Run `docker compose up -d postgres` and wait 5 seconds                             |
| Port conflict (5432 in use)      | Check `docker compose ps` for port binding; stop other Postgres instances          |
| Wrong credentials in `.env`      | Verify `DATABASE_URL=postgres://postgres:postgres@localhost:5432/soroban_explorer` |
| Docker not started               | Open Docker Desktop or run `systemctl start docker` (Linux)                        |

```bash
# Diagnostic command
docker compose logs postgres
```

### 2. `stellar` command not found

**Symptom**: `make deploy` fails with `stellar: command not found`.

**Fix**: Install the Stellar CLI:

```bash
# macOS
brew install stellar-cli

# Linux — download the binary
curl -fsSL https://github.com/stellar/stellar-cli/releases/latest/download/stellar-cli-ubuntu-x86_64.tar.gz \
  | tar xz -C /usr/local/bin stellar

# Verify
stellar --version
```

### 3. WASM build fails with Rust errors

**Symptom**: `make build` fails with `target wasm32-unknown-unknown not
installed` or linker errors.

**Fixes**:

```bash
# Install the wasm32 target
rustup target add wasm32-unknown-unknown

# Update Rust toolchain
rustup update stable

# Verify target is installed
rustup target list --installed | grep wasm32
```

If you get a linker error about `wasm-ld`, install `lld`:

```bash
# macOS
brew install llvm

# Debian/Ubuntu
sudo apt-get install -y lld
```

### 4. Frontend shows blank page or API errors in console

**Symptom**: Frontend loads but shows no data; browser console shows `Failed to
fetch` or `CORS` errors.

**Fixes**:

| Issue                                       | Fix                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Indexer not running                         | Start the indexer: `make indexer` or `cd indexer && npm start`                       |
| Wrong `VITE_INDEXER_URL` in frontend `.env` | Set `VITE_INDEXER_URL=http://localhost:3001` in `frontend/.env`                      |
| CORS blocked by browser                     | The indexer sets `CORS_ORIGINS=*` in `.env` by default — verify it is not overridden |
| Frontend built with wrong API URL           | Delete `frontend/dist` and restart Vite                                              |

```bash
# Quick API connectivity test
curl -s http://localhost:3001/api/health | head -c 200
```

### 5. Contract deploy fails with "insufficient balance"

**Symptom**: `make deploy` fails with a `-32000` or
`InsufficientBalance` error.

**Fixes**:

```bash
# Fund your deployer account via Friendbot
stellar keys fund default --network testnet

# Check balance
stellar keys address default
# → Copy the address, then visit:
# → https://friendbot.stellar.org?addr=<YOUR_ADDRESS>

# Or use the CLI helper
stellar keys fund default --network testnet
```

The testnet Friendbot gives 10,000 XLM — more than enough for deployments.

---

## Next steps

Once the stack is running, explore these guides:

- **[Register a contract ABI](../guides/register-abi.md)** — so your contract's
  events decode into plain English
- **[Build with the API](../guides/building-with-the-api.md)** — use the REST
  API from your own application
- **[Architecture deep dive](../guides/architecture-deep-dive.md)** — understand
  how the indexer, decoder, and frontend work together
- **[Sandbox IDE](../guides/sandbox-ide.md)** — experiment with Soroban
  contracts in your browser
- **[API playground](../api/playground.html)** — explore every endpoint via
  Swagger UI
- **[Configuration validation](../configuration-validation.md)** — reference
  for all environment variables
