import { describe, it, expect } from "vitest";
import { isCloudEnabled } from "../engine/cloud-switch.js";

describe("isCloudEnabled", () => {
  it("defaults to disabled when BEAM_CLOUD_ENABLED is absent or blank", () => {
    // Opt-in since the Cloudflare control plane was retired: an unset switch
    // must never send traffic to endpoints that no longer exist.
    expect(isCloudEnabled({})).toBe(false);
    expect(isCloudEnabled({ BEAM_CLOUD_ENABLED: "" })).toBe(false);
    expect(isCloudEnabled({ BEAM_CLOUD_ENABLED: "   " })).toBe(false);
  });

  it("stays disabled for every falsy spelling (case/whitespace insensitive)", () => {
    for (const value of ["false", "FALSE", "0", "no", "off", " False "]) {
      expect(isCloudEnabled({ BEAM_CLOUD_ENABLED: value })).toBe(false);
    }
  });

  it("enables only for explicit truthy values", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      expect(isCloudEnabled({ BEAM_CLOUD_ENABLED: value })).toBe(true);
    }
  });
});
