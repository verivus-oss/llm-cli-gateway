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
    """One-shot MCP JSON-RPC client over stdio (NDJSON framing).

    Sends all handshake messages (initialize, notifications/initialized,
    tools/call, shutdown) in a single stdin write, then reads all responses
    from stdout.  This works because the MCP StdioServerTransport processes
    messages sequentially off the same stream.
    """

    def __init__(self, command: list[str], timeout_ms: int = 300_000):
        self._command = command
        self._timeout_s = timeout_ms / 1000.0

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Invoke a single MCP tool and return ``{"text": ..., "structured": ...}``.

        Raises:
            McpError: If the gateway returns an error result, crashes, or times out.
        """
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
                f"Gateway process exited with code {proc.returncode}: "
                f"{stderr.decode(errors='replace').strip()}"
            )

        responses = self._parse_responses(stdout)
        return self._extract_tool_result(responses)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_messages(self, tool_name: str, arguments: dict[str, Any]) -> list[dict[str, Any]]:
        """Build the four MCP messages required for a single tool call."""
        return [
            # 1. initialize – negotiate protocol version and capabilities
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "llm-gateway-plugin", "version": "0.1.0"},
                },
            },
            # 2. notifications/initialized – confirm ready (no id = notification)
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            # 3. tools/call – the actual request
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments},
            },
            # 4. shutdown – signal orderly exit
            {"jsonrpc": "2.0", "id": 3, "method": "shutdown"},
        ]

    def _parse_responses(self, stdout: bytes) -> dict[int, dict[str, Any]]:
        """Parse NDJSON stdout into a mapping of request-id → response object."""
        responses: dict[int, dict[str, Any]] = {}
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

    def _extract_tool_result(self, responses: dict[int, dict[str, Any]]) -> dict[str, Any]:
        """Extract the tool call result (id=2) from parsed responses.

        Returns:
            ``{"text": str, "structured": dict}``

        Raises:
            McpError: If the tool result is missing or ``isError`` is true.
        """
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
