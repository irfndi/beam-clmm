// Replacer that stringifies BigInt values. Use with JSON.stringify whenever
// the value graph may contain bigints (e.g. pool metrics, bin arrays).
// Standard JSON.stringify throws on bigint; this is the standard workaround.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- replacer called by JSON.stringify with arbitrary JSON values at the serialization boundary
export function bigintReplacer(_key: string, value: unknown): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on arbitrary JSON value passed by JSON.stringify
  return typeof value === "bigint" ? value.toString() : value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- value is arbitrary serializable input; passed to JSON.stringify
export function stringifySafe(value: unknown, space?: string | number): string {
  return JSON.stringify(value, bigintReplacer, space);
}

// JSON.parse cannot reconstruct bigints; this reviver converts decimal strings
// back to BigInt for the fields we know are bigint in our domain types.
const BIGINT_FIELDS = new Set(["reserveX", "reserveY", "liquiditySupply", "liquidityShares"]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reviver called by JSON.parse with arbitrary JSON values at the parsing boundary
export function bigintReviver(key: string, value: unknown): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on arbitrary JSON value passed by JSON.parse
  if (typeof value === "string" && BIGINT_FIELDS.has(key)) {
    try {
      return BigInt(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function parseBigIntSafe<T = unknown>(text: string): T {
  return JSON.parse(text, bigintReviver) as T;
}
