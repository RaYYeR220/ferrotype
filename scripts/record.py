#!/usr/bin/env python3
"""Set dotted keys in a JSON file: record.py FILE key value [key value ...]."""
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
pairs = sys.argv[2:]
for key, value in zip(pairs[0::2], pairs[1::2]):
    node = data
    parts = key.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value
path.write_text(json.dumps(data, indent=2) + "\n", newline="\n")
