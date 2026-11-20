#!/usr/bin/env python3
"""Write every number on the website from the files that produce them.

    python3 scripts/render_web.py

Fills, in web/index.html and web/try/index.html:
    <x data-n="NAME">...</x>            the figure NAME (see `figures` below)
    <i data-bar="NAME" style="--w:..">  a gas bar, NAME's share of the largest
    <a data-addr="CONTRACT" href="..">  a Sepolia Etherscan link to a deployment
    <!-- contracts:begin --> .. <!-- contracts:end -->   the deployed contracts
    <!-- txs:begin --> .. <!-- txs:end -->               the recorded Sepolia txs
from results/tests.json, bench/results/gas.json, deployments/sepolia.json,
deployments/sepolia-snapshots.json, web/public/runs/index.json, the wasm
module, the test vectors and the README's measured-cost table. It also copies
the two deployment files to web/public/deployments/, where the app reads them.

So the HTML on disk holds the real numbers (they show without JavaScript and
never flash), and none of them is typed by hand. A marker whose figure is
unknown stops the script.
"""
import html
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PAGES = [WEB / "index.html", WEB / "try" / "index.html"]
ETHERSCAN = "https://sepolia.etherscan.io"


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


rows = load("bench/results/gas.json")["results"]
tests = load("results/tests.json")
dep = load("deployments/sepolia.json")
snaps = load("deployments/sepolia-snapshots.json")
runs = load("web/public/runs/index.json")
manifest = load("web/public/ferrotype.manifest.json")
wasm_bytes = (WEB / "public" / "ferrotype.wasm").stat().st_size
readme = (ROOT / "README.md").read_text(encoding="utf-8")
deploy_sh = (ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")


def gas(impl, case, field="execution_gas"):
    for r in rows:
        if r["implementation"] == impl and r["case"] == case and r.get("status") == "ok":
            return r.get(field)
    return None


def less(ours, theirs):
    return f"{round(100 * (1 - ours / theirs))}%"


def readme_cost(pattern):
    """A percentage from the README's 'Which abstractions are free' table."""
    m = re.search(pattern, readme)
    if not m:
        sys.exit(f"render_web: README has no row matching {pattern!r}")
    return m.group(1)


def short(address):
    return address[:6] + "…" + address[-4:]


def units(raw, decimals):
    whole, frac = divmod(int(raw, 16) if isinstance(raw, str) else int(raw), 10 ** decimals)
    frac = f"{frac:0{decimals}d}".rstrip("0")
    return f"{whole:,}" + (f".{frac}" if frac else "")


# ---- figures ------------------------------------------------------------------

READ, ABSENT = "usdc-holder", "weth-zero-slot"
fe = gas("ferrotype", READ)
vectors = sum(len(json.loads(p.read_text(encoding="utf-8"))) for p in sorted((ROOT / "fixtures" / "synthetic").glob("*.json")))
same = re.search(r"fn every_target_reaches_the_same_(\d+)_verdicts", (ROOT / "ingots" / "conformance" / "src" / "fuzz.fe").read_text(encoding="utf-8"))
unsafe = sum(len(re.findall(r"\bunsafe\b", p.read_text(encoding="utf-8"))) for p in (ROOT / "ingots" / "ferrotype" / "src").rglob("*.fe"))
compiler = tests["fe"]  # "fe 26.6.0 (5b3f96a)"
version = re.match(r"fe (\S+)", compiler).group(1)
demo, usdc = snaps["daos"]["demo"], snaps["daos"]["usdc"]

figures = {
    "fe_gas": f"{fe:,}",
    "lido_gas": f"{gas('lido', READ):,}",
    "op_gas": f"{gas('optimism', READ):,}",
    "curve_gas": f"{gas('curve-xdao', READ):,}",
    "fe_absent": f"{gas('ferrotype', ABSENT):,}",
    "lido_absent": f"{gas('lido', ABSENT):,}",
    "curve_absent": f"{gas('curve-xdao', ABSENT):,}",
    "op_absent": f"{gas('optimism', ABSENT):,}" if gas("optimism", ABSENT) else "cannot",
    "vs_lido": less(fe, gas("lido", READ)),
    "vs_op": less(fe, gas("optimism", READ)),
    "vs_curve": less(fe, gas("curve-xdao", READ)),
    "vs_lido_absent": less(gas("ferrotype", ABSENT), gas("lido", ABSENT)),
    "fe_tx": f"{gas('ferrotype-packed', READ, 'tx_gas'):,}",
    "lido_tx": f"{gas('lido', READ, 'tx_gas'):,}",
    "evm_tests": str(tests["evm_passed"]),
    "native_tests": str(tests["native_passed"]),
    "wasm_checks": str(tests["wasm_passed"]),
    "fuzz_rounds": f"{tests['fuzz_rounds']:,}",
    "fuzz_true": f"{tests['fuzz_true_value']:,}",
    "fuzz_rejected": f"{tests['fuzz_rejected']:,}",
    "fuzz_wrong": f"{tests['fuzz_wrong_value']:,}",
    "vectors": f"{vectors:,}",
    "same_rounds": same.group(1),
    "unsafe": str(unsafe),
    "wasm_bytes": f"{wasm_bytes:,}",
    "wasm_sha": manifest["module"]["sha256"][:12],
    "compiler": compiler.replace("fe ", "Fe ", 1),
    "fe_version": version,
    "fe_build": dep.get("fe", compiler),
    "unchecked": readme_cost(r"arithmetic\(unchecked\)\]`[^|\n]*\|\s*[−-]([\d.]+%)"),
    "observer": readme_cost(r"const WATCHING: bool`[^|\n]*\|\s*\+([\d.]+%)"),
    "observer_ungated": readme_cost(r"generic `Observer`[^|\n]*\|\s*\+([\d.]+%)"),
    "runs": str(len(runs["runs"])),
    "runs_fixtures": str(len({r["fixture"] for r in runs["runs"]})),
    "cli_sha": (runs.get("cli_sha256") or "")[:12],
    "demo_block": f"{demo['block']:,}",
    "usdc_block": f"{usdc['block']:,}",
    "usdc_holders": str(len(usdc["proofs"])),
    "demo_voters": str(len(demo["proofs"])),
}
BARS = ["fe_gas", "lido_gas", "op_gas", "curve_gas", "fe_absent", "lido_absent", "curve_absent"]
widest = max(int(figures[k].replace(",", "")) for k in BARS)
bars = {k: f"{100 * int(figures[k].replace(',', '')) / widest:.2f}".rstrip("0").rstrip(".") + "%" for k in BARS}

# ---- the deployments --------------------------------------------------------------

contracts = dep["contracts"]
CONTRACT_NAMES = [
    ("StateReader", "StateReader", "reads any slot, given a state root"),
    ("PlebisciteDemo", "Plebiscite · DemoToken", "one proposal, three voters"),
    ("DemoToken", "DemoToken", "a plain ERC-20"),
    ("PlebisciteUSDC", "Plebiscite · USDC", "Sepolia USDC, with its flag bit"),
]


def contract_list():
    items = []
    for key, name, _ in CONTRACT_NAMES:
        if key in contracts:
            a = contracts[key]
            items.append(f'        <li><span>{html.escape(name)}</span><a href="{ETHERSCAN}/address/{a}">{short(a)}</a></li>')
    return "\n      <ul>\n" + "\n".join(items) + "\n      </ul>\n      "


# What each recorded transaction did, worded from the files that sent it.
voters = dep.get("voters", {})
weights = {}
for p in demo["proofs"]:
    for who, addr in voters.items():
        if addr.lower() == p["holder"].lower():
            weights[who] = units(p["value"], 18)
moved = re.search(r'transfer\(address,uint256\)" "\$CAROL" (\d+)ether', deploy_sh)
against = set(re.findall(r'(\w+)\) pk=[^;]+; addr=[^;]+; side="--against"', deploy_sh))
moved = moved.group(1) if moved else None


def caption(name):
    if name == "propose":
        return f"Proposal 1 opens, counted at block {demo['block']:,}: the snapshot."
    if name == "transfer_after_snapshot" and moved and "alice" in weights:
        return f"Alice sends {moved} tokens to Carol after the snapshot: her vote still counts {weights['alice']}."
    m = re.match(r"vote_(\w+)$", name)
    if m and m.group(1) in weights:
        who = m.group(1)
        side = "against" if who in against else "for"
        extra = ""
        if who == "carol" and moved:
            extra = f", not the {int(weights['carol'].replace(',', '')) + int(moved):,} she holds after the transfer"
        return f"{who.capitalize()} votes {side} with {weights[who]}{extra}."
    if name == "execute":
        return "The proposal passed and Execute pays it: the one call the treasury can make."
    return None


DEMO_TXS = ["propose", "transfer_after_snapshot", "vote_alice", "vote_bob", "vote_carol", "execute"]


def tx_list():
    txs = dep.get("txs", {})
    items = []
    for name in DEMO_TXS:
        if name in txs and caption(name):
            h = txs[name]
            items.append(
                f'        <li><a href="{ETHERSCAN}/tx/{h}"><span class="tx-h">{h[:10]}…</span></a><span>{html.escape(caption(name))}</span></li>'
            )
    if "execute" not in txs:
        items.append('        <li class="tx-wait"><span class="tx-h">execute</span><span>Not sent yet. Anyone can send it once the vote has closed and the proposal passed.</span></li>')
    return "\n      <ol class=\"txs\">\n" + "\n".join(items) + "\n      </ol>\n      "


# ---- rendering ------------------------------------------------------------------

def render(text, path):
    used = set()

    def fill(m):
        key = m.group("key")
        if key not in figures:
            sys.exit(f"render_web: {path.name} asks for unknown figure {key!r}")
        used.add(key)
        return m.group("open") + html.escape(figures[key]) + m.group("close")

    text = re.sub(r'(?P<open><(?P<tag>[a-z0-9]+)\b[^>]*\bdata-n="(?P<key>[\w-]+)"[^>]*>)[^<]*(?P<close></(?P=tag)>)', fill, text)

    def bar(m):
        key = m.group("key")
        if key not in bars:
            sys.exit(f"render_web: {path.name} asks for unknown bar {key!r}")
        tag = re.sub(r'\sstyle="[^"]*"', "", m.group(0))
        return tag.replace(f'data-bar="{key}"', f'data-bar="{key}" style="--w:{bars[key]}"')

    text = re.sub(r'<[a-z]+\b[^>]*\bdata-bar="(?P<key>\w+)"[^>]*>', bar, text)

    def addr(m):
        key = m.group("key")
        if key not in contracts:
            sys.exit(f"render_web: {path.name} links unknown contract {key!r}")
        tag = re.sub(r'\shref="[^"]*"', f' href="{ETHERSCAN}/address/{contracts[key]}"', m.group("open"))
        body = m.group("body")
        if re.fullmatch(r"0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}", body):
            body = short(contracts[key])
        return tag + body + "</a>"

    text = re.sub(r'(?P<open><a\b[^>]*\bdata-addr="(?P<key>\w+)"[^>]*>)(?P<body>[^<]*)</a>', addr, text)
    text = re.sub(r"(<!-- contracts:begin -->).*?(<!-- contracts:end -->)", lambda m: m.group(1) + contract_list() + m.group(2), text, flags=re.S)
    text = re.sub(r"(<!-- txs:begin -->).*?(<!-- txs:end -->)", lambda m: m.group(1) + tx_list() + m.group(2), text, flags=re.S)
    return text, used


def main():
    for page in PAGES:
        if not page.exists():
            sys.exit(f"render_web: {page.relative_to(ROOT)} is missing")
        text, used = render(page.read_text(encoding="utf-8"), page)
        page.write_text(text, encoding="utf-8", newline="\n")
        print(f"{page.relative_to(ROOT).as_posix()}: {len(used)} figures rendered")
    out = WEB / "public" / "deployments"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("sepolia.json", "sepolia-snapshots.json"):
        shutil.copyfile(ROOT / "deployments" / name, out / name)
    print(f"copied deployments/sepolia.json and sepolia-snapshots.json to web/public/deployments/")
    print("execute tx: " + ("recorded" if "execute" in dep.get("txs", {}) else "not recorded yet"))


if __name__ == "__main__":
    main()
