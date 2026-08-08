#!/usr/bin/env bun
import "../engine/load-env.js";
import { Command } from "commander";
import { setupCommand } from "./setup.js";
import { registerCommand } from "./register.js";
import { loginCommand } from "./login.js";
import { whoamiCommand } from "./whoami.js";
import { telegramCommand } from "./telegram.js";
import { subscriptionCommand } from "./subscription.js";
import { issueCommand, supportCommand } from "./support.js";
import { devCommand } from "./dev.js";
import { backtestCommand } from "./backtest.js";
import { updateCommand } from "./update.js";
import { versionCommand } from "./version.js";
import { feedbackCommand } from "./feedback.js";
import { referralCommand } from "./referral.js";
import { portfolioCommand } from "./portfolio.js";
import { statusCommand } from "./status.js";
import { resumeCommand } from "./resume.js";
import { telemetryCommand } from "./telemetry.js";
import { configCommand } from "./config.js";
import { getCurrentVersion } from "../engine/version.js";

const program = new Command();

program
  .name("beam")
  .description("Beam — autonomous liquidity agent")
  .version(getCurrentVersion());

program.addCommand(setupCommand);
program.addCommand(registerCommand);
program.addCommand(loginCommand);
program.addCommand(whoamiCommand);
program.addCommand(telegramCommand);
program.addCommand(subscriptionCommand);
program.addCommand(issueCommand);
program.addCommand(supportCommand);
program.addCommand(devCommand);
program.addCommand(backtestCommand);
program.addCommand(updateCommand);
updateCommand.alias("upgrade");
program.addCommand(versionCommand);
program.addCommand(feedbackCommand);
program.addCommand(referralCommand);
program.addCommand(portfolioCommand);
program.addCommand(statusCommand);
program.addCommand(resumeCommand);
program.addCommand(telemetryCommand);
program.addCommand(configCommand);

await program.parseAsync();
