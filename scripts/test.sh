#!/usr/bin/env bash
# Runs every check and records the counts in results/tests.json, which
# scripts/render_readme.py writes into the README:
#   the same tests on the EVM and natively, the browser module against the
#   same vectors, a million damaged proofs natively, the gas benchmark, and
#   (with RPC set to a running anvil) the end-to-end governance run.
set -euo pipefail
cd "$(dirname "$0")/.."

FE=${FE:-fe}
PY=${PYTHON:-python3}
mkdir -p results
LOG=$(mktemp)

passed() { grep -E 'test result: ok\.' "$LOG" | tail -1 | sed -E 's/.* ([0-9]+) passed.*/\1/'; }

echo "== EVM"
"$FE" test ingots/conformance | tee "$LOG"
EVM=$(passed)

echo "== native"
"$FE" test --backend native ingots/conformance | tee "$LOG"
NATIVE=$(passed)

WASM=null
if [ -f web/public/ferrotype.wasm ]; then
  echo "== WebAssembly"
  node wasm/check.mjs web/public/ferrotype.wasm | tee "$LOG"
  WASM=$(sed -nE 's/^wasm: ([0-9]+) passed; 0 failed$/\1/p' "$LOG")
fi

echo "== fuzz (native)"
"$FE" build --backend native -O 2 ingots/fuzz --out-dir target/fuzz >/dev/null
target/fuzz/fuzz 1000000 1 | tee "$LOG"
FUZZ_TRUE=$(sed -nE 's/^true +([0-9]+).*/\1/p' "$LOG")
FUZZ_REJECTED=$(sed -nE 's/^rejected +([0-9]+)/\1/p' "$LOG")
FUZZ_WRONG=$(sed -nE 's/^wrong +([0-9]+)/\1/p' "$LOG")

if command -v forge >/dev/null; then
  echo "== gas benchmark"
  (cd bench && forge test && "$PY" render.py)
fi

E2E=null
if [ -n "${RPC:-}" ]; then
  echo "== end to end on $RPC"
  scripts/e2e.sh && E2E=true
fi

cat > results/tests.json <<EOF
{
  "fe": "$("$FE" --version)",
  "evm_passed": $EVM,
  "native_passed": $NATIVE,
  "wasm_passed": $WASM,
  "fuzz_rounds": 1000000,
  "fuzz_seed": 1,
  "fuzz_true_value": $FUZZ_TRUE,
  "fuzz_rejected": $FUZZ_REJECTED,
  "fuzz_wrong_value": $FUZZ_WRONG,
  "end_to_end": $E2E
}
EOF
rm -f "$LOG"
echo "Wrote results/tests.json"
