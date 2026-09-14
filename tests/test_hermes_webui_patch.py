"""Tests for hermes-webui DOM patch helpers."""

from __future__ import annotations

from pathlib import Path

from latent_protocol.adapters import hermes_webui as hw


def test_patch_and_unpatch_roundtrip(tmp_path: Path):
    static = tmp_path / "static"
    static.mkdir()
    index = static / "index.html"
    index.write_text(
        "<html><body><div id='app' data-hermes-webui='1'></div>"
        "<!-- hermes-webui --></body></html>",
        encoding="utf-8",
    )

    msg = hw.patch(
        server="https://api.latentprotocol.xyz",
        wallet="0x" + "ab" * 20,
        frequency=1,
        static_dir=static,
    )
    assert "Patched:" in msg
    html = index.read_text(encoding="utf-8")
    assert hw._MARKER in html
    assert "api.latentprotocol.xyz" in html
    assert "webui_thinking" in html
    assert "latent-ad-footer" in html
    assert "</body>" in html

    # force re-patch replaces (does not duplicate)
    hw.patch(
        server="https://api.example.test",
        wallet="0x" + "cd" * 20,
        frequency=1,
        static_dir=static,
        force=True,
    )
    html2 = index.read_text(encoding="utf-8")
    assert html2.count(hw._MARKER) == 1
    assert "api.example.test" in html2

    msg_u = hw.unpatch(static)
    assert "Unpatched:" in msg_u
    assert hw._MARKER not in index.read_text(encoding="utf-8")


def test_find_static_respects_env(tmp_path: Path, monkeypatch):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text(
        "<html><body><!-- hermes-webui --></body></html>",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("HERMES_WEBUI_STATIC", str(static))
    monkeypatch.delenv("HERMES_WEBUI_ROOT", raising=False)
    monkeypatch.delenv("HERMES_WEBUI_DIR", raising=False)
    assert hw._find_static() == static.resolve()


# ── Injected JS: escaping + local classification (no JS runtime here, so this
# asserts on the source text itself — a browser/e2e test would be the real
# regression guard, but this at least catches the raw-interpolation pattern
# from silently coming back). ──


def test_injected_js_escapes_ad_text_before_innerhtml():
    js = hw._AD_JS
    assert "_esc(ad.body" in js
    assert "_esc(ad.cta_text" in js
    assert "_esc(parseFloat(ad.earn_amount)" in js
    # the old raw-concatenation pattern must be gone
    assert "+ (ad.body || ad.title || '') +" not in js


def test_injected_js_gates_cta_url_through_a_safety_check_before_href():
    js = hw._AD_JS
    assert "_isSafeUrl(ad.cta_url)" in js
    assert '\'<a href="\' + _esc(ad.cta_url)' in js
    assert "'<a href=\"' + ad.cta_url +" not in js


def test_injected_js_classifies_context_locally_instead_of_sending_raw_text():
    js = hw._AD_JS
    assert "context: _classify(ctx)" in js
    assert "'thinking').slice(0, 100)" not in js
    # the classifier must exist and cover the same category slugs as
    # latent_protocol/classify.py
    for slug in ("frontend-ui", "backend", "databases", "devops-infra", "ai-ml", "web3-crypto"):
        assert f"'{slug}'" in js
