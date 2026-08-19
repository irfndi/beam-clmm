/* oxlint-disable */
import fs from "fs";
import path from "path";
import { privateKeyToAccount } from "viem/accounts";
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
    const value: unknown = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const privateKey = Reflect.get(value, "privateKey");
    if (typeof privateKey !== "string") return null;
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

export interface EffectiveWallet {
  readonly address?: `0x${string}`;
  readonly error?: string;
}

/**
 * Resolve the effective wallet address from the keystore or WALLET_PRIVATE_KEY
 * (keystore wins). Returns null when no key is configured at all; a
 * non-null result carries either the address or a parse error.
 */
export function resolveEffectiveWallet(): EffectiveWallet | null {
  const raw = loadKeystoreSecretKeyHex() ?? process.env.WALLET_PRIVATE_KEY ?? null;
  if (raw === null) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  try {
    // SAFETY: the preceding validation accepts exactly a 32-byte hexadecimal
    // private key with the 0x prefix, which is the input contract of viem.
    return { address: privateKeyToAccount(key as `0x${string}`).address };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get */
