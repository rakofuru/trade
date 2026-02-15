import { loadConfig } from "./config.mjs";
import { Logger } from "./utils/logger.mjs";
import { BudgetManager } from "./core/budget-manager.mjs";
import { HyperliquidHttpClient } from "./hyperliquid/client.mjs";
import { keccakHex } from "./utils/crypto/keccak.mjs";
import { privateKeyToAddress } from "./utils/crypto/secp256k1.mjs";
import { Storage } from "./core/storage.mjs";
import { GptAdvisor } from "./core/gpt-advisor.mjs";
import { generateReport } from "./core/reporting.mjs";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

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

async function wsHealthcheck(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WS healthcheck timeout"));
    }, 12000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
    });

    ws.addEventListener("message", () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    });

    ws.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(`WS error: ${event?.message || "unknown"}`));
    });
  });
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

  console.log("[doctor] config ok");
  console.log(`[doctor] network=${config.network} http=${config.httpUrl} ws=${config.wsUrl}`);

  const keccakEmpty = keccakHex(new Uint8Array());
  if (keccakEmpty !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
    throw new Error("keccak self-check failed");
  }
  console.log("[doctor] crypto self-check ok");

  const signerAddress = privateKeyToAddress(config.apiWalletPrivateKey);
  console.log(`[doctor] signer=${maskAddress(signerAddress)} account=${maskAddress(client.accountAddress)}`);
  const signerEqualsAccount = signerAddress.toLowerCase() === String(client.accountAddress).toLowerCase();
  if (signerEqualsAccount && !config.requireAgentWallet) {
    console.log("[doctor] warning: signerAddress == accountAddress (agent wallet not enforced).");
  }
  if (config.requireAgentWallet && signerEqualsAccount) {
    throw new Error(
      "Agent wallet check failed: signerAddress == accountAddress. Use an API/Agent wallet private key from Hyperliquid UI (/API).",
    );
  }

  storage.appendMetric({ type: "doctor_write_test", ok: true });
  console.log("[doctor] storage write ok");

  const meta = await client.postInfo({ type: "meta" }, "meta");
  const universeSize = Array.isArray(meta?.universe) ? meta.universe.length : 0;
  console.log(`[doctor] /info meta ok universe=${universeSize}`);

  const userState = await client.fetchUserState();
  const accountValue = Number(userState?.marginSummary?.accountValue ?? userState?.crossMarginSummary?.accountValue ?? NaN);
  console.log(`[doctor] /info perp state ok accountValue=${Number.isFinite(accountValue) ? accountValue : "n/a"}`);

  const spotState = await client.fetchSpotState();
  if (spotState && Array.isArray(spotState.balances)) {
    const usdc = spotState.balances.find((b) => String(b.coin).toUpperCase() === "USDC");
    const spotUsdc = Number(usdc?.total ?? 0);
    console.log(`[doctor] /info spot state ok spotUSDC=${Number.isFinite(spotUsdc) ? spotUsdc : 0}`);
    if ((Number.isFinite(accountValue) ? accountValue : 0) <= 0 && spotUsdc > 0) {
      console.log("[doctor] warning: perp accountValue is 0 while spot has USDC. Move funds Spot -> Perp before starting bot.");
    }
  }

  const openOrders = await client.fetchOpenOrders();
  console.log(`[doctor] /info openOrders ok count=${openOrders.length}`);

  const budget = await client.fetchBudgetStatus();
  if (budget) {
    console.log(`[doctor] /info userRateLimit ok remaining=${budget.remaining} cap=${budget.cap}`);
  } else {
    console.log("[doctor] quota endpoint not available; counter budget only");
  }
  const budgetSnapshot = budgetManager.snapshot();
  console.log(`[doctor] budget counters http=${budgetSnapshot.dailyHttpCalls}/${budgetSnapshot.dailyLimit} orders=${budgetSnapshot.dailyOrders}/${budgetSnapshot.dailyOrderLimit} cancels=${budgetSnapshot.dailyCancels}/${budgetSnapshot.dailyCancelLimit}`);
  console.log(`[doctor] storage streams=${config.streamDir} rollups=${config.rollupDir} rawKeepDays=${config.rawKeepDays} compressedKeepDays=${config.compressedKeepDays}`);
  const report = generateReport({
    storage,
    budgetSnapshot,
    windowMs: parseWindowArg(),
  });
  const stability = report.stability || {};
  console.log(`[doctor] stability overall=${String(stability.overall || "unknown").toUpperCase()} sampleOrders=${stability.sampleOrders ?? 0} minOrders=${stability.minOrders ?? 0}`);
  for (const metric of stability.metrics || []) {
    const value = formatStability(metric);
    const threshold = formatStability({ ...metric, value: metric.threshold });
    const compare = metric.thresholdType === "min" ? ">=" : "<=";
    console.log(`[doctor] stability ${metric.key}=${value} target ${compare} ${threshold} status=${String(metric.status || "unknown").toUpperCase()}`);
  }

  const recentExchangeRows = storage.readStream("raw_http", { maxLines: 4000 })
    .filter((r) => String(r.label || "").startsWith("exchange:"))
    .slice(-200)
    .map((row) => ({ row, error: extractExchangeError(row) }))
    .filter((x) => Boolean(x.error));
  if (recentExchangeRows.length) {
    const latest = recentExchangeRows[recentExchangeRows.length - 1];
    console.log(`[doctor] recent exchange err: ${redactSensitiveText(latest.error)}`);
  }

  if (!hasFlag("--skip-ws")) {
    await wsHealthcheck(config.wsUrl);
    console.log("[doctor] websocket ok");
  }

  if (config.gptEnabled) {
    try {
      const gpt = await gptAdvisor.healthcheck();
      if (!gpt.ok) {
        console.log("[doctor] warning: GPT healthcheck returned non-ok");
      } else {
        console.log(`[doctor] gpt ok model=${config.openaiModel} tokens=${gpt.usage?.totalTokens ?? "n/a"}`);
      }
    } catch (error) {
      console.log(`[doctor] warning: GPT healthcheck failed (${error.message})`);
    }
  } else {
    console.log("[doctor] gpt disabled");
  }

  console.log("[doctor] all checks passed");
}

main().catch((error) => {
  console.error(`[doctor] failed: ${error.message}`);
  process.exitCode = 1;
});

function extractExchangeError(rawRow) {
  const response = rawRow?.response || {};
  if (String(response?.status || "").toLowerCase() === "err") {
    if (typeof response?.response === "string" && response.response) {
      return response.response;
    }
    if (typeof response?.error === "string" && response.error) {
      return response.error;
    }
    if (typeof response?.response?.error === "string" && response.response.error) {
      return response.response.error;
    }
  }

  const statuses = response?.response?.data?.statuses || response?.data?.statuses || [];
  for (const status of statuses) {
    if (typeof status?.error === "string" && status.error) {
      return status.error;
    }
  }
  return null;
}

function formatStability(metric) {
  const key = String(metric?.key || "");
  const value = Number(metric?.value || 0);
  if (key.includes("rate") || key.includes("ratio")) {
    return `${(value * 100).toFixed(2)}%`;
  }
  if (key.includes("bps")) {
    return `${value.toFixed(2)}bps`;
  }
  return value.toFixed(4);
}

function maskAddress(value) {
  const str = String(value || "");
  if (!str.startsWith("0x") || str.length < 12) {
    return "***";
  }
  return `${str.slice(0, 6)}***${str.slice(-4)}`;
}

function redactSensitiveText(value) {
  if (!value) {
    return value;
  }
  return String(value).replace(/0x[a-fA-F0-9]{8,}/g, (m) => `${m.slice(0, 6)}***${m.slice(-4)}`);
}
