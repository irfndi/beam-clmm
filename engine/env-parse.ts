/**
 * `.env` parsing without a dependency (replaces `dotenv`).
 *
 * Supports what the engine's env files actually contain: `KEY=VALUE` lines,
 * `#` comments, an optional `export` prefix, single/double quoted values
 * (double quotes unescape `\n` / `\r` / `\t`), and inline `#` comments after
 * unquoted values.
 */
import { readFileSync } from "node:fs";

/** Parse an env file body into key/value pairs. */
export function parseEnvFile(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
      }
    } else {
      // Unquoted values end at the first ` #` (dotenv strips inline comments).
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    out.set(key, value);
  }
  return out;
}

/** Load `path` into `env` without overwriting anything already set. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return; // No env file is a valid configuration.
  }
  for (const [key, value] of parseEnvFile(body)) {
    if (env[key] === undefined) env[key] = value;
  }
}
