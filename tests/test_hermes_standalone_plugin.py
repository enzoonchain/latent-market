"""The flat Hermes plugin `init` installs (cli/templates/hermes-plugin/__init__.py).

It must load in a Hermes venv that has nothing but the stdlib, and it must
only ever add a *visible* footer — never inject context the user can't see.
"""

import ast
import importlib.util
import json
import sys
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[1] / "cli" / "templates" / "hermes-plugin" / "__init__.py"
WALLET = "0x" + "ab" * 20
AD = {
    "ad_id": "ad-1",
    "title": "T",
    "body": "Move assets to Base",
    "cta_text": "Bridge now",
    "cta_url": "https://example.com/bridge",
    "earn_amount": 0.0025,
    "impression_token": "imp-tok",
    "click_token": "clk-tok",
}


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in ("ADS_ENABLED", "ADS_WALLET", "ADS_SERVER"):
        monkeypatch.delenv(var, raising=False)
    cfg_dir = tmp_path / ".latent-protocol"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(
        json.dumps({"wallet": WALLET, "server": "https://srv.example/", "frequency": 1})
    )
    spec = importlib.util.spec_from_file_location("latent_hermes_plugin", TEMPLATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    calls = []

    def fake_post(url, body):
        calls.append((url, body))
        if url.endswith("/ad/request"):
            return 200, dict(AD)
        return 200, {"ok": True}

    monkeypatch.setattr(mod, "_post_json", fake_post)
    return mod, calls


class Ctx:
    def __init__(self):
        self.hooks, self.commands = {}, {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_middleware(self, kind, fn):
        self.middleware = getattr(self, "middleware", {})
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


def test_registers_only_the_visible_footer_hook(plugin):
    mod, _ = plugin
    ctx = Ctx()
    mod.register(ctx)
    assert set(ctx.hooks) == {"transform_llm_output"}
    assert set(ctx.middleware) == {"llm_request"}
    assert "ads" in ctx.commands


def test_footer_appended_and_impression_billed(plugin):
    mod, calls = plugin
    ctx = Ctx()
    mod.register(ctx)
    out = ctx.hooks["transform_llm_output"](response_text="pong", session_id="s", platform="cli")
    assert out.startswith("pong\n\n💰 Sponsored: Move assets to Base")
    # The link credits the click server-side, then redirects to the advertiser.
    assert "https://srv.example/ad/click?ad=ad-1&w=" + WALLET + "&t=clk-tok" in out
    urls = [u for u, _ in calls]
    assert urls == ["https://srv.example/ad/request", "https://srv.example/ad/impression"]
    req = calls[0][1]
    assert req["user_wallet"] == WALLET and req["surface"] == "response_footer"
    assert req["context"] == "coding"  # never the conversation text
    assert calls[1][1] == {"ad_id": "ad-1", "user_wallet": WALLET, "token": "imp-tok"}


def test_no_fill_leaves_reply_untouched_and_bills_nothing(plugin, monkeypatch):
    mod, _ = plugin
    calls = []
    monkeypatch.setattr(mod, "_post_json", lambda url, body: (calls.append(url), (204, None))[1])
    ctx = Ctx()
    mod.register(ctx)
    assert ctx.hooks["transform_llm_output"](response_text="pong") is None
    assert all(not u.endswith("/ad/impression") for u in calls)


def test_frequency_and_pause(plugin, tmp_path):
    mod, calls = plugin
    cfg = tmp_path / ".latent-protocol" / "config.json"
    cfg.write_text(json.dumps({"wallet": WALLET, "frequency": 2}))
    ctx = Ctx()
    mod.register(ctx)
    hook = ctx.hooks["transform_llm_output"]
    assert hook(response_text="a") is None
    assert hook(response_text="b").startswith("b")
    ctx.commands["ads"]("off")
    assert hook(response_text="c") is None and hook(response_text="d") is None
    ctx.commands["ads"]("on")


def test_no_wallet_means_no_request(plugin, tmp_path):
    mod, calls = plugin
    (tmp_path / ".latent-protocol" / "config.json").write_text("{}")
    ctx = Ctx()
    mod.register(ctx)
    assert ctx.hooks["transform_llm_output"](response_text="pong") is None
    assert calls == []


def test_markdown_footer_sanitizes_advertiser_text(plugin):
    mod, _ = plugin
    ad = dict(AD, body="evil [link](https://x.example) \x1b[31mred\u202e", click_token="")
    out = mod.format_footer(ad, "markdown", link=mod.click_url(ad, {"server": "https://s", "wallet": WALLET}))
    assert "\x1b" not in out and "\u202e" not in out
    assert "[link]" not in out  # brackets neutralised, no second link
    assert "[Bridge now →](https://example.com/bridge)" in out


def test_unsafe_cta_url_is_not_linked(plugin):
    mod, _ = plugin
    ad = dict(AD, cta_url="javascript:alert(1)", click_token="")
    link = mod.click_url(ad, {"server": "https://s", "wallet": WALLET})
    assert link == ""
    assert "javascript" not in mod.format_footer(ad, "markdown", link=link)


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


def test_history_middleware_hides_footers_from_the_model(plugin):
    """The stored reply keeps the footer for the reader; the model never sees it."""
    mod, _ = plugin
    ctx = Ctx()
    mod.register(ctx)
    replied = ctx.hooks["transform_llm_output"](response_text="pong", platform="cli")
    request = {
        "model": "m",
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "say pong"},
            {"role": "assistant", "content": replied},
            {"role": "assistant", "content": [{"type": "text", "text": "hi" + mod.format_footer(AD, "markdown")}]},
            {"role": "user", "content": "Sponsored: is a word I typed"},
        ],
    }
    out = ctx.middleware["llm_request"](request=request)
    msgs = out["request"]["messages"]
    assert msgs[2]["content"] == "pong"
    assert msgs[3]["content"] == [{"type": "text", "text": "hi"}]
    assert msgs[4]["content"] == "Sponsored: is a word I typed"  # user text untouched
    assert request["messages"][2]["content"] == replied  # caller's copy not mutated
    assert ctx.middleware["llm_request"](request={"messages": [{"role": "assistant", "content": "plain"}]}) is None


def test_history_middleware_handles_responses_api_input(plugin):
    mod, _ = plugin
    req = {"input": [{"role": "assistant", "content": [{"type": "output_text", "text": "ok" + mod.format_footer(AD, "telegram")}]}]}
    out = mod.strip_footers_from_request(req)
    assert out["input"][0]["content"][0]["text"] == "ok"


def test_plugin_still_loads_without_middleware_support(plugin):
    mod, _ = plugin

    class OldCtx:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, fn):
            self.hooks[name] = fn

        def register_command(self, *a, **k):
            pass

    ctx = OldCtx()
    mod.register(ctx)
    assert "transform_llm_output" in ctx.hooks
