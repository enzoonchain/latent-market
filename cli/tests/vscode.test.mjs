/**
 * VS Code / Cursor surface: extension-id correctness, installed-dir detection,
 * and the scan row shape. The editor-bound half (download + `--install-extension`)
 * is network- and machine-side-effect territory and stays out of unit tests.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/vscode.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scanner = await import("../dist/scanners/vscode.js");
const surface = await import("../dist/surfaces/vscode.js");

test("extension id matches vscode-extension/package.json (publisher.name)", () => {
  assert.equal(
    scanner.VSCODE_EXTENSION_ID,
    "latent-protocol.latent-protocol-vscode",
  );
  assert.equal(
    surface.vscodeExtensionId(),
    "latent-protocol.latent-protocol-vscode",
  );
});

test("isLatentExtensionDir matches the unpacked folder, not the old wrong id", () => {
  assert.equal(
    scanner.isLatentExtensionDir("latent-protocol.latent-protocol-vscode-0.2.0"),
    true,
  );
  assert.equal(
    scanner.isLatentExtensionDir("latent-protocol.latent-protocol-vscode"),
    true,
  );
  assert.equal(scanner.isLatentExtensionDir("latentprotocol.vscode-0.1.0"), false);
  assert.equal(scanner.isLatentExtensionDir("ms-python.python-2024.0.0"), false);
});

test("detectVscode returns the detection shape", () => {
  const det = scanner.detectVscode();
  assert.ok(
    det.editor === "vscode" || det.editor === "cursor" || det.editor === null,
  );
  assert.equal(typeof det.installed, "boolean");
  assert.ok(det.bin === null || typeof det.bin === "string");
  assert.ok(det.extensionsDir === null || typeof det.extensionsDir === "string");
});

test("scanVscode is a zero-billable AgentScanResult row", () => {
  const row = scanner.scanVscode(30);
  for (const key of [
    "agent",
    "label",
    "detected",
    "sessions",
    "userTurns",
    "thinkingStates",
    "billableSlots",
    "detail",
  ]) {
    assert.ok(key in row, `missing ${key}`);
  }
  assert.equal(row.label, "VS Code / Cursor");
  assert.equal(row.billableSlots, 0);
  assert.equal(typeof row.detail, "string");
});

test("vscodeStatus always names the surface and never throws", () => {
  assert.match(surface.vscodeStatus(), /^VS Code \/ Cursor/);
});

test("missing editor fails closed without touching the machine", async () => {
  if (scanner.detectEditors().length > 0) {
    // Editor present: covered by the fake-editor subprocess test below.
    assert.equal(surface.vscodeDetected(), true);
    return;
  }
  assert.equal(surface.vscodeDetected(), false);
  assert.equal(
    await surface.installVscode(),
    "❌ VS Code / Cursor not found — install the editor first.",
  );
  assert.match(await surface.uninstallVscode(), /nothing to remove/);
});

test("pickVsixRelease takes the newest vscode-v* release that has the VSIX (not releases/latest)", () => {
  const asset = (name) => ({ name, browser_download_url: `https://dl/${name}` });
  const releases = [
    { tag_name: "cli-v0.1.5", assets: [asset("latent-protocol-0.1.5.tgz")] },
    { tag_name: "vscode-v0.3.0", draft: true, assets: [asset(surface.VSIX_ASSET)] },
    { tag_name: "vscode-v0.2.1", assets: [] },
    {
      tag_name: "vscode-v0.2.0",
      assets: [asset(surface.VSIX_ASSET), asset(`${surface.VSIX_ASSET}.sha256`)],
    },
  ];
  assert.deepEqual(surface.pickVsixRelease(releases), {
    url: `https://dl/${surface.VSIX_ASSET}`,
    sha256Url: `https://dl/${surface.VSIX_ASSET}.sha256`,
    tag: "vscode-v0.2.0",
  });
  assert.equal(surface.pickVsixRelease(releases.slice(0, 3)), null);
});

test("release workflow uploads the asset name the CLI looks for", () => {
  const wf = readFileSync(new URL("../../.github/workflows/vscode-release.yml", import.meta.url), "utf8");
  assert.match(wf, new RegExp(`-o ${surface.VSIX_ASSET.replace(/\./g, "\\.")}`));
  assert.match(wf, /startsWith\(github\.event\.release\.tag_name, 'vscode-v'\)/);
});

// Runs installVscode in a child process with a fake HOME and a fake `cursor`
// CLI first on PATH, so no real editor is ever touched.
function runWithFakeCursor(env) {
  const dir = mkdtempSync(join(tmpdir(), "latent-vscode-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "home", ".cursor", "extensions"), { recursive: true });
  const log = join(dir, "calls.log");
  writeFileSync(join(bin, "cursor"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  const vsix = join(dir, "x.vsix");
  writeFileSync(vsix, "fake-vsix-bytes");
  const sha = createHash("sha256").update("fake-vsix-bytes").digest("hex");
  const surfaceUrl = new URL("../dist/surfaces/vscode.js", import.meta.url).href;
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(surfaceUrl)}); console.log(await m.installVscode());`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(dir, "home"),
        PATH: `${bin}:/usr/bin:/bin`,
        LATENT_VSIX_URL: vsix,
        LATENT_VSIX_SHA256: env.sha === "good" ? sha : "0".repeat(64),
      },
    },
  );
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { out: res.stdout + res.stderr, calls };
}

test("installs the checksum-verified VSIX through the editor CLI", () => {
  const { out, calls } = runWithFakeCursor({ sha: "good" });
  assert.match(out, /Cursor: latent-protocol\.latent-protocol-vscode installed/);
  assert.match(calls, /^--install-extension .*latent-protocol-vscode\.vsix --force$/m);
});

test("a checksum mismatch installs nothing", () => {
  const { out, calls } = runWithFakeCursor({ sha: "bad" });
  assert.match(out, /checksum mismatch/);
  assert.equal(calls, "");
});
