import { loadConfig } from "./config.mjs";
import { Logger } from "./utils/logger.mjs";
import { Storage } from "./core/storage.mjs";
import { BudgetManager, BudgetExceededError } from "./core/budget-manager.mjs";
import { HyperliquidHttpClient } from "./hyperliquid/client.mjs";
import { TradingEngine } from "./core/trading-engine.mjs";
import { GptAdvisor } from "./core/gpt-advisor.mjs";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const logger = new Logger(config.logLevel);
  const storage = new Storage(config);
  const budgetManager = new BudgetManager(config, logger);
  const client = new HyperliquidHttpClient(config, logger, budgetManager, storage);
  const gptAdvisor = new GptAdvisor({ config, logger, budgetManager, storage });

  if (config.requireAgentWallet && client.signerInfo().signerEqualsAccount) {
    logger.error("Agent wallet check failed: signerAddress == accountAddress. Use API/Agent wallet private key.");
    process.exitCode = 1;
    return;
  }

  const engine = new TradingEngine({
    config,
    logger,
    client,
    budgetManager,
    storage,
    gptAdvisor,
  });

  const shutdown = async (reason) => {
    await engine.requestShutdown(reason);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      logger.error("Shutdown failed", { error: err.message });
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      logger.error("Shutdown failed", { error: err.message });
    });
  });

  try {
    await engine.init();

    if (config.budgetMode === "quota") {
      const status = await client.fetchBudgetStatus();
      if (status) {
        budgetManager.applyQuotaStatus(status);
      } else {
        logger.warn("Quota mode selected but status endpoint unavailable; using local counters");
      }
    }

    const result = await engine.start();
    logger.info("Engine stopped", result);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      logger.warn("Budget exceeded during startup", { reason: error.message, details: error.details });
      await engine.requestShutdown(error.message, error);
      return;
    }

    logger.error("Fatal startup error", { error: error.message, stack: error.stack });
    try {
      await engine.requestShutdown("fatal_error", error);
    } catch {
      // no-op
    }
    process.exitCode = 1;
  }
}

main();
