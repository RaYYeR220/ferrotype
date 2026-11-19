#!/usr/bin/env bash
# Runs every check: the same tests on the EVM and natively, the browser module
# against the same vectors, the gas benchmark, and (with RPC set to a running
# anvil) the end-to-end governance run.
set -euo pipefail
cd "$(dirname "$0")/.."

FE=${FE:-fe}

echo "== EVM"
"$FE" test ingots/conformance

echo "== native"
"$FE" test --backend native ingots/conformance

if [ -f web/public/ferrotype.wasm ]; then
  echo "== WebAssembly"
  node wasm/check.mjs web/public/ferrotype.wasm
fi

if command -v forge >/dev/null; then
  echo "== gas benchmark"
  (cd bench && forge test && ${PYTHON:-python3} render.py)
fi

if [ -n "${RPC:-}" ]; then
  echo "== end to end on $RPC"
  scripts/e2e.sh
fi
