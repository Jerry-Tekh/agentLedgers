#!/usr/bin/env python3
"""
Deep-check: cross-reference the contract's real ABI (from genvm-lint schema)
against every functionName + arg-count used in the frontend and SDK. This
catches typos in function names and wrong argument counts -- the two classes
of bug that wouldn't be caught by TypeScript (functionName is a plain
string, args is a plain array; nothing types-checks them against the
contract's actual signature).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "agentledger.py"
FILES_TO_CHECK = [
    ROOT / "frontend" / "src" / "lib" / "contract.ts",
    ROOT / "sdk" / "src" / "client.ts",
]

def get_schema():
    result = subprocess.run(
        ["genvm-lint", "schema", str(CONTRACT), "--json"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)["schema"]

def find_calls(text: str):
    """Find every `"function_name", [arg, arg, ...]` call-site pattern --
    covers both frontend/lib/contract.ts's `write(client, address, "name", [...])`
    / `read(client, address, "name", [...])` helpers and the SDK's
    `this.write("name", [...], ...)` / `this.read("name", [...])` methods.
    """
    calls = []
    for m in re.finditer(r'"([a-z_]+)"\s*,\s*\[([^\]]*)\]', text):
        name = m.group(1)
        raw = m.group(2).strip()
        arg_count = 0 if raw == "" else len([a for a in split_top_level(raw) if a.strip()])
        calls.append((name, arg_count))
    return calls

def split_top_level(s: str):
    """Split on commas not nested inside (), [], {}."""
    parts, depth, current = [], 0, ""
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return parts

def main():
    schema = get_schema()
    methods = schema["methods"]
    errors = []
    checked = 0

    for path in FILES_TO_CHECK:
        text = path.read_text()
        calls = find_calls(text)
        for name, arg_count in calls:
            checked += 1
            if name not in methods:
                errors.append(f"{path.relative_to(ROOT)}: calls '{name}' -- NOT FOUND in contract ABI")
                continue
            expected = len(methods[name]["params"])
            if arg_count is None:
                errors.append(f"{path.relative_to(ROOT)}: calls '{name}' -- could not statically determine arg count, needs manual check")
            elif arg_count != expected:
                errors.append(
                    f"{path.relative_to(ROOT)}: calls '{name}' with {arg_count} args, "
                    f"contract expects {expected} ({[p[0] for p in methods[name]['params']]})"
                )

    print(f"Checked {checked} call sites across {len(FILES_TO_CHECK)} files against {len(methods)} contract methods.")
    if errors:
        print(f"\n{len(errors)} MISMATCH(ES):")
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)
    else:
        print("All call sites match the contract ABI exactly (name + arg count).")

        # Also report which contract methods are never called anywhere, as a coverage note.
        all_called = {name for path in FILES_TO_CHECK for name, _ in find_calls(path.read_text())}
        uncalled = set(methods) - all_called
        if uncalled:
            print(f"\nContract methods with no frontend/SDK call site: {sorted(uncalled)}")

if __name__ == "__main__":
    main()
