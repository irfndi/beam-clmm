/** `.env` parsing + load precedence for the in-repo replacement of `dotenv`. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "../engine/env-parse.js";

describe("parseEnvFile", () => {
  it("parses plain, quoted, exported and commented entries", () => {
    const parsed = parseEnvFile(
      [
        "# leading comment",
        "PLAIN=value",
        "  INDENTED = spaced  ",
        "export EXPORTED=yes",
        "SINGLE='single quoted'",
        'DOUBLE="line\\nbreak"',
        "INLINE=value # trailing comment",
        "HASH_INSIDE=abc#def",
        "",
        "NOT_AN_ENTRY",
        "=no-key",
      ].join("\n"),
    );

    expect(Object.fromEntries(parsed)).toEqual({
      PLAIN: "value",
      INDENTED: "spaced",
      EXPORTED: "yes",
      SINGLE: "single quoted",
      DOUBLE: "line\nbreak",
      INLINE: "value",
      HASH_INSIDE: "abc#def",
    });
  });

  it("keeps an empty value and ignores unbalanced quotes", () => {
    expect(Object.fromEntries(parseEnvFile('EMPTY=\nBROKEN="unbalanced'))).toEqual({
      EMPTY: "",
      BROKEN: '"unbalanced',
    });
  });
});

describe("loadEnvFile", () => {
  it("loads a file without overwriting values already in the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "ALREADY_SET=from-file\nFRESH=from-file\n");

    const env: NodeJS.ProcessEnv = { ALREADY_SET: "from-process" };
    loadEnvFile(path, env);

    expect(env).toEqual({ ALREADY_SET: "from-process", FRESH: "from-file" });
  });

  it("is a no-op when the file is missing", () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(join(tmpdir(), "beam-does-not-exist", ".env"), env);
    expect(env).toEqual({});
  });
});
