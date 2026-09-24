import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WB_BLOCK_FILE,
  WB_MARK_START,
  findWorkbenchHtml,
  injectTag,
  isWorkbenchPatched,
  patchWorkbench,
  restoreAllWorkbenches,
  restoreWorkbench,
  syncWorkbenchChecksum,
} from "../src/workbench.js";
import { createHash } from "node:crypto";

// Trimmed copy of Cursor 3.21's workbench.html tail.
const PRISTINE = `<!DOCTYPE html>
<html>
\t<head><meta http-equiv="Content-Security-Policy" content="script-src 'self'; connect-src 'self' http:"/></head>
\t<body aria-label="">
\t</body>

\t<!-- Startup (do not modify order of script tags!) -->
\t<script src="./workbench.js" type="module"></script>
</html>
`;

let home: string;
let prevHome: string | undefined;
let html: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "latent-wb-"));
  process.env.HOME = home;
  const dir = join(home, "app", "out", "vs", "code", "electron-sandbox", "workbench");
  mkdirSync(dir, { recursive: true });
  html = join(dir, "workbench.html");
  writeFileSync(html, PRISTINE);
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workbench patcher", () => {
  it("finds workbench.html under the app root", () => {
    expect(findWorkbenchHtml(join(home, "app"))).toBe(html);
    expect(findWorkbenchHtml(join(home, "nope"))).toBeNull();
  });

  it("adds the script tag after the bootstrap script, without stacking", () => {
    const once = injectTag(PRISTINE);
    expect(injectTag(once)).toBe(once);
    expect(once.indexOf(WB_MARK_START)).toBeGreaterThan(once.indexOf("./workbench.js"));
    expect(once).toContain(`<script src="./${WB_BLOCK_FILE}"></script>`);
  });

  it("patch + restore round-trips byte-exact and removes the sibling file", () => {
    expect(patchWorkbench(html, "/* block */")).toBe("patched");
    expect(isWorkbenchPatched(html)).toBe(true);
    expect(readFileSync(join(dirname(html), WB_BLOCK_FILE), "utf8")).toBe("/* block */");
    expect(patchWorkbench(html, "/* block v2 */")).toBe("patched");
    expect(readFileSync(html, "utf8").split(WB_MARK_START).length).toBe(2);

    expect(restoreWorkbench(html)).toBe(true);
    expect(readFileSync(html, "utf8")).toBe(PRISTINE);
    expect(existsSync(join(dirname(html), WB_BLOCK_FILE))).toBe(false);
  });

  it("after a Cursor update, re-patches on top of the new build (never restores the old one)", () => {
    patchWorkbench(html, "/* block */");
    const updated = PRISTINE.replace("<head>", "<head><!-- v2 -->");
    writeFileSync(html, updated); // the update wiped our tag
    patchWorkbench(html, "/* block */");
    restoreWorkbench(html);
    expect(readFileSync(html, "utf8")).toBe(updated);
  });

  it("rewrites the workbench.html checksum while patched and restores it", () => {
    const product = join(home, "app", "product.json");
    const pristineSum = createHash("sha256").update(PRISTINE).digest("base64").replace(/=+$/, "");
    writeFileSync(
      product,
      `{\n\t"checksums": {\n\t\t"vs/code/electron-sandbox/workbench/workbench.html": "${pristineSum}"\n\t}\n}\n`,
    );
    patchWorkbench(html, "/* block */");
    const patched = JSON.parse(readFileSync(product, "utf8")) as { checksums: Record<string, string> };
    const liveSum = createHash("sha256").update(readFileSync(html)).digest("base64").replace(/=+$/, "");
    expect(patched.checksums["vs/code/electron-sandbox/workbench/workbench.html"]).toBe(liveSum);
    expect(liveSum).not.toBe(pristineSum);
    restoreWorkbench(html);
    const restored = JSON.parse(readFileSync(product, "utf8")) as { checksums: Record<string, string> };
    expect(restored.checksums["vs/code/electron-sandbox/workbench/workbench.html"]).toBe(pristineSum);
    syncWorkbenchChecksum(join(home, "missing.html"));
  });

  it("restoreAllWorkbenches finds patched workbenches without an app root (uninstall path)", () => {
    patchWorkbench(html, "/* block */");
    restoreAllWorkbenches();
    expect(readFileSync(html, "utf8")).toBe(PRISTINE);
  });
});
