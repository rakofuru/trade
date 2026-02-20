import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "../core/storage.mjs";
import { DataLifecycleManager } from "../core/data-lifecycle.mjs";
import { RollupManager } from "../core/rollup-manager.mjs";
import { Logger } from "../utils/logger.mjs";
import { appendJsonl, ensureDir, fileExists, gzipFile } from "../utils/fs.mjs";
import { validateProposal } from "../core/gpt-advisor.mjs";
import { defaultArms } from "../core/bandit.mjs";
import { evaluateStability } from "../core/stability.mjs";
import { generateReport } from "../core/reporting.mjs";
import { normalizePerpPriceForWire, validatePerpOrderWire } from "../hyperliquid/constraints.mjs";
import { toOrderWire } from "../hyperliquid/signing.mjs";
import {
  buildStrategyDecisionMetric,
  buildTpSlOrderRequests,
  computeTpSlTriggerPrices,
  dailyLossWindowStartTs,
  evaluateAskQuestionPolicy,
  evaluateAskQuestionTriggerGate,
  resolveAskQuestionTtlDefaultAction,
  shouldRefreshTpSlState,
} from "../core/trading-engine.mjs";
import { shouldTriggerWsWatchdog } from "../hyperliquid/ws-client.mjs";
import {
  buildSignal,
  resetStrategyStateForTests,
} from "../core/strategy-engine.mjs";
import { analyzeRows } from "../../ops/analyze-ops.mjs";
import { buildDailySummary, renderDailySummary } from "../../ops/daily-summary.mjs";
import {
  buildPerformanceReport,
  renderPerformanceMarkdown,
  renderPerformanceTable,
} from "../../ops/performance-report.mjs";
import { buildStrategyDecisionReport } from "../../ops/strategy-decision-report.mjs";
import {
  buildPositionWhyReport,
  renderPositionWhyMarkdown,
  renderPositionWhyTable,
} from "../../ops/position-why.mjs";
import { parseBotDecisionMessage } from "../line/decision-parser.mjs";
import { verifyLineSignature } from "../line/signature.mjs";
import { buildAskQuestionMessages } from "../line/ask-question.mjs";
import { buildDailyEvaluationMessages } from "../line/daily-eval.mjs";
import { isLineUserAllowed } from "../line/line-ops-bridge.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hl-bot-test-"));
}

function mkConfig(baseDir) {
  return {
    dataDir: baseDir,
    stateDir: path.join(baseDir, "state"),
    streamDir: path.join(baseDir, "streams"),
    rollupDir: path.join(baseDir, "rollups"),
    rawMaxFileMb: 0.001,
    rawKeepDays: 1,
    compressedKeepDays: 30,
    rollupKeepDays: 365,
    rollupIntervalSec: 60,
    reportRawLookbackHours: 24,
  };
}

function dayKey(daysAgo) {
  const t = Date.now() - (daysAgo * 24 * 3600 * 1000);
  return new Date(t).toISOString().slice(0, 10);
}

function makeCandles({
  length = 90,
  base = 100,
  drift = 0,
  highPad = 0.2,
  lowPad = 0.2,
} = {}) {
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const close = base + (drift * i);
    out.push({
      ts: i * 60_000,
      open: close,
      high: close + highPad,
      low: close - lowPad,
      close,
      volume: 10 + i,
    });
  }
  return out;
}

function makeTrendBreakoutCandles() {
  const candles = makeCandles({ length: 70, base: 100.3, drift: 0.001, highPad: 0.25, lowPad: 0.25 });
  candles[68] = {
    ts: 68 * 60_000,
    open: 100.95,
    high: 101.35,
    low: 100.85,
    close: 101.2,
    volume: 40,
  };
  candles[69] = {
    ts: 69 * 60_000,
    open: 101.15,
    high: 101.65,
    low: 101.05,
    close: 101.5,
    volume: 45,
  };
  return candles;
}

function baseStrategyConfig() {
  return {
    strategySymbolDefaults: {
      makerSpreadBps: 10,
      makerSlippageBps: 10,
      turbulenceRet1mPct: 0.65,
      trendTakerTriggerPct: 0.12,
    },
    strategyDataStaleCandleMs: 90_000,
    strategyDataStaleBookMs: 20_000,
    strategyDataStaleTradesMs: 20_000,
    strategyTurbulenceAtrMedianMult: 1.8,
    strategyTrendAdxMin: 20,
    strategyRangeAdxMax: 15,
    strategyTrendEmaGapBpsMin: 8,
    strategyRangeEmaGapBpsMax: 4,
    strategyTrendBreakoutLookbackBars: 20,
    strategyTrendBreakoutConfirmBars: 2,
    strategyTrendBreakoutBufferBps: 3,
    strategyTrendBreakoutMinBodyRatio: 0.35,
    strategyTrendBreakoutMaxRet1mPct: 1.2,
    strategyTrendFlowWindowSec: 20,
    strategyTrendAggressorRatioMin: 0.55,
    strategyTrendImbalanceThreshold: 0.1,
    strategyRangeZEntry: 2.0,
    strategyRangeNoBreakoutBars: 2,
    strategyRangeMaxAtrPct: 0.9,
    strategyRangeMaxRet1mPct: 0.45,
    strategyTrendSlAtrMult: 1.2,
    strategyTrendSlMinPct: 0.45,
    strategyTrendSlMaxPct: 0.9,
    strategyTrendTpMult: 1.3,
    strategyTrendTimeStopMs: 12 * 60 * 1000,
    strategyTrendTimeStopProgressR: 0.4,
    strategyRangeSlAtrMult: 1.5,
    strategyRangeSlMinPct: 0.55,
    strategyRangeSlMaxPct: 1.2,
    strategyRangeOneRTpMult: 1.0,
    strategyRangeTimeStopMs: 6 * 60 * 1000,
    strategyRangeTimeStopProgressR: 0.3,
    strategyTrendMakerTtlMs: 8000,
    strategyRangeMakerTtlMs: 10000,
    strategyMaxEntriesPerCoinPerHour: 4,
    strategyEntryCooldownMs: 0,
    strategyRestartNoTradeMs: 0,
    strategyRegimeMinHoldMs: 600000,
    strategyRegimeConfirmBars: 2,
    strategyRegimeFlipWindowMs: 1800000,
    strategyRegimeFlipMaxInWindow: 4,
    strategyRegimeFlipCooldownMs: 300000,
    strategyMinEdgeBaseBps: 8,
    strategyMinEdgeVolK: 1.5,
    strategyMinEdgeSafetyBufferBps: 1,
    strategyMinEdgeFallbackSlippageBps: 2,
    strategyMinEdgeMakerSlipFactor: 0.65,
    strategyFeeMakerBps: 1.8,
    strategyFeeTakerBps: 3.6,
    strategyFeeRefreshMs: 300000,
  };
}

function makeMarketDataStub(overrides = {}) {
  const candles = makeTrendBreakoutCandles();
  return {
    hasStaleData: () => ({ stale: false, channels: [] }),
    lastBook: () => ({
      ts: candles[candles.length - 1].ts,
      spreadBps: 2.0,
      spread: 0.2,
      bestBid: 101.4,
      bestAsk: 101.6,
      mid: 101.5,
      bidDepth: 50000,
      askDepth: 50000,
      levels: {
        bids: [{ px: 101.4, sz: 10 }],
        asks: [{ px: 101.6, sz: 10 }],
      },
    }),
    estimateSlippageBps: () => 1.5,
    atrPercent: () => 0.4,
    atrPercentSeries: () => [0.28, 0.31, 0.33, 0.36, 0.4],
    recentCloseReturnPct: () => 0.2,
    ema: (_coin, interval, length) => {
      if (interval === "15m" && length === 20) return 101.5;
      if (interval === "15m" && length === 50) return 100.9;
      return null;
    },
    adx: () => 28,
    candlesByInterval: () => candles,
    recentAggressiveVolumeRatio: () => 0.67,
    top5Imbalance: () => 0.18,
    mid: () => 101.5,
    zScoreFromVwap: () => 2.3,
    vwap: () => 101.0,
    ...overrides,
  };
}

async function testStorageRotation() {
  const dir = tmpDir();
  const config = mkConfig(dir);
  const storage = new Storage(config);

  for (let i = 0; i < 2500; i += 1) {
    storage.appendMetric({
      msg: "x".repeat(420),
      i,
    });
  }

  const today = dayKey(0);
  const dayDir = path.join(config.streamDir, today);
  const files = fs.readdirSync(dayDir).filter((x) => x.startsWith("metrics"));
  assert(files.some((x) => x === "metrics.jsonl"), "base metrics file missing");
  assert(files.some((x) => /\.part\d+\.jsonl$/.test(x)), "rotation part file missing");
}

async function testLifecycleCompressionAndRetention() {
  const dir = tmpDir();
  const config = mkConfig(dir);
  const storage = new Storage(config);
  const logger = new Logger("error");
  const lifecycle = new DataLifecycleManager({ config, storage, logger });

  const recentDay = dayKey(2);
  const recentRaw = path.join(config.streamDir, recentDay, "raw_http.jsonl");
  ensureDir(path.dirname(recentRaw));
  appendJsonl(recentRaw, { ts: Date.now(), ok: true });

  const oldDay = dayKey(40);
  const oldRaw = path.join(config.streamDir, oldDay, "raw_http.jsonl");
  ensureDir(path.dirname(oldRaw));
  appendJsonl(oldRaw, { ts: Date.now(), old: true });
  gzipFile(oldRaw, `${oldRaw}.gz`);
  fs.unlinkSync(oldRaw);

  await lifecycle.runOnce();

  assert(!fileExists(recentRaw), "recent raw should be removed after keep period once gz exists");
  assert(fileExists(`${recentRaw}.gz`), "recent raw should be compressed");
  assert(!fileExists(`${oldRaw}.gz`), "very old compressed raw should be deleted");
}

async function testRollupAggregation() {
  const dir = tmpDir();
  const config = mkConfig(dir);
  const storage = new Storage(config);
  const logger = new Logger("error");
  const rollups = new RollupManager({ config, storage, logger });

  const baseTs = Math.floor(Date.now() / 60000) * 60000;
  rollups.recordBook({ coin: "ETH", spreadBps: 3.2, depthUsd: 120000, mid: 2000, ts: baseTs + 1000 });
  rollups.recordBook({ coin: "ETH", spreadBps: 2.8, depthUsd: 110000, mid: 2001, ts: baseTs + 2000 });
  rollups.recordOrderResult({ coin: "ETH", submitted: 1, rejected: 0, ts: baseTs + 3000 });
  rollups.recordOrderResult({ coin: "ETH", submitted: 0, rejected: 1, ts: baseTs + 4000 });
  rollups.recordExecution({
    coin: "ETH",
    notional: 25,
    slippageBps: 6,
    feeUsd: 0.02,
    realizedPnl: 0.05,
    ts: baseTs + 5000,
  });
  rollups.recordHealth({ coin: "ETH", drawdownBps: 40, isUp: true, apiCalls: 100, ts: baseTs + 1000 });
  rollups.recordHealth({ coin: "ETH", drawdownBps: 45, isUp: true, apiCalls: 104, ts: baseTs + 50000 });
  rollups.flush(baseTs + 120000);

  const rows = storage.readRollup("coin_rollup");
  assert(rows.length >= 1, "rollup row should be written");
  const latest = rows[rows.length - 1];
  assert.equal(latest.coin, "ETH");
  assert(Number.isFinite(Number(latest.spread_bps)), "spread_bps should be numeric");
  assert(Number(latest.orders_submitted) >= 1, "orders_submitted should be aggregated");
  assert(Number(latest.api_calls) >= 0, "api_calls should be aggregated");
}

async function testGptProposalSchemaValidation() {
  const arms = defaultArms();
  const valid = validateProposal({
    summary: { diagnosis: "x", confidence: 0.9 },
    proposals: [
      {
        id: "p1",
        type: "param",
        change: {
          coin: "ETH",
          regime: "ALL",
          armId: "momentum_fast",
          params: { lookback: 999, signalThreshold: 0.1 },
        },
        expectedImpact: "better",
        risk: "low",
        tests: ["a"],
        rollback: "revert",
      },
      {
        id: "p2",
        type: "coin",
        change: { action: "remove", coin: "DOGE" },
      },
    ],
    stop: { suggest: false, reason: "", severity: "low" },
    alerts: [],
    meta: { horizon: "1d", priority: "medium" },
  }, arms);

  assert.equal(valid.schemaValid, true);
  assert(valid.changes.length >= 1, "param proposal should convert to changes");
  assert(valid.coinActions.some((x) => x.action === "remove"), "coin action should be preserved");
  const lookback = Number(valid.changes[0].params.lookback);
  assert(lookback <= 80, "lookback should be clamped to max bound");

  const invalid = validateProposal({ foo: "bar" }, arms);
  assert.equal(invalid.schemaValid, false, "invalid schema should be flagged");
}

async function testStabilityEvaluation() {
  const config = {
    stabilityMinOrders: 10,
    stabilityMinCancelAttempts: 3,
    stabilityMinFillRate: 0.02,
    stabilityMaxRejectRate: 0.35,
    stabilityMaxSlippageBps: 18,
    stabilityMaxExceptionRate: 0.2,
    stabilityMaxCancelErrorRate: 0.8,
    stabilityMaxWsReconnectRatio: 0.8,
    stabilityMaxDrawdownBps: 350,
    budgetMaxWsReconnects: 50,
  };

  const pass = evaluateStability({
    summary: {
      orderCount: 40,
      executionCount: 12,
      exchangeErrCount: 6,
      errorCount: 3,
      totalNotional: 1000,
      totalSlippageUsd: 0.9,
      currentDrawdownBps: 90,
    },
  }, config, { wsReconnects: 5, reconnectLimit: 50 });
  assert.equal(pass.overall, "pass", "healthy profile should pass stability gate");

  const fail = evaluateStability({
    summary: {
      orderCount: 40,
      executionCount: 4,
      exchangeErrCount: 22,
      errorCount: 20,
      totalNotional: 1000,
      totalSlippageUsd: 4,
      currentDrawdownBps: 120,
    },
  }, config, { wsReconnects: 5, reconnectLimit: 50 });
  assert.equal(fail.overall, "fail", "high reject/exception profile should fail stability gate");
  assert(fail.violations.length >= 1, "fail should expose violations");

  const warmup = evaluateStability({
    summary: {
      orderCount: 2,
      cancelAttemptCount: 1,
      cancelErrorRate: 1,
      executionCount: 1,
      exchangeErrCount: 1,
      errorCount: 1,
      totalNotional: 10,
      totalSlippageUsd: 0.01,
      currentDrawdownBps: 5,
    },
  }, config, { wsReconnects: 0, reconnectLimit: 50 });
  assert.equal(warmup.overall, "warmup", "small sample should remain in warmup");
  const cancelMetric = warmup.metrics.find((m) => m.key === "cancel_error_rate");
  assert.equal(cancelMetric?.status, "warmup", "cancel metric should warm up when cancel samples are tiny");
}

async function testPerpConstraintValidation() {
  const ok = validatePerpOrderWire({
    px: "2076.3",
    sz: "0.0058",
    szDecimals: 4,
  });
  assert.equal(ok.ok, true, "valid perp wire should pass");

  const badPrice = validatePerpOrderWire({
    px: "2076.560175",
    sz: "0.0058",
    szDecimals: 4,
  });
  assert.equal(badPrice.ok, false, "price violating sigfig/decimals should fail");

  const integerAllowed = validatePerpOrderWire({
    px: "100000",
    sz: "0.0058",
    szDecimals: 4,
  });
  assert.equal(integerAllowed.ok, true, "integer price should be allowed");

  const badTrigger = validatePerpOrderWire({
    px: "2076.3",
    sz: "0.0058",
    szDecimals: 4,
    triggerPx: "2076.560175",
  });
  assert.equal(badTrigger.ok, false, "trigger price violating sigfig/decimals should fail");
}

async function testPerpPriceNormalizationForWire() {
  const normalized = normalizePerpPriceForWire({
    px: "2076.560175",
    szDecimals: 4,
    mode: "nearest",
  });
  assert.equal(normalized.ok, true, "price should be normalizable");
  const check = validatePerpOrderWire({
    px: normalized.normalized,
    sz: "0.0058",
    szDecimals: 4,
    triggerPx: normalized.normalized,
  });
  assert.equal(check.ok, true, "normalized wire price should pass preflight");
}

async function testTriggerOrderWire() {
  const wire = toOrderWire({
    asset: 1,
    isBuy: false,
    limitPx: 2050,
    sz: 0.0058,
    reduceOnly: true,
    orderType: {
      trigger: {
        isMarket: true,
        triggerPx: 2050,
        tpsl: "sl",
      },
    },
    cloid: "0x11111111111111111111111111111111",
  });
  assert.equal(wire.r, true, "trigger wire should preserve reduceOnly");
  assert.equal(wire.t?.trigger?.isMarket, true, "trigger wire should set isMarket");
  assert.equal(wire.t?.trigger?.tpsl, "sl", "trigger wire should set tpsl");
  assert.equal(wire.t?.trigger?.triggerPx, "2050", "trigger wire should set triggerPx");
}

async function testTpSlPriceComputationLongShort() {
  const long = computeTpSlTriggerPrices({
    entryPx: 2000,
    positionSize: 0.25,
    tpBps: 25,
    slBps: 15,
  });
  assert.equal(long.closeSide, "sell");
  assert(Math.abs(Number(long.tpRaw) - 2005) < 1e-9, "long TP should be +bps");
  assert(Math.abs(Number(long.slRaw) - 1997) < 1e-9, "long SL should be -bps");

  const short = computeTpSlTriggerPrices({
    entryPx: 2000,
    positionSize: -0.25,
    tpBps: 25,
    slBps: 15,
  });
  assert.equal(short.closeSide, "buy");
  assert(Math.abs(Number(short.tpRaw) - 1995) < 1e-9, "short TP should be -bps");
  assert(Math.abs(Number(short.slRaw) - 2003) < 1e-9, "short SL should be +bps");
}

async function testTpSlRefreshOnSizeChange() {
  const current = {
    side: "sell",
    size: 0.01,
    referencePx: 2000,
    tpPx: 2005,
    slPx: 1997,
    tpCloid: "0x11111111111111111111111111111111",
    slCloid: "0x22222222222222222222222222222222",
    extraCloids: [],
  };
  const desiredSame = {
    closeSide: "sell",
    size: 0.01,
    referencePx: 2000.01,
    tpPx: 2005,
    slPx: 1997,
    meta: {
      szDecimals: 4,
      priceDecimals: 1,
    },
  };
  assert.equal(shouldRefreshTpSlState(current, desiredSame), false, "same size/price should not refresh");

  const desiredChanged = {
    ...desiredSame,
    size: 0.02,
  };
  assert.equal(shouldRefreshTpSlState(current, desiredChanged), true, "size change should trigger refresh");
}

async function testTpSlOrderRequestSideAndZeroSize() {
  const long = buildTpSlOrderRequests({
    coin: "ETH",
    desired: {
      asset: 1,
      closeSide: "sell",
      size: 0.01,
      tpPx: 2005,
      slPx: 1997,
    },
    isMarket: true,
  });
  assert.equal(long.length, 2, "long should create tp/sl");
  assert(long.every((x) => x.order.isBuy === false), "long close orders should be SELL");

  const short = buildTpSlOrderRequests({
    coin: "ETH",
    desired: {
      asset: 1,
      closeSide: "buy",
      size: 0.01,
      tpPx: 1995,
      slPx: 2003,
    },
    isMarket: true,
  });
  assert.equal(short.length, 2, "short should create tp/sl");
  assert(short.every((x) => x.order.isBuy === true), "short close orders should be BUY");

  const zero = buildTpSlOrderRequests({
    coin: "ETH",
    desired: {
      asset: 1,
      closeSide: "buy",
      size: 0,
      tpPx: 1995,
      slPx: 2003,
    },
    isMarket: true,
  });
  assert.equal(zero.length, 0, "zero size should produce no orders");
}

async function testDailyLossWindowModes() {
  const now = Date.parse("2026-02-18T12:34:56.789Z");
  assert.equal(
    dailyLossWindowStartTs(now, "utc_day"),
    Date.parse("2026-02-18T00:00:00.000Z"),
    "utc day mode should anchor to UTC midnight",
  );
  assert.equal(
    dailyLossWindowStartTs(now, "rolling24h"),
    now - (24 * 3600 * 1000),
    "rolling mode should keep legacy 24h window",
  );
}

async function testWsWatchdogTrigger() {
  const now = 1_000_000;
  assert.equal(
    shouldTriggerWsWatchdog({
      nowTs: now,
      lastMessageAt: now - 61_000,
      timeoutMs: 60_000,
    }),
    true,
    "watchdog should fire when timeout exceeded",
  );
  assert.equal(
    shouldTriggerWsWatchdog({
      nowTs: now,
      lastMessageAt: now - 10_000,
      timeoutMs: 60_000,
    }),
    false,
    "watchdog should stay idle while messages are fresh",
  );
  assert.equal(
    shouldTriggerWsWatchdog({
      nowTs: now,
      lastMessageAt: 0,
      timeoutMs: 60_000,
    }),
    false,
    "watchdog should not fire without first message timestamp",
  );
}

async function testLineSignatureVerification() {
  const rawBody = JSON.stringify({ events: [{ type: "message", message: { type: "text", text: "hi" } }] });
  const secret = "test_line_secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  assert.equal(
    verifyLineSignature({
      channelSecret: secret,
      rawBody,
      signature,
    }),
    true,
    "valid LINE signature should pass",
  );
  assert.equal(
    verifyLineSignature({
      channelSecret: secret,
      rawBody,
      signature: "invalid",
    }),
    false,
    "invalid LINE signature should fail",
  );
}

async function testLineDecisionTemplateParsing() {
  const validV2 = parseBotDecisionMessage([
    "free text line",
    "```txt",
    "BOT_DECISION_V2",
    "questionId=ask_test_1",
    "action=PAUSE",
    "ttl_sec=300",
    "reason=need_review",
    "```",
    "tail text",
  ].join("\n"));
  assert.equal(validV2.ok, true, "valid V2 decision template should parse");
  assert.equal(validV2.command.version, 2);
  assert.equal(validV2.command.action, "PAUSE");
  assert.equal(validV2.command.questionId, "ask_test_1");
  assert.equal(validV2.command.coin, "ALL");
  assert.equal(Number(validV2.command.ttlSec), 300);

  const invalid = parseBotDecisionMessage([
    "BOT_DECISION_V1",
    "action=PAUSE",
  ].join("\n"));
  assert.equal(invalid.ok, false, "V1 template should be rejected in V2-only mode");
  assert.equal(invalid.error, "header_missing");

  const invalidAction = parseBotDecisionMessage([
    "BOT_DECISION_V2",
    "action=DO_SOMETHING",
  ].join("\n"));
  assert.equal(invalidAction.ok, false, "invalid action should be rejected");
  assert.equal(invalidAction.error, "invalid_action");

  const approveAlias = parseBotDecisionMessage([
    "BOT_DECISION_V2",
    "action=APPROVE",
  ].join("\n"));
  assert.equal(approveAlias.ok, true, "APPROVE alias should parse");
  assert.equal(approveAlias.command.action, "RESUME", "APPROVE should normalize to RESUME");
}

async function testLineAllowlistRejection() {
  const allow = new Set(["U_ALLOW_1", "U_ALLOW_2"]);
  assert.equal(isLineUserAllowed("U_ALLOW_1", allow), true, "allowlisted user should pass");
  assert.equal(isLineUserAllowed("U_DENY_1", allow), false, "non-allowlisted user should be rejected");
}

async function testAskQuestionPayloadFormatting() {
  const messages = buildAskQuestionMessages({
    questionId: "ask_test_1",
    coin: "BTC",
    midPx: 101234.56,
    positionSize: 0.01,
    positionSide: "long",
    positionNotional: 1012.34,
    openOrders: 2,
    dailyPnlUsd: 12.34,
    drawdownBps: 45.6,
    regime: "TREND_UP",
    signalSummary: "breakout_minEdge_borderline",
    recommendedAction: "HOLD",
    approvedAction: "RESUME",
    triggerReasons: ["blocked_persistent_growth"],
    dilemmas: ["edge不足", "ボラ高止まり", "方向感なし"],
    options: ["APPROVE(RESUME)", "PAUSE", "DETAIL"],
  });
  assert.equal(messages.length, 2, "ask question should be generated as two messages");
  assert(messages[0].includes("【HL Trade Ops / AskQuestion】"), "human message title should exist");
  assert(messages[0].includes("recommendedAction=HOLD"), "human message should include recommendedAction");
  assert(messages[0].includes("approvedAction=RESUME"), "human message should include approvedAction");
  assert(messages[1].includes("【あなたへの依頼】"), "prompt message should include request section");
  assert(messages[1].includes("BOT_DECISION_V2"), "reply template V2 header should be embedded");
  assert(messages[1].includes("questionId=ask_test_1"), "prompt should include questionId");
}

async function testDailyEvaluationPayloadFormatting() {
  const messages = buildDailyEvaluationMessages({
    dateUtc: "2026-02-20",
    dailyRealizedPnlUsd: 123.45,
    maxDdBps: 95.1,
    entryCount: 10,
    exitCount: 9,
    winRate: 0.55,
    slippageEstimate: "12.3 USD",
    rejectCount: 2,
    regimeTop: "TREND_UP (5)",
    regimeBottom: "RANGE (2)",
    watchdogCount: 1,
    reconcileFailCount: 0,
    cleanupFailCount: 0,
  });
  assert.equal(messages.length, 2, "daily evaluation should be generated as two messages");
  assert(messages[0].includes("【HL Trade Ops / Daily Summary】"), "daily human summary title should exist");
  assert(messages[1].includes("【あなたへの依頼】"), "daily prompt should include request header");
  assert(messages[1].includes("BOT_TUNING_V1"), "daily prompt should include optional tuning block");
}

async function testAskQuestionTriggerGate() {
  const config = {
    askQuestionTriggerDrawdownBps: 150,
    askQuestionTriggerDailyPnlUsd: -10,
    askQuestionTriggerPositionNotionalRatio: 0.8,
    riskMaxPositionNotionalUsd: 120,
    askQuestionTriggerReconcileFailureStreak: 2,
    askQuestionTriggerWsTimeouts15m: 2,
    askQuestionTriggerBlockedAgeMs: 1800000,
    askQuestionTriggerBlockedGrowth15m: 50,
    askQuestionSuppressFlatLowRisk: true,
  };

  const suppressed = evaluateAskQuestionTriggerGate({
    phase: "cycle_blocked_persistent",
    reasonCode: "no_trade_regime",
    signalSummary: "NO_TRADE_REGIME",
    positionSide: "flat",
    riskSnapshot: {
      dailyPnl: -1,
      drawdownBps: 0.22,
      openOrders: 0,
      positionNotional: 0,
    },
    config,
    openOrdersReconcileFailureStreak: 0,
    wsWatchdogTimeoutCountWindow: 0,
    blockedAgeMs: 5 * 60 * 1000,
    blockedCountDeltaWindow: 5,
  });
  assert.equal(suppressed.allowed, false, "flat low-risk no-trade should be suppressed");
  assert.equal(suppressed.suppressReason, "flat_low_risk_no_trade");

  const triggered = evaluateAskQuestionTriggerGate({
    phase: "cycle_blocked_persistent",
    reasonCode: "cycle_blocked_persistent",
    signalSummary: "waiting_signal",
    positionSide: "long",
    riskSnapshot: {
      dailyPnl: -12,
      drawdownBps: 180,
      openOrders: 1,
      positionNotional: 110,
    },
    config,
    openOrdersReconcileFailureStreak: 2,
    wsWatchdogTimeoutCountWindow: 2,
    blockedAgeMs: 1900000,
    blockedCountDeltaWindow: 70,
  });
  assert.equal(triggered.allowed, true, "risk trigger should allow ask question");
  assert(triggered.triggerReasons.includes("drawdown_threshold"), "drawdown trigger should be present");
  assert(triggered.triggerReasons.includes("daily_loss_threshold"), "daily pnl trigger should be present");
  assert(triggered.triggerReasons.includes("position_notional_threshold"), "position notional trigger should be present");
  assert(triggered.triggerReasons.includes("reconcile_failure_streak"), "reconcile trigger should be present");
  assert(triggered.triggerReasons.includes("ws_watchdog_timeout_rate"), "ws timeout trigger should be present");
}

async function testAskQuestionPolicyGuards() {
  const nowTs = Date.parse("2026-02-19T12:00:00Z");
  const dayKeyValue = "2026-02-19";
  const config = {
    askQuestionCooldownMs: 1800000,
    askQuestionDailyMax: 8,
    askQuestionReasonCooldownMs: 7200000,
  };

  const capBlocked = evaluateAskQuestionPolicy({
    nowTs,
    dayKey: dayKeyValue,
    coin: "BTC",
    reasonCode: "cycle_blocked_persistent",
    config,
    state: {
      dayKey: dayKeyValue,
      dailyCount: 8,
      coinLastAt: {},
      reasonLastAt: {},
    },
  });
  assert.equal(capBlocked.allowed, false, "daily cap should block ask question");
  assert.equal(capBlocked.suppressReason, "daily_cap");

  const coinCooldownBlocked = evaluateAskQuestionPolicy({
    nowTs,
    dayKey: dayKeyValue,
    coin: "BTC",
    reasonCode: "cycle_blocked_persistent",
    config,
    state: {
      dayKey: dayKeyValue,
      dailyCount: 1,
      coinLastAt: { BTC: nowTs - 1000 },
      reasonLastAt: {},
    },
  });
  assert.equal(coinCooldownBlocked.allowed, false, "coin cooldown should block ask question");
  assert.equal(coinCooldownBlocked.suppressReason, "coin_cooldown");

  const reasonCooldownBlocked = evaluateAskQuestionPolicy({
    nowTs,
    dayKey: dayKeyValue,
    coin: "ETH",
    reasonCode: "cycle_blocked_persistent",
    config,
    state: {
      dayKey: dayKeyValue,
      dailyCount: 1,
      coinLastAt: {},
      reasonLastAt: { cycle_blocked_persistent: nowTs - 1000 },
    },
  });
  assert.equal(reasonCooldownBlocked.allowed, false, "reason cooldown should block ask question");
  assert.equal(reasonCooldownBlocked.suppressReason, "reason_cooldown");
}

async function testAskQuestionTtlDefaultAction() {
  const flatAction = resolveAskQuestionTtlDefaultAction({
    positionSide: "flat",
    config: {},
  });
  assert.equal(flatAction, "HOLD", "flat TTL default should be HOLD");

  const inPosAction = resolveAskQuestionTtlDefaultAction({
    positionSide: "long",
    config: {},
  });
  assert.equal(inPosAction, "FLATTEN", "in-position TTL default should be FLATTEN");

  const customAction = resolveAskQuestionTtlDefaultAction({
    positionSide: "flat",
    config: {
      askQuestionTtlDefaultActionFlat: "PAUSE",
    },
  });
  assert.equal(customAction, "PAUSE", "configured TTL default action should be respected");
}

async function testStrategyTrendBreakoutSignal() {
  resetStrategyStateForTests();
  const config = baseStrategyConfig();
  const marketData = makeMarketDataStub();
  const signal = buildSignal({
    arm: { id: "trend_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 1_000_000,
  });
  assert(signal && !signal.blocked, "trend breakout signal should be generated");
  assert.equal(signal.strategy, "trend_breakout");
  assert.equal(signal.regime, "TREND_UP");
  assert.equal(signal.explanation?.feature?.reasonCode, "trend_breakout_entry");
  assert(Number.isFinite(Number(signal.explanation?.feature?.minEdgeBps)), "entry should include minEdgeBps");
}

async function testStrategyRangeBlocksOnHighVol() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyTrendAdxMin: 40,
    strategyRangeAdxMax: 15,
    strategyRangeMaxAtrPct: 0.8,
  };
  const candles = makeCandles({ length: 95, base: 100.0, drift: 0, highPad: 0.2, lowPad: 0.2 });
  const marketData = makeMarketDataStub({
    atrPercent: () => 0.95,
    atrPercentSeries: () => [0.72, 0.76, 0.8, 0.82],
    recentCloseReturnPct: () => 0.2,
    ema: (_coin, interval, length) => {
      if (interval === "15m" && length === 20) return 100.02;
      if (interval === "15m" && length === 50) return 100.0;
      return null;
    },
    adx: () => 10,
    candlesByInterval: () => candles,
    zScoreFromVwap: () => 2.4,
    vwap: () => 99.9,
  });
  const signal = buildSignal({
    arm: { id: "range_test" },
    coin: "ETH",
    regime: "lowvol_range_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 2_000_000,
  });
  assert(signal && signal.blocked, "range signal should be blocked on high volatility");
  assert.equal(signal.reason, "NO_TRADE_RANGE_ATR");
}

async function testStrategyEntryPacingLimitPerHour() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyMaxEntriesPerCoinPerHour: 1,
    strategyEntryCooldownMs: 0,
  };
  const marketData = makeMarketDataStub();
  const first = buildSignal({
    arm: { id: "pace_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 3_000_000,
  });
  assert(first && !first.blocked, "first entry should pass pacing guard");

  const second = buildSignal({
    arm: { id: "pace_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 3_100_000,
  });
  assert(second && second.blocked, "second entry should be blocked by hourly limit");
  assert.equal(second.reason, "NO_TRADE_ENTRY_HOURLY_LIMIT");
  assert.equal(second.explanation?.feature?.reasonCode, "hourly_limit");
}

async function testStrategyBreakoutMinEdgeFilter() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyMinEdgeBaseBps: 100,
    strategyMinEdgeVolK: 2.0,
    strategyMinEdgeSafetyBufferBps: 2,
    strategyFeeTakerBps: 5,
  };
  const marketData = makeMarketDataStub({
    estimateSlippageBps: () => 5,
    atrPercent: () => 0.55,
  });
  const signal = buildSignal({
    arm: { id: "edge_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 4_000_000,
  });
  assert(signal && signal.blocked, "signal should be blocked when breakout edge is too small");
  assert.equal(signal.reason, "NO_TRADE_BREAKOUT_MIN_EDGE");
  assert.equal(signal.explanation?.feature?.reasonCode, "breakout_minEdge_fail");
  assert(
    Number(signal.explanation?.feature?.minEdgeBps || 0) > Number(signal.explanation?.feature?.breakoutBps || 0),
    "min edge should exceed breakout width when blocked",
  );
}

async function testStrategyRegimeHysteresisHold() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyRegimeMinHoldMs: 10 * 60 * 1000,
    strategyRegimeConfirmBars: 1,
  };

  const trendMarketData = makeMarketDataStub();
  const first = buildSignal({
    arm: { id: "regime_hold_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData: trendMarketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 5_000_000,
  });
  assert(first && !first.blocked, "first trend signal should pass");

  const rangeCandles = makeCandles({ length: 95, base: 100.0, drift: 0, highPad: 0.2, lowPad: 0.2 });
  const rangeMarketData = makeMarketDataStub({
    adx: () => 10,
    ema: (_coin, interval, length) => {
      if (interval === "15m" && length === 20) return 100.02;
      if (interval === "15m" && length === 50) return 100.0;
      return null;
    },
    candlesByInterval: () => rangeCandles,
    zScoreFromVwap: () => 2.2,
    vwap: () => 99.8,
  });
  const second = buildSignal({
    arm: { id: "regime_hold_test" },
    coin: "BTC",
    regime: "lowvol_range_tight",
    marketData: rangeMarketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 5_060_000,
  });
  assert(second && second.blocked, "regime switch should be held during minimum hold window");
  assert.equal(second.reason, "NO_TRADE_REGIME_HOLD");
  assert.equal(second.explanation?.feature?.reasonCode, "regime_hold");
}

async function testStrategyRegimeFlipChurnBlock() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyRegimeMinHoldMs: 0,
    strategyRegimeConfirmBars: 1,
    strategyRegimeFlipWindowMs: 30 * 60 * 1000,
    strategyRegimeFlipMaxInWindow: 1,
    strategyRegimeFlipCooldownMs: 5 * 60 * 1000,
    strategyMaxEntriesPerCoinPerHour: 10,
  };

  const trendMarketData = makeMarketDataStub();
  const rangeCandles = makeCandles({ length: 95, base: 100.0, drift: 0, highPad: 0.2, lowPad: 0.2 });
  const rangeMarketData = makeMarketDataStub({
    adx: () => 10,
    ema: (_coin, interval, length) => {
      if (interval === "15m" && length === 20) return 100.02;
      if (interval === "15m" && length === 50) return 100.0;
      return null;
    },
    candlesByInterval: () => rangeCandles,
    zScoreFromVwap: () => 2.2,
    vwap: () => 99.8,
  });

  const first = buildSignal({
    arm: { id: "regime_churn_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData: trendMarketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 6_000_000,
  });
  assert(first && !first.blocked, "first trend signal should pass");

  const second = buildSignal({
    arm: { id: "regime_churn_test" },
    coin: "BTC",
    regime: "lowvol_range_tight",
    marketData: rangeMarketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 6_060_000,
  });
  assert(second && !second.blocked, "first flip should still pass before churn threshold");

  const third = buildSignal({
    arm: { id: "regime_churn_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData: trendMarketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: 6_120_000,
  });
  assert(third && third.blocked, "repeated regime flips should trigger no-trade churn block");
  assert.equal(third.reason, "NO_TRADE_REGIME_FLIP_CHURN");
  assert.equal(third.explanation?.feature?.reasonCode, "regime_flip_churn");
}

async function testStrategyRestartWarmupNoTrade() {
  resetStrategyStateForTests();
  const config = {
    ...baseStrategyConfig(),
    strategyRestartNoTradeMs: 300000,
  };
  const marketData = makeMarketDataStub();
  const now = Date.now();
  const signal = buildSignal({
    arm: { id: "restart_warmup_test" },
    coin: "BTC",
    regime: "highvol_trend_tight",
    marketData,
    orderSize: 0.01,
    maxSlippageBps: 15,
    qualityGate: { pass: true },
    config,
    nowTs: now,
  });
  assert(signal && signal.blocked, "restart warmup should block entries after process start");
  assert.equal(signal.reason, "NO_TRADE_RESTART_WARMUP");
  assert.equal(signal.explanation?.feature?.reasonCode, "restart_warmup");
  assert(Number(signal.explanation?.feature?.waitMs || 0) > 0, "warmup block should expose remaining wait time");
}

async function testStrategyDecisionMetricRequiredKeys() {
  const metric = buildStrategyDecisionMetric({
    action: "entry",
    coin: "BTC",
    regime: "TREND_UP",
    ts: 1700000000000,
    armId: "trend_test",
    strategy: "trend_breakout",
    signal: {
      coin: "BTC",
      regime: "TREND_UP",
      explanation: {
        style: "trend_breakout_continuation",
        feature: {
          reasonCode: "trend_breakout_entry",
          ret1mPct: 0.21,
          atrPct: 0.43,
          breakoutBps: 12.5,
          minEdgeBps: 9.8,
          strategyContextId: "sctx_test_1",
        },
      },
    },
  });
  assert.equal(metric.type, "strategy_decision");
  assert.equal(metric.action, "entry");
  assert.equal(metric.reasonCode, "trend_breakout_entry");
  assert.equal(metric.coin, "BTC");
  assert.equal(metric.regime, "TREND_UP");
  assert.equal(metric.ts, 1700000000000);
}

async function testStrategyDecisionMetricSkipReasonCode() {
  const metric = buildStrategyDecisionMetric({
    action: "skip",
    coin: "ETH",
    regime: "RANGE",
    signal: {
      reason: "NO_TRADE_BREAKOUT_MIN_EDGE",
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "breakout_minEdge_fail",
          breakoutBps: 6.2,
          minEdgeBps: 11.4,
        },
      },
    },
  });
  assert.equal(metric.type, "strategy_decision");
  assert.equal(metric.action, "skip");
  assert.equal(metric.reasonCode, "breakout_minEdge_fail");
}

async function testStrategyDecisionMetricEntryMinEdge() {
  const metric = buildStrategyDecisionMetric({
    action: "entry",
    coin: "BTC",
    regime: "TREND_UP",
    signal: {
      explanation: {
        style: "trend_breakout_continuation",
        feature: {
          reasonCode: "trend_breakout_entry",
          minEdgeBps: 13.75,
          breakoutBps: 19.2,
        },
      },
    },
  });
  assert.equal(metric.type, "strategy_decision");
  assert.equal(metric.action, "entry");
  assert.equal(Number(metric.minEdgeBps), 13.75);
}

async function testTpSlReduceOnlyAndPreflightBlock() {
  const validDesired = {
    asset: 1,
    closeSide: "sell",
    size: 0.01,
    tpPx: 2005,
    slPx: 1997,
  };
  const requests = buildTpSlOrderRequests({
    coin: "ETH",
    desired: validDesired,
    isMarket: true,
  });
  assert.equal(requests.length, 2, "tp/sl should generate 2 trigger orders");
  assert(requests.every((x) => x.order.reduceOnly === true), "TP/SL orders must be reduceOnly");
  const wires = requests.map((x) => toOrderWire(x.order));
  assert(wires.every((x) => x.r === true), "wire reduceOnly must be true");

  const invalidDesired = {
    asset: 1,
    closeSide: "sell",
    size: 0.01,
    tpPx: 2076.560175,
    slPx: null,
  };
  const invalidReq = buildTpSlOrderRequests({
    coin: "ETH",
    desired: invalidDesired,
    isMarket: true,
  });
  const invalidWire = toOrderWire(invalidReq[0].order);
  const invalidPreflight = validatePerpOrderWire({
    px: invalidWire.p,
    sz: invalidWire.s,
    triggerPx: invalidWire?.t?.trigger?.triggerPx,
    szDecimals: 4,
  });
  assert.equal(invalidPreflight.ok, false, "invalid trigger wire should be blocked by preflight");
}

async function testReportOrderCancelSplit() {
  const dir = tmpDir();
  const config = mkConfig(dir);
  const storage = new Storage(config);

  storage.appendRawHttp({
    label: "exchange:order:ETH:test",
    request: {
      action: {
        type: "order",
        orders: [{ p: "2076.5", s: "0.0058", b: true, r: false, t: { limit: { tif: "Ioc" } } }],
      },
    },
    response: { status: "ok", response: { type: "order", data: { statuses: [{ error: "Order has invalid price." }] } } },
  });

  storage.appendRawHttp({
    label: "exchange:order:ETH:test_ok",
    request: {
      action: {
        type: "order",
        orders: [{ p: "2076.3", s: "0.0058", b: true, r: false, t: { limit: { tif: "Ioc" } } }],
      },
    },
    response: { status: "ok", response: { type: "order", data: { statuses: [{ filled: { avgPx: "2076.3", totalSz: "0.0058" } }] } } },
  });

  storage.appendFill({
    fill: {
      oid: 12345,
      coin: "ETH",
      px: "2076.3",
      sz: "0.0058",
    },
    context: {
      coin: "ETH",
      cloid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });

  storage.appendRawHttp({
    label: "exchange:cancelByCloid:test",
    request: {
      action: {
        type: "cancelByCloid",
        cancels: [{ asset: 1, cloid: "0x11111111111111111111111111111111" }],
      },
    },
    response: { status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order was never placed, already canceled, or filled. asset=1" }] } } },
  });

  storage.appendError({
    where: "order_submit",
    coin: "ETH",
    error: "Order has invalid price.",
  });
  storage.appendError({
    where: "guarded_loop",
    error: "timeout",
  });

  const report = generateReport({
    storage,
    budgetSnapshot: null,
    windowMs: 24 * 3600 * 1000,
  });

  assert.equal(report.summary.orderAttemptCount, 2, "order attempts should be derived from exchange raw");
  assert.equal(report.summary.cancelAttemptCount, 1, "cancel attempts should be derived from exchange raw");
  assert.equal(report.summary.orderRejectCount, 1, "order reject count should exclude cancel errors");
  assert.equal(report.summary.cancelErrorCount, 0, "benign cancel noop should not count as cancel error");
  assert.equal(report.summary.cancelNoopCount, 1, "benign cancel noop should be counted separately");
  assert.equal(report.summary.filledOrderCount, 1, "filled orders should use unique fill order keys");
  assert.equal(Number(report.summary.filledOrderRate.toFixed(6)), 0.5);
  assert.equal(report.summary.errorCount, 1, "exception count should exclude order_submit errors");
  assert.equal(Number(report.summary.orderRejectRate.toFixed(6)), 0.5);
  assert.equal(Number(report.summary.exceptionRate.toFixed(6)), Number((1 / 3).toFixed(6)));
}

function loadOpsFixtureRows() {
  const fixturePath = path.join(process.cwd(), "src", "tests", "fixtures", "ops", "analyze-ops-sample.ndjson");
  const lines = fs.readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function writeRowsAsStreams(streamDir, rows) {
  for (const row of rows) {
    const ts = Number(row?.ts || Date.now());
    const stream = String(row?.__stream || "metrics");
    const day = new Date(ts).toISOString().slice(0, 10);
    const file = path.join(streamDir, day, `${stream}.jsonl`);
    ensureDir(path.dirname(file));
    const payload = { ...row };
    delete payload.__stream;
    appendJsonl(file, payload);
  }
}

async function testOpsAnalyzerInvariantDetection() {
  const rows = loadOpsFixtureRows();

  const report = analyzeRows({
    rows,
    sinceTs: 1700000000000,
    untilTs: 1700000062000,
    chainLimit: 20,
  });

  assert(report.noProtection.count >= 1, "NO_PROTECTION incident should be detected");
  assert(report.flattenOrdering.violationCount >= 1, "flip ordering violation should be detected");

  const btc = report.fillsByCoin.BTC;
  assert(btc, "BTC fill aggregate should exist");
  assert.equal(Number(btc.fills), 3, "BTC fills should aggregate");
  assert.equal(Number(btc.takerFills), 3, "BTC taker fills should aggregate");

  assert.equal(Number(report.guardCounts.noTradeByReason.NO_TRADE_SPREAD || 0), 1, "NO_TRADE_SPREAD count should match");
  assert.equal(Number(report.guardCounts.dailyTradeLimitCount || 0), 1, "DAILY_TRADE_LIMIT should match");
  assert.equal(Number(report.guardCounts.dailyTakerLimitCount || 0), 1, "daily taker limit projection should match");
  assert(report.tradeAbsenceReasons.top.length >= 1, "trade absence reasons should be populated");
  assert(Number(report.noProtection.causeCounts.NO_PROTECTION || 0) >= 1, "NO_PROTECTION cause should be classified");
  assert(["OK", "WATCH", "STOP_RECOMMENDED"].includes(String(report.conclusion || "")), "conclusion should be normalized");

  assert(report.executionQuality.spreadBps.count >= 1, "spread distribution should be populated");
  assert(report.executionQuality.slippageBps.count >= 1, "slippage distribution should be populated");
  assert(report.executionQuality.takerThresholdViolations.length >= 1, "taker threshold violation should be detected");
  assert(report.recentChains.length >= 1, "recent chains should be populated");
  assert(String(report.recentChains[0]?.entry?.reasonCode || report.recentChains[0]?.entry?.reason || "").length > 0, "recent chain should include reason");
}

async function testDailySummaryFormatting() {
  const rows = loadOpsFixtureRows();
  const report = analyzeRows({
    rows,
    sinceTs: 1700000000000,
    untilTs: 1700000062000,
    chainLimit: 20,
  });
  const summary = buildDailySummary(report, { dayUtc: "2023-11-14" });
  assert.equal(summary.kind, "daily_summary_v1");
  assert.equal(summary.dayUtc, "2023-11-14");
  assert.equal(summary.invariants.A.status, "FAIL", "fixture should fail invariant A");
  assert.equal(summary.invariants.B.status, "FAIL", "fixture should fail invariant B");
  assert.equal(summary.conclusion, "STOP_RECOMMENDED", "A/B fail should escalate conclusion");
  assert(summary.tradeAbsenceReasons.top.length >= 1, "absence top reasons should be present");
  assert(summary.entryRationales.length >= 1, "entry rationales should be present");

  const text = renderDailySummary(summary);
  assert(text.includes("Daily Ops Summary"), "daily summary text should include title");
  assert(text.includes("Invariant A"), "daily summary text should include invariants");
  assert(text.includes("Recent Entry Rationales"), "daily summary text should include rationale section");
}

async function testPerformanceReportFormats() {
  const dir = tmpDir();
  const streamDir = path.join(dir, "streams");
  const rows = loadOpsFixtureRows();
  writeRowsAsStreams(streamDir, rows);

  const report = buildPerformanceReport({
    streamDir,
    sinceTs: 1700000000000,
    untilTs: 1700000062000,
    sinceLabel: "fixture-start",
    untilLabel: "fixture-end",
    chainLimit: 20,
  });
  assert(report.performance.rows.length >= 2, "performance rows should include fixture coins");

  const table = renderPerformanceTable(report);
  assert(table.includes("Coin"), "table output should include header");
  assert(table.includes("BTC"), "table output should include BTC row");

  const markdown = renderPerformanceMarkdown(report);
  assert(markdown.includes("| Coin |"), "markdown output should include table header");
  assert(markdown.includes("Top No-Trade / No-Signal Reasons"), "markdown output should include reason section");
}

function strategyDecisionFixture() {
  const baseTs = 1700000000000;
  return {
    sinceTs: baseTs - 1000,
    untilTs: baseTs + 60_000,
    metricsRows: [
      {
        ts: baseTs + 1000,
        type: "strategy_decision",
        action: "entry",
        reasonCode: "trend_breakout_entry",
        coin: "BTC",
        regime: "TREND_UP",
        ret1mPct: 0.22,
        atrPct: 0.44,
        breakoutBps: 14.2,
        minEdgeBps: 10.5,
        cloid: "0xentry_btc_1",
        strategyContextId: "sctx_btc_1",
      },
      {
        ts: baseTs + 2000,
        type: "strategy_decision",
        action: "skip",
        reasonCode: "breakout_minEdge_fail",
        coin: "BTC",
        regime: "TREND_UP",
        breakoutBps: 6.2,
        minEdgeBps: 11.8,
      },
      {
        ts: baseTs + 3000,
        type: "strategy_decision",
        action: "skip",
        reasonCode: "cooldown",
        coin: "ETH",
        regime: "RANGE",
      },
      {
        ts: baseTs + 4000,
        type: "strategy_decision",
        action: "entry",
        reasonCode: "range_reversion_entry",
        coin: "ETH",
        regime: "RANGE",
        ret1mPct: 0.15,
        atrPct: 0.31,
        breakoutBps: null,
        minEdgeBps: null,
        cloid: "0xentry_eth_1",
        strategyContextId: "sctx_eth_1",
      },
      {
        ts: baseTs + 5000,
        type: "strategy_decision",
        action: "exit",
        reasonCode: "time_stop_exit",
        coin: "ETH",
        regime: "RANGE",
      },
    ],
    executionRows: [
      {
        ts: baseTs + 15_000,
        coin: "BTC",
        cloid: "0xentry_btc_1",
        realizedPnl: 1.2,
      },
      {
        ts: baseTs + 16_000,
        coin: "ETH",
        cloid: "0xentry_eth_1",
        realizedPnl: -0.4,
      },
    ],
  };
}

async function testStrategyDecisionReportActionCounts() {
  const fixture = strategyDecisionFixture();
  const report = buildStrategyDecisionReport({
    metricsRows: fixture.metricsRows,
    executionRows: fixture.executionRows,
    sinceTs: fixture.sinceTs,
    untilTs: fixture.untilTs,
  });
  assert.equal(report.kind, "strategy_decision_report_v1");
  assert.equal(Number(report.summary.total), 5, "total decisions should aggregate");
  assert.equal(Number(report.summary.entry), 2, "entry count should aggregate");
  assert.equal(Number(report.summary.skip), 2, "skip count should aggregate");
  assert.equal(Number(report.summary.exit), 1, "exit count should aggregate");
}

async function testStrategyDecisionReportReasonAggregation() {
  const fixture = strategyDecisionFixture();
  const report = buildStrategyDecisionReport({
    metricsRows: fixture.metricsRows,
    executionRows: fixture.executionRows,
    sinceTs: fixture.sinceTs,
    untilTs: fixture.untilTs,
  });
  const skipCounts = Object.fromEntries((report.reasons.skipTop || []).map((row) => [row.reasonCode, row.count]));
  assert.equal(Number(skipCounts.breakout_minEdge_fail || 0), 1, "min edge skip reason should aggregate");
  assert.equal(Number(skipCounts.cooldown || 0), 1, "cooldown skip reason should aggregate");

  const entryCounts = Object.fromEntries((report.reasons.entryTop || []).map((row) => [row.reasonCode, row.count]));
  assert.equal(Number(entryCounts.trend_breakout_entry || 0), 1, "trend entry reason should aggregate");
  assert.equal(Number(entryCounts.range_reversion_entry || 0), 1, "range entry reason should aggregate");
  assert.equal(Number(report.ratios.minEdgeSkipCount || 0), 1, "min edge skip count should be exposed");
  assert.equal(Number(report.ratios.cooldownSkipCount || 0), 1, "cooldown skip count should be exposed");
}

async function testStrategyDecisionReportCoinRegimeAggregation() {
  const fixture = strategyDecisionFixture();
  const report = buildStrategyDecisionReport({
    metricsRows: fixture.metricsRows,
    executionRows: fixture.executionRows,
    sinceTs: fixture.sinceTs,
    untilTs: fixture.untilTs,
  });

  const byCoin = Object.fromEntries((report.byCoin || []).map((row) => [row.coin, row]));
  assert.equal(Number(byCoin.BTC?.entry || 0), 1, "BTC entry count should aggregate");
  assert.equal(Number(byCoin.BTC?.skip || 0), 1, "BTC skip count should aggregate");
  assert.equal(Number(byCoin.ETH?.entry || 0), 1, "ETH entry count should aggregate");
  assert.equal(Number(byCoin.ETH?.exit || 0), 1, "ETH exit count should aggregate");

  const byRegime = Object.fromEntries((report.byRegime || []).map((row) => [row.regime, row]));
  assert.equal(Number(byRegime.TREND_UP?.total || 0), 2, "TREND_UP count should aggregate");
  assert.equal(Number(byRegime.RANGE?.total || 0), 3, "RANGE count should aggregate");

  assert.equal(Number(report.executionLink.matchedExecutionCount || 0), 2, "execution link should match entry cloids");
  assert(Math.abs(Number(report.executionLink.realizedPnlUsd || 0) - 0.8) < 1e-9, "execution link pnl should sum");
}

async function testPositionWhyReport() {
  const runtimeState = {
    positionProtectionPlansByCoin: [
      {
        coin: "BTC",
        slPct: 0.62,
        tpPct: 0.81,
        entryAt: 1700001000000,
        entryPx: 62000,
        reason: "trend_pullback_continuation",
        strategy: "trend_pullback",
        regime: "TREND_UP",
        cloid: "0xbtc_entry_1",
      },
    ],
    lastEntryContextByCoin: [
      {
        coin: "BTC",
        cloid: "0xbtc_entry_1",
        side: "buy",
        fillTime: 1700001000500,
        regime: "TREND_UP",
        strategy: "trend_pullback",
        reason: "trend_pullback_continuation",
        explanation: {
          style: "trend_pullback_continuation",
          feature: {
            pullbackRecovered: true,
            aggressorRatio: 0.61,
          },
        },
      },
    ],
    lastEntrySnapshotByCoin: [
      {
        coin: "BTC",
        cloid: "0xbtc_entry_1",
        side: "buy",
        entryTs: 1700001000500,
        entryPx: 62010,
        notional: 620.1,
        regime: "TREND_UP",
        strategy: "trend_pullback",
        reason: "trend_pullback_continuation",
        reasonCode: "trend_pullback_continuation",
        features: {
          pullbackRecovered: true,
          aggressorRatio: 0.61,
          imbalance: 0.13,
        },
        protectionPlan: {
          slPct: 0.62,
          tpPct: 0.81,
          timeStopMs: 720000,
          timeStopProgressR: 0.4,
        },
      },
    ],
    lastOpenPositionsByCoin: [
      {
        coin: "BTC",
        size: 0.01,
        side: "buy",
        entryPx: 62010,
        markPx: 62100,
        unrealizedPnl: 0.9,
        updatedAt: 1700001010000,
      },
    ],
  };

  const report = buildPositionWhyReport({
    runtimeState,
    executionRows: [],
    orderRows: [],
    nowTs: 1700001015000,
  });

  assert.equal(report.kind, "position_why_v1");
  assert.equal(report.openPositionCount, 1, "open position should be detected");
  assert.equal(report.feedbackReadyCount, 1, "snapshot-backed reason should be feedback-ready");
  assert.equal(report.positions[0].coin, "BTC");
  assert.equal(report.positions[0].why, "trend_pullback_continuation");
  assert.equal(report.positions[0].feedbackReady, true, "position should have snapshot");
  assert.equal(report.positions[0].side, "buy");
  assert(report.positions[0].featureSummary.includes("aggressorRatio"), "feature summary should include signal features");

  const table = renderPositionWhyTable(report);
  assert(table.includes("BTC"), "table should include coin");
  assert(table.includes("trend_pullback"), "table should include strategy");

  const markdown = renderPositionWhyMarkdown(report);
  assert(markdown.includes("| Coin |"), "markdown should include header");
  assert(markdown.includes("trend_pullback_continuation"), "markdown should include why");
}

async function main() {
  await testStorageRotation();
  await testLifecycleCompressionAndRetention();
  await testRollupAggregation();
  await testGptProposalSchemaValidation();
  await testStabilityEvaluation();
  await testPerpConstraintValidation();
  await testPerpPriceNormalizationForWire();
  await testTriggerOrderWire();
  await testTpSlPriceComputationLongShort();
  await testTpSlRefreshOnSizeChange();
  await testTpSlReduceOnlyAndPreflightBlock();
  await testTpSlOrderRequestSideAndZeroSize();
  await testDailyLossWindowModes();
  await testWsWatchdogTrigger();
  await testLineSignatureVerification();
  await testLineDecisionTemplateParsing();
  await testLineAllowlistRejection();
  await testAskQuestionPayloadFormatting();
  await testDailyEvaluationPayloadFormatting();
  await testAskQuestionTriggerGate();
  await testAskQuestionPolicyGuards();
  await testAskQuestionTtlDefaultAction();
  await testStrategyTrendBreakoutSignal();
  await testStrategyRangeBlocksOnHighVol();
  await testStrategyEntryPacingLimitPerHour();
  await testStrategyBreakoutMinEdgeFilter();
  await testStrategyRegimeHysteresisHold();
  await testStrategyRegimeFlipChurnBlock();
  await testStrategyRestartWarmupNoTrade();
  await testStrategyDecisionMetricRequiredKeys();
  await testStrategyDecisionMetricSkipReasonCode();
  await testStrategyDecisionMetricEntryMinEdge();
  await testReportOrderCancelSplit();
  await testOpsAnalyzerInvariantDetection();
  await testDailySummaryFormatting();
  await testPerformanceReportFormats();
  await testStrategyDecisionReportActionCounts();
  await testStrategyDecisionReportReasonAggregation();
  await testStrategyDecisionReportCoinRegimeAggregation();
  await testPositionWhyReport();
  console.log("All tests passed");
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  process.exitCode = 1;
});

