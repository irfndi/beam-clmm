import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

function platformPackageName(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  return `sqlite-vec-${os}-${arch}`;
}

function extensionSuffix(platform: string): string {
  if (platform === "win32") return "dll";
  if (platform === "darwin") return "dylib";
  return "so";
}

/** Resolve sqlite-vec's native optional dependency for hoisted and isolated Bun installs. */
export function resolveSqliteVecPath(
  repoRoot: string,
  platform: string,
  arch: string,
): string | null {
  const packageName = platformPackageName(platform, arch);
  const filename = `vec0.${extensionSuffix(platform)}`;
  const candidates = [join(repoRoot, "node_modules", packageName, filename)];

  try {
    const sqliteVecPackage = dirname(require.resolve("sqlite-vec"));
    // Isolated installs place optional siblings beside sqlite-vec itself.
    candidates.unshift(join(dirname(sqliteVecPackage), packageName, filename));
  } catch {
    // Keep the hoisted candidate as the fallback for a partial install.
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function sqliteVecPlatformPackageName(platform: string, arch: string): string {
  return platformPackageName(platform, arch);
}
