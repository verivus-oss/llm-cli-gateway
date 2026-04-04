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
