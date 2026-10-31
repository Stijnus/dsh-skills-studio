#!/usr/bin/env python3
"""Extract the durable DSH model skill catalog from a session log (evidence helper).

DSH stores session logs as multi-frame zstd JSONL. The durable catalog message is a
user-role message whose text contains <available_skills>...</available_skills>.
This script decompresses every frame and prints/writes that block exactly as the
model received it (no re-escaping).

Usage:
  python3 extract-catalog.py <session.v4.jsonl.zstd> [out.txt]

Requires the `zstandard` Python module (present on this machine: 0.25.0).
Read-only: the session log is never modified.
"""
import json
import pathlib
import re
import sys

import zstandard


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    log_path = pathlib.Path(argv[1]).expanduser()
    raw = log_path.read_bytes()
    text = zstandard.ZstdDecompressor().stream_reader(raw, read_across_frames=True).read().decode("utf8", "replace")
    found = None
    for line in text.split("\n"):
        if "available_skills" not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        def walk(node):
            if isinstance(node, str):
                if "<available_skills>" in node:
                    yield node
            elif isinstance(node, dict):
                for value in node.values():
                    yield from walk(value)
            elif isinstance(node, list):
                for value in node:
                    yield from walk(value)

        for candidate in walk(obj):
            match = re.search(r"<available_skills>(.*?)</available_skills>", candidate, re.S)
            if match:
                found = match.group(1)
                break
        if found is not None:
            break
    if found is None:
        print("no <available_skills> catalog found in session log", file=sys.stderr)
        return 1
    print(f"catalog bytes: {len(found)}")
    names = re.findall(r"^- `([^`]+)`: ", found, re.M)
    print(f"catalog entries: {len(names)}")
    if len(argv) > 2:
        pathlib.Path(argv[2]).write_text(found)
        print(f"wrote {argv[2]}")
    else:
        print(found)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
