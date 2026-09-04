import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

export const LOCKFILE_DIR = path.join(os.homedir(), ".config", "beam");
/** The dev singleton lock. Parallel chain/wallet agents each get their own
 *  instance lock (AGENT_INSTANCE_ID → dev-<id>.lock) so `beam-base` and
 *  `beam-robinhood` can run simultaneously, each guarding its own engine
 *  process. Without AGENT_INSTANCE_ID the legacy shared dev.lock is used. */
export const LOCKFILE_PATH = process.env.AGENT_INSTANCE_ID
  ? path.join(LOCKFILE_DIR, `dev-${process.env.AGENT_INSTANCE_ID}.lock`)
  : path.join(LOCKFILE_DIR, "dev.lock");

interface LockfileData {
  readonly pid: number;
  readonly timestamp: number;
}

function isLockfileData(parsed: LockfileData | null): parsed is LockfileData {
  return parsed !== null && Number.isFinite(parsed.pid) && Number.isFinite(parsed.timestamp);
}

export function ensureLockfileDir(lockfileDir = LOCKFILE_DIR): void {
  if (!fs.existsSync(lockfileDir)) {
    fs.mkdirSync(lockfileDir, { recursive: true, mode: 0o700 });
  }
}

export function readLockfile(lockfilePath = LOCKFILE_PATH): LockfileData | null {
  try {
    const content = fs.readFileSync(lockfilePath, "utf-8");
    // SAFETY: isLockfileData validates both numeric fields before the record is returned.
    const parsed = JSON.parse(content) as LockfileData | null;
    if (isLockfileData(parsed)) {
      return parsed;
    }
    return null;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const EXCLUDED_PATTERNS = [
  "bun install",
  "bun add",
  "bun remove",
  "bun update",
  "bun test",
  "bun run test",
  "bun run lint",
  "bun run format",
  "bun run setup",
  "bun run backtest",
];

export function findRunningEngineProcess(
  spawner: (
    command: string,
    args: ReadonlyArray<string>,
    options: { encoding: "utf-8"; shell: false; timeout?: number },
  ) => { readonly stdout?: string | Buffer; readonly error?: Error } = spawnSync,
): { readonly pid: number; readonly command: string } | null {
  if (process.platform === "win32") return null;
  try {
    const result = spawner("ps", ["-eo", "pid,args"], {
      encoding: "utf-8",
      shell: false,
      timeout: 3000,
    });
    if (result.error || !result.stdout) return null;
    const stdout = result.stdout.toString();
    const lines = stdout.trim().split("\n").slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pidStr = match[1];
      const args = match[2];
      if (pidStr === undefined || args === undefined) continue;
      const pid = Number.parseInt(pidStr, 10);
      if (pid === process.pid) continue;
      if (!args.includes("bun")) continue;
      if (EXCLUDED_PATTERNS.some((pattern) => args.includes(pattern))) continue;
      if (
        args.includes("engine/index.ts") ||
        args.includes("run dev") ||
        args.includes("cli/dev.ts") ||
        // Bundled/source CLI dev process (e.g. `bun /root/.beam/dist/cli/
        // index.mjs dev` under systemd, or a relative `bun cli/index.ts dev`
        // from the repo root): the source-path patterns above do not match
        // the bundle. Scoped to Beam's CLI layout — the `cli/` segment must
        // be preceded by a whitespace, slash, or line start (so an unrelated
        // `*-cli/` or `mycli/` directory cannot match) — with a STANDALONE
        // `dev` argument: a bare substring `dev` (dev-server, development,
        // /devtools/) or an unrelated project's index.mjs must never
        // false-positive the RESTART REQUIRED notice and its kill hint.
        (/(^|[\s/])cli\/index\.(mjs|ts)(\s|$)/.test(args) && /(^|\s)dev($|\s)/.test(args))
      ) {
        return { pid, command: args };
      }
    }
  } catch {
    return null;
  }
  return null;
}

type AcquireResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly pid: number };
type TryCreateResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly existing: LockfileData | null };

function tryAtomicCreateLock(lockfilePath: string): TryCreateResult {
  try {
    const data: LockfileData = { pid: process.pid, timestamp: Date.now() };
    const fd = fs.openSync(lockfilePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      const existing = readLockfile(lockfilePath);
      return { acquired: false, existing };
    }
    throw err;
  }
}

function resolveExistingWithRetry(
  firstExisting: LockfileData | null,
  lockfilePath: string,
): AcquireResult | { readonly existing: LockfileData | null } {
  if (firstExisting !== null) return { existing: firstExisting };
  const retry = tryAtomicCreateLock(lockfilePath);
  if (retry.acquired) return retry;
  return { existing: retry.existing };
}

function checkLiveLock(existing: LockfileData | null): AcquireResult | null {
  if (existing !== null && isProcessAlive(existing.pid)) {
    return { acquired: false, pid: existing.pid };
  }
  return null;
}

function checkUnparseableLock(existing: LockfileData | null): AcquireResult | null {
  if (existing === null) {
    // Lockfile exists but couldn't be parsed after two attempts.
    // Another process may be mid-write. Fail closed — don't unlink.
    return { acquired: false, pid: 0 };
  }
  return null;
}

function tryRenameStaleLock(lockfilePath: string, backupPath: string): AcquireResult | null {
  try {
    fs.renameSync(lockfilePath, backupPath);
    return null;
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
    // The lock vanished between our read and rename — another launcher is
    // replacing it. Only an exclusive create can win now.
    const created = tryAtomicCreateLock(lockfilePath);
    return created.acquired
      ? { acquired: true }
      : { acquired: false, pid: created.existing?.pid ?? 0 };
  }
}

function restoreMismatchedLock(backupPath: string, lockfilePath: string): void {
  try {
    fs.linkSync(backupPath, lockfilePath);
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Best-effort cleanup of the restored lock.
    }
  } catch (restoreErr) {
    if (!(restoreErr instanceof Error && "code" in restoreErr && restoreErr.code === "EEXIST")) {
      throw restoreErr;
    }
  }
}

function handleMovedLockMismatch(
  backupPath: string,
  existing: LockfileData,
  lockfilePath: string,
): AcquireResult | null {
  const moved = readLockfile(backupPath);
  if (moved === null || moved.pid !== existing.pid || moved.timestamp !== existing.timestamp) {
    // The moved file is not the stale lock we read — a concurrent launcher
    // re-acquired it (or the file was mid-write). Restore it with a hard
    // link (never clobbers a lock that appeared in the meantime) and fail
    // with the owner we displaced, falling back to the current owner.
    restoreMismatchedLock(backupPath, lockfilePath);
    const current = readLockfile(lockfilePath);
    return { acquired: false, pid: current?.pid ?? moved?.pid ?? 0 };
  }
  return null;
}

function finalizeStaleLockCreation(lockfilePath: string): AcquireResult {
  const second = tryAtomicCreateLock(lockfilePath);
  if (second.acquired) return { acquired: true };
  return { acquired: false, pid: second.existing?.pid ?? 0 };
}

function replaceStaleLock(lockfilePath: string, existing: LockfileData): AcquireResult {
  // `existing` is a valid stale lock (dead PID) — replace it atomically. The
  // old unlink-then-create flow had a TOCTOU window: a concurrent launcher
  // could re-acquire the lock between our unlink and our exclusive create, and
  // our unlink would delete their fresh lock, leaving both launchers believing
  // they hold it. Renaming the stale file aside first is atomic, and checking
  // the moved copy (not the live path) detects a concurrent re-acquisition
  // without a check-then-act race; the exclusive create can then only fail if
  // another launcher already owns the lock.
  const backupPath = `${lockfilePath}.${process.pid}.${Date.now()}.tmp`;
  const renameResult = tryRenameStaleLock(lockfilePath, backupPath);
  if (renameResult !== null) return renameResult;
  try {
    const mismatch = handleMovedLockMismatch(backupPath, existing, lockfilePath);
    if (mismatch !== null) return mismatch;
    return finalizeStaleLockCreation(lockfilePath);
  } finally {
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Best-effort cleanup of the moved stale lock.
    }
  }
}

export function acquireLock(
  lockfilePath = LOCKFILE_PATH,
): { readonly acquired: true } | { readonly acquired: false; readonly pid: number } {
  ensureLockfileDir(path.dirname(lockfilePath));
  const first = tryAtomicCreateLock(lockfilePath);
  if (first.acquired) return first;
  const resolved = resolveExistingWithRetry(first.existing, lockfilePath);
  if ("acquired" in resolved) return resolved;
  const existing = resolved.existing;
  return (
    checkLiveLock(existing) ??
    checkUnparseableLock(existing) ??
    replaceStaleLock(lockfilePath, existing as LockfileData)
  );
}

export function releaseLock(lockfilePath = LOCKFILE_PATH): void {
  try {
    const existing = readLockfile(lockfilePath);
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(lockfilePath);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return;
    }
    // Best-effort cleanup; ignore other errors.
  }
}
