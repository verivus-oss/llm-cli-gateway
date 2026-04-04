from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path


_node_checked = False


def _bundled_gateway_path() -> str:
    return str(Path(__file__).parent / "bundled" / "gateway.js")


def check_node_version() -> None:
    global _node_checked
    if _node_checked:
        return
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True, text=True, timeout=10
        )
    except FileNotFoundError:
        raise RuntimeError(
            "Node.js 18+ is required but 'node' was not found on PATH. "
            "Install from https://nodejs.org/"
        )
    if result.returncode != 0:
        raise RuntimeError(f"node --version failed: {result.stderr.strip()}")
    match = re.match(r"v(\d+)", result.stdout.strip())
    if not match:
        raise RuntimeError(f"Could not parse Node.js version from: {result.stdout.strip()}")
    major = int(match.group(1))
    if major < 18:
        raise RuntimeError(
            f"Node.js 18+ is required, found v{major}. "
            "Upgrade from https://nodejs.org/"
        )
    _node_checked = True


def resolve_gateway() -> list[str]:
    # 1. GATEWAY_PATH env var
    env_path = os.environ.get("GATEWAY_PATH")
    if env_path:
        if not os.path.isfile(env_path):
            raise FileNotFoundError(f"GATEWAY_PATH points to missing file: {env_path}")
        check_node_version()
        return ["node", env_path]

    # 2. llm-cli-gateway on PATH (npm-installed)
    on_path = shutil.which("llm-cli-gateway")
    if on_path:
        return ["llm-cli-gateway"]

    # 3. Bundled gateway.js
    bundled = _bundled_gateway_path()
    if os.path.isfile(bundled):
        check_node_version()
        return ["node", bundled]

    # 4. Nothing found
    raise RuntimeError(
        "llm-cli-gateway not found. Install via: npm install -g llm-cli-gateway\n"
        "Node.js 18+ is required. Install from https://nodejs.org/"
    )
