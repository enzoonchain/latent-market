/**
 * Surgical edits of a single TOML table (`[ui.status_line]`).
 *
 * We do not round-trip the whole file through a parser: Grok's config.toml
 * is user-owned and may carry comments / key order we must not rewrite.
 * Only the named table is replaced or appended; everything else is
 * byte-preserved.
 */

export function findTable(
  src: string,
  name: string,
): { start: number; end: number; body: string } | null {
  const needle = `[${name}]`;
  let searchFrom = 0;
  while (searchFrom <= src.length) {
    const idx = src.indexOf(needle, searchFrom);
    if (idx === -1) return null;
    // Must be at the start of a line (or start of file).
    if (idx > 0 && src[idx - 1] !== "\n") {
      searchFrom = idx + needle.length;
      continue;
    }
    const after = idx + needle.length;
    const rest = src.slice(after);
    const nl = rest.match(/^[ \t]*\r?\n/);
    const bodyStart = after + (nl ? nl[0].length : 0);
    const next = src.slice(bodyStart).search(/^[ \t]*\[/m);
    const end = next === -1 ? src.length : bodyStart + next;
    return { start: idx, end, body: src.slice(idx, end) };
  }
  return null;
}

/** Parse `key = value` pairs from a table body. Strings only unquote `"…"` / `'…'`. */
export function parseTableValues(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[key] = val;
  }
  return out;
}

export function formatTable(name: string, values: Record<string, string | number>): string {
  const lines = [`[${name}]`];
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "number") lines.push(`${k} = ${v}`);
    else lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Replace the named table in `src`, or append it. Returns the new file
 * contents. A trailing newline is guaranteed on the result.
 */
export function upsertTable(
  src: string,
  name: string,
  values: Record<string, string | number>,
): string {
  const block = formatTable(name, values);
  const found = findTable(src, name);
  if (!found) {
    const base = src.endsWith("\n") || src.length === 0 ? src : src + "\n";
    const sep = base.length === 0 || base.endsWith("\n\n") ? "" : "\n";
    return base + sep + block;
  }
  const before = src.slice(0, found.start);
  let after = src.slice(found.end);
  // Drop a single leftover blank line the old table owned, so we don't
  // accumulate blanks on repeated upserts.
  after = after.replace(/^\r?\n/, "");
  return before + block + (after.startsWith("[") ? "\n" + after : after);
}

/** Remove the named table. No-op if absent. */
export function removeTable(src: string, name: string): string {
  const found = findTable(src, name);
  if (!found) return src;
  const before = src.slice(0, found.start);
  let after = src.slice(found.end);
  after = after.replace(/^\r?\n/, "");
  return before + after;
}
