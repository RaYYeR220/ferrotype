"""Saves balance proofs at each deployed Plebiscite's snapshot block.

    RPC=https://sepolia.gateway.tenderly.co python3 scripts/capture_snapshots.py

A vote carries a storage proof of the voter's balance at the proposal's
snapshot block, and free public nodes only answer eth_getProof for roughly the
last hundred blocks. Run this right after scripts/deploy.sh: it reads
deployments/sepolia.json, asks each Plebiscite for its snapshot, and saves the
proofs for a few holders (the three demo voters; for USDC, recent receivers
from the Transfer log) to deployments/sepolia-snapshots.json. The web page
replays them against the deployed contracts with eth_call, so anyone can ask
the contract for a holder's voting power without a node that keeps history.
"""

import json
import os
import sys
import urllib.request
from pathlib import Path

from eth_hash.auto import keccak

ROOT = Path(__file__).resolve().parent.parent
RPC = os.environ.get("RPC", "https://sepolia.gateway.tenderly.co")
NETWORK = os.environ.get("NETWORK", "sepolia")
TRANSFER = "0x" + keccak(b"Transfer(address,address,uint256)").hex()
SNAPSHOT = "0x8f1dd809"  # snapshot(uint256)


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "ferrotype"})
    with urllib.request.urlopen(req, timeout=30) as r:
        reply = json.load(r)
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def word(n: int) -> str:
    return f"{n:064x}"


def balance_key(holder: str, slot: int) -> str:
    return "0x" + keccak(bytes.fromhex(word(int(holder, 16)) + word(slot))).hex()


def snapshot(dao: str) -> dict:
    out = rpc("eth_call", [{"to": dao, "data": SNAPSHOT + word(1)}, "latest"])[2:]
    return {"block": int(out[0:64], 16), "storage_root": "0x" + out[64:128], "supply": str(int(out[128:192], 16))}


def proofs(token: str, slot: int, holders: list, block: int) -> list:
    out = []
    for holder in holders:
        key = balance_key(holder, slot)
        p = rpc("eth_getProof", [token, [key], hex(block)])
        sp = p["storageProof"][0]
        out.append({"holder": holder, "key": key, "value": sp["value"], "proof": sp["proof"]})
        print(f"  {holder} {sp['value']}")
    return out


def receivers(token: str, block: int, want: int) -> list:
    seen = []
    for back in (200, 2000):
        logs = rpc("eth_getLogs", [{"address": token, "topics": [TRANSFER], "fromBlock": hex(max(0, block - back)), "toBlock": hex(block)}])
        for log in reversed(logs):
            to = "0x" + log["topics"][2][-40:]
            if to not in seen and int(to, 16) != 0:
                seen.append(to)
        if len(seen) >= want:
            break
    return seen[:want]


def main() -> int:
    dep = json.loads((ROOT / "deployments" / f"{NETWORK}.json").read_text())
    c = dep["contracts"]
    result = {"network": NETWORK, "rpc": RPC, "daos": {}}

    demo = snapshot(c["PlebisciteDemo"])
    print(f"demo DAO {c['PlebisciteDemo']} snapshot block {demo['block']}")
    voters = [dep["voters"][k] for k in ("alice", "bob", "carol")]
    result["daos"]["demo"] = {
        "dao": c["PlebisciteDemo"], "token": c["DemoToken"], "layout": "solidity", "balance_slot": 0, "proposal": 1,
        **demo, "proofs": proofs(c["DemoToken"], 0, voters, demo["block"]),
    }

    usdc = snapshot(c["PlebisciteUSDC"])
    print(f"USDC DAO {c['PlebisciteUSDC']} snapshot block {usdc['block']}")
    holders = receivers(dep["usdc"], usdc["block"], 8)
    result["daos"]["usdc"] = {
        "dao": c["PlebisciteUSDC"], "token": dep["usdc"], "layout": "flagged", "balance_slot": 9, "proposal": 1,
        **usdc, "proofs": proofs(dep["usdc"], 9, holders, usdc["block"]),
    }

    out = ROOT / "deployments" / f"{NETWORK}-snapshots.json"
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {out.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
