# Testnet Deployment Runbook

This runbook describes how to deploy the Soroban Smart Block Explorer stack to
Stellar testnet, from a fresh checkout through to a fully operational deployment
with all CI smoke tests passing.

> ⏱ **Target time**: Following this runbook from a clean checkout results in a
> working testnet deployment with all CI smoke tests passing.

---

## Prerequisites

Install and verify these tools before starting:

| Tool                       | Version                                      | Check command                                                      |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Rust                       | Stable (1.80+) with `wasm32-unknown-unknown` | `rustc --version && rustup target list --installed \| grep wasm32` |
| Stellar CLI                | 23.x or newer                                | `stellar --version`                                                |
| Node.js                    | 20 LTS or newer                              | `node --version && npm --version`                                  |
| Docker                     | Latest stable                                | `docker --version && docker compose version`                       |
| A testnet deployer account | Funded with testnet XLM                      | `stellar keys address deployer`                                    |

> **Important**: Use a dedicated testnet secret for deployment work. Never reuse
> a mainnet secret in local shells, CI logs, or screenshots.

---

## Required Environment Variables

The following table lists every secret and configuration value needed across the
stack. Copy `.env.example` to `.env` and fill in each value.

### Secrets table

| #   | Env var                  | Required | Example value                                        | Where to get it                                                                                                          |
| --- | ------------------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `STELLAR_ADMIN_SECRET`   | ✅ Yes   | `SAZGBIC...`                                         | Generate with `stellar keys generate deployer` then `stellar keys show deployer`                                         |
| 2   | `STELLAR_ADMIN_PUBLIC`   | ✅ Yes   | `GBCQVJ...`                                          | `stellar keys address deployer`                                                                                          |
| 3   | `DATABASE_URL`           | ✅ Yes   | `postgres://user:pass@db-host:5432/soroban_explorer` | Your PostgreSQL provider (e.g., [Aiven](https://aiven.io/postgresql), [Supabase](https://supabase.com/), or self-hosted) |
| 4   | `SOROBAN_RPC_URL`        | ✅ Yes   | `https://soroban-testnet.stellar.org`                | Stellar testnet (default). For multi-node resilience, use `SOROBAN_RPC_URLS`                                             |
| 5   | `NETWORK_PASSPHRASE`     | ✅ Yes   | `Test SDF Network ; September 2015`                  | Must match the network (testnet passphrase shown)                                                                        |
| 6   | `HORIZON_URL`            | ✅ Yes   | `https://horizon-testnet.stellar.org`                | Stellar testnet Horizon                                                                                                  |
| 7   | `CONTRACT_ID`            | ✅ Yes   | `CDA2ZCIB...`                                        | Output of `stellar contract deploy` (step 2)                                                                             |
| 8   | `API_KEY`                | Optional | `sk_live_abc123`                                     | Your API management system                                                                                               |
| 9   | `ADMIN_SECRET`           | Optional | `admin-secret-123`                                   | Generate a strong random secret                                                                                          |
| 9b  | `ADMIN_TOTP_SECRET`      | Optional | `JBSWY3DPEHPK3PXP`                                    | Base32 TOTP secret; when set, `/api/admin/*` also requires `X-Admin-TOTP`                                                |
| 10  | `REDIS_URL`              | Optional | `redis://user:pass@redis-host:6379`                  | Your Redis provider (if using caching/rate-limiting)                                                                     |
| 11  | `GITHUB_TOKEN`           | Optional | `ghp_abc123...`                                      | GitHub Settings → Developer settings → Personal access tokens                                                            |
| 12  | `STRIPE_SECRET_KEY`      | Optional | `sk_test_...`                                        | Stripe Dashboard → Developers → API keys                                                                                 |
| 13  | `STRIPE_WEBHOOK_SECRET`  | Optional | `whsec_...`                                          | Stripe Dashboard → Developers → Webhooks                                                                                 |
| 14  | `GEOIP_DB_PATH`          | Optional | `/etc/GeoLite2-Country.mmdb`                         | [MaxMind](https://www.maxmind.com/en/geolite2-free-geolite2-country-database) (free registration required)               |
| 15  | `CLOUDFLARE_WEBHOOK_URL` | Optional | `https://hooks.cloudflare.com/...`                   | Cloudflare Dashboard                                                                                                     |

---

## 1. Clone and configure

```bash
git clone https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block
cd Soroban-Smart-Block

# Create environment files
cp .env.example .env
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env
```

Edit `.env` and set the required values from the secrets table above:

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
DATABASE_URL=postgres://user:pass@your-db-host:5432/soroban_explorer
EXPLORER_CONTRACT_ID=<will-be-filled-after-step-2>
```

---

## 2. Build and deploy the contract to testnet

### 2a. Build the WASM contract

```bash
make build
```

This compiles the explorer contract and outputs:
`target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm`

Optimise the binary:

```bash
make optimize
```

### Verified Build Reference

A clean release build of `soroban-explorer-contract` was verified at commit `002fc6a` (2026-07-21) per [#441](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/issues/441):

| Field | Value |
| --- | --- |
| Artifact | `target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm` |
| Size | 30,778 bytes (~30 KB, well under the 100 KB budget) |
| SHA256 | `82dd8081e1af944a331905a69892b45ad9c115ee8e96cdb4ac7ba566bf41b2fd` |

This is a point-in-time record, not a guarantee for future builds — recompute the size and hash after any contract source change before deploying.

Verify the optimized artifact exists:

```bash
find . -path "*target/wasm32-unknown-unknown/release/*.optimized.wasm"
```

### 2b. Set up the Stellar CLI identity

```bash
# Generate a deployer keypair (skip if you already have one)
stellar keys generate deployer

# Fund the deployer account via Friendbot
stellar keys fund deployer --network testnet

# Verify the address
stellar keys address deployer

# Check balance via Horizon (stellar keys balance not available in all CLI versions)
DEPLOYER_ADDR=$(stellar keys address deployer)
curl -s "https://horizon-testnet.stellar.org/accounts/$DEPLOYER_ADDR" | python3 -c "
import sys, json
data = json.load(sys.stdin)
balance = next((b['balance'] for b in data['balances'] if b['asset_type'] == 'native'), '0')
print(f'Balance: {balance} XLM')
"
```

The testnet Friendbot gives 10,000 test XLM — more than enough for deployment
and contract operations.

### 2c. Deploy to testnet

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm \
  --source deployer \
  --network testnet
```

Copy the returned contract ID:

```bash
export CONTRACT_ID=<returned-contract-id>
echo "CONTRACT_ID=$CONTRACT_ID"
```

### 2d. Update environment files with the contract ID

```bash
# Update root .env
sed -i '' "s/^EXPLORER_CONTRACT_ID=.*/EXPLORER_CONTRACT_ID=$CONTRACT_ID/" .env

# Update indexer .env
sed -i '' "s/^EXPLORER_CONTRACT_ID=.*/EXPLORER_CONTRACT_ID=$CONTRACT_ID/" indexer/.env
```

> On Linux, use `sed -i` (without the `''`).

---

## 3. Install dependencies and run database migrations

### 3a. Install npm packages

```bash
cd indexer && npm ci && cd ..
cd frontend && npm ci && cd ..
```

### 3b. Run database migrations

```bash
cd indexer
node src/migrate.js
cd ..
```

This applies all migration files from `indexer/migrations/` in numerical order.
Each migration runs in a transaction and is recorded in a migrations tracking
table.

Expected output:

```
✓ Migration 001_initial_schema applied
✓ Migration 002_core_schema applied
✓ Migration 003_invocations_and_verifications applied
... (all migrations up to the latest)
```

> **Troubleshooting**: If a migration fails, check that `DATABASE_URL` is
> correct and the target database exists. You can create it manually:
>
> ```sql
> CREATE DATABASE soroban_explorer;
> ```

---

## 4. Start the indexer

Start the indexer daemon in production mode:

```bash
cd indexer
NODE_ENV=production npm start
```

The daemon will:

1. Connect to Stellar testnet via `SOROBAN_RPC_URL`
2. Begin polling for new events from `START_LEDGER` (set to `0` for latest)
3. Decode events using the deployed contract's ABI
4. Store decoded events in PostgreSQL
5. Expose the REST API on port `3001` (configurable via `PORT`)

### Running as a background process

For persistent deployment, run the indexer with a process manager:

```bash
# Using pm2
npm install -g pm2
pm2 start indexer/src/index.js --name soroban-indexer

# Or using systemd (create a service unit)
sudo tee /etc/systemd/system/soroban-indexer.service << 'EOF'
[Unit]
Description=Soroban Smart Block Indexer
After=network.target postgresql.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/soroban/indexer
ExecStart=/usr/bin/node src/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now soroban-indexer
```

### Verify the indexer is processing ledgers

Watch the logs for ledger advancement:

```bash
# Using pm2
pm2 logs soroban-indexer

# Look for output like:
# [INFO] Indexed ledger 4521983 (2 events, 0 decodes)
# [INFO] Indexed ledger 4521984 (0 events)
# [INFO] Indexed ledger 4521985 (1 events, 1 decode)
```

---

## 5. Configure the frontend

### 5a. Set environment variables

Edit `frontend/.env`:

```bash
VITE_INDEXER_URL=https://your-indexer-domain.com
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

### 5b. Build the frontend

```bash
cd frontend
npm run build
```

This produces a static build in `frontend/dist/` that can be served by any
static file server (Nginx, Caddy, Cloudflare Pages, etc.).

### 5c. Serve the frontend

Example Nginx configuration:

```nginx
server {
    listen 80;
    server_name explorer.your-domain.com;

    root /opt/soroban/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 6. Set GitHub Actions secrets

For the CD pipeline (`.github/workflows/deploy.yml`) to work, configure the
following repository secrets under **Settings → Secrets and variables →
Actions**:

| Secret name            | Value                                 | Required for                    |
| ---------------------- | ------------------------------------- | ------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection string          | DB migrations and health checks |
| `STELLAR_ADMIN_SECRET` | Deployer account secret key           | Contract upgrades               |
| `APP_URL`              | `https://your-deployment.example.com` | Post-deploy smoke tests         |
| `CODECOV_TOKEN`        | CodeCov upload token                  | Coverage reporting              |
| `SLACK_WEBHOOK_URL`    | Slack webhook URL                     | Deployment notifications        |

### Setting secrets via GitHub CLI

```bash
gh secret set DATABASE_URL --body "postgres://user:pass@host:5432/soroban_explorer"
gh secret set STELLAR_ADMIN_SECRET --body "SAZGBIC..."
gh secret set APP_URL --body "https://explorer.your-domain.com"
gh secret set CODECOV_TOKEN --body "<token>"
gh secret set SLACK_WEBHOOK_URL --body "https://hooks.slack.com/services/..."
```

### Setting environment variables (not secrets)

For non-sensitive config used across workflows, set repository variables:

```bash
gh variable set STELLAR_NETWORK --body "testnet"
gh variable set SOROBAN_RPC_URL --body "https://soroban-testnet.stellar.org"
gh variable set HORIZON_URL --body "https://horizon-testnet.stellar.org"
gh variable set FRONTEND_PORT --body "80"
```

---

## 7. Smoke test checklist

Run these checks to verify the deployment is healthy:

### 7a. Contract level

```bash
# Contract is deployed and queryable
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- \
  event_count
# Expected: returns a number ≥ 0
```

### 7b. Database level

```bash
# Verify tables exist
psql "$DATABASE_URL" -c "\dt"

# Verify migrations tracked
psql "$DATABASE_URL" -c "SELECT * FROM migrations ORDER BY id;"

# Check for indexed events
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM events;"
```

### 7c. Indexer API level

```bash
# Health endpoint
curl -s https://your-indexer-domain.com/api/health | python3 -m json.tool

# Expected response:
# { "status": "ok", "indexer": { "latest_ledger": 4521983, "status": "indexing" } }

# Events endpoint (should return a valid JSON array)
curl -s https://your-indexer-domain.com/api/events?limit=5 | python3 -c "
import sys, json
data = json.load(sys.stdin)
assert isinstance(data, list), 'Expected array'
print(f'✅ Events endpoint returned {len(data)} events')
"

# Ledger lag (should be < 30)
LEDGER_LAG=$(curl -s https://your-indexer-domain.com/api/health | python3 -c "
import sys, json
print(json.load(sys.stdin).get('indexer', {}).get('ledger_lag', 0))
")
if [ "$LEDGER_LAG" -gt 30 ]; then
  echo "❌ Indexer is $LEDGER_LAG ledgers behind (threshold: 30)"
else
  echo "✅ Indexer ledger lag: $LEDGER_LAG"
fi
```

### 7d. Frontend level

```bash
# Frontend responds with HTML
curl -s https://explorer.your-domain.com | head -c 200
# Expected: starts with <!DOCTYPE html>

# Check for JavaScript bundle
curl -s -o /dev/null -w "%{http_code}" https://explorer.your-domain.com/assets/index-*.js
# Expected: 200
```

### 7e. CI smoke test

Trigger a deployment via the GitHub Actions workflow:

```bash
gh workflow run deploy.yml --ref main -f environment=dev
```

Monitor the run and verify all smoke test steps pass:

```bash
gh run watch
```

---

## Upgrading the contract

After contract code changes:

```bash
# 1. Rebuild
make build && make optimize

# 2. Upload new WASM
WASM_HASH=$(stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm \
  --source deployer \
  --network testnet \
  | grep -oP '[a-f0-9]{64}')

# 3. Invoke upgrade (if the contract exposes an upgrade function)
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- \
  upgrade \
  --wasm_hash "$WASM_HASH"
```

After the upgrade:

1. Re-run all smoke tests
2. Restart the indexer if event schemas changed
3. Rebuild the frontend if generated bindings changed
4. Record the new WASM hash, contract ID, and deployer in release notes

---

## Rollback procedure

If a deployment introduces issues:

```bash
# 1. Roll back the indexer image (Docker Compose)
docker compose pull indexer
docker compose up -d --no-deps indexer

# 2. Roll back the frontend image
docker compose pull frontend
docker compose up -d --no-deps frontend

# 3. Reset the indexer cursor to resume from a known-good ledger
#    (re-run the indexer; it resumes from the last cursor in the DB)
docker compose restart indexer

# 4. Verify health
curl -sf https://your-indexer-domain.com/api/health
```

---

## Environment reference

### Summary of all environment files

| File            | Purpose                                            |
| --------------- | -------------------------------------------------- |
| `.env` (root)   | Docker Compose, contract deployment, shared config |
| `indexer/.env`  | Indexer daemon runtime config                      |
| `frontend/.env` | Frontend build-time config (Vite)                  |

### Key variable relationships

```
Root .env                       indexer/.env                  frontend/.env
──────────────────────────────────────────────────────────────────────────────
SOROBAN_RPC_URL   ───────────►  SOROBAN_RPC_URL
DATABASE_URL      ───────────►  DATABASE_URL
NETWORK_PASSPHRASE ──────────►  NETWORK_PASSPHRASE
EXPLORER_CONTRACT_ID ───────►  EXPLORER_CONTRACT_ID
                                                              VITE_INDEXER_URL  ◄── http://indexer:3001
                                                              VITE_SOROBAN_RPC_URL  ◄── SOROBAN_RPC_URL
                                                              VITE_NETWORK_PASSPHRASE ◄── NETWORK_PASSPHRASE
```

---

## Frequently asked questions

### Q: What is the minimum PostgreSQL version?

PostgreSQL 15 or newer is recommended. The project uses `postgres:15-alpine` in
development and has been tested against PostgreSQL 16 in CI.

### Q: Can I deploy the frontend to a CDN?

Yes. The frontend build produces static files in `frontend/dist/`. Upload these
to Cloudflare Pages, Vercel, Netlify, or any static hosting provider. Ensure
the `VITE_INDEXER_URL` points to your deployed indexer API.

### Q: How do I monitor the indexer?

The indexer exposes a health endpoint at `/api/health` and Prometheus metrics at
`/api/metrics`. Set up monitoring with Prometheus + Grafana, or use a
commercial observability platform.

### Q: What happens if the indexer crashes?

The indexer records its progress (last processed ledger) in PostgreSQL. On
restart, it resumes from the last processed ledger. Use a process manager
(pm2, systemd, Docker restart policies) to ensure automatic recovery.

### Q: How do I rotate secrets?

1. Update the secret in your provider (e.g., generate a new Stellar keypair)
2. Update the GitHub Actions secret
3. Update the environment file on the deployment target
4. Restart the affected services
5. Revoke the old secret
