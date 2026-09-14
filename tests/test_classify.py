"""Unit tests for the local message categorizer — the privacy invariant is
that only the returned slug, never the input text, should ever be sent
onward."""

from latent_protocol.classify import CATEGORIES, classify


def test_picks_the_category_with_the_most_keyword_hits():
    assert classify("help me fix this react component's tsx props") == "frontend-ui"
    assert classify("write a fastapi endpoint with jwt auth middleware") == "backend"
    assert classify("optimize this postgres query and add an index") == "databases"
    assert classify("deploy this docker container to kubernetes via terraform") == "devops-infra"
    assert classify("write solidity for an erc20 token on base") == "web3-crypto"


def test_falls_back_to_general():
    assert classify("what's a good name for my cat") == "general"
    assert classify("") == "general"
    assert classify(None) == "general"


def test_output_is_always_one_of_the_fixed_slugs_never_the_input():
    secret = "sk-live-abc123 my ssn is 000-00-0000, react app with a fastapi backend"
    result = classify(secret)
    assert secret not in result
    assert result in (*CATEGORIES, "general")
