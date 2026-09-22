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
  const det = scanner.detectVscode();
  if (det.editor !== null) {
    // Editor present: install/uninstall would hit the network or the editor
    // CLI — covered by manual runs, not unit tests.
    assert.equal(surface.vscodeDetected(), true);
    return;
  }
  assert.equal(surface.vscodeDetected(), false);
  assert.equal(
    await surface.installVscode(),
    "❌ VS Code / Cursor not found — install the editor first.",
  );
  assert.equal(await surface.uninstallVscode(), "❌ VS Code / Cursor not found.");
});
