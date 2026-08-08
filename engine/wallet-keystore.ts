import fs from "fs";
import path from "path";
import { isAddress } from "viem";
import { getBeamUserConfigDir } from "./paths.js";

/**
 * Path to the non-custodial local keystore written by `beam wallet generate|import`.
 * Lives in the user config dir (respects BEAM_CONFIG_DIR, never the source tree) so the
 * CLI that writes it and the engine that reads it always agree on the same file.
 */
export function getWalletKeystorePath(): string {
  return path.join(getBeamUserConfigDir(), "wallet.json");
}

/**
 * Load the keystore's private key as a 0x-hex string (the format
 * config.walletPrivateKey expects). Returns null when the keystore is absent,
 * unreadable, or malformed — the engine treats that as "no keystore key" and
 * the caller falls back accordingly.
 */
export function loadKeystoreSecretKeyHex(): string | null {
  try {
    const keystorePath = getWalletKeystorePath();
    if (!fs.existsSync(keystorePath)) return null;
    const data = JSON.parse(fs.readFileSync(keystorePath, "utf-8")) as {
      privateKey?: unknown;
    };
    if (typeof data.privateKey !== "string") return null;
    const key = data.privateKey.startsWith("0x") ? data.privateKey : `0x${data.privateKey}`;
    return isAddress(key) || /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}
