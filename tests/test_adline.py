from latent_protocol.adline import compose_ad_line, display_url


def test_compose_puts_brand_first():
    assert compose_ad_line("Latent", "The ad marketplace for AI agents") == (
        "Latent — The ad marketplace for AI agents"
    )


def test_display_url_drops_the_scheme():
    assert display_url("https://example.com/audit?ref=latent") == "example.com/audit?ref=latent"
    assert display_url("javascript:alert(1)") == ""
