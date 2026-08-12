import "./load-env.js";
import fs from "fs";
import path from "path";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";
import { AdapterService } from "./services.js";
import { CHAIN_ID } from "./adapter-service.js";
import { createLogger } from "./logger.js";
import { errorReporter } from "./error-reporter.js";
import { getCurrentVersion } from "./version.js";
import {
  getBeamConfigDir,
  getBeamDataDir,
  getBeamDbPath,
  getBeamEnvPath,
  getBeamLogsDir,
} from "./paths.js";

function redirectStdoutStderrToFile(): void {
  const logsDir = getBeamLogsDir();
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logsDir, "engine.log");
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stdout.write
    chunk: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stdout.write
    encoding?: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stdout.write
    cb?: unknown,
  ) => boolean;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stderr.write
    chunk: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stderr.write
    encoding?: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stderr.write
    cb?: unknown,
  ) => boolean;
  const streamWrite = stream.write.bind(stream) as (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node stream.write() overload shadow, params dictated by stream.write type
    chunk: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node stream.write() overload shadow, params dictated by stream.write type
    encoding?: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node stream.write() overload shadow, params dictated by stream.write type
    cb?: unknown,
  ) => boolean;

  let streamBroken = false;

  stream.on("error", (err) => {
    if (streamBroken) return;
    streamBroken = true;
    // Restore original writers so a broken stream doesn't keep swallowing output.
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    process.stderr.write(`[run-engine] log stream error: ${err.message}\n`);
  });

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by process.stdout.write type
  function safeStreamWrite(chunk: unknown, encoding?: unknown, cb?: unknown): void {
    if (streamBroken) return;
    Effect.runSync(
      Effect.try({
        try: () => streamWrite(chunk, encoding, cb),
        catch: () => undefined,
      }),
    );
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stdout.write
  process.stdout.write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStdoutWrite(chunk, encoding, cb);
  } as typeof process.stdout.write;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node write() overload shadow, params dictated by typeof process.stderr.write
  process.stderr.write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStderrWrite(chunk, encoding, cb);
  } as typeof process.stderr.write;
}

redirectStdoutStderrToFile();

function ensureError(cause: unknown): Error {
  if ((cause as object) instanceof Error) {
    return cause as Error;
  }
  return new Error(String(cause));
}

export function runEngine(): Promise<void> {
  errorReporter.setAppVersion(getCurrentVersion());

  const logger = createLogger("run-engine");
  logger.info(`Beam engine starting — version ${getCurrentVersion()}`);
  logger.info(
    `Resolved paths: installDir=${process.env.BEAM_INSTALL_DIR ?? "(not set)"} configDir=${getBeamConfigDir()} dataDir=${getBeamDataDir()} envPath=${getBeamEnvPath()} dbPath=${getBeamDbPath()} logsDir=${getBeamLogsDir()}`,
  );

  process.on("uncaughtException", (err) => {
    errorReporter.report(ensureError(err), { severity: "critical" });
    console.error("Uncaught exception:", err);
    setImmediate(() =>
      Effect.runFork(
        errorReporter.flushEffect(2_000).pipe(Effect.ensuring(Effect.sync(() => process.exit(1)))),
      ),
    );
  });

  const config = Effect.runSync(
    Effect.gen(function* () {
      return yield* ConfigService;
    }).pipe(Effect.provide(ConfigLive)),
  );

  // Chain-identity pre-flight (fail-closed): every contract address this
  // engine uses is Robinhood Chain (4663)-specific. Verify the CONFIGURED
  // RPC is actually 4663 before the program effect scans or broadcasts
  // anything — a wrong RPC URL would otherwise silently target the wrong
  // network. A transport error is tolerated (the first scan cycle surfaces
  // connectivity anyway); a WRONG chain is never tolerated. Runs on the
  // adapter's own client via the real layer, so paper and live mode share
  // the exact same check. Only the adapter subtree of the layer graph is
  // constructed here (adapter -> configLayer); the DB stays untouched.
  const chainPreflight = Effect.gen(function* () {
    const adapter = yield* AdapterService;
    const connectedChainId: number | null = yield* adapter.verifyChainId
      ? adapter.verifyChainId().pipe(
          Effect.catch(() => Effect.succeed(null)),
          Effect.map((id) => id as number | null),
        )
      : Effect.succeed<number | null>(null);
    if (connectedChainId !== null && connectedChainId !== CHAIN_ID) {
      return yield* Effect.fail(
        new Error(
          `Refusing to start: RPC reports chain ${connectedChainId}, expected ${CHAIN_ID} ` +
            `(Robinhood Chain). Fix ROBINHOOD_RPC_URL before running the engine.`,
        ),
      );
    }
    if (connectedChainId === CHAIN_ID) {
      logger.info("Chain verified: Robinhood Chain (4663)");
    } else {
      logger.info(
        "Chain verification skipped (RPC unreachable at boot); first scan cycle will surface connectivity",
      );
    }
  }).pipe(Effect.provide(buildLayer(config)));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- error callback accepts any thrown value
  const fatal = (err: unknown) =>
    Effect.sync(() => {
      errorReporter.report(ensureError(err), { severity: "critical" });
      console.error("Fatal error:", err);
      setImmediate(() =>
        Effect.runFork(
          errorReporter
            .flushEffect(2_000)
            .pipe(Effect.ensuring(Effect.sync(() => process.exit(1)))),
        ),
      );
    });

  return Effect.runPromise(
    chainPreflight.pipe(
      Effect.catch(fatal),
      Effect.andThen(
        program.pipe(Effect.provide(buildLayer(config)), Effect.catch(fatal)),
      ),
    ),
  );
}
