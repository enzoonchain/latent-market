"""The flat Hermes plugin `init` installs (cli/templates/hermes-plugin/__init__.py).

It must load in a Hermes venv that has nothing but the stdlib, and it must
never touch a model request or reply: no LLM hooks, no middleware — only the
`/ads` command. The ad surface is the Hermes Desktop status bar
(desktop/plugin.js).
"""

import ast
import importlib.util
import json
import sys
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[1] / "cli" / "templates" / "hermes-plugin" / "__init__.py"
WALLET = "0x" + "ab" * 20


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cfg_dir = tmp_path / ".latent-protocol"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(json.dumps({"wallet": WALLET, "server": "https://srv.example/"}))
    spec = importlib.util.spec_from_file_location("latent_hermes_plugin", TEMPLATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    calls = []

    def fake_post(url, body):
        calls.append((url, body))
        return 200, {"ok": True}

    monkeypatch.setattr(mod, "_post_json", fake_post)
    return mod, calls


class Ctx:
    def __init__(self):
        self.hooks, self.commands, self.middleware = {}, {}, {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_middleware(self, kind, fn):
        self.middleware[kind] = fn


def test_template_imports_only_the_stdlib():
    tree = ast.parse(TEMPLATE.read_text())
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            roots.add(node.module.split(".")[0])
    roots.discard("__future__")
    assert roots <= set(sys.stdlib_module_names), roots - set(sys.stdlib_module_names)


def test_registers_no_llm_hooks_or_middleware(plugin):
    mod, calls = plugin
    ctx = Ctx()
    mod.register(ctx)
    assert ctx.hooks == {}
    assert ctx.middleware == {}
    assert set(ctx.commands) == {"ads"}
    assert calls == []  # loading never talks to the ad server


def test_manifest_declares_no_hooks():
    manifest = (TEMPLATE.parent / "plugin.yaml").read_text()
    assert "provides_hooks: []" in manifest
    assert "transform_llm_output" not in manifest and "pre_llm_call" not in manifest


def test_balance_and_payout_point_at_the_dashboard(plugin):
    mod, calls = plugin
    ctx = Ctx()
    mod.register(ctx)
    for cmd in ("balance", "payout"):
        assert mod.DASHBOARD_URL in ctx.commands["ads"](cmd)
    assert calls == []  # signed-only endpoints are never called unsigned


def test_setup_use_validates_and_saves(plugin, tmp_path):
    mod, _ = plugin
    ctx = Ctx()
    mod.register(ctx)
    assert "Invalid" in ctx.commands["ads"]("setup use 0xdead")
    new = "0x" + "cd" * 20
    assert new in ctx.commands["ads"]("setup use " + new)
    saved = json.loads((tmp_path / ".latent-protocol" / "config.json").read_text())
    assert saved["wallet"] == new and saved["auth"] == "address"


def test_settings_shows_wallet(plugin):
    mod, _ = plugin
    ctx = Ctx()
    mod.register(ctx)
    assert WALLET in ctx.commands["ads"]("settings")
