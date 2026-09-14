/**
 * Local message categorizer.
 *
 * Mirrors the CodeBacks / cli `classify.ts` privacy model: categorization runs
 * entirely on the machine hosting the plugin, over the user's message text,
 * and ONLY the resulting category slug ever leaves the machine (as the
 * ad-request targeting tag). The raw message must never be forwarded as-is —
 * `thinking-inject.ts` and `message-footer.ts` used to send `event.userMessage`
 * / `event.content` verbatim as `context`; this is what replaces that.
 *
 * Kept as a separate copy of `cli/src/classify.ts` (no manifest-file scan,
 * since a gateway plugin has no single project `cwd`) — this package has no
 * dependency on `cli/`, see `tsconfig.json` `rootDir`. Keep the category slugs
 * identical across both so server-side targeting sees one consistent set.
 */

export type Category =
  | "frontend-ui"
  | "backend"
  | "databases"
  | "devops-infra"
  | "ai-ml"
  | "web3-crypto"
  | "mobile"
  | "data-eng"
  | "general";

/** Ordered keyword table — same slugs/words as `cli/src/classify.ts`. */
const KEYWORDS: Record<Exclude<Category, "general">, string[]> = {
  "frontend-ui": [
    "react", "vue", "svelte", "angular", "next", "nuxt", "tailwind", "css",
    "component", "frontend", "ui", "ux", "webpack", "vite", "dom", "jsx", "tsx",
  ],
  backend: [
    "api", "server", "express", "fastapi", "flask", "django", "rails", "spring",
    "endpoint", "rest", "graphql", "grpc", "middleware", "auth", "jwt", "route",
  ],
  databases: [
    "sql", "postgres", "postgresql", "mysql", "sqlite", "mongodb", "mongo",
    "redis", "prisma", "query", "schema", "migration", "index", "orm", "database",
  ],
  "devops-infra": [
    "docker", "kubernetes", "k8s", "terraform", "ansible", "ci", "cd", "pipeline",
    "deploy", "nginx", "aws", "gcp", "azure", "helm", "infra", "devops", "compose",
  ],
  "ai-ml": [
    "llm", "gpt", "openai", "anthropic", "claude", "embedding", "vector", "rag",
    "pytorch", "tensorflow", "model", "training", "inference", "prompt", "agent", "ml",
  ],
  "web3-crypto": [
    "solidity", "ethereum", "evm", "wallet", "web3", "onchain", "contract", "erc20",
    "erc721", "base", "usdc", "x402", "defi", "token", "crypto", "blockchain",
  ],
  mobile: [
    "swift", "swiftui", "kotlin", "android", "ios", "flutter", "dart",
    "react-native", "expo", "xcode", "mobile",
  ],
  "data-eng": [
    "pandas", "spark", "airflow", "etl", "dbt", "kafka", "snowflake", "bigquery",
    "warehouse", "dataframe", "parquet", "pipeline", "analytics",
  ],
};

function scoreText(haystack: string): Map<Category, number> {
  const scores = new Map<Category, number>();
  const lower = haystack.toLowerCase();
  for (const [cat, words] of Object.entries(KEYWORDS) as [
    Exclude<Category, "general">,
    string[],
  ][]) {
    let hits = 0;
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, "g");
      const m = lower.match(re);
      if (m) hits += m.length;
    }
    if (hits) scores.set(cat, hits);
  }
  return scores;
}

/**
 * Classify a chat message into a coarse category slug. Only this slug should
 * ever be sent to the ad server — never `message` itself.
 */
export function classifyMessage(message: string | null | undefined): Category {
  const scores = scoreText(String(message ?? ""));
  let best: Category = "general";
  let bestScore = 0;
  for (const [c, n] of scores) {
    if (n > bestScore) {
      best = c;
      bestScore = n;
    }
  }
  return best;
}
