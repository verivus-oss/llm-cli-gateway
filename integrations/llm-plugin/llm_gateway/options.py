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
    """Validate and parse a JSON string intended for gateway_args.

    Returns an empty dict when *raw* is None. Raises ValueError on malformed
    JSON, non-object payloads, or payloads that contain reserved keys that
    would conflict with fields the plugin manages itself.
    """
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in gateway_args: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(
            "gateway_args must be a JSON object, not " + type(parsed).__name__
        )
    conflicts = RESERVED_KEYS & set(parsed)
    if conflicts:
        raise ValueError(
            f"Reserved keys in gateway_args: {', '.join(sorted(conflicts))}"
        )
    return parsed


class GatewayOptions(llm.Options):
    """Options for llm-gateway model instances."""

    show_thinking: bool = Field(
        default=False,
        description="Include reasoning blocks inline in the response",
    )
    timeout: int = Field(
        default=300_000,
        description="Request timeout in milliseconds (default: 300 000 ms / 5 min)",
    )
    optimize_prompt: bool = Field(
        default=False,
        description="Apply gateway token optimisation to the outbound prompt",
    )
    session_mode: str = Field(
        default="off",
        description="Session continuity mode: 'off' (stateless) or 'gateway' (MCP-managed)",
    )
    gateway_args: Optional[str] = Field(
        default=None,
        description=(
            "Raw JSON object merged verbatim into the MCP tool call. "
            "Must not contain reserved keys: "
            + ", ".join(sorted(RESERVED_KEYS))
        ),
    )

    @field_validator("session_mode")
    @classmethod
    def check_session_mode(cls, v: str) -> str:
        allowed = ("off", "gateway")
        if v not in allowed:
            raise ValueError(
                f"session_mode must be one of {allowed!r}, got '{v}'"
            )
        return v
