#!/usr/bin/env python3
"""Bundle the Ferrotype library and wasm/exports.fe into one standalone file.

Fe's WebAssembly backend compiles a single standalone `.fe` file, so the build
puts each library module inline (`pub mod rlp { ... }`) after the exports. The
module bodies are the library's sources, unchanged: their `ingot::` paths
resolve to the inline modules of the bundle.

Usage: bundle_wasm.py <out.fe>
"""
import pathlib
import sys

MODULES = ["hash", "rlp", "trie", "nodes", "state", "slots"]

root = pathlib.Path(__file__).resolve().parent.parent
lib = root / "ingots" / "ferrotype" / "src"
parts = ["// Bundled by scripts/bundle_wasm.py from wasm/exports.fe and ingots/ferrotype/src.\n"]
parts.append((root / "wasm" / "exports.fe").read_text())
for name in MODULES:
    body = (lib / f"{name}.fe").read_text()
    # Inner doc comments document a file module; an inline module cannot hold them.
    body = "\n".join(line for line in body.splitlines() if not line.startswith("//!"))
    parts.append(f"pub mod {name} {{\n{body}\n}}\n")
out = pathlib.Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(parts), newline="\n")
