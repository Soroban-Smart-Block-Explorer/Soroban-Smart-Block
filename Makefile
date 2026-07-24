.PHONY: build test check deploy indexer frontend clean fmt fmt-check lint \
	docker-up docker-down docker-build docker-logs docker-test docker-staging docker-prod \
	e2e e2e-setup e2e-test e2e-api e2e-chaos e2e-property e2e-playwright e2e-k6 e2e-full

# ── Contract ──────────────────────────────────────────────────────────────────
build:
	cargo build --release --target wasm32-unknown-unknown \
	  -p soroban-explorer-contract

test:
	cargo test -p soroban-explorer-contract

fmt:
	cargo fmt

fmt-check:
	cargo fmt --check

lint:
	cargo clippy -- -D warnings

check: fmt-check lint test

optimize:
	stellar contract optimize \
	  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm

deploy: build optimize
	stellar contract deploy \
	  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm \
	  --source default \
	  --network testnet

# ── Indexer ───────────────────────────────────────────────────────────────────
indexer-install:
	cd indexer && npm install

indexer:
	cd indexer && npm start

# ── Frontend ──────────────────────────────────────────────────────────────────
frontend-install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

frontend-build:
	cd frontend && npm run build

# ── Docker ─────────────────────────────────────────────────────────────────────
# Start dev stack (hot-reload via docker-compose.override.yml)
# Uses Dockerfile.dev for indexer + frontend with source mounts
docker-up:
	docker compose up -d

# Start production stack (no overrides, uses Dockerfile)
docker-prod:
	docker compose -f docker-compose.yml --profile prod up -d

# Start staging stack (mirror of prod)
docker-staging:
	docker compose -f docker-compose.yml --profile staging up -d

# CI / integration test stack
docker-test:
	docker compose -f docker-compose.yml --profile test up -d --abort-on-container-exit

# Stop all containers
docker-down:
	docker compose down

# Build all images without running
docker-build:
	docker compose build

# Tail logs from all services
docker-logs:
	docker compose logs -f

# Rebuild a specific service (e.g., make docker-rebuild indexer)
docker-rebuild:
	docker compose build $(filter-out $@,$(MAKECMDGOALS))
	docker compose up -d $(filter-out $@,$(MAKECMDGOALS))

# Check container health status
docker-ps:
	docker compose ps

# ── All ───────────────────────────────────────────────────────────────────────
install: indexer-install frontend-install

dev:
	$(MAKE) -j2 indexer frontend

clean:
	cargo clean
	rm -rf frontend/dist

# ── E2E Tests ──────────────────────────────────────────────────────────────────
e2e-setup:
	cd e2e && npm install && bash setup.sh

e2e-test:
	cd e2e && npm run test:e2e

e2e-api:
	cd e2e && npm run test:api

e2e-chaos:
	cd e2e && npm run test:chaos

e2e-property:
	cd e2e && npm run test:property

e2e-playwright:
	cd e2e && npm run test:playwright

e2e-k6:
	cd e2e && npm run test:k6

e2e-full:
	cd e2e && npm run test:full

e2e: e2e-setup e2e-test
