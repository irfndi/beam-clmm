import { config } from "dotenv";
import { installBigintWarningFilter } from "./bigint-warning-filter.js";
import { ensureBeamConfigDir, getBeamEnvPath } from "./paths.js";

// Installed here — load-env is the first module every entry point imports
// (cli/index.ts, run-engine.ts), so the patch lands before any static import
// reaches bigint-buffer's module-load warn.
installBigintWarningFilter();

ensureBeamConfigDir();
config({ path: getBeamEnvPath(), quiet: true });
