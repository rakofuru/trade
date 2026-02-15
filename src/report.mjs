import { loadConfig } from "./config.mjs";
import { Logger } from "./utils/logger.mjs";
import { Storage } from "./core/storage.mjs";
import { BudgetManager } from "./core/budget-manager.mjs";
import { generateReport, formatReport, saveReport, generateTopImprovements } from "./core/reporting.mjs";

function parseWindowArg() {
  const idx = process.argv.indexOf("--hours");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) {
      return n * 3600 * 1000;
    }
  }
  return 24 * 3600 * 1000;
}

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const storage = new Storage(config);
  const budget = new BudgetManager(config, logger);

  const report = generateReport({
    storage,
    budgetSnapshot: budget.snapshot(),
    windowMs: parseWindowArg(),
  });
  saveReport(storage, report, "manual_cli");
  storage.appendImprovement({
    source: "manual_report",
    improvements: generateTopImprovements(report),
    summary: report.summary,
  });

  console.log(formatReport(report));
}

main().catch((error) => {
  console.error(`report failed: ${error.message}`);
  process.exitCode = 1;
});
