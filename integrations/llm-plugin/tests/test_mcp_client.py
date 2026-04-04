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
        mock_proc.communicate.return_value = (stdout_data, b"")
        mock_proc.returncode = 0

        with patch("subprocess.Popen", return_value=mock_proc):
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
        mock_proc.communicate.return_value = (stdout_data, b"")
        mock_proc.returncode = 0

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"])
            with pytest.raises(McpError, match="CLI not found"):
                client.call_tool("claude_request", {"prompt": "hello"})

    def test_process_crash_raises(self):
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = (b"", b"Segfault\n")
        mock_proc.returncode = 139

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"])
            with pytest.raises(McpError, match="Gateway process"):
                client.call_tool("claude_request", {"prompt": "hello"})

    def test_timeout_kills_process(self):
        mock_proc = MagicMock()
        mock_proc.communicate.side_effect = subprocess.TimeoutExpired(cmd="node", timeout=5)
        mock_proc.kill.return_value = None
        mock_proc.wait.return_value = -9

        with patch("subprocess.Popen", return_value=mock_proc):
            client = McpClient(["node", "gateway.js"], timeout_ms=5000)
            with pytest.raises(McpError, match="timed out"):
                client.call_tool("claude_request", {"prompt": "hello"})
        mock_proc.kill.assert_called_once()
