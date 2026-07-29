# =============================================================================
#  Soroban Smart Block — Indexer production image (Issue #343)
#
#  Stage 1 (build): install ONLY production runtime dependencies.
#  Stage 2 (final): minimal runtime layer — non-root user (uid 1001),
#  HEALTHCHECK against /health, exec-form ENTRYPOINT (no shell wrapper).
#  Target image size: < 150MB.
# =============================================================================

# ---------- Stage 1: install production-only dependencies --------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifest files first to leverage Docker layer caching for npm install.
COPY package.json package-lock.json ./

# --omit=dev (the modern form of --only=production) ensures devDependencies,
# tests, and tooling are not carried into the final image.
RUN npm ci --omit=dev && npm cache clean --force


# ---------- Stage 2: minimal runtime image ----------------------------------
FROM node:20-alpine AS final
WORKDIR /app

# Create the dedicated non-root user (uid 1001) BEFORE any COPY uses --chown.
# Docker resolves --chown against /etc/passwd at COPY time — performing this
# step after a --chown COPY would fail with "chown: no such user: appuser".
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

# Pull in only the production node_modules from the build stage.
# --chown sets ownership at copy time so USER appuser can read everything
# without needing a separate `chown -R` RUN layer.
COPY --chown=appuser:appgroup --from=build /app/node_modules ./node_modules

# Copy the application source. .dockerignore strips tests/, *.md, .env,
# node_modules and other dev artefacts from this layer.
COPY --chown=appuser:appgroup . .

USER appuser

# The indexer HTTP API listens on 3001 (matches docker-compose.yml port mapping
# and is wired to `app.get("/health", …)` in src/api.js:261).
EXPOSE 3001

# Container-level liveness check. wget is shipped with node:20-alpine, so no
# extra apk add is required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Exec form — no /bin/sh wrapper, no tini. The Node process becomes PID 1 and
# relies on src/index.js' SIGTERM/SIGINT handlers for graceful shutdown.
ENTRYPOINT ["node", "src/index.js"]
