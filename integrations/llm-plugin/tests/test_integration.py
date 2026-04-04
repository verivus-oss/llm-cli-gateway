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
        assert len(result.stdout.strip()) > 0

    def test_gateway_codex_hello(self):
        """Smoke test: send a simple prompt through gateway-codex."""
        result = subprocess.run(
            ["llm", "-m", "gateway-codex", "Reply with exactly: GATEWAY_OK"],
            capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert len(result.stdout.strip()) > 0

    def test_gateway_gemini_hello(self):
        """Smoke test: send a simple prompt through gateway-gemini."""
        result = subprocess.run(
            ["llm", "-m", "gateway-gemini", "Reply with exactly: GATEWAY_OK"],
            capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert len(result.stdout.strip()) > 0

    def test_logs_contain_gateway_response(self):
        """Verify the response appears in llm logs."""
        result = subprocess.run(
            ["llm", "logs", "-n", "1", "--json"],
            capture_output=True, text=True, timeout=10
        )
        assert result.returncode == 0
        assert "gateway" in result.stdout.lower()
