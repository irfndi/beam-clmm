import pkg from "../package.json" with { type: "json" };

let cachedVersion: string | null = null;

export function getCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- defensive guard on statically-imported package.json JSON module
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- defensive guard on statically-imported package.json JSON module
    typeof pkg.version === "string"
  ) {
    cachedVersion = pkg.version;
    return cachedVersion;
  }
  return "0.0.0";
}
