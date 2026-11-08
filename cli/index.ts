#!/usr/bin/env bun
import "../engine/load-env.js";
import { Command } from "commander";
import { setupCommand } from "./setup.js";
import { devCommand } from "./dev.js";
import { backtestCommand } from "./backtest.js";
import { updateCommand } from "./update.js";
import { versionCommand } from "./version.js";
import { feedbackCommand } from "./feedback.js";
import { portfolioCommand } from "./portfolio.js";
import { statusCommand } from "./status.js";
import { resumeCommand } from "./resume.js";
import { telemetryCommand } from "./telemetry.js";
import { configCommand } from "./config.js";
import { decisionsCommand } from "./decisions.js";
import { getCurrentVersion } from "../engine/version.js";

const program = new Command();

program.name("beam").description("Beam — autonomous liquidity agent").version(getCurrentVersion());

program.addCommand(setupCommand);
program.addCommand(devCommand);
program.addCommand(backtestCommand);
program.addCommand(updateCommand);
updateCommand.alias("upgrade");
program.addCommand(versionCommand);
program.addCommand(feedbackCommand);
program.addCommand(portfolioCommand);
program.addCommand(statusCommand);
program.addCommand(resumeCommand);
program.addCommand(telemetryCommand);
program.addCommand(configCommand);
program.addCommand(decisionsCommand);

await program.parseAsync();
