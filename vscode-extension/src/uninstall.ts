/**
 * Uninstall cleanup — triggered by `vscode:uninstall` hook.
 *
 * Restores any patched bundles and removes CLI hooks so the extension
 * leaves no trace. This is the `uninstall.js` entry point that VS Code
 * calls when the extension is uninstalled.
 */
import { restore, findAgentBundles } from "./patcher.js";
import { removeClaudeCliHook } from "./claude-cli.js";

export function uninstallCleanup(): void {
  // Restore all patched bundles
  try {
    for (const b of findAgentBundles()) {
      restore(b);
    }
  } catch {
    // best-effort
  }

  // Remove Claude CLI hook
  try {
    removeClaudeCliHook();
  } catch {
    // best-effort
  }

  // Note: we do NOT delete ~/.latent-protocol/ — the user's wallet config
  // should survive a reinstall. Only hooks and patches are removed.
}
