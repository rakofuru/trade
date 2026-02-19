import { loadConfig } from "./config.mjs";
import { Logger } from "./utils/logger.mjs";
import { Storage } from "./core/storage.mjs";
import { BudgetManager, BudgetExceededError } from "./core/budget-manager.mjs";
import { HyperliquidHttpClient } from "./hyperliquid/client.mjs";
import { TradingEngine } from "./core/trading-engine.mjs";
import { GptAdvisor } from "./core/gpt-advisor.mjs";
import { LineOpsBridge } from "./line/line-ops-bridge.mjs";

function toError(input) {
  if (input instanceof Error) {
    return input;
  }
  if (typeof input === "string") {
    return new Error(input);
  }
  try {
    return new Error(JSON.stringify(input));
  } catch {
    return new Error(String(input));
  }
}

function reasonTag(kind, error) {
  const base = `${kind}:${String(error?.message || "unknown")}`;
  return base.slice(0, 240);
}

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
  const lineBridge = new LineOpsBridge({
    config,
    logger,
    storage,
    onDecision: async (command, context) => engine.handleOperatorDecision(command, {
      ...context,
      source: "line",
    }),
  });
  engine.setAskQuestionDispatcher(async (payload) => lineBridge.sendAskQuestion(payload));
  engine.setDailyEvalDispatcher(async (payload) => lineBridge.sendDailyEvaluation(payload));

  const shutdown = async (reason) => {
    await engine.requestShutdown(reason);
    await lineBridge.stop();
  };

  let fatalInProgress = false;
  const handleFatal = (kind, rawError) => {
    const error = toError(rawError);
    if (fatalInProgress) {
      logger.error("Fatal handler already running", { kind, error: error.message });
      process.exitCode = 1;
      return;
    }
    fatalInProgress = true;
    logger.error("Fatal process event", { kind, error: error.message, stack: error.stack });
    engine.requestShutdown(
      reasonTag(kind, error),
      error,
      { createKillSwitch: true },
    ).catch((shutdownError) => {
      logger.error("Fatal shutdown failed", { kind, error: shutdownError.message });
    }).finally(() => {
      lineBridge.stop().catch((stopError) => {
        logger.error("Line bridge stop failed", { kind, error: stopError.message });
      });
      process.exitCode = 1;
    });
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

  process.on("uncaughtException", (error) => {
    handleFatal("uncaughtException", error);
  });

  process.on("unhandledRejection", (reason) => {
    handleFatal("unhandledRejection", reason);
  });

  try {
    await lineBridge.start();
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
    await lineBridge.stop();
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      logger.warn("Budget exceeded during startup", { reason: error.message, details: error.details });
      await engine.requestShutdown(error.message, error);
      await lineBridge.stop();
      return;
    }

    logger.error("Fatal startup error", { error: error.message, stack: error.stack });
    try {
      await engine.requestShutdown("fatal_error", error, { createKillSwitch: true });
      await lineBridge.stop();
    } catch {
      // no-op
    }
    process.exitCode = 1;
  }
}

main();
