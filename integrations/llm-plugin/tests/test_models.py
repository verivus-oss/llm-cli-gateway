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
    def _make_prompt_mock(self, text="test prompt", system=None, **option_overrides):
        prompt = MagicMock()
        prompt.prompt = text
        prompt.system = system
        opts = MagicMock()
        opts.show_thinking = option_overrides.get("show_thinking", False)
        opts.timeout = option_overrides.get("timeout", 300000)
        opts.optimize_prompt = option_overrides.get("optimize_prompt", False)
        opts.session_mode = option_overrides.get("session_mode", "off")
        opts.gateway_args = option_overrides.get("gateway_args", None)
        prompt.options = opts
        return prompt

    def _mock_call_tool_result(self, text="response text", structured=None):
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
        instance.call_tool.return_value = self._mock_call_tool_result("Hello world")

        model = GatewayClaude()
        prompt = self._make_prompt_mock()
        response = MagicMock()
        response.response_json = None

        chunks = list(model.execute(prompt, False, response, None))
        assert chunks == ["Hello world"]

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_execute_sets_usage(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool_result()

        model = GatewayClaude()
        prompt = self._make_prompt_mock()
        response = MagicMock()
        response.response_json = None

        list(model.execute(prompt, False, response, None))
        response.set_usage.assert_called_once_with(input=50, output=100)

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_execute_sets_response_json(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool_result(structured={
            "model": "sonnet", "cli": "claude", "correlationId": "test-123",
            "sessionId": "sess-1", "durationMs": 2000,
            "inputTokens": 50, "outputTokens": 100,
            "exitCode": 0, "retryCount": 0
        })

        model = GatewayClaude()
        prompt = self._make_prompt_mock()
        response = MagicMock()
        response.response_json = None

        list(model.execute(prompt, False, response, None))
        assert response.response_json["correlation_id"] == "test-123"
        assert response.response_json["gateway_session_id"] == "sess-1"
        assert response.response_json["duration_ms"] == 2000

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_codex_uses_codex_request_tool(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool_result()

        model = GatewayCodex()
        prompt = self._make_prompt_mock()
        response = MagicMock()
        response.response_json = None

        list(model.execute(prompt, False, response, None))
        call_args = instance.call_tool.call_args
        assert call_args[0][0] == "codex_request"

    @patch("llm_gateway.models.resolve_gateway", return_value=["llm-cli-gateway"])
    @patch("llm_gateway.models.McpClient")
    def test_gemini_uses_gemini_request_tool(self, MockClient, mock_resolve):
        instance = MockClient.return_value
        instance.call_tool.return_value = self._mock_call_tool_result()

        model = GatewayGemini()
        prompt = self._make_prompt_mock()
        response = MagicMock()
        response.response_json = None

        list(model.execute(prompt, False, response, None))
        call_args = instance.call_tool.call_args
        assert call_args[0][0] == "gemini_request"
