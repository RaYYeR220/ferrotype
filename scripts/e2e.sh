#!/usr/bin/env bash
# End to end on a local anvil chain:
#   1. deploy a plain ERC-20 (no checkpoints) and a Plebiscite for it, fund the treasury;
#   2. open a proposal anchored to a real block hash (the CLI builds the header and proofs);
#   3. move tokens after the snapshot, then vote with storage proofs: weights are the
#      balances at the snapshot block, not today's;
#   4. check the refusals: a second vote, and a proof for someone else's balance;
#   5. advance time and execute the treasury payment.
#
# Needs: anvil and cast (Foundry), python3, the contracts built with
#   fe build -O 2 ingots/contracts --out-dir out
# and the CLI built with
#   fe build --backend native -O 2 ingots/cli --out-dir target/cli
#
# Environment:
#   RPC        the anvil URL for cast            (default http://127.0.0.1:8545)
#   CLI_RPC    the anvil URL the CLI should use  (default $RPC)
#   FERROTYPE  how to run the CLI                (default ./target/bin/ferrotype)
#   PYTHON     a Python 3 interpreter            (default python3)
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC:-http://127.0.0.1:8545}
CLI_RPC=${CLI_RPC:-$RPC}
FERROTYPE=${FERROTYPE:-./target/bin/ferrotype}
PY=${PYTHON:-python3}
py() { "$PY" "$@" | tr -d '\r'; }

ok() { printf '  \033[32mok\033[0m  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

# anvil's default accounts are unlocked: cast sends from them without keys.
mapfile -t ACCOUNTS < <(cast rpc --rpc-url "$RPC" eth_accounts | py -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
DEPLOYER=${ACCOUNTS[0]}
ALICE=${ACCOUNTS[1]}
BOB=${ACCOUNTS[2]}
CAROL=${ACCOUNTS[3]}
RECIPIENT=0x000000000000000000000000000000000000c0de

send() { cast send --rpc-url "$RPC" --unlocked --from "$1" "${@:2}" >/dev/null; }
deploy() {
  local code; code="$(cat "out/$1.bin")${2:-}"
  cast send --rpc-url "$RPC" --unlocked --from "$DEPLOYER" --create "0x${code#0x}" --json \
    | py -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])'
}
last_line() { tail -n 1; }

step "1. Deploy a plain ERC-20 and a Plebiscite for it"
TOKEN=$(deploy DemoToken)
ok "DemoToken  $TOKEN"
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$ALICE" 600ether
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$BOB" 300ether
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$CAROL" 100ether
ok "minted 600 / 300 / 100 to alice / bob / carol"
# token, layout 0 (Solidity mapping) at slot 0, supply at slot 1, 1 hour, 40% quorum, 256 blocks
ARGS=$(cast abi-encode "f(address,uint8,uint256,uint256,uint256,uint256,uint256)" "$TOKEN" 0 0 1 3600 4000 256)
DAO=$(deploy Plebiscite "${ARGS#0x}")
ok "Plebiscite $DAO"
send "$DEPLOYER" "$DAO" "deposit()" --value 5ether
ok "treasury holds $(cast balance --rpc-url "$RPC" "$DAO" --ether) ETH"

step "2. Open a proposal: pay 1 ETH to $RECIPIENT"
PROPOSE=$($FERROTYPE propose --rpc "$CLI_RPC" --token "$TOKEN" --supply-slot 1 --target "$RECIPIENT" --value 1000000000000000000)
echo "$PROPOSE" | sed -n '1,5p' | sed 's/^/      /'
send "$ALICE" "$DAO" "$(echo "$PROPOSE" | last_line)"
SNAPSHOT=$(cast call --rpc-url "$RPC" "$DAO" "snapshot(uint256)(uint256,bytes32,uint256)" 1)
ok "proposal 1 counts votes at block $(echo "$SNAPSHOT" | head -1), supply $(echo "$SNAPSHOT" | tail -1)"

step "3. Alice sends 500 tokens to Carol after the snapshot, then everyone votes"
send "$ALICE" "$TOKEN" "transfer(address,uint256)" "$CAROL" 500ether
ok "today: alice 100, carol 600; at the snapshot: alice 600, carol 100"
for who in ALICE BOB CAROL; do
  addr=${!who}
  side=--for; [ "$who" = BOB ] && side=--against
  VOTE=$($FERROTYPE vote --rpc "$CLI_RPC" --dao "$DAO" --id 1 --holder "$addr" $([ "$side" = --against ] && echo --against))
  echo "$VOTE" | grep '^weight' | sed "s/^/      $who /"
  send "$addr" "$DAO" "$(echo "$VOTE" | last_line)"
done
TALLY=$(cast call --rpc-url "$RPC" "$DAO" "tally(uint256)(uint256,uint256,uint256,uint256,uint256,bool)" 1)
FOR=$(echo "$TALLY" | sed -n 1p | cut -d' ' -f1); AGAINST=$(echo "$TALLY" | sed -n 2p | cut -d' ' -f1)
[ "$FOR" = "700000000000000000000" ] && [ "$AGAINST" = "300000000000000000000" ] || fail "tally $FOR / $AGAINST"
ok "tally: 700 for (alice 600 + carol 100), 300 against: snapshot balances, not today's"

step "4. Refusals"
VOTE=$($FERROTYPE vote --rpc "$CLI_RPC" --dao "$DAO" --id 1 --holder "$ALICE")
if cast send --rpc-url "$RPC" --unlocked --from "$ALICE" "$DAO" "$(echo "$VOTE" | last_line)" >/dev/null 2>&1; then
  fail "a second vote was accepted"
fi
ok "alice's second vote is refused (already voted)"
OTHER=$(cast rpc --rpc-url "$RPC" eth_accounts | py -c 'import json,sys; print(json.load(sys.stdin)[4])')
if cast send --rpc-url "$RPC" --unlocked --from "$OTHER" "$DAO" "$(echo "$VOTE" | last_line)" >/dev/null 2>&1; then
  fail "alice's proof counted for another voter"
fi
ok "alice's balance proof sent by someone else is refused (it proves alice's slot, not theirs)"

step "5. After the deadline, execute"
cast rpc --rpc-url "$RPC" evm_increaseTime 3601 >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
BEFORE=$(cast balance --rpc-url "$RPC" "$RECIPIENT")
send "$BOB" "$DAO" "execute(uint256,bytes)" 1 0x
AFTER=$(cast balance --rpc-url "$RPC" "$RECIPIENT")
[ "$(py -c "print($AFTER - $BEFORE)")" = "1000000000000000000" ] || fail "recipient got $BEFORE -> $AFTER"
ok "recipient received 1 ETH from the treasury"
if cast send --rpc-url "$RPC" --unlocked --from "$BOB" "$DAO" "execute(uint256,bytes)" 1 0x >/dev/null 2>&1; then
  fail "executed twice"
fi
ok "a second execute is refused"

printf '\n\033[32mend to end: all checks passed\033[0m\n'
