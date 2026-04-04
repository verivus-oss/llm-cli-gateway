import os
import subprocess
from unittest.mock import patch, MagicMock
import pytest
import llm_gateway.gateway_resolver as resolver_module
from llm_gateway.gateway_resolver import resolve_gateway, check_node_version


@pytest.fixture(autouse=True)
def reset_node_checked():
    """Reset the _node_checked global before each test to prevent state leakage."""
    resolver_module._node_checked = False
    yield
    resolver_module._node_checked = False


class TestResolveGateway:
    def test_gateway_path_env_takes_priority(self, tmp_path):
        fake = tmp_path / "gateway.js"
        fake.write_text("// fake")
        with patch.dict(os.environ, {"GATEWAY_PATH": str(fake)}):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stdout="v20.19.5\n")
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
                        with patch("subprocess.run") as mock_run:
                            mock_run.return_value = MagicMock(returncode=0, stdout="v20.19.5\n")
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
