import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getBeamConfigDir,
  getBeamUserConfigDir,
  getBeamDataDir,
  getBeamEnvPath,
  getBeamDbPath,
  setBeamEntryScriptOverride,
} from "../engine/paths.js";

describe("paths", () => {
  const originalConfigDir = process.env.BEAM_CONFIG_DIR;
  const originalDataDir = process.env.BEAM_DATA_DIR;
  const originalSqliteDbPath = process.env.SQLITE_DB_PATH;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "beam-paths-"));
    process.env.BEAM_CONFIG_DIR = path.join(tmpHome, ".config", "beam");
    process.env.BEAM_DATA_DIR = path.join(tmpHome, ".local", "share", "beam");
    delete process.env.SQLITE_DB_PATH;
    setBeamEntryScriptOverride(undefined);
  });

  afterEach(() => {
    process.env.BEAM_CONFIG_DIR = originalConfigDir;
    process.env.BEAM_DATA_DIR = originalDataDir;
    if (originalSqliteDbPath === undefined) {
      delete process.env.SQLITE_DB_PATH;
    } else {
      process.env.SQLITE_DB_PATH = originalSqliteDbPath;
    }
    setBeamEntryScriptOverride(undefined);
  });

  it("uses the project root for a source install with a .env", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beam-source-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    fs.mkdirSync(path.join(projectRoot, "engine"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "cli"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "cli", "index.ts"), "// entry");
    fs.writeFileSync(path.join(projectRoot, ".env"), "PAPER_TRADING=false");

    setBeamEntryScriptOverride(path.join(projectRoot, "cli", "index.ts"));

    const realProjectRoot = fs.realpathSync(projectRoot);
    expect(getBeamConfigDir()).toBe(realProjectRoot);
    expect(getBeamUserConfigDir()).toBe(process.env.BEAM_CONFIG_DIR);
    expect(getBeamDataDir()).toBe(realProjectRoot);
    expect(getBeamEnvPath()).toBe(path.join(realProjectRoot, ".env"));
    expect(getBeamDbPath()).toBe(path.join(realProjectRoot, "beam.db"));
  });

  it("falls back to home dirs when a source project has no .env", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beam-source-noenv-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    fs.mkdirSync(path.join(projectRoot, "engine"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "cli"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "cli", "index.ts"), "// entry");

    setBeamEntryScriptOverride(path.join(projectRoot, "cli", "index.ts"));

    const expectedConfigDir = path.join(tmpHome, ".config", "beam");
    const expectedDataDir = path.join(tmpHome, ".local", "share", "beam");
    expect(getBeamConfigDir()).toBe(expectedConfigDir);
    expect(getBeamDataDir()).toBe(expectedDataDir);
    expect(getBeamEnvPath()).toBe(path.join(expectedConfigDir, ".env"));
    expect(getBeamDbPath()).toBe(path.join(expectedDataDir, "beam.db"));
  });

  it("uses home dirs for a compiled bundle install", () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beam-bundle-"));
    fs.mkdirSync(path.join(bundleRoot, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, "dist", "cli", "index.mjs"), "// bundle");

    setBeamEntryScriptOverride(path.join(bundleRoot, "dist", "cli", "index.mjs"));

    const expectedConfigDir = path.join(tmpHome, ".config", "beam");
    const expectedDataDir = path.join(tmpHome, ".local", "share", "beam");
    expect(getBeamConfigDir()).toBe(expectedConfigDir);
    expect(getBeamDataDir()).toBe(expectedDataDir);
  });
});
