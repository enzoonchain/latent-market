import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patch, relaxCsp, restore, type AgentBundle } from "../src/patcher.js";

// Shapes taken from an installed Claude Code 2.1.278.
const MONACO_TOKENIZER = 'tokenizer:{root:[[/child-src/,"string.quote"],[/connect-src/,"string.quote"],[/default-src/,"string.quote"]]}';
const HOST_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-{{NONCE}}\'; img-src data:;">';

describe("relaxCsp", () => {
  it("leaves a /connect-src/ regex literal untouched (it used to become a SyntaxError)", () => {
    const js = `var t={${MONACO_TOKENIZER}};`;
    expect(relaxCsp(js)).toBe(js);
    expect(() => new Function(relaxCsp(js))).not.toThrow();
  });

  it("widens a real connect-src directive", () => {
    const out = relaxCsp("default-src 'self'; connect-src 'self' https://cdn.example; img-src data:");
    expect(out).toContain("connect-src 'self' https://cdn.example http://127.0.0.1:*;");
  });

  it("adds connect-src next to default-src 'none' (the host file's CSP)", () => {
    expect(relaxCsp(HOST_CSP)).toContain("default-src 'none'; connect-src http://127.0.0.1:*; style-src");
  });
});

describe("patch / restore", () => {
  function fixture(): AgentBundle {
    const dir = mkdtempSync(join(tmpdir(), "latent-patcher-"));
    const bundlePath = join(dir, "index.js");
    const cspHostPath = join(dir, "extension.js");
    writeFileSync(bundlePath, `var verbs=["Thinking"];var t={${MONACO_TOKENIZER}};`);
    writeFileSync(cspHostPath, `const html = \`${HOST_CSP}\`;`);
    return { agent: "claude-code", extDir: dir, bundlePath, cspHostPath };
  }

  it("patches the bundle and relaxes the CSP in the separate host file", () => {
    const b = fixture();
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    const bundle = readFileSync(b.bundlePath, "utf8");
    expect(bundle).toContain("LATENT-START");
    expect(() => new Function(bundle)).not.toThrow();
    expect(readFileSync(b.cspHostPath!, "utf8")).toContain("connect-src http://127.0.0.1:*");
  });

  it("re-patching starts from pristine (no stacked connect-src)", () => {
    const b = fixture();
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    expect(readFileSync(b.cspHostPath!, "utf8").match(/connect-src/g)).toHaveLength(1);
  });

  it("mints a pristine backup from a live file that already carries the block", () => {
    const b = fixture();
    const pristine = readFileSync(b.bundlePath, "utf8");
    writeFileSync(b.bundlePath, `${pristine}\n/* LATENT-START */old/* LATENT-END */\n`);
    expect(patch(b, "/* LATENT-START */new/* LATENT-END */")).toBe("patched");
    const backup = readFileSync(b.bundlePath + ".latent-backup", "utf8");
    expect(backup).not.toContain("LATENT-START");
    expect(backup).toContain("Thinking");
    expect(readFileSync(b.bundlePath, "utf8")).toContain("LATENT-START */new");
  });

  it("restore puts both files back byte-for-byte", () => {
    const b = fixture();
    const bundle0 = readFileSync(b.bundlePath, "utf8");
    const host0 = readFileSync(b.cspHostPath!, "utf8");
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    expect(restore(b)).toBe(true);
    expect(readFileSync(b.bundlePath, "utf8")).toBe(bundle0);
    expect(readFileSync(b.cspHostPath!, "utf8")).toBe(host0);
    expect(existsSync(b.cspHostPath + ".latent-backup")).toBe(false);
  });
});
