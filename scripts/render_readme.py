#!/usr/bin/env python3
"""Write the gas numbers from bench/results/gas.json into README.md.

Everything between `<!-- gas:begin -->` and `<!-- gas:end -->` is replaced,
and so are the `<!-- n:NAME -->...<!-- /n -->` figures in the prose, so no
number in the README is typed by hand.
"""
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
rows = json.loads((root / "bench" / "results" / "gas.json").read_text())["results"]

NAMES = {
    "optimism": "Optimism Bedrock `SecureMerkleTrie` (audited)",
    "lido": "Lido `StateProofVerifier` (audited, solc 0.6.12)",
    "lido-0.8": "Lido `StateProofVerifier`, solc 0.8 port",
    "curve-xdao": "Curve `curve-xdao` (patched, 2025, solc 0.8.18)",
    "ferrotype": "**Ferrotype**, `bytes[]` proofs",
    "ferrotype-packed": "**Ferrotype**, packed proofs",
}
CASES = {
    "usdc-holder": "USDC balance",
    "usdc-blacklisted-holder": "USDC, flagged holder",
    "weth-zero-slot": "WETH, empty slot (absence)",
    "absent-account": "Absent account",
    "eoa-empty-storage": "EOA, no storage",
}


def gas(impl, case, field="execution_gas"):
    for r in rows:
        if r["implementation"] == impl and r["case"] == case and r.get("status") == "ok":
            return r.get(field)
    return None


def cell(v):
    return f"{v:,}" if v else "unsupported"


table = ["| Verifier | " + " | ".join(CASES.values()) + " |", "|---|" + "---:|" * len(CASES)]
for impl, name in NAMES.items():
    table.append(f"| {name} | " + " | ".join(cell(gas(impl, c)) for c in CASES) + " |")

fe = gas("ferrotype", "usdc-holder")
figures = {
    "fe_gas": f"{fe:,}",
    "lido_gas": f"{gas('lido', 'usdc-holder'):,}",
    "op_gas": f"{gas('optimism', 'usdc-holder'):,}",
    "vs_lido": f"{round(100 * (1 - fe / gas('lido', 'usdc-holder')))}%",
    "vs_op": f"{round(100 * (1 - fe / gas('optimism', 'usdc-holder')))}%",
    "vs_lido_absent": f"{round(100 * (1 - gas('ferrotype', 'weth-zero-slot') / gas('lido', 'weth-zero-slot')))}%",
    "vs_curve": f"{round(100 * (1 - fe / gas('curve-xdao', 'usdc-holder')))}%",
    "fe_tx": f"{gas('ferrotype-packed', 'usdc-holder', 'tx_gas'):,}",
    "lido_tx": f"{gas('lido', 'usdc-holder', 'tx_gas'):,}",
}

tests_file = root / "results" / "tests.json"
if tests_file.exists():
    tests = json.loads(tests_file.read_text())
    figures.update({
        "evm_tests": str(tests["evm_passed"]),
        "native_tests": str(tests["native_passed"]),
        "wasm_checks": str(tests["wasm_passed"]),
        "fuzz_rounds": f"{tests['fuzz_rounds']:,}",
        "fuzz_true": f"{tests['fuzz_true_value']:,}",
        "fuzz_rejected": f"{tests['fuzz_rejected']:,}",
        "fuzz_wrong": f"{tests['fuzz_wrong_value']:,}",
    })

readme = root / "README.md"
text = readme.read_text(encoding="utf-8")
text = re.sub(
    r"<!-- gas:begin -->.*?<!-- gas:end -->",
    "<!-- gas:begin -->\n" + "\n".join(table) + "\n<!-- gas:end -->",
    text,
    flags=re.S,
)
for name, value in figures.items():
    text = re.sub(rf"<!-- n:{name} -->.*?<!-- /n -->", f"<!-- n:{name} -->{value}<!-- /n -->", text)

# The Sepolia deployment, from deployments/sepolia.json (scripts/deploy.sh).
deployment = root / "deployments" / "sepolia.json"
if deployment.exists():
    dep = json.loads(deployment.read_text())
    scan = "https://sepolia.etherscan.io"
    contracts = {
        "StateReader": "verifies a storage proof against a state root (`storageAt`, `storageAtPacked`)",
        "PlebisciteDemo": "governance and treasury for `DemoToken`, 30-minute votes",
        "DemoToken": "a plain ERC-20 written in Fe (balances at slot 0, supply at slot 1)",
        "PlebisciteUSDC": "governance for Sepolia USDC (balances with a flag bit at slot 9, supply at slot 11)",
    }
    steps = {
        "propose": "proposal 1 opens, anchored to a block hash the chain remembers",
        "transfer_after_snapshot": "Alice sends 500 tokens to Carol after the snapshot",
        "vote_alice": "Alice votes for with 600 (her snapshot balance, not today's 100)",
        "vote_bob": "Bob votes against with 300",
        "vote_carol": "Carol votes for with 100 (not the 600 she holds now)",
        "execute": "after the vote, the treasury pays 0.001 ETH to `0x…c0de`",
        "propose_usdc": "a USDC proposal opens, so anyone can ask for a holder's voting power",
    }
    lines = ["| Contract | Address | Role |", "|---|---|---|"]
    for name, role in contracts.items():
        if name in dep["contracts"]:
            a = dep["contracts"][name]
            lines.append(f"| `{name}` | [`{a}`]({scan}/address/{a}) | {role} |")
    lines += ["", "The governance run on Sepolia, transaction by transaction:", ""]
    for key, what in steps.items():
        if key in dep["txs"]:
            h = dep["txs"][key]
            lines.append(f"1. {what}: [`{h[:10]}…`]({scan}/tx/{h})")
    text = re.sub(
        r"<!-- deploy:begin -->.*?<!-- deploy:end -->",
        "<!-- deploy:begin -->\n" + "\n".join(lines) + "\n<!-- deploy:end -->",
        text,
        flags=re.S,
    )

readme.write_text(text, encoding="utf-8", newline="\n")
print("README.md: rendered from bench/results/gas.json, results/tests.json and deployments/sepolia.json")
