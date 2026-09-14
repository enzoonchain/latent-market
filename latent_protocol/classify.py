"""Local prompt/message categorizer.

Mirrors the CodeBacks / ``cli/src/classify.ts`` privacy model: categorization
runs entirely on the machine hosting the adapter, over the user's message
text, and ONLY the resulting category slug is meant to ever leave the
machine as the ad-request targeting tag.

Every adapter in this package (``hermes.py``, ``telegram.py``, ``cli.py``,
``unified.py``, ``claude_code.py``) funnels through ``delivery.reserve_ad()``,
which used to forward its ``context`` argument to ``/ad/request`` verbatim —
several call sites pass the raw user message or assistant response text as
that argument (their own docstrings show ``context=user_msg`` /
``context=update.message.text``). ``reserve_ad`` now classifies before
sending; this module is that classifier. Keep the category slugs identical to
``cli/src/classify.ts`` so server-side targeting sees one consistent set.
"""

import re

Category = str  # one of CATEGORIES, or "general"

CATEGORIES = (
    "frontend-ui",
    "backend",
    "databases",
    "devops-infra",
    "ai-ml",
    "web3-crypto",
    "mobile",
    "data-eng",
)

_KEYWORDS: dict[str, tuple[str, ...]] = {
    "frontend-ui": (
        "react", "vue", "svelte", "angular", "next", "nuxt", "tailwind", "css",
        "component", "frontend", "ui", "ux", "webpack", "vite", "dom", "jsx", "tsx",
    ),
    "backend": (
        "api", "server", "express", "fastapi", "flask", "django", "rails", "spring",
        "endpoint", "rest", "graphql", "grpc", "middleware", "auth", "jwt", "route",
    ),
    "databases": (
        "sql", "postgres", "postgresql", "mysql", "sqlite", "mongodb", "mongo",
        "redis", "prisma", "query", "schema", "migration", "index", "orm", "database",
    ),
    "devops-infra": (
        "docker", "kubernetes", "k8s", "terraform", "ansible", "ci", "cd", "pipeline",
        "deploy", "nginx", "aws", "gcp", "azure", "helm", "infra", "devops", "compose",
    ),
    "ai-ml": (
        "llm", "gpt", "openai", "anthropic", "claude", "embedding", "vector", "rag",
        "pytorch", "tensorflow", "model", "training", "inference", "prompt", "agent", "ml",
    ),
    "web3-crypto": (
        "solidity", "ethereum", "evm", "wallet", "web3", "onchain", "contract", "erc20",
        "erc721", "base", "usdc", "x402", "defi", "token", "crypto", "blockchain",
    ),
    "mobile": (
        "swift", "swiftui", "kotlin", "android", "ios", "flutter", "dart",
        "react-native", "expo", "xcode", "mobile",
    ),
    "data-eng": (
        "pandas", "spark", "airflow", "etl", "dbt", "kafka", "snowflake", "bigquery",
        "warehouse", "dataframe", "parquet", "pipeline", "analytics",
    ),
}

_WORD_RE_CACHE: dict[str, re.Pattern] = {}


def _hits(lower_text: str, word: str) -> int:
    pattern = _WORD_RE_CACHE.get(word)
    if pattern is None:
        pattern = re.compile(rf"(^|[^a-z0-9]){re.escape(word)}([^a-z0-9]|$)")
        _WORD_RE_CACHE[word] = pattern
    return len(pattern.findall(lower_text))


def classify(text: str | None) -> str:
    """Classify free text into a coarse category slug (default ``"general"``).

    Only this slug should ever be sent to the ad server as ``context`` —
    never ``text`` itself.
    """
    lower = str(text or "").lower()
    best = "general"
    best_score = 0
    for category, words in _KEYWORDS.items():
        score = sum(_hits(lower, w) for w in words)
        if score > best_score:
            best = category
            best_score = score
    return best
