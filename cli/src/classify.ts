/**
 * Local prompt/project categorizer.
 *
 * Mirrors the CodeBacks privacy model: categorization runs entirely on the
 * user's machine over the prompt text and the project's manifest files, and
 * ONLY the resulting category slug ever leaves the machine (as the ad-request
 * targeting tag). Raw prompt text and source code never go to the ad server.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Ordered keyword table — first category with the most hits wins. */
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

/** Manifest files we scan (dependency names are strong signals). */
const MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
];

function readManifestText(cwd: string): string {
  const parts: string[] = [];
  for (const name of MANIFESTS) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      parts.push(readFileSync(p, "utf8"));
    } catch {
      // ignore unreadable manifest
    }
  }
  return parts.join("\n");
}

function scoreText(haystack: string): Map<Category, number> {
  const scores = new Map<Category, number>();
  const lower = haystack.toLowerCase();
  for (const [cat, words] of Object.entries(KEYWORDS) as [
    Exclude<Category, "general">,
    string[],
  ][]) {
    let hits = 0;
    for (const w of words) {
      // Word-ish boundary so "ml" doesn't match "html".
      const re = new RegExp(`(?:^|[^a-z0-9])${w}(?=[^a-z0-9]|$)`, "g");
      const m = lower.match(re);
      if (m) hits += m.length;
    }
    if (hits) scores.set(cat, hits);
  }
  return scores;
}

/**
 * Classify a turn into a coarse category slug. `prompt` is the user's message;
 * `cwd` (default: process.cwd) is scanned for manifest files. Manifest hits are
 * weighted higher than prompt hits because they describe the whole project.
 */
export function classifyPrompt(prompt: string, cwd: string = process.cwd()): Category {
  const promptScores = scoreText(prompt || "");
  const manifestScores = scoreText(readManifestText(cwd));

  const total = new Map<Category, number>();
  for (const [c, n] of promptScores) total.set(c, (total.get(c) ?? 0) + n);
  for (const [c, n] of manifestScores) total.set(c, (total.get(c) ?? 0) + n * 2);

  let best: Category = "general";
  let bestScore = 0;
  for (const [c, n] of total) {
    if (n > bestScore) {
      best = c;
      bestScore = n;
    }
  }
  return best;
}
