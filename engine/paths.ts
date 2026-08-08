import fs from "fs";
import os from "os";
import path from "path";
import { isSourceInstall } from "./install-method.js";

/**
 * Beam path resolution.
 *
 * When running from a source checkout (e.g. `bun cli/index.ts`), the active
 * project directory is derived from the entry script so the wrapper can be a
 * symlink anywhere on PATH and the engine still finds the repo's `.env`,
 * `beam.db`, and logs.
 *
 * When running as a compiled binary, config and data are kept under the user's
 * home directory so the binary can be invoked from anywhere.
 */

let entryScriptOverride: string | undefined;

export function setBeamEntryScriptOverride(entry: string | undefined): void {
  entryScriptOverride = entry;
}

function resolveEntryScript(): string {
  if (entryScriptOverride !== undefined) return entryScriptOverride;
  if (typeof Bun !== "undefined" && Bun.main) {
    return Bun.main;
  }
  return process.argv[1] ?? "";
}

function resolveProjectRoot(): string {
  // The wrapper sets this so bundled/source installs resolve consistently
  // regardless of how the binary was invoked or where the caller's CWD is.
  if (process.env.BEAM_INSTALL_DIR) {
    return path.resolve(process.env.BEAM_INSTALL_DIR);
  }

  const entry = resolveEntryScript();
  if (!entry) return process.cwd();

  const realEntry = path.resolve(fs.realpathSync(entry));
  const entryDir = path.dirname(realEntry);
  const entryDirName = path.basename(entryDir);
  const parentDir = path.dirname(entryDir);

  // Explicitly support the two known entry layouts so we don't rely on a
  // blind two-level dirname assumption that breaks for bundled installs.
  const entryFile = path.basename(realEntry);
  if (entryFile === "index.ts" && entryDirName === "cli") {
    return parentDir;
  }
  if (entryFile === "index.mjs" && entryDirName === "cli" && path.basename(parentDir) === "dist") {
    return path.dirname(parentDir);
  }

  // Fallback: walk up from the entry script looking for a Beam source tree.
  let dir = entryDir;
  while (dir !== path.dirname(dir)) {
    if (isSourceInstall(dir)) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

function isRunningFromSource(): boolean {
  return isSourceInstall(resolveProjectRoot());
}

function hasProjectEnv(): boolean {
  return fs.existsSync(path.join(resolveProjectRoot(), ".env"));
}

function getDefaultConfigDir(): string {
  return process.env.BEAM_CONFIG_DIR ?? path.join(os.homedir(), ".config", "beam");
}

function getDefaultDataDir(): string {
  return process.env.BEAM_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "beam");
}

export function getBeamConfigDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return resolveProjectRoot();
  }
  return getDefaultConfigDir();
}

export function getBeamUserConfigDir(): string {
  return getDefaultConfigDir();
}

export function getBeamDataDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return resolveProjectRoot();
  }
  return getDefaultDataDir();
}

export function getBeamEnvPath(): string {
  return path.join(getBeamConfigDir(), ".env");
}

export function getBeamDbPath(): string {
  // Keep in sync with mcp-server/src/tools.ts::getBeamDbPath
  if (process.env.SQLITE_DB_PATH) return process.env.SQLITE_DB_PATH;
  return path.join(getBeamDataDir(), "beam.db");
}

export function getBeamLogsDir(): string {
  return path.join(getBeamDataDir(), "logs");
}

export function getBeamLogsPath(): string {
  return path.join(getBeamLogsDir(), "audit-trail.jsonl");
}

export function ensureBeamDataDir(): void {
  fs.mkdirSync(getBeamDataDir(), { recursive: true, mode: 0o700 });
}

export function ensureBeamConfigDir(): void {
  fs.mkdirSync(getBeamConfigDir(), { recursive: true, mode: 0o700 });
}
