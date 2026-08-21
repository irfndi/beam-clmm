#!/usr/bin/env bun
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execSync, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { resolveSqliteVecPath } from "./sqlite-vec-path.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const platform = process.platform;
const arch = process.arch;

const extensionSuffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
const vec0Path = resolveSqliteVecPath(repoRoot, platform, arch);
const platformKey = `${platform === "win32" ? "windows" : platform}-${arch}`;

function run(cmd: string): void {
  console.log(`→ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const pkgPath = path.join(repoRoot, "package.json");
// SAFETY: package.json is repository-owned and the release script only reads its version field.
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
// In CI the git tag is the source of truth; package.json may be stale at the
// tagged commit. Prefer VERSION env so bundles are named after the release.
const version = process.env.VERSION ?? pkg.version;

// VERSION is interpolated into the tarball filename and reused across the
// release pipeline; reject anything that could inject shell commands or
// escape the repo root (e.g. "/", "..", ";", "$(...)", backticks).
if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
  console.error(`Invalid VERSION: ${version}`);
  console.error(
    "VERSION must start with a letter or digit and contain only letters, digits, '.', '_', '-' or '+'.",
  );
  process.exit(1);
}

// Generate embedded sqlite-vec fallback for the current platform.
if (vec0Path !== null) {
  run(`bun run scripts/generate-vec-embed.ts ${platform} ${arch}`);
} else {
  console.warn(`⚠ sqlite-vec extension not found for ${platformKey}; skipping embed fallback`);
}

// Build the engine and CLI bundles.
run("bun run build");
run("bunx --bun tsdown --config tsdown.cli.config.ts");

// Stage the distribution layout.
const stageDir = path.join(repoRoot, ".beam-bundle-stage");
if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
fs.mkdirSync(stageDir, { recursive: true });

fs.cpSync(path.join(repoRoot, "dist"), path.join(stageDir, "dist"), { recursive: true });

const libDir = path.join(stageDir, "lib");
fs.mkdirSync(libDir, { recursive: true });

if (vec0Path !== null) {
  fs.copyFileSync(vec0Path, path.join(libDir, `vec0.${extensionSuffix}`));
}

const tarballName = `beam-v${version}-${platformKey}.tar.gz`;
const tarballPath = path.join(repoRoot, tarballName);

execFileSync("tar", ["-czf", tarballName, "-C", stageDir, "dist", "lib"], {
  cwd: repoRoot,
  stdio: "inherit",
});

fs.writeFileSync(`${tarballPath}.sha256`, `${sha256(tarballPath)}  ${tarballName}\n`);

console.log(`✓ Built ${tarballPath}`);
console.log(`  SHA-256: ${sha256(tarballPath)}`);

// Clean up the staging directory.
fs.rmSync(stageDir, { recursive: true, force: true });
