/**
 * Bundle the extension to a single dist/extension.js (+ dist/uninstall.js) (CommonJS — VS Code loads
 * extensions as CJS). `vscode` is provided by the host and must stay external;
 * everything else is inlined so the packaged .vsix carries no node_modules.
 */
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  // extension.js is the extension; uninstall.js is the `vscode:uninstall`
  // script (runs in plain node after uninstall — must not import `vscode`).
  entryPoints: { extension: "src/extension.ts", uninstall: "src/uninstall-main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  // Node's default field order picks jsonc-parser's UMD build, which calls
  // require("./impl/format") at runtime. Those files are not in the VSIX, so
  // activation dies before the panel or status bar exists. Prefer the ESM
  // entry so the parser is actually inlined.
  mainFields: ["module", "main"],
  sourcemap: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await (await import("esbuild")).context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(options);
  console.log("bundled → dist/extension.js, dist/uninstall.js");
}
