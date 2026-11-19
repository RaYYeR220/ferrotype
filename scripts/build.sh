#!/usr/bin/env bash
# Builds every artifact from the same library sources:
#   out/                   the contracts (EVM bytecode and ABI), at -O 2
#   target/bin/ferrotype   the CLI (native executable)
#   target/wasm/           the browser module, if FE_WASM names a compiler
#                          built with the `wasm` feature (see README)
set -euo pipefail
cd "$(dirname "$0")/.."

FE=${FE:-fe}
FE_WASM=${FE_WASM:-}
PY=${PYTHON:-python3}

"$FE" --version
"$FE" build -O 2 ingots/contracts --out-dir out

"$FE" build --backend native -O 2 ingots/cli --out-dir target/cli
"$FE" build --backend native -O 2 ingots/fuzz --out-dir target/fuzz
mkdir -p target/bin
cp target/cli/cli target/bin/ferrotype
echo "Wrote target/bin/ferrotype"

if [ -n "$FE_WASM" ]; then
  "$PY" scripts/bundle_wasm.py target/wasm/ferrotype.fe
  (cd target/wasm && "$FE_WASM" build --backend wasm -O 2 --out-dir . ferrotype.fe)
  cp target/wasm/ferrotype.wasm target/wasm/ferrotype.manifest.json web/public/
  echo "Copied the module to web/public/"
fi
