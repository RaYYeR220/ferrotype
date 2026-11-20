#!/usr/bin/env bash
# End to end on a local anvil chain:
#   1. deploy a minimal ERC-20 (no checkpoints) and a Plebiscite for it, fund the treasury;
#   2. open a proposal anchored to a fresh block hash (the CLI builds the header and proofs),
#      after seeing a proposer below the threshold and a header older than the maximum
#      snapshot age refused;
#   3. move tokens after the snapshot, then vote with storage proofs: weights are the
#      balances at the snapshot block, not today's;
#   4. check the refusals: a second vote, and a proof for someone else's balance;
#   5. after the deadline, see execution refused during the timelock, then execute the
#      treasury payment once it has passed;
#   6. use the token's allowance (approve, transferFrom) and check its ERC-20 event.
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

# The DAO's settings: 1-hour votes, 40% quorum, snapshots at most 16 blocks old,
# 1% of the supply to propose, a 5-minute timelock, then a week to execute.
PERIOD=3600
QUORUM=4000
MAX_AGE=16
THRESHOLD=100
TIMELOCK=300
GRACE=604800

# The Refused reasons this run expects (ingots/contracts/src/ballot.fe).
ALREADY_VOTED=4
UNKNOWN_BLOCK=10
BELOW_THRESHOLD=15
TIMELOCKED=17

# anvil's default accounts are unlocked: cast sends from them without keys.
mapfile -t ACCOUNTS < <(cast rpc --rpc-url "$RPC" eth_accounts | py -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
DEPLOYER=${ACCOUNTS[0]}
ALICE=${ACCOUNTS[1]}
BOB=${ACCOUNTS[2]}
CAROL=${ACCOUNTS[3]}
DAVE=${ACCOUNTS[4]}
RECIPIENT=0x000000000000000000000000000000000000c0de

send() { cast send --rpc-url "$RPC" --unlocked --from "$1" "${@:2}" >/dev/null; }
# Sends a transaction that the contract must refuse with exactly Refused(reason).
refused() {
  local reason=$1 out want
  if out=$(cast send --rpc-url "$RPC" --unlocked --from "$2" "${@:3}" 2>&1); then
    fail "accepted, but Refused($reason) was expected: ${*:3}"
  fi
  want=$(printf 'bd5adfec%064x' "$reason")
  echo "$out" | tr -d '\r\n' | grep -qi "$want" || fail "expected Refused($reason), got: $(echo "$out" | tail -n 1)"
}
deploy() {
  local code; code="$(cat "out/$1.bin")${2:-}"
  cast send --rpc-url "$RPC" --unlocked --from "$DEPLOYER" --create "0x${code#0x}" --json \
    | py -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])'
}
last_line() { tail -n 1; }
propose_as() {
  $FERROTYPE propose --rpc "$CLI_RPC" --token "$TOKEN" --supply-slot 1 --proposer "$1" --layout solidity --slot 0 \
    --target "$RECIPIENT" --value 1000000000000000000
}

step "1. Deploy a minimal ERC-20 and a Plebiscite for it"
TOKEN=$(deploy DemoToken)
ok "DemoToken  $TOKEN"
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$ALICE" 600ether
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$BOB" 300ether
send "$DEPLOYER" "$TOKEN" "mint(address,uint256)" "$CAROL" 100ether
ok "minted 600 / 300 / 100 to alice / bob / carol"
if cast send --rpc-url "$RPC" --unlocked --from "$ALICE" "$TOKEN" "mint(address,uint256)" "$ALICE" 1ether >/dev/null 2>&1; then
  fail "someone other than the deployer minted"
fi
ok "only the deployer mints"
# token, layout 0 (Solidity mapping) at slot 0, supply at slot 1, then the settings above
ARGS=$(cast abi-encode "f(address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)" \
  "$TOKEN" 0 0 1 $PERIOD $QUORUM $MAX_AGE $THRESHOLD $TIMELOCK $GRACE)
DAO=$(deploy Plebiscite "${ARGS#0x}")
ok "Plebiscite $DAO"
send "$DEPLOYER" "$DAO" "deposit()" --value 5ether
ok "treasury holds $(cast balance --rpc-url "$RPC" "$DAO" --ether) ETH"

step "2. Open a proposal: pay 1 ETH to $RECIPIENT"
# The CLI checks the header against a block hash given to it, not only the node's.
LATEST_N=$(cast block --rpc-url "$RPC" latest -f number | tr -d '\r')
LATEST_H=$(cast block --rpc-url "$RPC" "$LATEST_N" -f hash | tr -d '\r')
READ=$($FERROTYPE read --rpc "$CLI_RPC" --account "$TOKEN" --slot 1 --block-hash "$LATEST_H")
echo "$READ" | grep -q '^trust    the header hashes to --block-hash' || fail "--block-hash was not checked"
if $FERROTYPE read --rpc "$CLI_RPC" --account "$TOKEN" --slot 1 --block "$LATEST_N" --block-hash "0x$(printf '%064x' 1)" >/dev/null 2>&1; then
  fail "a header was accepted against a block hash it does not hash to"
fi
ok "the CLI proves against a block hash it is given, and refuses a header that does not hash to it"
# Dave holds no tokens: below the 1% threshold.
refused $BELOW_THRESHOLD "$DAVE" "$DAO" "$(propose_as "$DAVE" | last_line)"
ok "dave's proposal is refused: he held less than 1% of the supply at the snapshot"
# A header older than the maximum snapshot age.
STALE=$(propose_as "$ALICE" | last_line)
cast rpc --rpc-url "$RPC" anvil_mine "$((MAX_AGE + 1))" >/dev/null
refused $UNKNOWN_BLOCK "$ALICE" "$DAO" "$STALE"
ok "a proposal anchored $((MAX_AGE + 1)) blocks back is refused (at most $MAX_AGE)"
PROPOSE=$(propose_as "$ALICE")
echo "$PROPOSE" | sed -n '1,8p' | sed 's/^/      /'
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
TALLY=$(cast call --rpc-url "$RPC" "$DAO" "tally(uint256)(uint256,uint256,uint256,uint256,uint256,bool,uint256)" 1)
FOR=$(echo "$TALLY" | sed -n 1p | cut -d' ' -f1); AGAINST=$(echo "$TALLY" | sed -n 2p | cut -d' ' -f1)
[ "$FOR" = "700000000000000000000" ] && [ "$AGAINST" = "300000000000000000000" ] || fail "tally $FOR / $AGAINST"
ok "tally: 700 for (alice 600 + carol 100), 300 against: snapshot balances, not today's"

step "4. Refusals"
VOTE=$($FERROTYPE vote --rpc "$CLI_RPC" --dao "$DAO" --id 1 --holder "$ALICE")
refused $ALREADY_VOTED "$ALICE" "$DAO" "$(echo "$VOTE" | last_line)"
ok "alice's second vote is refused (already voted)"
if cast send --rpc-url "$RPC" --unlocked --from "$DAVE" "$DAO" "$(echo "$VOTE" | last_line)" >/dev/null 2>&1; then
  fail "alice's proof counted for another voter"
fi
ok "alice's balance proof sent by someone else is refused (it proves alice's slot, not theirs)"

step "5. After the deadline and the timelock, execute"
cast rpc --rpc-url "$RPC" evm_increaseTime $((PERIOD + 1)) >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
refused $TIMELOCKED "$BOB" "$DAO" "execute(uint256,bytes)" 1 0x
ok "the vote is over, but execution waits $TIMELOCK s more"
cast rpc --rpc-url "$RPC" evm_increaseTime $TIMELOCK >/dev/null
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

step "6. The token is an ERC-20: allowances and events"
send "$CAROL" "$TOKEN" "approve(address,uint256)" "$DAVE" 50ether
[ "$(cast call --rpc-url "$RPC" "$TOKEN" "allowance(address,address)(uint256)" "$CAROL" "$DAVE" | cut -d' ' -f1)" = "50000000000000000000" ] \
  || fail "allowance not set"
RECEIPT=$(cast send --rpc-url "$RPC" --unlocked --from "$DAVE" "$TOKEN" "transferFrom(address,address,uint256)" "$CAROL" "$DAVE" 20ether --json)
TOPIC=$(echo "$RECEIPT" | py -c 'import json,sys; print(json.load(sys.stdin)["logs"][0]["topics"][0])')
[ "$TOPIC" = "$(cast keccak 'Transfer(address,address,uint256)')" ] || fail "transferFrom logged $TOPIC"
[ "$(cast call --rpc-url "$RPC" "$TOKEN" "allowance(address,address)(uint256)" "$CAROL" "$DAVE" | cut -d' ' -f1)" = "30000000000000000000" ] \
  || fail "allowance not spent"
[ "$(cast call --rpc-url "$RPC" "$TOKEN" "balanceOf(address)(uint256)" "$DAVE" | cut -d' ' -f1)" = "20000000000000000000" ] \
  || fail "transferFrom did not move the tokens"
if cast send --rpc-url "$RPC" --unlocked --from "$DAVE" "$TOKEN" "transferFrom(address,address,uint256)" "$CAROL" "$DAVE" 31ether >/dev/null 2>&1; then
  fail "transferFrom spent more than the allowance"
fi
ok "carol approves dave for 50; dave moves 20 with transferFrom (a standard Transfer event), not 31 more"

printf '\n\033[32mend to end: all checks passed\033[0m\n'
