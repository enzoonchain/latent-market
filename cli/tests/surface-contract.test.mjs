/**
 * Block-system surface contract (docs/BLOCK_SYSTEM_CLIENT.md, C1).
 *
 * The server maps the reported `surface` to an ambient (CLI) or premium (IDE)
 * block, and the IDE extension bills as `agent="claude-code"` just like the
 * CLI — so the surface string alone decides the block. The CLI must never
 * send an IDE surface, and the extension must never send a CLI one.
 *
 *   node --test cli/tests/surface-contract.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PREMIUM = new Set(["spinner", "statusbar", "cursor", "overlay", "webui_thinking"]);

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function reportedSurfaces(dir) {
  const found = [];
  for (const file of sources(dir)) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bsurface:\s*"([a-z_]+)"/g)) {
      found.push({ file: file.slice(root.length), surface: m[1] });
    }
  }
  return found;
}

test("the CLI only ever reports ambient surfaces", () => {
  const found = reportedSurfaces(join(root, "cli", "src"));
  assert.ok(found.length > 0, "expected the CLI to report a surface somewhere");
  for (const { file, surface } of found) {
    assert.ok(!PREMIUM.has(surface), `${file} reports premium surface "${surface}"`);
  }
});

test("the IDE extension only ever reports premium surfaces", () => {
  const found = reportedSurfaces(join(root, "vscode-extension", "src"));
  assert.ok(found.length > 0, "expected the extension to report a surface somewhere");
  for (const { file, surface } of found) {
    assert.ok(PREMIUM.has(surface), `${file} reports non-premium surface "${surface}"`);
  }
});
