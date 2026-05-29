#!/usr/bin/env python3
"""Validate the minimal hashed Python tool requirements used by CI."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REQUIREMENT_RE = re.compile(r"^([A-Za-z0-9_.-]+)==")
BANNED_PACKAGES = {"bandit", "llm", "ruff"}
REQUIRED_PACKAGES = {"zizmor"}


def parse_packages(path: Path) -> set[str]:
    packages: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = REQUIREMENT_RE.match(line.strip())
        if match:
            packages.add(match.group(1).lower().replace("_", "-"))
    return packages


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_security_requirements.py <requirements-file>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    packages = parse_packages(path)

    banned = sorted(packages & BANNED_PACKAGES)
    if banned:
        print(f"banned packages in {path}: {', '.join(banned)}", file=sys.stderr)
        return 1

    missing = sorted(REQUIRED_PACKAGES - packages)
    if missing:
        print(f"required packages missing from {path}: {', '.join(missing)}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
