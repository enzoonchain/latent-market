/**
 * Uninstall cleanup — the `vscode:uninstall` entry point (bundled separately
 * to dist/uninstall.js via src/uninstall-main.ts; package.json `scripts["vscode:uninstall"]`).
 *
 * The editor runs it in a plain node process once the extension is fully
 * uninstalled — NOT on window close/reload. It must never be called from
 * `deactivate()`: that runs on every reload, and would strip patches another
 * window still uses.
 *
 * Restores patched agent bundles and Cursor workbenches, and removes the
 * Claude CLI statusLine only if the extension itself wrote it (a CLI-installed
 * one belongs to `latent uninstall`).
 */
import { restore, findAgentBundles } from "./patcher.js";
import { removeClaudeCliHook } from "./claude-cli.js";
import { restoreAllWorkbenches } from "./workbench.js";

export function uninstallCleanup(): void {
  try {
    for (const b of findAgentBundles()) restore(b);
  } catch {
    // best-effort
  }
  try {
    restoreAllWorkbenches();
  } catch {
    // best-effort
  }
  try {
    removeClaudeCliHook();
  } catch {
    // best-effort
  }
  // ~/.latent-protocol/ (wallet config) is deliberately kept — it is shared
  // with the CLI and must survive a reinstall.
}
