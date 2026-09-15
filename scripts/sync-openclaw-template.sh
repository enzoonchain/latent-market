#!/usr/bin/env bash
# Sync OpenClaw plugin into cli/templates so `npx latent-market` can install it
# without needing the monorepo sibling path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/openclaw-plugin"
DEST="$ROOT/cli/templates/openclaw-plugin"

if [[ ! -f "$SRC/openclaw.plugin.json" ]]; then
  echo "sync-openclaw-template: missing $SRC" >&2
  exit 1
fi

# Ensure dist exists
if [[ ! -f "$SRC/dist/index.js" ]]; then
  npm --prefix "$SRC" install --include=dev
  npm --prefix "$SRC" run build
fi

rm -rf "$DEST"
mkdir -p "$DEST"
# Copy runtime bits only (no node_modules)
cp -R "$SRC/dist" "$DEST/dist"
cp "$SRC/openclaw.plugin.json" "$DEST/"
# Strip devDependencies + dev-only scripts (test/typecheck/build) — this
# package.json ships to every end user via `npx latent-protocol init`, which
# never runs `npm install --include=dev` there; a bare `npm install && npm
# test` in the installed plugin used to immediately fail with "No test
# files found" since test/ and tsconfig*.json aren't shipped at all.
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("'"$SRC"'/package.json", "utf8"));
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.writeFileSync("'"$DEST"'/package.json", JSON.stringify(pkg, null, 2) + "\n");
'
if [[ -d "$SRC/skills" ]]; then
  cp -R "$SRC/skills" "$DEST/skills"
fi
# Tiny README so the template is self-describing
cat > "$DEST/README.md" <<'EOF'
Bundled OpenClaw plugin for `npx github:enzoonchain/latent-market init`
(shortens to `npx latent-market init` once published to npm).
Source of truth: `/openclaw-plugin` in the latent-market repo.
EOF

echo "Synced OpenClaw plugin → $DEST"
