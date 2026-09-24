import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeBundle, codexBundle, injectCodexShimmer, isPatched, jsParses, patch, relaxClaudeCspMetas, relaxCsp, restore, type AgentBundle } from "../src/patcher.js";

// Shapes taken from an installed Claude Code 2.1.278.
const MONACO_TOKENIZER = 'tokenizer:{root:[[/child-src/,"string.quote"],[/connect-src/,"string.quote"],[/default-src/,"string.quote"]]}';
const HOST_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-{{NONCE}}\'; img-src data:;">';

describe("claudeBundle", () => {
  it("targets webview/index.js even when extension.js contains Thinking", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-cc-"));
    const webview = join(dir, "webview");
    mkdirSync(webview);
    writeFileSync(join(dir, "extension.js"), `function thinkingDisplayExplicit(){}\n${HOST_CSP}`);
    writeFileSync(join(webview, "index.js"), 'var verbs=["Clauding","Discombobulating"];');
    const hit = claudeBundle(dir);
    expect(hit?.bundlePath).toBe(join(webview, "index.js"));
    expect(hit?.cspHostPath).toBeNull();
  });
});

describe("isPatched", () => {
  it("sees a marker in the tail and one spliced into the middle of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-tail-"));
    const file = join(dir, "index.js");
    writeFileSync(file, `${"x".repeat(80_000)}/* LATENT-START */`);
    expect(isPatched(file)).toBe(true);
    writeFileSync(file, `${"x".repeat(80_000)}/* LATENT-START */${"x".repeat(80_000)}`);
    expect(isPatched(file)).toBe(true);
  });
});

describe("relaxClaudeCspMetas", () => {
  const login = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{{NONCE}}'; img-src data:;">`;
  const panel = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; ${Z}; ${D}; ${O}; script-src 'nonce-${B}'; ${M};\">";

  it("adds the loopback to Claude's two meta tags and leaves other connect-src alone", () => {
    const codex = 'function kz(){return [`connect-src ${n.join(" ")}`];}';
    const out = relaxClaudeCspMetas(`${login}\n${panel}\n${codex}`);
    expect(out).toContain("default-src 'none'; connect-src http://127.0.0.1:*; style-src 'unsafe-inline'");
    expect(out).toContain("default-src 'none'; connect-src http://127.0.0.1:*; ${Z};");
    expect(out).toContain('`connect-src ${n.join(" ")}`');
    expect(relaxClaudeCspMetas(out)).toBe(out);
    expect(jsParses(`const html = ${JSON.stringify(out)};\n${codex}`)).toBe(true);
  });
});

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

  it("widens Codex's template connect-src without breaking the interpolation", () => {
    const js = 'function kz(){return ["default-src \'none\'",`connect-src ${n.join(" ")}`].join("; ");}';
    const out = relaxCsp(js);
    expect(out).toContain('http://127.0.0.1:* ${n.join(" ")}');
    expect(out).not.toContain("default-src 'none'; connect-src");
    expect(() => new Function(out)).not.toThrow();
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

  it("patches the webview bundle and leaves the extension host module untouched", () => {
    const b = fixture();
    const host0 = readFileSync(b.cspHostPath!, "utf8");
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    const bundle = readFileSync(b.bundlePath, "utf8");
    expect(bundle).toContain("LATENT-START");
    expect(jsParses(bundle)).toBe(true);
    expect(readFileSync(b.cspHostPath!, "utf8")).toContain("connect-src http://127.0.0.1:*");
    expect(readFileSync(b.cspHostPath! + ".latent-backup", "utf8")).toBe(host0);
  });

  it("re-patching starts from pristine (no stacked sponsor blocks)", () => {
    const b = fixture();
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    expect(readFileSync(b.bundlePath, "utf8").match(/LATENT-START/g)).toHaveLength(1);
  });

  it("mints a pristine backup from a live file that already carries the block", () => {
    const b = fixture();
    const pristine = readFileSync(b.bundlePath, "utf8");
    writeFileSync(b.bundlePath, `${pristine}\n/* LATENT-START */;"old"/* LATENT-END */\n`);
    expect(patch(b, "/* LATENT-START */;'new'/* LATENT-END */")).toBe("patched");
    const backup = readFileSync(b.bundlePath + ".latent-backup", "utf8");
    expect(backup).not.toContain("LATENT-START");
    expect(backup).toContain("Thinking");
    expect(readFileSync(b.bundlePath, "utf8")).toContain("LATENT-START */;'new'");
  });

  it("strips a sponsor block an older locator left in the extension host", () => {
    const b = fixture();
    const host = readFileSync(b.cspHostPath!, "utf8");
    writeFileSync(b.cspHostPath!, `${host}\n/* LATENT-START */nope/* LATENT-END */\n`);
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    const after = readFileSync(b.cspHostPath!, "utf8");
    expect(after).not.toContain("LATENT-START");
    expect(after).toContain("connect-src http://127.0.0.1:*");
    expect(readFileSync(b.bundlePath, "utf8")).toContain("LATENT-START");
  });

  it("restores a parseable host backup and keeps a broken one off the live file", () => {
    const b = fixture();
    const host0 = readFileSync(b.cspHostPath!, "utf8");
    writeFileSync(b.cspHostPath!, "function ( {");
    writeFileSync(b.cspHostPath! + ".latent-backup", "function ( {");
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    expect(readFileSync(b.cspHostPath!, "utf8")).toBe("function ( {");

    writeFileSync(b.cspHostPath! + ".latent-backup", host0);
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    expect(readFileSync(b.cspHostPath!, "utf8")).toContain("connect-src http://127.0.0.1:*");
    expect(readFileSync(b.cspHostPath! + ".latent-backup", "utf8")).toBe(host0);
  });

  it("does not write the bundle when neither it nor its backup parses", () => {
    const b = fixture();
    writeFileSync(b.bundlePath, "function ( {");
    writeFileSync(b.bundlePath + ".latent-backup", "function ( {");
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("error");
    expect(readFileSync(b.bundlePath, "utf8")).toBe("function ( {");
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

const CODEX_BUNDLE = [
  'function yPt(e){return "loading-shimmer-pure-text";}',
  'function vJt(e){return Z("loading-shimmer-pure-text", bK.cadencedShimmer);}',
  'function yJt(e){return "Thinking";}',
].join("");

describe("codex shimmer injection", () => {
  it("splices into the renderer that paints cadencedShimmer, not the sibling row", () => {
    const block = "/* LATENT-START */;/* LATENT-END */";
    const out = injectCodexShimmer(CODEX_BUNDLE, block);
    expect(out).toBeTruthy();
    const v = out!.indexOf("function vJt");
    const mark = out!.indexOf("LATENT-START");
    expect(mark).toBeGreaterThan(v);
    expect(mark).toBeLessThan(out!.indexOf("function yJt"));
    expect(out!.indexOf("LATENT-START")).toBe(out!.lastIndexOf("LATENT-START"));
    expect(() => new Function(out!)).not.toThrow();
  });

  it("targets the shimmer chunk, not a file that only contains Thinking", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-codex-"));
    const assets = join(dir, "webview", "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "locale.js"), 'var m="Thinking";');
    const shimmer = join(assets, "app.js");
    writeFileSync(shimmer, CODEX_BUNDLE);
    writeFileSync(join(dir, "extension.js"), HOST_CSP);
    const hit = codexBundle(dir);
    expect(hit?.bundlePath).toBe(shimmer);
    expect(hit?.cspHostPath).toBeNull();
  });

  it("patches the shimmer function, leaves the host module, and restores a stale chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-codex-patch-"));
    const assets = join(dir, "webview", "assets");
    mkdirSync(assets, { recursive: true });
    const bundlePath = join(assets, "app.js");
    writeFileSync(bundlePath, CODEX_BUNDLE);
    const cspHostPath = join(dir, "extension.js");
    const host0 = 'function kz(){return ["default-src \'none\'",`connect-src ${n.join(" ")}`].join("; ");}';
    writeFileSync(cspHostPath, host0);
    const stale = join(assets, "am.js");
    writeFileSync(stale + ".latent-backup", "pristine-am");
    writeFileSync(stale, "pristine-am\n/* LATENT-START */old/* LATENT-END */\n");
    const b: AgentBundle = { agent: "codex", extDir: dir, bundlePath, cspHostPath };
    expect(patch(b, "/* LATENT-START */;/* LATENT-END */")).toBe("patched");
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle.indexOf("LATENT-START")).toBeGreaterThan(bundle.indexOf("function vJt"));
    expect(bundle.indexOf("function yPt")).toBeLessThan(bundle.indexOf("LATENT-START"));
    expect(jsParses(bundle)).toBe(true);
    expect(readFileSync(cspHostPath, "utf8")).toBe(host0);
    expect(existsSync(cspHostPath + ".latent-backup")).toBe(false);
    expect(readFileSync(stale, "utf8")).toBe("pristine-am");
    patch(b, "/* LATENT-START */;/* LATENT-END */");
    expect(readFileSync(bundlePath, "utf8").match(/LATENT-START/g)).toHaveLength(1);
    expect(restore(b)).toBe(true);
    expect(readFileSync(bundlePath, "utf8")).toBe(CODEX_BUNDLE);
    expect(readFileSync(cspHostPath, "utf8")).toBe(host0);
  });
});
