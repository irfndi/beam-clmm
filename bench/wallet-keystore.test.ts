import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import fs from "fs";
import os from "os";
import path from "path";
import { loadKeystoreSecretKeyHex, getWalletKeystorePath } from "../engine/wallet-keystore.js";
import { ConfigService, ConfigLive } from "../engine/config-service.js";
import type { AppConfig } from "../engine/config-service.js";

const TEST_PRIVATE_KEY = `0x${"ab".repeat(32)}`; // valid 64-hex key

async function loadConfig(): Promise<AppConfig> {
  return Effect.runPromise(Effect.provide(ConfigService, ConfigLive, { local: true }));
}

function writeKeystore(privateKey: string): void {
  fs.writeFileSync(
    getWalletKeystorePath(),
    JSON.stringify({
      privateKey,
    }),
  );
}

describe("wallet-keystore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "beam-ks-"));
    process.env.BEAM_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.BEAM_CONFIG_DIR;
    delete process.env.WALLET_PRIVATE_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("loadKeystoreSecretKeyHex", () => {
    it("loads the keystore private key as 0x-hex", () => {
      writeKeystore(TEST_PRIVATE_KEY);
      expect(loadKeystoreSecretKeyHex()).toBe(TEST_PRIVATE_KEY);
    });

    it("normalizes a bare (non-0x) hex key", () => {
      writeKeystore(TEST_PRIVATE_KEY.slice(2));
      expect(loadKeystoreSecretKeyHex()).toBe(TEST_PRIVATE_KEY);
    });

    it("returns null when no keystore exists", () => {
      expect(loadKeystoreSecretKeyHex()).toBeNull();
    });

    it("returns null for a malformed keystore", () => {
      fs.writeFileSync(getWalletKeystorePath(), "{ this is not json");
      expect(loadKeystoreSecretKeyHex()).toBeNull();
    });

    it("returns null for a non-hex key", () => {
      writeKeystore("not-a-key");
      expect(loadKeystoreSecretKeyHex()).toBeNull();
    });
  });

  describe("engine config wallet resolution", () => {
    it("falls back to the keystore when WALLET_PRIVATE_KEY is unset", async () => {
      writeKeystore(TEST_PRIVATE_KEY);
      const config = await loadConfig();
      expect(config.walletPrivateKey).toBe(TEST_PRIVATE_KEY);
    });

    it("prefers WALLET_PRIVATE_KEY over the keystore", async () => {
      writeKeystore(TEST_PRIVATE_KEY);
      process.env.WALLET_PRIVATE_KEY = `0x${"cd".repeat(32)}`;
      const config = await loadConfig();
      expect(config.walletPrivateKey).toBe(`0x${"cd".repeat(32)}`);
    });
  });
});
