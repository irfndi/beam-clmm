import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../engine/db.js";

describe("migration v27 pool snapshot address compatibility", () => {
  let testDirectory: string | null = null;

  afterEach(() => {
    if (testDirectory !== null) {
      rmSync(testDirectory, { recursive: true, force: true });
      testDirectory = null;
    }
  });

  it("repairs legacy v26 token columns without losing snapshot addresses", () => {
    testDirectory = mkdtempSync(join(tmpdir(), "beam-snapshot-v26-upgrade-"));
    const dbPath = join(testDirectory, "beam.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO _migrations (version, name, applied_at)
      VALUES (26, 'pool_snapshots_usd_price_metadata', 1);

      CREATE TABLE pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_x TEXT,
        token_y TEXT,
        token_x_decimals INTEGER,
        token_y_decimals INTEGER,
        token_x_price_usd REAL,
        token_y_price_usd REAL
      );
      INSERT INTO pool_snapshots (
        token_x,
        token_y,
        token_x_decimals,
        token_y_decimals,
        token_x_price_usd,
        token_y_price_usd
      ) VALUES (
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        18,
        6,
        1.25,
        1.0
      );
    `);
    legacy.close();

    const upgraded = createDatabase(dbPath);
    // SAFETY: the migration creates these exact nullable TEXT columns.
    const snapshot = upgraded
      .query("SELECT token_x_address, token_y_address FROM pool_snapshots WHERE id = 1")
      .get() as {
      readonly token_x_address: string | null;
      readonly token_y_address: string | null;
    };
    // SAFETY: COUNT(*) always returns one numeric `count` column.
    const migrationCount = upgraded
      .query("SELECT COUNT(*) AS count FROM _migrations WHERE version = 27")
      .get() as { readonly count: number };

    expect(snapshot).toEqual({
      token_x_address: "0x1111111111111111111111111111111111111111",
      token_y_address: "0x2222222222222222222222222222222222222222",
    });
    expect(migrationCount.count).toBe(1);
    upgraded.close();

    const reopened = createDatabase(dbPath);
    // SAFETY: COUNT(*) always returns one numeric `count` column.
    const reopenedMigrationCount = reopened
      .query("SELECT COUNT(*) AS count FROM _migrations WHERE version = 27")
      .get() as { readonly count: number };
    expect(reopenedMigrationCount.count).toBe(1);
    reopened.close();
  });
});
