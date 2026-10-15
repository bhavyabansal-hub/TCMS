#!/usr/bin/env python3
"""Adds staleTime: REFERENCE_STALE_TIME_MS to reference-data useQuery sites.

Handles two shapes:
  multi-line:  queryKey: ['modules', 'tree'],  -> insert staleTime line after
  single-line: useQuery({ queryKey: ['modules', 'tree'], queryFn: x }) -> inline

Also ensures the file imports REFERENCE_STALE_TIME_MS from '@/lib/client/api'.
Idempotent: skips sites that already declare a staleTime in the same options object.
"""
import re
import sys

TARGET_KEYS = ["['modules', 'tree']", "['users', 'options']"]
FILES = [
    "src/components/views/tasks.tsx",
    "src/components/views/activity-log.tsx",
    "src/components/views/test-case-import.tsx",
    "src/components/views/modules.tsx",
    "src/components/views/test-cases.tsx",
    "src/components/views/test-case-detail.tsx",
    "src/components/views/bugs.tsx",
    "src/components/providers.tsx",
]

CONST = "REFERENCE_STALE_TIME_MS"

def ensure_import(text: str) -> str:
    if re.search(r"\b" + CONST + r"\b", text.split("export function", 1)[0].split("export default", 1)[0]) and CONST in text:
        pass  # presence checked below more precisely
    # find existing import from '@/lib/client/api'
    m = re.search(r"import\s*\{([^}]*)\}\s*from\s*'@/lib/client/api'", text)
    if m:
        names = [n.strip() for n in m.group(1).split(",") if n.strip()]
        if CONST not in names:
            names.append(CONST)
            new_import = "import { " + ", ".join(sorted(names)) + " } from '@/lib/client/api'"
            text = text[: m.start()] + new_import + text[m.end():]
    else:
        # add a standalone import after the last existing import line
        lines = text.split("\n")
        last_import = max(i for i, l in enumerate(lines) if l.startswith("import "))
        lines.insert(last_import + 1, "import { " + CONST + " } from '@/lib/client/api'")
        text = "\n".join(lines)
    return text

def process(path: str) -> int:
    with open(path) as f:
        text = f.read()
    changed = 0
    for key in TARGET_KEYS:
        key_pat = re.escape(key)
        # single-line useQuery({...}) containing this key, no staleTime yet
        single = re.compile(r"(useQuery\(\{[^{}\n]*" + key_pat + r"[^{}\n]*?)(\}\))")
        new_single = r"\1, staleTime: " + CONST + r" \2"
        # only if 'staleTime' not already on that line
        def single_sub(m):
            if "staleTime" in m.group(0):
                return m.group(0)
            return re.sub(single, new_single, m.group(0), count=1)
        before = text
        text = single.sub(lambda m: m.group(0) if "staleTime" in m.group(0) else re.sub(single, new_single, m.group(0), count=1), text, count=0)
        if text != before:
            changed += 1
            continue
        # multi-line: insert after the queryKey line if options block lacks staleTime
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if key in line and "queryKey" in line:
                # find end of options object
                j = i
                depth = line.count("{") - line.count("}")
                block = [line]
                while depth > 0 and j + 1 < len(lines):
                    j += 1
                    depth += lines[j].count("{") - lines[j].count("}")
                    block.append(lines[j])
                if any("staleTime" in b for b in block):
                    continue
                indent = re.match(r"\s*", lines[i + 1] if i + 1 < len(lines) else "").group(0)
                lines.insert(i + 1, indent + "staleTime: " + CONST + ",")
                changed += 1
                text = "\n".join(lines)
                break
    if changed:
        text = ensure_import(text)
    with open(path, "w") as f:
        f.write(text)
    return changed

total = 0
for f in FILES:
    n = process(f)
    print(f"{f}: {n} site(s) updated")
    total += n
print(f"TOTAL: {total}")
sys.exit(0)
