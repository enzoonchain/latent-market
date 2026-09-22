import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extensionStatuslineCommand,
  installClaudeCliHook,
  removeClaudeCliHook,
} from "../src/claude-cli.js";
import { uninstallCleanup } from "../src/uninstall.js";

let home: string;
let prevHome: string | undefined;
const settings = () => join(home, ".claude", "settings.json");
const read = () => readFileSync(settings(), "utf8");
const write = (s: string) => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settings(), s);
};
const stageRuntime = () => {
  mkdirSync(join(home, ".latent-protocol", "bin"), { recursive: true });
  writeFileSync(join(home, ".latent-protocol", "bin", "statusline.mjs"), "");
};

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "latent-cli-hook-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("CLI-installed statusLine is never the extension's to remove", () => {
  const cli = `{"model":"opus","statusLine":{"type":"command","command":"node \\"/x/.latent-protocol/bin/statusline.mjs\\""}}`;

  it("removeClaudeCliHook leaves it byte-for-byte", () => {
    write(cli);
    expect(removeClaudeCliHook()).toBe("not-installed");
    expect(read()).toBe(cli);
  });

  it("uninstallCleanup leaves it, even with a stale whole-file backup lying around", () => {
    write(cli);
    writeFileSync(settings() + ".latent-backup", `{"model":"OLD-STALE"}`);
    uninstallCleanup();
    expect(read()).toBe(cli);
  });

  it("install reports it as already installed and writes nothing", () => {
    write(cli);
    stageRuntime();
    expect(installClaudeCliHook()).toBe("already-installed");
    expect(read()).toBe(cli);
    expect(existsSync(join(home, ".latent-protocol", "vscode-cli-hook.json"))).toBe(false);
  });
});

describe("extension-installed statusLine", () => {
  it("needs the CLI-staged runtime (never falls back to npx)", () => {
    write(`{}`);
    expect(installClaudeCliHook()).toBe("needs-cli");
    expect(read()).toBe(`{}`);
  });

  it("writes a node command and removes only that, keeping later user edits", () => {
    write(`{\n  // mine\n  "model": "opus"\n}\n`);
    stageRuntime();
    expect(installClaudeCliHook()).toBe("installed");
    const installed = JSON.parse(read().replace(/\/\/.*$/gm, ""));
    expect(installed.statusLine.command).toBe(extensionStatuslineCommand());
    expect(installed.statusLine.command).not.toMatch(/npx/);
    expect(read()).toContain("// mine");

    // user edits settings after the install
    write(read().replace(`"model": "opus"`, `"model": "opus",\n  "theme": "dark"`));
    expect(removeClaudeCliHook()).toBe("removed");
    const after = read();
    expect(after).toContain(`"theme": "dark"`);
    expect(after).toContain("// mine");
    expect(after).not.toContain("statusLine");
  });

  it("a second install does not break removal", () => {
    write(`{}`);
    stageRuntime();
    expect(installClaudeCliHook()).toBe("installed");
    expect(installClaudeCliHook()).toBe("already-installed");
    expect(removeClaudeCliHook()).toBe("removed");
    expect(read()).not.toContain("statusLine");
  });

  it("a foreign statusLine needs force, and comes back on removal", () => {
    const foreign = { type: "command", command: "npx kickbacks statusline" };
    write(JSON.stringify({ statusLine: foreign }));
    stageRuntime();
    expect(installClaudeCliHook()).toBe("conflict");
    expect(JSON.parse(read()).statusLine).toEqual(foreign);
    expect(installClaudeCliHook(true)).toBe("installed");
    expect(removeClaudeCliHook()).toBe("removed");
    expect(JSON.parse(read()).statusLine).toEqual(foreign);
  });

  it("is not removed once something else rewrote it", () => {
    write(`{}`);
    stageRuntime();
    installClaudeCliHook();
    const other = `{"statusLine":{"type":"command","command":"my-own-line"}}`;
    write(other);
    expect(removeClaudeCliHook()).toBe("not-installed");
    expect(read()).toBe(other);
  });

  it("refuses an unparseable settings.json instead of clobbering it", () => {
    write(`{ "model": `);
    stageRuntime();
    expect(installClaudeCliHook()).toBe("error");
    expect(read()).toBe(`{ "model": `);
  });
});
