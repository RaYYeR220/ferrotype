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
    "fe_tx": f"{gas('ferrotype-packed', 'usdc-holder', 'tx_gas'):,}",
    "lido_tx": f"{gas('lido', 'usdc-holder', 'tx_gas'):,}",
}

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
readme.write_text(text, encoding="utf-8", newline="\n")
print("README.md: gas table and figures rendered from bench/results/gas.json")
