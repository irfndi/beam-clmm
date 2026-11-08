/**
 * Master switch for the hosted Beam Cloud control plane (Cloudflare Workers +
 * D1/KV: agent-status reports, alerts, revenue config, cloud feedback).
 *
 * `BEAM_CLOUD_ENABLED=false` makes the agent fully standalone — state stays in
 * SQLite, the operator surface is the local `http-status-server`, and alerts
 * are written to the audit log instead of being pushed to Telegram. This is the
 * mode to run when the cloud isn't wanted (cost, air-gapped VPS, self-hosting).
 *
 * The hosted control plane (Cloudflare Workers + D1) was retired when Beam moved
 * to a self-hosted VPS. Default is DISABLED (opt-in): nothing leaves the machine
 * unless `BEAM_CLOUD_ENABLED=true` is set explicitly. Set it to a truthy value
 * only if you have re-provisioned the cloud control plane somewhere.
 *
 * `BEAM_CLOUD_ENABLED=false` (or unset) makes the agent fully standalone — state
 * stays in SQLite, the operator surface is the local `http-status-server`, and
 * alerts are written to the audit log instead of being pushed to Telegram.
 */
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * False unless `BEAM_CLOUD_ENABLED` is explicitly a truthy value. Opt-in since
 * the Cloudflare control plane was retired; a default-on switch would make
 * every install hammer endpoints that no longer exist.
 */
export const isCloudEnabled = (env: Record<string, string | undefined> = process.env): boolean => {
  const raw = env.BEAM_CLOUD_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  return !DISABLED_VALUES.has(raw);
};
