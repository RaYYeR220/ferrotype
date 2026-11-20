#!/usr/bin/env python3
"""Asks the contracts deployed on Sepolia, with eth_call only (no key, no funds).

    python3 scripts/check_live.py [RPC ...]

Checks, against deployments/sepolia.json:
  - StateReader proves each saved mainnet read (fixtures/mainnet) against its
    state root, and refuses the same proof with a node missing or a bit flipped;
  - each Plebiscite answers config() with its ten settings (the timelocked
    version), returns every saved voter's snapshot balance as voting power
    (deployments/sepolia-snapshots.json), and refuses one voter's proof sent
    for another;
  - the demo proposal's tally: 700 for, 300 against, executed (or, before
    that, when it can be).
Prints one line per check and exits non-zero if any fails. Standard library only.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
# eth_call at the latest block works on any node; the next one is a fallback.
RPCS = sys.argv[1:] or ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"]
REASONS = {1: "Malformed", 2: "HashMismatch", 3: "MissingNode", 4: "ExtraNodes", 5: "BadReference"}
# Refused(reason) codes 1 to 19, ingots/contracts/src/ballot.fe
REFUSED = ["UnknownProposal", "VotingClosed", "VotingOpen", "AlreadyVoted", "NoWeight", "FlaggedHolder", "NotPassed",
           "AlreadyExecuted", "WrongCalldata", "UnknownBlock", "BadHeader", "CallFailed", "BadConfig", "NoSupply",
           "BelowThreshold", "WeightAboveSupply", "Timelocked", "Expired", "InsufficientGas"]
STORAGE_AT_PACKED = "fe3242a8"  # storageAtPacked(bytes32,address,bytes32,bytes,bytes)
VOTING_POWER = "08e038f3"  # votingPower(uint256,address,bytes)
TALLY = "ed8b6b31"  # tally(uint256)
CONFIG = "79502c55"  # config()


def word(n):
    return f"{int(n, 16) if isinstance(n, str) else n:064x}"


def encode(*values):
    """ABI-encodes words (ints or hex strings) and `("bytes", hex)` values."""
    heads, tails, offset = [], [], 32 * len(values)
    for v in values:
        if isinstance(v, tuple):
            body = v[1][2:] if v[1].startswith("0x") else v[1]
            tail = word(len(body) // 2) + body.ljust(-(-len(body) // 64) * 64, "0")
            heads.append(word(offset))
            tails.append(tail)
            offset += len(tail) // 2
        else:
            heads.append(word(v))
    return "".join(heads) + "".join(tails)


def packed(nodes):
    return ("bytes", "".join(n[2:] for n in nodes))


def call(to, data):
    """Returns ("ok", hex) or ("revert", reason)."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": "0x" + data}, "latest"]})
    for i, rpc in enumerate(RPCS):
        req = urllib.request.Request(rpc, body.encode(), {"content-type": "application/json", "user-agent": "ferrotype"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                reply = json.load(r)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if i == len(RPCS) - 1:
                raise
    if "result" in reply:
        return "ok", reply["result"]
    data = reply["error"].get("data") or ""
    data = data if isinstance(data, str) else data.get("data", "")
    if data[:10] == "0xf7f9ec62":
        return "revert", f"InvalidProof({REASONS.get(int(data[10:74], 16), '?')})"
    if data[:10] == "0xbd5adfec":
        code = int(data[10:74], 16)
        return "revert", f"Refused({REFUSED[code - 1] if 0 < code <= len(REFUSED) else code})"
    return "revert", reply["error"].get("message", "?")


def flip(node):
    at = (len(node) - 2) // 4 * 2 + 2
    return node[:at] + f"{int(node[at:at + 2], 16) ^ 1:02x}" + node[at + 2:]


failed = 0


def check(label, got, want):
    global failed
    ok = got == want
    failed += not ok
    shown = got[1] if got[0] == "revert" else int(got[1], 16)
    if not isinstance(shown, str) and shown >= 1 << 128:
        shown = hex(shown)  # a word with a flag bit set reads better in hex
    print(f"{'pass' if ok else 'FAIL'}  {label}: {shown}"
          + ("" if ok else f"  (expected {want})"))


dep = json.loads((ROOT / "deployments" / "sepolia.json").read_text())
snaps = json.loads((ROOT / "deployments" / "sepolia-snapshots.json").read_text())
reader = dep["contracts"]["StateReader"]
print(f"Sepolia, via {' or '.join(RPCS)}\n\nStateReader {reader} on saved mainnet proofs")
for name in ("usdc", "weth", "crv", "absent-account", "eoa-empty-storage"):
    f = json.loads((ROOT / "fixtures" / "mainnet" / f"{name}.json").read_text())
    p, root = f["proof"], f["block"]["stateRoot"]
    sp = p["storageProof"][0]
    ask = lambda acct, stor: call(reader, STORAGE_AT_PACKED + encode(root, p["address"], sp["key"], packed(acct), packed(stor)))
    check(f"{name}, as fetched", ask(p["accountProof"], sp["proof"]), ("ok", "0x" + word(sp["value"])))
    check(f"{name}, last account node missing", ask(p["accountProof"][:-1], sp["proof"]), ("revert", "InvalidProof(MissingNode)"))
    check(f"{name}, one bit flipped in the last account node", ask(p["accountProof"][:-1] + [flip(p["accountProof"][-1])], sp["proof"]), ("revert", "InvalidProof(HashMismatch)"))


def words(hexdata):
    body = hexdata[2:]
    return [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]


for key, dao in snaps["daos"].items():
    print(f"\nPlebiscite ({key}) {dao['dao']}, proposal {dao['proposal']}, snapshot block {dao['block']}")
    status, out = call(dao["dao"], CONFIG)
    cfg = words(out) if status == "ok" else []
    failed += len(cfg) != 10
    if len(cfg) == 10:
        print(f"pass  config(): {cfg[5] / 100:g}% quorum, {cfg[7] / 100:g}% of the supply to propose, snapshots at most "
              f"{cfg[6]} blocks old, {cfg[4]} s to vote, then a {cfg[8]} s timelock and {cfg[9]} s to execute")
    else:
        print(f"FAIL  config(): {len(cfg)} words, not the ten of the timelocked Plebiscite ({status})")
    for v in dao["proofs"]:
        got = call(dao["dao"], VOTING_POWER + encode(dao["proposal"], v["holder"], packed(v["proof"])))
        check(f"voting power of {v['holder']}", got, ("ok", "0x" + word(v["value"]) if dao["layout"] != "flagged" else "0x" + word(int(v["value"], 16) & ((1 << 255) - 1))))
    # Both holders hold tokens, so both keys are in the trie: where their paths
    # part, the branch holds a different child than the next node of a's proof.
    held = [v for v in dao["proofs"] if int(v["value"], 16)]
    a, b = held[0], held[1]
    check(f"{a['holder'][:10]}...'s proof sent for {b['holder'][:10]}...", call(dao["dao"], VOTING_POWER + encode(dao["proposal"], b["holder"], packed(a["proof"]))), ("revert", "InvalidProof(HashMismatch)"))

demo = dep["contracts"]["PlebisciteDemo"]
status, out = call(demo, TALLY + word(1))
tally = words(out)
votes_for, votes_against, deadline, executed = tally[0] // 10**18, tally[1] // 10**18, tally[3], tally[5] == 1
_, out = call(demo, CONFIG)
cfg = words(out)
print(f"\nDemo proposal 1: {votes_for} for, {votes_against} against, executed: {'yes' if executed else 'no'}")
if not executed and len(cfg) == 10:
    opens = deadline + cfg[8]
    print(f"  it can be executed from unix time {opens} until {opens + cfg[9]} (deadline + timelock, then the grace period)")
failed += (votes_for, votes_against) != (700, 300) or not executed
print("\nall checks passed" if not failed else f"\n{failed} check(s) failed")
sys.exit(1 if failed else 0)
