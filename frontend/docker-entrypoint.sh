#!/bin/sh
# =============================================================================
#  Soroban Smart Block — frontend runtime entrypoint (Issue #344)
#
#  Replaces the literal placeholder that Stage 1 baked into the bundle with the
#  VITE_API_URL env var passed to `docker run`. Then exec's nginx.
#
#  We pre-escape sed replacement metachars (\, &, and the @ delimiter) BEFORE
#  running sed, so an operator-supplied URL like
#      https://api.example.com/q?x=1&y=2
#  cannot corrupt the emitted JS bundle. (envsubst < file > file truncates the
#  file before substitution completes, which is the other reason we use sed
#  here instead of envsubst.)
# =============================================================================

set -eu

PLACEHOLDER="__RUNTIME_VITE_API_URL__"
DEFAULT_API_URL="http://localhost:3001"

# Default to a same-origin /api/ proxy when no env var is provided — see
# nginx.conf. This keeps the image usable out-of-the-box without `docker run -e`.
if [ -z "${VITE_API_URL:-}" ]; then
    VITE_API_URL="$DEFAULT_API_URL"
fi

# Pre-escape `\`, `&`, and `@` for use as the RIGHT-HAND side of a sed `s@…@…@`
# expression. `@` is chosen as the sed delimiter because URLs often contain
# `|` and `/`, which would force multiple escapes.
ESCAPED_URL=$(printf '%s' "$VITE_API_URL" | sed 's/[\\&@]/\\&/g')

# Substituting in /usr/share/nginx/html/assets/*.js is sufficient because
# `vite build` emits every environment-influenced constant into the hashed
# JS chunks. We deliberately scope to /assets/ to avoid touching /index.html
# or other static files that may contain $-tokens (e.g. JSON-LD templates).
if [ -d /usr/share/nginx/html/assets ]; then
    find /usr/share/nginx/html/assets -type f -name "*.js" -exec \
        sed -i "s@${PLACEHOLDER}@${ESCAPED_URL}@g" {} +
fi

echo "[entrypoint] VITE_API_URL=${VITE_API_URL}"

# Exec replaces this shell process so nginx becomes PID 1 and receives signals.
exec nginx -g 'daemon off;'
