"""Runs the native CLI on every saved mainnet proof and on damaged copies of
it, and records what it printed, for the web page's CLI lane.

    FERROTYPE=./target/bin/ferrotype python3 scripts/record_cli_runs.py

Writes, under web/public/runs/:
    <fixture>--<damage>.json   the exact file the CLI was given
    index.json                 for each file: its sha256, the command, the
                               exit code, every line printed, and the reason
                               the CLI gave when it refused

The page loads these same files, so the browser module and the contract are
checked on the bytes the CLI was checked on. Nothing here decides a verdict.
"""

import copy
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "runs"
FIXTURES = ["usdc", "weth", "absent-account", "eoa-empty-storage"]
CLI = shlex.split(os.environ.get("FERROTYPE", "./target/bin/ferrotype"))


def flip(node: str) -> str:
    """Flips the low bit of the byte in the middle of a hex node."""
    body = node[2:]
    at = (len(body) // 4) * 2
    byte = int(body[at:at + 2], 16) ^ 1
    return "0x" + body[:at] + f"{byte:02x}" + body[at + 2:]


def damages(fixture: dict):
    """Each damage is (name, what it does, the damaged file)."""
    yield "none", "the proof as the node sent it", fixture
    storage = fixture["proof"]["storageProof"]
    account = fixture["proof"]["accountProof"]
    if storage and storage[0]["proof"]:
        d = copy.deepcopy(fixture)
        p = d["proof"]["storageProof"][0]["proof"]
        p[-1] = flip(p[-1])
        yield "flip-storage", "one bit flipped in the last storage node", d
        d = copy.deepcopy(fixture)
        d["proof"]["storageProof"][0]["proof"] = d["proof"]["storageProof"][0]["proof"][:-1]
        yield "truncate-storage", "the last storage node removed", d
    d = copy.deepcopy(fixture)
    d["proof"]["accountProof"][-1] = flip(account[-1])
    yield "flip-account", "one bit flipped in the last account node", d
    d = copy.deepcopy(fixture)
    d["proof"]["accountProof"] = account[:-1]
    yield "truncate-account", "the last account node removed", d
    d = copy.deepcopy(fixture)
    root = d["block"]["stateRoot"]
    d["block"]["stateRoot"] = root[:-1] + ("0" if root[-1] != "0" else "1")
    yield "wrong-root", "the header's state root changed by one digit", d


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    binary = ROOT / "target" / "bin" / "ferrotype"
    index = {
        "fe": json.loads((ROOT / "results" / "tests.json").read_text())["fe"],
        "cli_sha256": hashlib.sha256(binary.read_bytes()).hexdigest() if binary.exists() else None,
        "runs": [],
    }
    for name in FIXTURES:
        fixture = json.loads((ROOT / "fixtures" / "mainnet" / f"{name}.json").read_text())
        for damage, what, data in damages(fixture):
            path = OUT / f"{name}--{damage}.json"
            text = json.dumps(data, indent=1) + "\n"
            path.write_text(text, encoding="utf-8", newline="\n")
            rel = path.relative_to(ROOT).as_posix()
            run = subprocess.run(CLI + ["verify", rel], cwd=ROOT, capture_output=True, text=True)
            lines = [l for l in (run.stdout + run.stderr).replace("\r", "").splitlines() if l.strip()]
            reason = None
            for line in lines:
                m = re.search(r"\((Malformed|HashMismatch|MissingNode|ExtraNodes|BadReference)\)", line)
                if m:
                    reason = m.group(1)
            index["runs"].append({
                "fixture": name,
                "damage": damage,
                "what": what,
                "file": path.name,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "command": f"ferrotype verify web/public/runs/{path.name}",
                "exit": run.returncode,
                "accepted": run.returncode == 0,
                "reason": reason,
                "output": lines,
            })
            verdict = "ok" if run.returncode == 0 else (reason or lines[-1] if lines else "?")
            print(f"{name:18} {damage:17} {verdict}")
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {len(index['runs'])} runs to {OUT.relative_to(ROOT).as_posix()}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
