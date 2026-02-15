import { loadConfig } from "./config.mjs";
import { Logger } from "./utils/logger.mjs";
import { Storage } from "./core/storage.mjs";
import { runReplay } from "./core/replay-runner.mjs";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const storage = new Storage(config);

  const result = await runReplay({ config, logger, storage });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`replay failed: ${error.message}`);
  process.exitCode = 1;
});