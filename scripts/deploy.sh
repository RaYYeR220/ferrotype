#!/usr/bin/env bash
# Deploys the contracts to a public chain and runs the governance flow there,
# recording every address and transaction in deployments/<network>.json.
#
#   RPC=https://ethereum-sepolia-rpc.publicnode.com NETWORK=sepolia \
#   PRIVATE_KEY=0x... scripts/deploy.sh
#
# Deploys:
#   StateReader
#   DemoToken + a Plebiscite for it (30-minute votes), and runs one proposal
#     through to execution with three voters (two fresh keys, funded here)
#   a Plebiscite for USDC (Circle's FiatToken, balances with a flag bit at
#     slot 9, total supply at slot 11) and opens one proposal anchored to a
#     real block, so anyone can ask it for any holder's voting power
set -euo pipefail
cd "$(dirname "$0")/.."

: "${RPC:?set RPC}"
: "${PRIVATE_KEY:?set PRIVATE_KEY}"
NETWORK=${NETWORK:-sepolia}
USDC=${USDC:-0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238}
FERROTYPE=${FERROTYPE:-./target/bin/ferrotype}
CLI_RPC=${CLI_RPC:-$RPC}
PY=${PYTHON:-python3}
py() { "$PY" "$@" | tr -d '\r'; }

OUT=deployments/$NETWORK.json
mkdir -p deployments
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "deployer $DEPLOYER, balance $(cast balance --rpc-url "$RPC" "$DEPLOYER" --ether) ETH"

record() { "$PY" scripts/record.py "$OUT" "$@"; }
# Public RPC endpoints are load-balanced, and a node that lags one block
# behind hands out a stale nonce. So every sender's nonce is counted here,
# in files, because tx and deploy run inside command substitutions.
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
nonce() {
  local a f n
  a=$(cast wallet address --private-key "$1"); f="$STATE/$a"
  if [ -f "$f" ]; then n=$(cat "$f"); else n=$(cast nonce --rpc-url "$RPC" --block pending "$a"); fi
  echo $((n + 1)) > "$f"
  echo "$n"
}
# Sends a transaction and prints its hash; stops the script if it fails.
tx() {
  local receipt n; n=$(nonce "$1")
  receipt=$(cast send --rpc-url "$RPC" --private-key "$1" --nonce "$n" "${@:2}" --json 2>"$STATE/err")     || { echo "transaction failed: ${*:2}" >&2; cat "$STATE/err" >&2; exit 1; }
  echo "$receipt" | py -c 'import json,sys; r=json.load(sys.stdin); assert r.get("status") in ("0x1", 1, "1"), r; print(r["transactionHash"])'
}
deploy() {
  local code; code="$(cat "out/$1.bin")${2:-}"
  local receipt n; n=$(nonce "$PRIVATE_KEY")
  receipt=$(cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --nonce "$n" --create "0x${code#0x}" --json 2>"$STATE/err")     || { echo "deployment failed: $1" >&2; cat "$STATE/err" >&2; exit 1; }
  local addr hash
  addr=$(echo "$receipt" | py -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])')
  hash=$(echo "$receipt" | py -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')
  record "contracts.$3" "$addr" "txs.deploy_$3" "$hash"
  echo "$addr"
}

record network "$NETWORK" chain_id "$(cast chain-id --rpc-url "$RPC")" deployer "$DEPLOYER" fe "$(fe --version 2>/dev/null || echo 'fe 26.6.0')"

echo "== StateReader"
READER=$(deploy StateReader "" StateReader)
echo "   $READER"

echo "== DemoToken and its Plebiscite"
TOKEN=$(deploy DemoToken "" DemoToken)
ARGS=$(cast abi-encode "f(address,uint8,uint256,uint256,uint256,uint256,uint256)" "$TOKEN" 0 0 1 1800 4000 256)
DAO=$(deploy Plebiscite "${ARGS#0x}" PlebisciteDemo)
echo "   token $TOKEN, dao $DAO"

# Two more voters, funded with a little ETH for gas.
BOB_PK=$(cast wallet new --json | py -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data",d); d=d[0] if isinstance(d,list) else d; print([v for k,v in d.items() if "private" in k.lower()][0])')
CAROL_PK=$(cast wallet new --json | py -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data",d); d=d[0] if isinstance(d,list) else d; print([v for k,v in d.items() if "private" in k.lower()][0])')
BOB=$(cast wallet address --private-key "$BOB_PK")
CAROL=$(cast wallet address --private-key "$CAROL_PK")
record voters.alice "$DEPLOYER" voters.bob "$BOB" voters.carol "$CAROL"
# The two throwaway voter keys, kept outside the repository if asked.
if [ -n "${VOTER_KEYS:-}" ]; then printf 'BOB_PK=%s
CAROL_PK=%s
' "$BOB_PK" "$CAROL_PK" > "$VOTER_KEYS"; fi
tx "$PRIVATE_KEY" "$BOB" --value 0.004ether >/dev/null
tx "$PRIVATE_KEY" "$CAROL" --value 0.004ether >/dev/null
record txs.mint_alice "$(tx "$PRIVATE_KEY" "$TOKEN" "mint(address,uint256)" "$DEPLOYER" 600ether)"
record txs.mint_bob "$(tx "$PRIVATE_KEY" "$TOKEN" "mint(address,uint256)" "$BOB" 300ether)"
record txs.mint_carol "$(tx "$PRIVATE_KEY" "$TOKEN" "mint(address,uint256)" "$CAROL" 100ether)"
record txs.deposit "$(tx "$PRIVATE_KEY" "$DAO" "deposit()" --value 0.002ether)"

echo "== Proposal 1: pay 0.001 ETH to 0x...c0de"
PROPOSE=$($FERROTYPE propose --rpc "$CLI_RPC" --token "$TOKEN" --supply-slot 1 --target 0x000000000000000000000000000000000000c0de --value 1000000000000000)
record txs.propose "$(tx "$PRIVATE_KEY" "$DAO" "$(echo "$PROPOSE" | tail -n 1)")"
record txs.transfer_after_snapshot "$(tx "$PRIVATE_KEY" "$TOKEN" "transfer(address,uint256)" "$CAROL" 500ether)"
for who in alice bob carol; do
  case $who in alice) pk=$PRIVATE_KEY; addr=$DEPLOYER; side="";; bob) pk=$BOB_PK; addr=$BOB; side="--against";; carol) pk=$CAROL_PK; addr=$CAROL; side="";; esac
  VOTE=$($FERROTYPE vote --rpc "$CLI_RPC" --dao "$DAO" --id 1 --holder "$addr" $side)
  record "txs.vote_$who" "$(tx "$pk" "$DAO" "$(echo "$VOTE" | tail -n 1)")"
done
cast call --rpc-url "$RPC" "$DAO" "tally(uint256)(uint256,uint256,uint256,uint256,uint256,bool)" 1

echo "== USDC Plebiscite"
ARGS=$(cast abi-encode "f(address,uint8,uint256,uint256,uint256,uint256,uint256)" "$USDC" 2 9 11 604800 100 256)
USDC_DAO=$(deploy Plebiscite "${ARGS#0x}" PlebisciteUSDC)
PROPOSE=$($FERROTYPE propose --rpc "$CLI_RPC" --token "$USDC" --supply-slot 11 --target 0x000000000000000000000000000000000000c0de --value 0)
record txs.propose_usdc "$(tx "$PRIVATE_KEY" "$USDC_DAO" "$(echo "$PROPOSE" | tail -n 1)")"
record usdc "$USDC"

echo "Wrote $OUT. The demo proposal can be executed 30 minutes after it opened:"
echo "  cast send --rpc-url \$RPC --private-key \$PRIVATE_KEY $DAO 'execute(uint256,bytes)' 1 0x"
