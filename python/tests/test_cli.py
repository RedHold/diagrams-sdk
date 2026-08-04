"""CLI surface: `diagrams-so login|logout|whoami`.

The device flow itself is covered in test_login.py; these assert the command
wiring, argument handling, and that failures exit non-zero with a useful line.
"""
import json
import os
import sys

import pytest

from diagrams_so import cli


def test_help_and_version(capsys):
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert "diagrams-so login" in out and "whoami" in out

    assert cli.main(["--help"]) == 0
    assert cli.main(["--version"]) == 0
    assert cli.main(["version"]) == 0


def test_unknown_command_exits_nonzero(capsys):
    assert cli.main(["frobnicate"]) == 1
    err = capsys.readouterr().err
    assert "Unknown command" in err


def test_unknown_option_exits_nonzero(capsys):
    assert cli.main(["logout", "--wat"]) == 1
    assert "Unknown option" in capsys.readouterr().err


def test_base_url_requires_a_value():
    with pytest.raises(SystemExit):
        cli.main(["whoami", "--base-url"])


def test_whoami_not_connected(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DIAGRAMS_API_KEY", raising=False)
    assert cli.main(["whoami"]) == 1
    assert "Not connected" in capsys.readouterr().err


def test_logout_is_idempotent(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert cli.main(["logout"]) == 0
    assert cli.main(["logout"]) == 0
    assert "Disconnected" in capsys.readouterr().out


def test_whoami_prefers_env_over_cache(tmp_path, monkeypatch, capsys):
    """Same precedence the SDK and MCP server use: env beats a stored login."""
    monkeypatch.setenv("HOME", str(tmp_path))
    d = tmp_path / ".diagrams-so"
    d.mkdir()
    (d / "credentials.json").write_text(json.dumps({
        "version": 1, "api_key": "dgz_live_cached", "scope": "", "livemode": True,
        "auth_method": "device", "created_at": "2026-08-04T00:00:00Z",
        "expires_at": None, "base_url": "https://api.diagrams.so/api/v2",
    }))
    monkeypatch.setenv("DIAGRAMS_API_KEY", "dgz_live_fromenv")

    seen = {}

    class FakeClient:
        def __init__(self, api_key=None, base_url=None):
            seen["key"] = api_key

        def me(self):
            return {"email": "e@x.io", "livemode": True}

    monkeypatch.setattr(cli, "DiagramsClient", FakeClient)
    assert cli.main(["whoami"]) == 0
    assert seen["key"] == "dgz_live_fromenv"
    assert "env (DIAGRAMS_API_KEY)" in capsys.readouterr().out


def test_console_script_is_declared():
    """pyproject must expose the command, or `pip install` gives no CLI."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    text = (root / "pyproject.toml").read_text()
    assert "[project.scripts]" in text
    assert 'diagrams-so = "diagrams_so.cli:main"' in text
