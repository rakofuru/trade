import assert from "node:assert/strict";
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
  buildTpSlOrderRequests,
  computeTpSlTriggerPrices,
  shouldRefreshTpSlState,
} from "../core/trading-engine.mjs";
import { analyzeRows } from "../../ops/analyze-ops.mjs";
import { buildDailySummary, renderDailySummary } from "../../ops/daily-summary.mjs";
import {
  buildPerformanceReport,
  renderPerformanceMarkdown,
  renderPerformanceTable,
} from "../../ops/performance-report.mjs";
import {
  buildPositionWhyReport,
  renderPositionWhyMarkdown,
  renderPositionWhyTable,
} from "../../ops/position-why.mjs";

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

  const text = renderDailySummary(summary);
  assert(text.includes("Daily Ops Summary"), "daily summary text should include title");
  assert(text.includes("Invariant A"), "daily summary text should include invariants");
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
  await testReportOrderCancelSplit();
  await testOpsAnalyzerInvariantDetection();
  await testDailySummaryFormatting();
  await testPerformanceReportFormats();
  await testPositionWhyReport();
  console.log("All tests passed");
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  process.exitCode = 1;
});
