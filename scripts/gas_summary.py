#!/usr/bin/env python3
"""Print execution gas per case and implementation from bench/results/gas.json."""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
rows = json.loads((root / "bench" / "results" / "gas.json").read_text())["results"]
cases = list(dict.fromkeys(r["case"] for r in rows))
impls = list(dict.fromkeys(r["implementation"] for r in rows))
print("implementation".ljust(20) + "".join(c[:22].rjust(24) for c in cases))
for impl in impls:
    line = impl.ljust(20)
    for case in cases:
        r = next((r for r in rows if r["implementation"] == impl and r["case"] == case), None)
        cell = str(r["execution_gas"]) if r and r.get("execution_gas") else "-"
        line += cell.rjust(24)
    print(line)
