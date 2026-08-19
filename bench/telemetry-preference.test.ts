import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readTelemetryPreference,
  writeTelemetryPreference,
} from "../engine/telemetry-preference.js";

// telemetry-preference reads/writes against the Beam config dir, which
// getBeamUserConfigDir resolves from BEAM_CONFIG_DIR (or ~/.config/beam).
// Point it at a throwaway temp dir so the write path never pollutes the real
// user config (which would silently disable the error reporter for the whole
// test run — a hard-to-debug cross-test side effect).

const ORIGINAL_BEAM_CONFIG_DIR = process.env.BEAM_CONFIG_DIR;
let configDir: string;

describe("telemetry preference file I/O", () => {
  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "beam-tel-"));
    process.env.BEAM_CONFIG_DIR = configDir;
  });

  afterAll(() => {
    if (ORIGINAL_BEAM_CONFIG_DIR === undefined) {
      delete process.env.BEAM_CONFIG_DIR;
    } else {
      process.env.BEAM_CONFIG_DIR = ORIGINAL_BEAM_CONFIG_DIR;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes a preference file successfully", () => {
    const result = writeTelemetryPreference(false);
    expect(result.ok).toBe(true);
  });

  it("readTelemetryPreference returns the written (disabled) preference", () => {
    const read = readTelemetryPreference();
    expect(read.enabled).toBe(false);
    expect(read.updatedAt).toBeTypeOf("string");
    const parsed = Date.parse(read.updatedAt);
    expect(Number.isFinite(parsed)).toBe(true);
  });

  it("defaults to enabled when no preference file exists", () => {
    // Fresh subdir with no file → enabled.
    const fresh = mkdtempSync(join(tmpdir(), "beam-tel-fresh-"));
    process.env.BEAM_CONFIG_DIR = fresh;
    const read = readTelemetryPreference();
    expect(read.enabled).toBe(true);
    process.env.BEAM_CONFIG_DIR = configDir;
    rmSync(fresh, { recursive: true, force: true });
  });
});
