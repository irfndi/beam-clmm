import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  readonly version?: string;
}

interface ReleaseManifest {
  version: string;
  channel: ReleaseChannel;
  commit?: string;
  tarball_url: string;
  sha256_url: string;
  published_at: string;
  min_cli_version: string;
  bundles: Record<string, { url: string; sha256_url: string }>;
}

const version = process.env.VERSION ?? "";
type ReleaseChannel = "stable" | "beta" | "dev" | "canary";
const channelValue = process.env.CHANNEL ?? "stable";
const channels = [
  "stable",
  "beta",
  "dev",
  "canary",
] as const satisfies ReadonlyArray<ReleaseChannel>;
function isReleaseChannel(value: string): value is ReleaseChannel {
  return includesString(channels, value);
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function packageVersion(value: PackageJson | null): string | null {
  return value?.version && value.version.length > 0 ? value.version : null;
}

if (!isReleaseChannel(channelValue)) {
  console.error(`Invalid channel: ${channelValue}`);
  process.exit(1);
}
const channel: ReleaseChannel = channelValue;
const r2Base = (
  process.env.R2_BASE_URL ?? "https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev"
).replace(/\/+$/, "");
const keyPrefix = (process.env.R2_KEY_PREFIX ?? `releases/v${version}`).replace(/^\/+|\/+$/g, "");
const commit = process.env.COMMIT;
const outFile = process.env.OUT_FILE ?? "manifest.json";
const requireAllBundles = (process.env.REQUIRE_ALL_BUNDLES ?? "true") === "true";

if (!version) {
  console.error("VERSION env is required");
  process.exit(1);
}

// VERSION is interpolated into artifact URLs and the R2 key prefix; reject
// anything that could escape the key path or break bundle-name matching
// (mirrors the validation in scripts/build-bundle.ts).
if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
  console.error(`Invalid VERSION: ${version}`);
  console.error(
    "VERSION must start with a letter or digit and contain only letters, digits, '.', '_', '-' or '+'.",
  );
  process.exit(1);
}

if (!keyPrefix) {
  console.error(
    "R2_KEY_PREFIX resolved to an empty string; refusing to emit a manifest with an empty key path",
  );
  process.exit(1);
}

const cwd = process.cwd();
const files = fs.readdirSync(cwd).filter((f) => {
  return f.startsWith(`beam-v${version}-`) && f.endsWith(".tar.gz") && !f.endsWith(".sha256");
});

const expectedPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const bundles: Record<string, { url: string; sha256_url: string }> = {};

for (const file of files) {
  // Reconstruct the platform key from the fixed file-name shape instead of
  // interpolating the version into a regex (a `+` in semver build metadata
  // would otherwise be parsed as a quantifier and break the match).
  const platformKey = file.slice(`beam-v${version}-`.length, -".tar.gz".length);
  if (!platformKey) continue;
  const sha256File = `${file}.sha256`;
  if (!fs.existsSync(path.join(cwd, sha256File))) {
    console.warn(`Missing checksum for ${file}, skipping`);
    continue;
  }
  const url = `${r2Base}/${keyPrefix}/${file}`;
  bundles[platformKey] = { url, sha256_url: `${url}.sha256` };
}

if (requireAllBundles) {
  const missing = expectedPlatforms.filter((p) => !bundles[p]);
  if (missing.length > 0) {
    console.error(`Missing bundles for platforms: ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (Object.keys(bundles).length === 0) {
  console.warn("No bundles found; manifest will have no per-platform bundles.");
}

const tarballUrl = `${r2Base}/${keyPrefix}/beam-v${version}.tar.gz`;

// The CLI's own version (engine/version.ts reads package.json) is the minimum
// that can consume this manifest; deriving it here keeps the two from drifting.
let minCliVersion = "0.0.0";
try {
  // SAFETY: packageVersion reads only the optional string version field.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
  ) as PackageJson;
  const parsedVersion = packageVersion(pkg);
  if (parsedVersion !== null) minCliVersion = parsedVersion;
} catch {
  // fall back to "0.0.0" if package.json is unreadable
}

const manifest: ReleaseManifest = {
  version,
  channel,
  tarball_url: tarballUrl,
  sha256_url: `${tarballUrl}.sha256`,
  published_at: new Date().toISOString(),
  min_cli_version: minCliVersion,
  bundles,
};
if (commit) manifest.commit = commit;

fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${outFile} with bundles: ${Object.keys(bundles).join(", ") || "none"}`);
