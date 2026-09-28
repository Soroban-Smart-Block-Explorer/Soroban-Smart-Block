# Issue #796 — pinned build container for reproducible source verification.
# Built as $VERIFIER_BUILD_IMAGE; invoked by indexer/src/contractVerifier.js as
#   docker run --rm <image> <repo-url> <commit>
# and prints WASM_SHA256=<hex> on success.
FROM rust:1.84.0-slim-bookworm

ARG STELLAR_CLI_VERSION=22.6.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && cargo install --locked stellar-cli --version "${STELLAR_CLI_VERSION}" --no-default-features

RUN useradd --create-home builder
USER builder
WORKDIR /home/builder

COPY --chown=builder:builder build.sh /usr/local/bin/verify-build
ENTRYPOINT ["/usr/local/bin/verify-build"]
