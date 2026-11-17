#!/usr/bin/env python3
"""Fetch a block header and an eth_getProof response into a fixture file.

Usage: fetch_proof.py <rpc-url> <block|latest> <account> <slot-hex>... > fixture.json
"""
import json
import sys
import urllib.request


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "ferrotype-fixtures"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.load(resp)
    if "error" in out:
        raise SystemExit(f"{method}: {out['error']}")
    return out["result"]


def main():
    url, block, account, *slots = sys.argv[1:]
    if block == "latest":
        block = rpc(url, "eth_blockNumber", [])
    elif not block.startswith("0x"):
        block = hex(int(block))
    header = rpc(url, "eth_getBlockByNumber", [block, False])
    proof = rpc(url, "eth_getProof", [account, slots, block])
    chain_id = rpc(url, "eth_chainId", [])
    header.pop("transactions", None)
    json.dump({"chainId": chain_id, "block": header, "proof": proof}, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
