# =============================================================================
#  Soroban Smart Block — Frontend production image (Issue #344)
#
#  Stage 1 (build): install ALL deps (Vite + plugins) and run `vite build`,
#                   emitting a literal placeholder string for VITE_API_URL so
#                   the same image can be re-targeted at container start.
#  Stage 2 (serve): nginx:1.25-alpine serving the static dist + a custom
#                   nginx.conf (5 security headers, gzip, SPA routing,
#                   long-lived /assets/ caching, /api/ proxy) on port 8080,
#                   fronted by a tiny entrypoint that performs runtime
#                   substitution of VITE_API_URL via sed (envsubst in-place
#                   deletes the file before substitution completes).
#  Target image size: < 50 MB.
# =============================================================================

# ---------- Stage 1: Vite production build ----------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifest files first to maximise layer caching of the install step.
COPY package.json package-lock.json ./

# `npm ci` installs both prod and dev deps — required because Vite plugins
# (e.g. @vitejs/plugin-react, monaco workers) live in devDependencies.
RUN npm ci

# Copy the rest of the frontend source (tests/, *.md, .env, node_modules
# are excluded by .dockerignore so they never enter the layer).
COPY . .

# Bake a literal placeholder into the bundle. The entrypoint script in the
# runtime stage replaces this token, in every emitted /assets/*.js file, with
# whatever VITE_API_URL is set to on `docker run`. Empty default is safe —
# the frontend falls back to "http://localhost:3001".
ENV VITE_API_URL=__RUNTIME_VITE_API_URL__
RUN npm run build \
 && test -d dist \
 && test -n "$(ls dist 2>/dev/null)"


# ---------- Stage 2: nginx runtime -------------------------------------------
FROM nginx:1.25-alpine AS final

# The custom nginx config replaces /etc/nginx/conf.d/default.conf — it is
# already wired into nginx:1.25-alpine's /etc/nginx/nginx.conf http{} block.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Drop in the runtime envsubst entrypoint. This is what the container runs
# instead of the stock nginx CMD.
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copy the built static assets from Stage 1.
COPY --from=build /app/dist /usr/share/nginx/html

# Listen on 8080 (unprivileged) so the container can stay runnable as a
# non-root user in the future and so acceptance tests `curl :8080` succeed.
EXPOSE 8080

# Exec form — the entrypoint performs runtime substitution, then exec's nginx.
# No `/bin/sh -c` wrapper around nginx itself.
ENTRYPOINT ["/docker-entrypoint.sh"]
