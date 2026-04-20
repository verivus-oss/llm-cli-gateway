# llm-gateway Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python plugin for Simon Willison's `llm` CLI tool that registers `gateway-claude`, `gateway-codex`, and `gateway-gemini` as model providers, routing requests through the llm-cli-gateway MCP server.

**Architecture:** The plugin spawns the gateway as a one-shot child process per `execute()` call, speaks MCP JSON-RPC (NDJSON framing) over stdio, extracts structured metadata from responses, and maps it into `llm`'s native logging. Gateway resolution: `GATEWAY_PATH` env -> `llm-cli-gateway` on PATH -> bundled `gateway.js`.

**Tech Stack:** Python 3.9+, llm >= 0.19, subprocess (stdlib), json (stdlib), Pydantic (via llm.Options)

**Spec:** `docs/superpowers/specs/2026-04-04-simon-willison-integration-design.md`

---

## File Structure

```
integrations/llm-plugin/
├── pyproject.toml                    # Package metadata, entry point, package_data
├── llm_gateway/
│   ├── __init__.py                   # @llm.hookimpl register_models hook
│   ├── models.py                     # GatewayClaude, GatewayCodex, GatewayGemini model classes
│   ├── mcp_client.py                 # MCP JSON-RPC stdio client (NDJSON framing)
│   ├── gateway_resolver.py           # Find gateway binary (env -> PATH -> bundled)
│   └── options.py                    # Options Pydantic model + gateway_args validation
├── tests/
│   ├── conftest.py                   # Shared fixtures (mock gateway process)
│   ├── test_options.py               # Options parsing, gateway_args validation
│   ├── test_gateway_resolver.py      # Resolution order, Node.js detection
│   ├── test_mcp_client.py            # NDJSON framing, lifecycle, error handling
│   ├── test_models.py                # Model registration, execute(), metadata mapping
│   └── test_integration.py           # End-to-end with real gateway (optional, slow)
└── README.md                         # Plugin-specific docs
```

---

### Task 1: Scaffold the Python package

**Files:**
- Create: `integrations/llm-plugin/pyproject.toml`
- Create: `integrations/llm-plugin/llm_gateway/__init__.py`
- Create: `integrations/llm-plugin/README.md`

- [ ] **Step 1: Create pyproject.toml**

```toml
[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "llm-gateway"
version = "0.1.0"
description = "llm plugin for multi-LLM orchestration via llm-cli-gateway"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.9"
dependencies = ["llm>=0.19"]

[project.entry-points.llm]
gateway = "llm_gateway"

[tool.setuptools.packages.find]
include = ["llm_gateway*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Create `__init__.py` with placeholder hook**

```python
import llm


@llm.hookimpl
def register_models(register):
    pass  # Models added in Task 5
```

- [ ] **Step 3: Create README.md**

```markdown
# llm-gateway

An [llm](https://llm.datasette.io/) plugin that provides access to Claude, Codex, and Gemini
through the [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) MCP server.

## Installation

```bash
llm install llm-gateway
```

## Usage

```bash
llm -m gateway-claude "Explain this function"
llm -m gateway-codex "Implement a binary search"
llm -m gateway-gemini "Review this code for bugs"
```

## Requirements

- Node.js 18+ (for the gateway runtime)
- At least one of: Claude Code CLI, Codex CLI, Gemini CLI
```

- [ ] **Step 4: Install in development mode and verify registration**

Run:
```bash
cd integrations/llm-plugin && pip install -e .
llm plugins
```
Expected: `llm-gateway` appears in the plugin list.

- [ ] **Step 5: Commit**

```bash
git add integrations/llm-plugin/
git commit -m "feat(llm-plugin): scaffold Python package with entry point"
```

---

### Task 2: Options module

**Files:**
- Create: `integrations/llm-plugin/llm_gateway/options.py`
- Create: `integrations/llm-plugin/tests/test_options.py`
- Create: `integrations/llm-plugin/tests/conftest.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/conftest.py`:
```python
# Shared fixtures — populated in later tasks
```

Create `tests/test_options.py`:
```python
import json
import pytest
from llm_gateway.options import GatewayOptions, validate_gateway_args, RESERVED_KEYS


class TestGatewayOptions:
    def test_defaults(self):
        opts = GatewayOptions()
        assert opts.show_thinking is False
        assert opts.timeout == 300000
        assert opts.optimize_prompt is False
        assert opts.session_mode == "off"
        assert opts.gateway_args is None

    def test_custom_values(self):
        opts = GatewayOptions(show_thinking=True, timeout=60000, session_mode="gateway")
        assert opts.show_thinking is True
        assert opts.timeout == 60000
        assert opts.session_mode == "gateway"

    def test_invalid_session_mode_rejected(self):
        with pytest.raises(Exception):
            GatewayOptions(session_mode="invalid")

    def test_extra_fields_rejected(self):
        with pytest.raises(Exception):
            GatewayOptions(unknown_field="value")


class TestValidateGatewayArgs:
    def test_none_returns_empty_dict(self):
        assert validate_gateway_args(None) == {}

    def test_valid_json(self):
        result = validate_gateway_args('{"fullAuto": true}')
        assert result == {"fullAuto": True}

    def test_invalid_json_raises(self):
        with pytest.raises(ValueError, match="Invalid JSON"):
            validate_gateway_args("not json")

    def test_reserved_key_raises(self):
        for key in RESERVED_KEYS:
            with pytest.raises(ValueError, match="Reserved"):
                validate_gateway_args(json.dumps({key: "value"}))

    def test_non_dict_raises(self):
        with pytest.raises(ValueError, match="must be a JSON object"):
            validate_gateway_args('"just a string"')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_options.py -v`
Expected: ImportError — `llm_gateway.options` does not exist.

- [ ] **Step 3: Implement options.py**

```python
from __future__ import annotations

import json
from typing import Optional

import llm
from pydantic import Field, field_validator


RESERVED_KEYS = frozenset({
    "prompt", "model", "sessionId", "createNewSession", "correlationId"
})

PLUGIN_PRECEDENCE_KEYS = frozenset({"optimizePrompt", "idleTimeoutMs"})


def validate_gateway_args(raw: Optional[str]) -> dict:
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in gateway_args: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("gateway_args must be a JSON object, not " + type(parsed).__name__)
    conflicts = RESERVED_KEYS & set(parsed)
    if conflicts:
        raise ValueError(f"Reserved keys in gateway_args: {', '.join(sorted(conflicts))}")
    return parsed


class GatewayOptions(llm.Options):
    show_thinking: bool = Field(default=False, description="Include reasoning blocks inline")
    timeout: int = Field(default=300000, description="Request timeout in milliseconds")
    optimize_prompt: bool = Field(default=False, description="Apply gateway token optimization")
    session_mode: str = Field(default="off", description="Session mode: off or gateway")
    gateway_args: Optional[str] = Field(default=None, description="Raw JSON merged into MCP tool call")

    @field_validator("session_mode")
    @classmethod
    def check_session_mode(cls, v: str) -> str:
        if v not in ("off", "gateway"):
            raise ValueError(f"session_mode must be 'off' or 'gateway', got '{v}'")
        return v
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_options.py -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add integrations/llm-plugin/llm_gateway/options.py integrations/llm-plugin/tests/
git commit -m "feat(llm-plugin): add GatewayOptions with gateway_args validation"
```

---

### Task 3: Gateway resolver

**Files:**
- Create: `integrations/llm-plugin/llm_gateway/gateway_resolver.py`
- Create: `integrations/llm-plugin/tests/test_gateway_resolver.py`

- [ ] **Step 1: Write the failing tests**

```python
import os
import subprocess
from unittest.mock import patch, MagicMock
import pytest
from llm_gateway.gateway_resolver import resolve_gateway, check_node_version


class TestResolveGateway:
    def test_gateway_path_env_takes_priority(self, tmp_path):
        fake = tmp_path / "gateway.js"
        fake.write_text("// fake")
        with patch.dict(os.environ, {"GATEWAY_PATH": str(fake)}):
            cmd = resolve_gateway()
        assert cmd == ["node", str(fake)]

    def test_gateway_path_env_missing_file_raises(self):
        with patch.dict(os.environ, {"GATEWAY_PATH": "/nonexistent/gateway.js"}):
            with pytest.raises(FileNotFoundError):
                resolve_gateway()

    def test_llm_cli_gateway_on_path(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GATEWAY_PATH", None)
            with patch("shutil.which", return_value="/usr/local/bin/llm-cli-gateway"):
                cmd = resolve_gateway()
        assert cmd == ["llm-cli-gateway"]

    def test_bundled_fallback(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GATEWAY_PATH", None)
            with patch("shutil.which", return_value=None):
                with patch("llm_gateway.gateway_resolver._bundled_gateway_path") as mock_bp:
                    mock_bp.return_value = "/fake/bundled/gateway.js"
                    with patch("os.path.isfile", return_value=True):
                        cmd = resolve_gateway()
                assert cmd == ["node", "/fake/bundled/gateway.js"]

    def test_nothing_found_raises(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GATEWAY_PATH", None)
            with patch("shutil.which", return_value=None):
                with patch("llm_gateway.gateway_resolver._bundled_gateway_path") as mock_bp:
                    mock_bp.return_value = "/fake/bundled/gateway.js"
                    with patch("os.path.isfile", return_value=False):
                        with pytest.raises(RuntimeError, match="Node.js 18"):
                            resolve_gateway()


class TestCheckNodeVersion:
    def test_valid_version(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="v20.19.5\n")
            check_node_version()  # Should not raise

    def test_old_version_raises(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="v16.20.0\n")
            with pytest.raises(RuntimeError, match="18"):
                check_node_version()

    def test_node_not_found_raises(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            with pytest.raises(RuntimeError, match="Node.js"):
                check_node_version()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_gateway_resolver.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement gateway_resolver.py**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_gateway_resolver.py -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add integrations/llm-plugin/llm_gateway/gateway_resolver.py integrations/llm-plugin/tests/test_gateway_resolver.py
git commit -m "feat(llm-plugin): add gateway resolver with Node.js version check"
```

---

### Task 4: MCP client

**Files:**
- Create: `integrations/llm-plugin/llm_gateway/mcp_client.py`
- Create: `integrations/llm-plugin/tests/test_mcp_client.py`

- [ ] **Step 1: Write the failing tests**

```python
import json
import subprocess
from unittest.mock import patch, MagicMock
import pytest
from llm_gateway.mcp_client import McpClient, McpError


def _ndjson(*messages):
    """Build raw NDJSON bytes from a list of dicts."""
    return b"".join(json.dumps(m).encode() + b"\n" for m in messages)


class TestMcpClient:
    def test_call_tool_success(self):
        init_response = {"jsonrpc": "2.0", "id": 1, "result": {"capabilities": {}}}
        tool_response = {
            "jsonrpc": "2.0", "id": 2,
            "result": {
                "content": [{"type": "text", "text": "Hello from gateway"}],
                "structuredContent": {
                    "model": "sonnet", "cli": "claude", "correlationId": "abc-123",
                    "sessionId": None, "durationMs": 1500, "exitCode": 0, "retryCount": 0
                }
            }
        }
        shutdown_response = {"jsonrpc": "2.0", "id": 3, "result": {}}
        stdout_data = _ndjson(init_response, tool_response, shutdown_response)

        mock_proc = MagicMock()
        mock_proc.stdout = stdout_data
        mock_proc.stderr = b""
        mock_proc.returncode = 0
        mock_proc.wait.return_value = 0

        with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            client = McpClient(["node", "gateway.js"])
            result = client.call_tool("claude_request", {"prompt": "hello"})

        assert result["text"] == "Hello from gateway"
        assert result["structured"]["correlationId"] == "abc-123"

    def test_call_tool_error_response(self):
        init_response = {"jsonrpc": "2.0", "id": 1, "result": {"capabilities": {}}}
        tool_response = {
            "jsonrpc": "2.0", "id": 2,
            "result": {
                "isError": True,
                "content": [{"type": "text", "text": "CLI not found"}],
                "structuredContent": {"correlationId": "abc", "exitCode": 1, "errorCategory": "spawn_error"}
            }
        }
        shutdown_response = {"jsonrpc": "2.0", "id": 3, "result": {}}
        stdout_data = _ndjson(init_response, tool_response, shutdown_response)

        mock_proc = MagicMock()
        mock_proc.stdout = stdout_data
        mock_proc.stderr = b""
        mock_proc.returncode = 0
        mock_proc.wait.return_value = 0

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"])
            with pytest.raises(McpError, match="CLI not found"):
                client.call_tool("claude_request", {"prompt": "hello"})

    def test_process_crash_raises(self):
        mock_proc = MagicMock()
        mock_proc.stdout = b""
        mock_proc.stderr = b"Segfault\n"
        mock_proc.returncode = 139
        mock_proc.wait.return_value = 139

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"])
            with pytest.raises(McpError, match="Gateway process"):
                client.call_tool("claude_request", {"prompt": "hello"})

    def test_timeout_kills_process(self):
        mock_proc = MagicMock()
        mock_proc.stdout = b""
        mock_proc.stderr = b""
        mock_proc.wait.side_effect = subprocess.TimeoutExpired(cmd="node", timeout=5)
        mock_proc.kill.return_value = None
        mock_proc.returncode = -9

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"], timeout_ms=5000)
            with pytest.raises(McpError, match="timed out"):
                client.call_tool("claude_request", {"prompt": "hello"})
        mock_proc.kill.assert_called_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_mcp_client.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement mcp_client.py**

```python
from __future__ import annotations

import json
import subprocess
import sys
from typing import Any


class McpError(Exception):
    """Raised when the MCP gateway returns an error or the process fails."""

    def __init__(self, message: str, correlation_id: str | None = None, exit_code: int | None = None):
        super().__init__(message)
        self.correlation_id = correlation_id
        self.exit_code = exit_code


class McpClient:
    """One-shot MCP JSON-RPC client over stdio (NDJSON framing)."""

    def __init__(self, command: list[str], timeout_ms: int = 300_000):
        self._command = command
        self._timeout_s = timeout_ms / 1000.0

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        messages = self._build_messages(tool_name, arguments)
        stdin_bytes = b"".join(json.dumps(m).encode() + b"\n" for m in messages)

        proc = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        try:
            stdout, stderr = proc.communicate(input=stdin_bytes, timeout=self._timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise McpError(f"Gateway process timed out after {self._timeout_s:.0f}s")

        if not stdout:
            raise McpError(
                f"Gateway process exited with code {proc.returncode}: {stderr.decode(errors='replace').strip()}"
            )

        responses = self._parse_responses(stdout)
        return self._extract_tool_result(responses)

    def _build_messages(self, tool_name: str, arguments: dict[str, Any]) -> list[dict]:
        return [
            # 1. initialize
            {
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "llm-gateway-plugin", "version": "0.1.0"}
                }
            },
            # 2. notifications/initialized
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            # 3. tools/call
            {
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments}
            },
            # 4. shutdown
            {"jsonrpc": "2.0", "id": 3, "method": "shutdown"},
        ]

    def _parse_responses(self, stdout: bytes) -> dict[int, dict]:
        responses: dict[int, dict] = {}
        for line in stdout.split(b"\n"):
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print(f"[llm-gateway] Ignoring non-JSON line: {line!r}", file=sys.stderr)
                continue
            if "id" in msg and "result" in msg:
                responses[msg["id"]] = msg
        return responses

    def _extract_tool_result(self, responses: dict[int, dict]) -> dict[str, Any]:
        if 2 not in responses:
            raise McpError("Gateway process did not return a tool result")

        result = responses[2].get("result", {})
        content_list = result.get("content", [])
        text = content_list[0]["text"] if content_list else ""
        structured = result.get("structuredContent", {})
        is_error = result.get("isError", False)

        if is_error:
            raise McpError(
                text,
                correlation_id=structured.get("correlationId"),
                exit_code=structured.get("exitCode"),
            )

        return {"text": text, "structured": structured}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_mcp_client.py -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add integrations/llm-plugin/llm_gateway/mcp_client.py integrations/llm-plugin/tests/test_mcp_client.py
git commit -m "feat(llm-plugin): add MCP JSON-RPC stdio client with NDJSON framing"
```

---

### Task 5: Model classes

**Files:**
- Create: `integrations/llm-plugin/llm_gateway/models.py`
- Modify: `integrations/llm-plugin/llm_gateway/__init__.py`
- Create: `integrations/llm-plugin/tests/test_models.py`

- [ ] **Step 1: Write the failing tests**

```python
import json
from unittest.mock import patch, MagicMock
import pytest
import llm
from llm_gateway.models import GatewayClaude, GatewayCodex, GatewayGemini


class TestModelRegistration:
    def test_model_ids(self):
        assert GatewayClaude.model_id == "gateway-claude"
        assert GatewayCodex.model_id == "gateway-codex"
        assert GatewayGemini.model_id == "gateway-gemini"

    def test_models_registered_in_llm(self):
        model_ids = [m.model_id for m in llm.get_models()]
        assert "gateway-claude" in model_ids
        assert "gateway-codex" in model_ids
        assert "gateway-gemini" in model_ids

    def test_can_stream_is_false(self):
        assert GatewayClaude.can_stream is False


class TestExecute:
    def _mock_call_tool(self, text="response text", structured=None):
        return {
            "text": text,
            "structured": structured or {
                "model": "sonnet", "cli": "claude", "correlationId": "test-123",
                "sessionId": None, "durationMs": 2000,
                "inputTokens": 50, "outputTokens": 100,
                "exitCode": 0, "retryCount": 0
            }
        }

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_execute_yields_response_text(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool("Hello world")

        model = GatewayClaude()
        prompt = MagicMock()
        prompt.prompt = "test prompt"
        prompt.system = None
        prompt.options = MagicMock()
        prompt.options.show_thinking = False
        prompt.options.timeout = 300000
        prompt.options.optimize_prompt = False
        prompt.options.session_mode = "off"
        prompt.options.gateway_args = None
        response = MagicMock()

        chunks = list(model.execute(prompt, False, response, None))
        assert chunks == ["Hello world"]

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_execute_sets_usage(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool(structured={
            "model": "sonnet", "cli": "claude", "correlationId": "test-123",
            "sessionId": None, "durationMs": 2000,
            "inputTokens": 50, "outputTokens": 100,
            "exitCode": 0, "retryCount": 0
        })

        model = GatewayClaude()
        prompt = MagicMock()
        prompt.prompt = "test"
        prompt.system = None
        prompt.options = MagicMock()
        prompt.options.show_thinking = False
        prompt.options.timeout = 300000
        prompt.options.optimize_prompt = False
        prompt.options.session_mode = "off"
        prompt.options.gateway_args = None
        response = MagicMock()

        list(model.execute(prompt, False, response, None))
        response.set_usage.assert_called_once_with(input=50, output=100)

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_execute_sets_response_json(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool(structured={
            "model": "sonnet", "cli": "claude", "correlationId": "test-123",
            "sessionId": "sess-1", "durationMs": 2000,
            "inputTokens": 50, "outputTokens": 100,
            "exitCode": 0, "retryCount": 0
        })

        model = GatewayClaude()
        prompt = MagicMock()
        prompt.prompt = "test"
        prompt.system = None
        prompt.options = MagicMock()
        prompt.options.show_thinking = False
        prompt.options.timeout = 300000
        prompt.options.optimize_prompt = False
        prompt.options.session_mode = "off"
        prompt.options.gateway_args = None
        response = MagicMock()
        response.response_json = None

        list(model.execute(prompt, False, response, None))
        assert response.response_json["correlation_id"] == "test-123"
        assert response.response_json["gateway_session_id"] == "sess-1"
        assert response.response_json["duration_ms"] == 2000

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_codex_maps_to_codex_request(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool()

        model = GatewayCodex()
        prompt = MagicMock()
        prompt.prompt = "test"
        prompt.system = None
        prompt.options = MagicMock()
        prompt.options.show_thinking = False
        prompt.options.timeout = 300000
        prompt.options.optimize_prompt = False
        prompt.options.session_mode = "off"
        prompt.options.gateway_args = None
        response = MagicMock()

        list(model.execute(prompt, False, response, None))
        instance.call_tool.assert_called_once()
        call_args = instance.call_tool.call_args
        assert call_args[0][0] == "codex_request"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_models.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement models.py**

```python
from __future__ import annotations

import sys
from typing import Iterator, Optional

import llm

from .gateway_resolver import resolve_gateway
from .mcp_client import McpClient, McpError
from .options import GatewayOptions, validate_gateway_args, PLUGIN_PRECEDENCE_KEYS


_CAMEL_TO_SNAKE = {
    "correlationId": "correlation_id",
    "sessionId": "gateway_session_id",
    "model": "model",
    "cli": "cli",
    "durationMs": "duration_ms",
    "inputTokens": "input_tokens",
    "outputTokens": "output_tokens",
    "exitCode": "exit_code",
    "retryCount": "retry_count",
    "thinkingBlocks": "thinking_blocks",
}


def _map_structured_to_response_json(structured: dict) -> dict:
    return {
        snake: structured.get(camel)
        for camel, snake in _CAMEL_TO_SNAKE.items()
        if structured.get(camel) is not None
    }


class _GatewayModel(llm.Model):
    can_stream = False
    Options = GatewayOptions

    # Subclasses set these
    _cli: str
    _tool_name: str

    def execute(
        self,
        prompt: llm.Prompt,
        stream: bool,
        response: llm.Response,
        conversation: Optional[llm.Conversation],
    ) -> Iterator[str]:
        opts: GatewayOptions = prompt.options
        gateway_cmd = resolve_gateway()

        # Build tool arguments
        args: dict = {"prompt": prompt.prompt}
        if prompt.system:
            args["system"] = prompt.system
        if opts.optimize_prompt:
            args["optimizePrompt"] = True

        # Merge gateway_args (escape hatch)
        try:
            extra = validate_gateway_args(opts.gateway_args)
        except ValueError as exc:
            raise llm.ModelError(str(exc))
        # gateway_args keys first, then plugin-owned keys override
        for key, value in extra.items():
            if key not in PLUGIN_PRECEDENCE_KEYS:
                args[key] = value
        # Plugin-owned keys always win
        if opts.optimize_prompt:
            args["optimizePrompt"] = True

        # Session handling
        if opts.session_mode == "gateway" and conversation:
            prev_responses = conversation.responses
            if prev_responses:
                last_json = prev_responses[-1].response_json
                if last_json and "gateway_session_id" in last_json:
                    args["sessionId"] = last_json["gateway_session_id"]
                else:
                    args["createNewSession"] = True
                    print(
                        "[llm-gateway] No prior gateway_session_id found, creating new session",
                        file=sys.stderr,
                    )
            else:
                args["createNewSession"] = True
        elif opts.session_mode == "gateway":
            args["createNewSession"] = True

        # Execute
        client = McpClient(gateway_cmd, timeout_ms=opts.timeout)
        try:
            result = client.call_tool(self._tool_name, args)
        except McpError as exc:
            raise llm.ModelError(str(exc))

        text = result["text"]
        structured = result.get("structured", {})

        # Set usage metadata
        input_tokens = structured.get("inputTokens")
        output_tokens = structured.get("outputTokens")
        if input_tokens is not None or output_tokens is not None:
            response.set_usage(input=input_tokens, output=output_tokens)

        # Set resolved model
        resolved_model = structured.get("model")
        if resolved_model:
            response.set_resolved_model(resolved_model)

        # Set response_json (camelCase -> snake_case mapping)
        response.response_json = _map_structured_to_response_json(structured)

        yield text


class GatewayClaude(_GatewayModel):
    model_id = "gateway-claude"
    _cli = "claude"
    _tool_name = "claude_request"


class GatewayCodex(_GatewayModel):
    model_id = "gateway-codex"
    _cli = "codex"
    _tool_name = "codex_request"


class GatewayGemini(_GatewayModel):
    model_id = "gateway-gemini"
    _cli = "gemini"
    _tool_name = "gemini_request"
```

- [ ] **Step 4: Update `__init__.py` to register models**

```python
import llm

from .models import GatewayClaude, GatewayCodex, GatewayGemini


@llm.hookimpl
def register_models(register):
    register(GatewayClaude())
    register(GatewayCodex())
    register(GatewayGemini())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_models.py -v`
Expected: All pass.

- [ ] **Step 6: Verify models appear in llm**

Run: `llm models list | grep gateway`
Expected:
```
gateway-claude
gateway-codex
gateway-gemini
```

- [ ] **Step 7: Commit**

```bash
git add integrations/llm-plugin/llm_gateway/models.py integrations/llm-plugin/llm_gateway/__init__.py integrations/llm-plugin/tests/test_models.py
git commit -m "feat(llm-plugin): add gateway model classes with MCP integration"
```

---

### Task 6: End-to-end smoke test

**Files:**
- Create: `integrations/llm-plugin/tests/test_integration.py`

- [ ] **Step 1: Write the integration test**

```python
import subprocess
import pytest


pytestmark = pytest.mark.slow


class TestEndToEnd:
    def test_gateway_claude_hello(self):
        """Smoke test: send a simple prompt through gateway-claude."""
        result = subprocess.run(
            ["llm", "-m", "gateway-claude", "Reply with exactly: GATEWAY_OK"],
            capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "GATEWAY_OK" in result.stdout or len(result.stdout) > 0

    def test_gateway_codex_hello(self):
        """Smoke test: send a simple prompt through gateway-codex."""
        result = subprocess.run(
            ["llm", "-m", "gateway-codex", "Reply with exactly: GATEWAY_OK"],
            capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert len(result.stdout) > 0

    def test_gateway_gemini_hello(self):
        """Smoke test: send a simple prompt through gateway-gemini."""
        result = subprocess.run(
            ["llm", "-m", "gateway-gemini", "Reply with exactly: GATEWAY_OK"],
            capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert len(result.stdout) > 0

    def test_logs_contain_gateway_response(self):
        """Verify the response appears in llm logs."""
        result = subprocess.run(
            ["llm", "logs", "-n", "1", "--json"],
            capture_output=True, text=True, timeout=10
        )
        assert result.returncode == 0
        assert "gateway" in result.stdout.lower() or len(result.stdout) > 0
```

- [ ] **Step 2: Run unit tests (fast) to ensure nothing broke**

Run: `cd integrations/llm-plugin && python -m pytest tests/ -v --ignore=tests/test_integration.py`
Expected: All pass.

- [ ] **Step 3: Run integration tests (slow, requires real CLIs)**

Run: `cd integrations/llm-plugin && python -m pytest tests/test_integration.py -v -m slow --timeout=300`
Expected: At least `test_gateway_claude_hello` passes (Codex/Gemini depend on those CLIs being installed).

- [ ] **Step 4: Commit**

```bash
git add integrations/llm-plugin/tests/test_integration.py
git commit -m "test(llm-plugin): add end-to-end smoke tests"
```

---

### Task 7: README update — "For Fans of Simon Willison"

**Files:**
- Modify: `llm-cli-gateway/README.md` (add philosophy section)

- [ ] **Step 1: Add the section to README.md**

Add after the existing content, before any footer/license section:

```markdown
## For Fans of Simon Willison

Simon's `llm` tool made it trivially easy to talk to any LLM from the command line. But as
AI-assisted development matures, the challenge shifts from "how do I call a model" to "how do I
orchestrate multiple models reliably, and what did they actually do?"

**Multiple models increase the confidence factor.** When Claude writes code, Codex reviews it, and
Gemini checks for bugs -- each bringing different training data and reasoning patterns -- the result
is more robust than any single model alone. And often this isn't even enough. Having the models do
iterative reviews is where you start getting real confidence.

**Every interaction should be queryable data.** Inspired by `llm`'s SQLite logging philosophy, the
gateway records every request and response to a local SQLite database. Not just prompts and responses
-- retry counts, circuit breaker states, approval decisions, thinking blocks, cost estimates. Open it
with Datasette and you have a complete operational picture of your AI usage:

    datasette ~/.llm-cli-gateway/logs.db

**The `llm-gateway` plugin bridges both worlds.** Install it, and your existing `llm` workflows gain
orchestration features without changing how you work:

    llm install llm-gateway
    llm -m gateway-claude "explain this function"

Your gateway interactions appear in both `llm logs` (for your personal history) and the gateway's
flight recorder (for operational observability). Two audiences, one workflow.

**Composability over monoliths.** The gateway doesn't replace `llm` -- it complements it. Use `llm`
directly when you want simplicity. Route through the gateway when you want resilience, multi-model
coordination, or detailed operational telemetry. The plugin is the bridge, not the destination.
```

- [ ] **Step 2: Verify rendering**

Run: `head -n 5 README.md && echo "..." && grep -A2 "For Fans" README.md | head -5`
Expected: Section appears correctly formatted.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add 'For Fans of Simon Willison' section to README"
```

---

### Task 8: Final verification and push

- [ ] **Step 1: Run gateway build and tests**

Run:
```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
npm run build && npm test
```
Expected: Build passes, 284 tests pass.

- [ ] **Step 2: Run plugin tests**

Run:
```bash
cd integrations/llm-plugin
python -m pytest tests/ -v --ignore=tests/test_integration.py
```
Expected: All unit tests pass.

- [ ] **Step 3: Verify models appear in llm**

Run: `llm models list | grep gateway`
Expected: Three models listed.

- [ ] **Step 4: Manual smoke test**

Run: `llm -m gateway-claude "Say hello in exactly 3 words"`
Expected: A response appears (may take 5-15 seconds due to one-shot gateway startup + CLI execution).

- [ ] **Step 5: Push**

```bash
git push origin master
```
