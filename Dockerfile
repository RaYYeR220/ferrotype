# A reproducible environment for building and testing Ferrotype.
#
#   docker build -t ferrotype .
#   docker run --rm -it ferrotype            # build + all tests + end to end on anvil
#
# Fe 26.6.0 comes from its release (feup); Foundry is pinned. The browser
# module needs a Fe compiler built with the `wasm` Cargo feature, which the
# release binaries do not include; build this file with
#   docker build --build-arg WASM=1 -t ferrotype .
# to compile Fe v26.6.0 from source with that feature (about ten minutes).

FROM rust:1.100-bookworm AS fe-wasm
ARG WASM=0
RUN if [ "$WASM" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs npm && \
      git clone --depth 1 --branch v26.6.0 https://github.com/argotorg/fe.git /fe && \
      cd /fe && npm ci --prefix crates/tree-sitter-fe && \
      cargo build --locked --release -p fe --features wasm,cranelift && \
      cp target/release/fe /usr/local/bin/fe-wasm; \
    else \
      printf '#!/bin/sh\necho "built without WASM=1" >&2; exit 1\n' > /usr/local/bin/fe-wasm && chmod +x /usr/local/bin/fe-wasm; \
    fi

FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git python3 nodejs \
    && rm -rf /var/lib/apt/lists/*

# Fe 26.6.0, the release this project targets.
RUN curl -fsSL https://raw.githubusercontent.com/argotorg/fe/v26.6.0/feup/feup.sh | bash -s -- --version v26.6.0
ENV PATH="/root/.fe/bin:/root/.foundry/bin:${PATH}"

# Foundry, for the gas benchmark and the local chain.
RUN curl -fsSL https://foundry.paradigm.xyz | bash && foundryup --install v1.8.3

COPY --from=fe-wasm /usr/local/bin/fe-wasm /usr/local/bin/fe-wasm

WORKDIR /ferrotype
COPY . .
RUN fe --version && forge --version

CMD ["bash", "-c", "scripts/build.sh && (anvil --silent &) && sleep 2 && RPC=http://127.0.0.1:8545 scripts/test.sh"]
