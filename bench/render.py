#!/usr/bin/env python3
"""Render results/gas.json (and results/soundness.json, if present) into results/gas.md.

Standard library only. Run after `forge test` from anywhere:  python render.py
"""

import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / "results"

# Row labels. Compiler versions come from each wrapper's pragma; see README.md.
IMPLEMENTATIONS = {
    "optimism": "Optimism Bedrock `SecureMerkleTrie` (solc 0.8.37)",
    "lido": "Lido `StateProofVerifier` (solc 0.6.12, as audited)",
    "lido-0.8": "Lido `StateProofVerifier`, 0.8 port (solc 0.8.37)",
    "curve-xdao": "Curve `curve-xdao` (patched, 2025)",
    "ferrotype": "Ferrotype (Fe), `storageAt` with `bytes[]`",
    "ferrotype-packed": "Ferrotype (Fe), `storageAtPacked`",
}

CASES = {
    "usdc-blacklisted-holder": "USDC, blacklisted holder (top bit set)",
    "usdc-holder": "USDC, holder balance",
    "weth-zero-slot": "WETH, zero slot (storage exclusion)",
    "absent-account": "Absent account (state exclusion)",
    "eoa-empty-storage": "EOA, empty storage root",
}

MUTATIONS = {
    "wrong-state-root": "flip the low bit of the block's state root.",
    "tampered-storage-leaf": "flip one bit in the last byte of the storage proof's leaf.",
    "truncated-storage-proof": "drop the storage proof's last node.",
    "truncated-account-proof": "drop the account proof's last node and send no storage proof.",
}

# Both truncations end the proof right after a branch node whose child is not empty.
EARLY_ENDING = ["truncated-storage-proof", "truncated-account-proof"]
CONTROL = "curve-xdao"

DASH = "—"


def label(table, key):
    return table.get(key, f"`{key}`")


def num(n):
    return f"{n:,}"


def ordered(rows, field):
    seen = []
    for row in rows:
        if row[field] not in seen:
            seen.append(row[field])
    return seen


def cell(row):
    if row["status"] == "ok":
        return num(row["execution_gas"])
    return f"{DASH} ({row['status']})"


def gas_tables(rows):
    impls = ordered(rows, "implementation")
    cases = ordered(rows, "case")
    by_key = {(r["implementation"], r["case"]): r for r in rows}

    out = ["## Execution gas", ""]
    out.append("Gas spent inside the verifier for one `storageAt` call: account proof, then storage proof.")
    out.append("Excludes the 21,000 base and calldata.")
    out.append("")
    out.append("| Implementation | " + " | ".join(label(CASES, c) for c in cases) + " |")
    out.append("|---|" + "---:|" * len(cases))
    for impl in impls:
        cells = [cell(by_key[(impl, c)]) if (impl, c) in by_key else DASH for c in cases]
        out.append(f"| {label(IMPLEMENTATIONS, impl)} | " + " | ".join(cells) + " |")
    out.append("")

    out.append("## Full breakdown")
    out.append("")
    out.append(
        "`tx gas` = 21,000 + max(calldata gas + execution gas, EIP-7623 floor). "
        "Calldata gas is 16 per nonzero byte and 4 per zero byte."
    )
    out.append("")
    out.append("| Case | Implementation | Status | Execution gas | Calldata bytes | Calldata gas | Tx gas |")
    out.append("|---|---|---|---:|---:|---:|---:|")
    for c in cases:
        for impl in impls:
            r = by_key.get((impl, c))
            if r is None:
                continue
            status = r["status"]
            if "note" in r and status != "ok":
                status = f"{status}: {r['note']}"
            ok = r["status"] == "ok"
            out.append(
                f"| {label(CASES, c)} | {label(IMPLEMENTATIONS, impl)} | {status} | "
                f"{num(r['execution_gas']) if ok else DASH} | {num(r['calldata_bytes'])} | "
                f"{num(r['calldata_gas'])} | {num(r['tx_gas']) if ok else DASH} |"
            )
    out.append("")
    return out


def soundness_table(rows):
    impls = ordered(rows, "implementation")
    mutations = ordered(rows, "mutation")
    by_key = {(r["implementation"], r["mutation"]): r for r in rows}

    out = ["## Broken proofs", ""]
    out.append(f"Each mutation is applied to the `{rows[0]['case']}` proof. Every verifier should reject all four.")
    out.append("")
    for name, what in MUTATIONS.items():
        if name in mutations:
            out.append(f"- `{name}`: {what}")
    out.append("")
    out.append("| Implementation | " + " | ".join(f"`{m}`" for m in mutations) + " |")
    out.append("|---|" + "---|" * len(mutations))
    for impl in impls:
        cells = []
        for m in mutations:
            r = by_key.get((impl, m))
            if r is None or r["outcome"] == "skipped":
                cells.append(DASH)
            elif r["outcome"] == "accepted":
                cells.append(f"**accepted**, returned {int(r['value'], 16)}")
            else:
                cells.append("rejected")
        out.append(f"| {label(IMPLEMENTATIONS, impl)} | " + " | ".join(cells) + " |")
    out.append("")
    out += early_ending_note(impls, [m for m in EARLY_ENDING if m in mutations], by_key)
    return out


def early_ending_note(impls, early, by_key):
    """Who accepts a proof that stops after a branch node, and how the patched control rejects it."""
    if not early:
        return []
    out = ["Both truncations end the proof right after a branch node whose child is not empty."]
    accepted = [i for i in impls if any(by_key.get((i, m), {}).get("outcome") == "accepted" for m in early)]
    if accepted:
        out.append(
            "Accepted as proofs of absence, so the slot reads as 0: "
            + "; ".join(label(IMPLEMENTATIONS, i) for i in accepted)
            + "."
        )
    control = [by_key.get((CONTROL, m)) for m in early]
    if all(r is not None and r["outcome"] == "rejected" for r in control):
        reasons = ", ".join(f"`{n}`" for n in sorted({r.get("note", "?") for r in control}))
        out.append(
            f"{label(IMPLEMENTATIONS, CONTROL)} is the same library with Curve's 2025 fix, "
            f"and rejects both with {reasons}."
        )
    out.append("")
    return out


def main():
    gas = json.loads((RESULTS / "gas.json").read_text(encoding="utf-8"))["results"]
    lines = ["# Storage-proof gas", "", "Generated by `render.py` from `results/gas.json`. Do not edit by hand.", ""]
    lines += gas_tables(gas)

    soundness_path = RESULTS / "soundness.json"
    if soundness_path.exists():
        lines += soundness_table(json.loads(soundness_path.read_text(encoding="utf-8"))["results"])

    blocks = sorted({r["block"] for r in gas})
    lines.append(f"Fixtures: Ethereum mainnet, blocks {', '.join(num(b) for b in blocks)}.")
    lines.append("")
    with open(RESULTS / "gas.md", "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {RESULTS / 'gas.md'}")


if __name__ == "__main__":
    main()
