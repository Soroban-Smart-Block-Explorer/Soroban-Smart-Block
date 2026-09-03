# Devcontainer image: Rust + Node 20 + wasm32 target
#
# Optimisation notes (issue #787):
# - Package manifests (Cargo.toml, package*.json) are copied first so that
#   dependency installation is cached as a Docker layer. Only when these files
#   change will the layer be rebuilt.
# - BuildKit cache mounts for ~/.cargo and /root/.npm keep downloaded crates
#   and npm packages across rebuilds, even when the COPY layer is invalidated.
# - The Stellar CLI install uses `|| true` so a build failure does not block
#   the devcontainer start (it is optional tooling).

# ── Stage 1: Rust + Node base ────────────────────────────────────────────────
FROM mcr.microsoft.com/devcontainers/rust:1 AS base

# Install Node.js 20 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Add wasm32 target for Soroban contract builds
RUN rustup target add wasm32-unknown-unknown

# ── Stage 2: Pre-cache dependencies ──────────────────────────────────────────
# Copy only the dependency manifests first. This layer is cached until a
# manifest changes, so `cargo fetch` and `npm install` do not re-run on
# every file edit.
FROM base AS deps

WORKDIR /workspaces/Soroban-Smart-Block

# Copy Cargo workspace manifest + lock file (root of Cargo workspace)
COPY Cargo.toml Cargo.lock ./

# Copy indexer package manifests
COPY indexer/package.json indexer/package-lock.json ./indexer/

# Copy frontend package manifests
COPY frontend/package.json frontend/package-lock.json ./frontend/

# Pre-fetch Cargo crates (uses BuildKit cache mount for faster rebuilds)
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo fetch

# Pre-install indexer node_modules (uses npm cache mount)
RUN --mount=type=cache,target=/root/.npm \
    cd indexer && npm ci --prefer-offline

# Pre-install frontend node_modules (uses npm cache mount)
RUN --mount=type=cache,target=/root/.npm \
    cd frontend && npm ci --prefer-offline

# Pre-install root package.json dependencies (if any)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline || true

# ── Stage 3: Final image ─────────────────────────────────────────────────────
FROM base AS final

# Install Stellar CLI (latest) — optional, non-blocking
RUN cargo install --locked stellar-cli --features opt 2>/dev/null || true

# Copy pre-cached dependencies from the deps stage.
# These directories are now populated, so postCreateCommand skips the
# heavy installs entirely.
COPY --from=deps /workspaces/Soroban-Smart-Block/indexer/node_modules /workspaces/Soroban-Smart-Block/indexer/node_modules
COPY --from=deps /workspaces/Soroban-Smart-Block/frontend/node_modules /workspaces/Soroban-Smart-Block/frontend/node_modules
COPY --from=deps /usr/local/cargo/registry /usr/local/cargo/registry
COPY --from=deps /usr/local/cargo/git /usr/local/cargo/git
