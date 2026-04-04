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
