import fs from "fs";
import path from "path";
import { getOrCreateInstallId } from "./install-id.js";
import { getCurrentVersion } from "../engine/version.js";
import { getBeamUserConfigDir } from "../engine/paths.js";

const DEFAULT_API_URL = "https://beam-api.irfndi.workers.dev";

export function getApiBaseUrl(): string {
  return process.env.BEAM_API_URL ?? DEFAULT_API_URL;
}

export const CREDENTIALS_FILE = path.join(getBeamUserConfigDir(), "credentials.json");

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export interface BeamCredentials {
  apiKey: string;
  userId: string;
  createdAt: string;
}

interface ApiRequestOptions {
  apiKey?: string;
  signal?: AbortSignal;
}

export async function beamApiPost<T = unknown>(
  path: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Generic API client: the request body is arbitrary JSON payloads sent to a third-party HTTP boundary; the schema varies per endpoint, so the value type is intentionally open.
  body: Record<string, unknown>,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.apiKey) {
    headers.set("Authorization", `Bearer ${options.apiKey}`);
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, init);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Beam API error: ${response.status} ${response.statusText}`,
      };
    }
    const json = (await response.json()) as T;
    return { ok: true, status: response.status, data: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function beamApiGet<T = unknown>(
  path: string,
  options: { apiKey?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Beam API error: ${response.status} ${response.statusText}`,
      };
    }
    const json = (await response.json()) as T;
    return { ok: true, status: response.status, data: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readCredentials(): {
  apiKey: string;
  userId: string;
  createdAt: string;
} | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function requireRegistered(validate = false): Promise<BeamCredentials> {
  const credentials = readCredentials();
  if (!credentials?.apiKey || !credentials.userId) {
    throw new Error("Beam account required. Run 'beam register' first.");
  }
  if (validate) {
    const result = await beamApiPost(
      "/v1/login",
      {},
      { apiKey: credentials.apiKey, signal: AbortSignal.timeout(5000) },
    );
    if (!result.ok) {
      throw new Error(
        `Stored Beam credentials are invalid or unavailable. Run 'beam login <key>'.${
          result.error ? ` ${result.error}` : ""
        }`,
      );
    }
  }
  return credentials;
}

export function writeCredentials(creds: {
  apiKey: string;
  userId: string;
  createdAt: string;
}): void {
  const dir = path.dirname(CREDENTIALS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

export function pingInstall(
  event: "install" | "setup" | "dev_start" | "register",
  options: { userId?: string } = {},
): Promise<boolean> {
  return (async () => {
    try {
      const body = {
        installId: getOrCreateInstallId(),
        event,
        version: getCurrentVersion(),
        channel: process.env.UPDATE_CHANNEL ?? "stable",
        platform: process.platform,
      };
      const credentials = readCredentials();
      if (event !== "install" && !credentials?.apiKey) return false;
      if (options.userId && credentials?.userId !== options.userId) return false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const requestOptions: ApiRequestOptions = {
        signal: controller.signal,
      };
      if (credentials?.apiKey) requestOptions.apiKey = credentials.apiKey;
      const result = await beamApiPost("/v1/installs/ping", body, requestOptions).finally(() =>
        clearTimeout(timeout),
      );
      return result.ok;
    } catch {
      return false;
    }
  })();
}
