import { Command } from "commander";
import fs from "fs";
import path from "path";
import { beamApiGet } from "./api.js";
import { getBeamUserConfigDir } from "../engine/paths.js";

const CREDENTIALS_FILE = path.join(getBeamUserConfigDir(), "credentials.json");

// Tier display info
const TIER_INFO: Record<
  string,
  { name: string; maxProfit: string; monthlyFee: string; features: string[] }
> = {
  free: {
    name: "Free",
    maxProfit: "1 USD/month",
    monthlyFee: "0 USD",
    features: ["Paper trading", "Basic pool monitoring", "Community support"],
  },
  pro: {
    name: "Pro",
    maxProfit: "10 USD/month",
    monthlyFee: "0.5 USD",
    features: ["Live trading", "Advanced analytics", "Priority support", "10% performance fee"],
  },
  fund: {
    name: "Fund",
    maxProfit: "Unlimited",
    monthlyFee: "2 USD",
    features: [
      "Live trading",
      "Full analytics suite",
      "Dedicated support",
      "20% performance fee",
      "Custom strategies",
    ],
  },
};

function getCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch (err) {
    console.error("Error: Failed to parse credentials file. Run 'beam register' first.");
    process.exit(1);
  }
}

export const subscriptionCommand = new Command("subscription")
  .description("Manage subscription")
  .addCommand(
    new Command("status").description("Show current tier and usage").action(async () => {
      const creds = getCredentials();
      if (!creds) {
        console.error("Error: Not registered. Run 'beam register' first.");
        process.exit(1);
      }

      const result = await beamApiGet<{
        tier: string;
        walletSol: number;
        referralCount: number;
        credits: number;
        platformFeeRate: number;
      }>("/v1/subscription/status", { apiKey: creds.apiKey });

      if (!result.ok || !result.data) {
        console.error("Error: Failed to fetch subscription status");
        if (result.error) console.error(`  ${result.error}`);
        process.exit(1);
      }

      const { tier, walletSol, referralCount, credits, platformFeeRate } = result.data;
      const info = (TIER_INFO[tier] ?? TIER_INFO.free)!;

      console.log(`Tier: ${info.name}`);
      console.log(`Wallet: $${walletSol.toFixed(2)}`);
      console.log(`Referrals: ${referralCount}`);
      console.log(`Credits: $${credits}`);
      console.log(`Platform fee: ${(platformFeeRate * 100).toFixed(0)}%`);
      console.log("");
      console.log("Features:");
      info.features.forEach((f) => {
        console.log(`  • ${f}`);
      });
    }),
  )
  .addCommand(
    new Command("upgrade")
      .description("Upgrade to a higher tier")
      .argument("<tier>", "Tier to upgrade to (pro|fund)")
      .action((tier) => {
        const creds = getCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'beam register' first.");
          process.exit(1);
        }

        if (!TIER_INFO[tier]) {
          console.error(`Error: Unknown tier '${tier}'. Available: pro, fund`);
          process.exit(1);
        }

        const info = TIER_INFO[tier];

        console.log(`Upgrade to ${info.name}`);
        console.log(`Monthly fee: ${info.monthlyFee}`);
        console.log("");
        console.log("Features:");
        info.features.forEach((f) => {
          console.log(`  • ${f}`);
        });
        console.log("");

        // Payment details: the new cloud API will publish a payment link here.
        console.log(`Please send ${info.monthlyFee} to the fee wallet to complete the upgrade.`);
      }),
  )
  .addCommand(
    new Command("tiers").description("List all available tiers").action(() => {
      console.log("Available Tiers\n");
      Object.entries(TIER_INFO).forEach(([key, info]) => {
        console.log(`${info.name} (${key})`);
        console.log(`  Max profit: ${info.maxProfit}`);
        console.log(`  Monthly fee: ${info.monthlyFee}`);
        console.log("  Features:");
        info.features.forEach((f) => {
          console.log(`  • ${f}`);
        });
        console.log("");
      });
    }),
  );
