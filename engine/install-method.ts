import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type InstallMethod = "tarball" | "curl" | "git" | "unknown";

export function detectInstallMethod(): InstallMethod {
  const beamDir = join(homedir(), ".beam");
  if (existsSync(join(beamDir, ".tarball-install"))) return "tarball";
  if (process.env.BEAM_TARBALL_INSTALL === "1") return "tarball";
  const wrapperPath = join(homedir(), ".local", "bin", "beam");
  if (existsSync(wrapperPath)) return "curl";
  if (existsSync(join(process.cwd(), ".git"))) return "git";
  return "unknown";
}

export function isSourceInstall(installDir: string): boolean {
  return (
    existsSync(join(installDir, "package.json")) &&
    existsSync(join(installDir, "engine")) &&
    existsSync(join(installDir, "cli", "index.ts"))
  );
}
