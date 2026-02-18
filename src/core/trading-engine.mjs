import crypto from "node:crypto";
import { HyperliquidWsClient } from "../hyperliquid/ws-client.mjs";
import {
  makeOrderAction,
  toOrderWire,
  makeCloid,
  makeCancelByCloidAction,
  makeCancelAction,
} from "../hyperliquid/signing.mjs";
import {
  validatePerpOrderWire,
  normalizePerpPriceForWire,
  countDecimalPlaces,
  countSignificantFigures,
} from "../hyperliquid/constraints.mjs";
import { MarketDataBuffer } from "./market-data.mjs";
import { ContextualBandit, defaultArms } from "./bandit.mjs";
import { buildSignal } from "./strategy-engine.mjs";
import {
  FeedbackLoop,
  inventoryNotional,
  summarizeOpenPositions,
} from "./feedback.mjs";
import { BudgetExceededError } from "./budget-manager.mjs";
import { IdempotencyLedger } from "./idempotency-ledger.mjs";
import { generateReport, saveReport, generateTopImprovements } from "./reporting.mjs";
import { ImprovementLoop } from "./improvement-loop.mjs";
import { RollupManager } from "./rollup-manager.mjs";
import { DataLifecycleManager } from "./data-lifecycle.mjs";
import { CoinSelector } from "./coin-selector.mjs";

const TPSL_CLOID_PREFIX_HEX = "7470736c"; // "tpsl"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function inferCoinFromTrade(trade, fallback) {
  return trade.coin || trade.asset || fallback || null;
}

function inferCoinFromCandle(candle, fallback = null) {
  return candle?.coin || candle?.s || candle?.symbol || fallback || null;
}

function rewardTotalsFromFeedback(feedbackMetrics) {
  const g = feedbackMetrics.global || {};
  return {
    realizedPnl: Number(g.realizedPnl || 0),
    fees: Number(g.fees || 0),
    slippageUsd: Number(g.slippageUsd || 0),
    notional: Number(g.notional || 0),
  };
}

function utcDayKey(ts = Date.now()) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function utcDayEndTs(ts = Date.now()) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  return Date.UTC(y, m, day + 1, 0, 0, 0, 0);
}

function sameDirection(positionSize, side) {
  if (Number(positionSize || 0) === 0) return false;
  const dir = Number(positionSize) > 0 ? "buy" : "sell";
  return dir === String(side || "").toLowerCase();
}

export class TradingEngine {
  constructor({ config, logger, client, budgetManager, storage, gptAdvisor = null }) {
    this.config = config;
    this.logger = logger;
    this.client = client;
    this.budgetManager = budgetManager;
    this.storage = storage;
    this.gptAdvisor = gptAdvisor;

    this.marketData = new MarketDataBuffer({ coins: config.coins });

    this.bandit = new ContextualBandit({
      arms: defaultArms(),
      explorationCoef: config.banditExplorationCoef,
      decay: config.banditDecay,
      initialState: storage.loadState("bandit-state", null),
    });

    this.feedback = new FeedbackLoop({
      storage,
      config,
      initialState: storage.loadState("feedback-state", null),
    });

    this.idempotency = new IdempotencyLedger({
      storage,
      initialState: storage.loadState("idempotency-state", null),
    });

    this.improvement = new ImprovementLoop({
      config,
      storage,
      initialState: storage.loadState("improvement-state", null),
    });
    this.coinSelector = new CoinSelector({
      explorationCoef: Math.max(0.3, config.banditExplorationCoef * 0.9),
      decay: config.banditDecay,
      cooldownMs: config.coinCooldownMs,
      rejectStreakLimit: config.coinRejectStreakLimit,
      minDepthUsd: config.minBookDepthUsd,
      maxSpreadBps: config.maxSpreadBps,
      initialState: storage.loadState("coin-selector-state", null),
    });
    this.rollups = new RollupManager({ config, storage, logger });
    this.dataLifecycle = new DataLifecycleManager({ config, storage, logger });

    const runtime = storage.loadState("runtime-state", {});
    this.lastFillCursor = runtime.lastFillCursor || Date.now() - config.backfillHours * 3600 * 1000;
    this.openOrders = new Map((runtime.openOrders || []).map((x) => [x.cloid, x]));
    this.orderContextsByCloid = new Map((runtime.orderContextsByCloid || []).map((x) => [x.cloid, x]));
    this.orderContextsByOid = new Map((runtime.orderContextsByOid || []).map((x) => [String(x.oid), x]));
    this.tpslByCoin = new Map((runtime.tpslByCoin || []).map((x) => [x.coin, x]));
    this.tpslEntryFallbackStreakByCoin = new Map((runtime.tpslEntryFallbackStreakByCoin || []).map((x) => [x.coin, Number(x.streak || 0)]));
    this.tpslLastAttemptAtByCoin = new Map((runtime.tpslLastAttemptAtByCoin || []).map((x) => [x.coin, Number(x.ts || 0)]));
    this.tpslLastEmergencyFlattenAtByCoin = new Map((runtime.tpslLastEmergencyFlattenAtByCoin || []).map((x) => [x.coin, Number(x.ts || 0)]));
    this.tpslBlockedCoins = new Map((runtime.tpslBlockedCoins || []).map((x) => [x.coin, Number(x.until || 0)]));
    this.strategyBlockedCoins = new Map((runtime.strategyBlockedCoins || []).map((x) => [x.coin, {
      until: Number(x.until || 0),
      reason: String(x.reason || ""),
      dayKey: String(x.dayKey || ""),
    }]));
    this.positionProtectionPlansByCoin = new Map((runtime.positionProtectionPlansByCoin || []).map((x) => [x.coin, x]));
    this.lastEntryContextByCoin = new Map((runtime.lastEntryContextByCoin || []).map((x) => [x.coin, x]));
    this.lastEntrySnapshotByCoin = new Map((runtime.lastEntrySnapshotByCoin || []).map((x) => [String(x.coin || ""), x]));
    this.lastOpenPositionsByCoin = new Map((runtime.lastOpenPositionsByCoin || []).map((x) => [String(x.coin || ""), x]));
    this.pendingFlipByCoin = new Map((runtime.pendingFlipByCoin || []).map((x) => [x.coin, x]));
    this.recentFlipCompletedByCoin = new Map((runtime.recentFlipCompletedByCoin || []).map((x) => [x.coin, x]));
    this.globalNoTradeReason = runtime.globalNoTradeReason || null;
    this.orderTtlTimers = new Map();

    this.assetsByCoin = new Map();
    this.assetMetaByCoin = new Map();
    this.tradeUniverseCoins = [...config.coins];
    this.selectedCoins = [...config.coins];
    this.ws = null;
    this.running = false;
    this.stopping = false;
    this.stopReason = null;
    this.timers = [];
    this.stopPromise = null;
    this.resolveStop = null;

    this.cycleCounter = Number(runtime.cycleCounter || 0);
    this.pendingRewardContext = runtime.pendingRewardContext || null;
    this.lastUserState = null;
    this.lastTotals = runtime.lastTotals || rewardTotalsFromFeedback(this.feedback.currentMetrics());
    this.lastUnrealized = Number(runtime.lastUnrealized || 0);
    this.lastGptReportAt = Number(runtime.lastGptReportAt || 0);
    this.lastReportAt = Number(runtime.lastReportAt || 0);
    this.lastLifecycleAt = Number(runtime.lastLifecycleAt || 0);
    this.riskSnapshot = runtime.riskSnapshot || {
      checkedAt: 0,
      dailyPnl: 0,
      drawdownBps: 0,
      openOrders: 0,
      openPositions: 0,
      positionNotional: 0,
    };
    if (Array.isArray(runtime.selectedCoins) && runtime.selectedCoins.length) {
      this.selectedCoins = runtime.selectedCoins;
    }
  }

  async init() {
    this.#logRecentExchangeErrors();
    await this.#loadMeta();
    await this.#bootstrapManagedTpSlState();
    await this.#primeUserState();
    await this.#runBackfill();
    await this.#refreshRiskSnapshot(true);
    this.#assertRiskWithinLimits();
    await this.#reconcileProtectionState();
    if (this.config.coinSelectionEnabled) {
      await this.#refreshSelectedCoins();
    }
    this.#initWs();
  }

  async start() {
    this.running = true;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });

    this.ws.start();
    this.#startIntervals();

    this.logger.info("Trading engine started", {
      coins: this.config.coins,
      universeCoins: this.tradeUniverseCoins.length,
      selectedCoins: this.selectedCoins,
      budgetMode: this.config.budgetMode,
      strategyIntervalMs: this.config.strategyIntervalMs,
      gptEnabled: this.config.gptEnabled,
    });
    this.#logNextSteps();

    return this.stopPromise;
  }

  async requestShutdown(reason, error = null) {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.running = false;
    this.stopReason = reason;

    this.logger.warn("Shutdown requested", {
      reason,
      error: error ? error.message : undefined,
    });

    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers = [];
    for (const timer of this.orderTtlTimers.values()) {
      clearTimeout(timer);
    }
    this.orderTtlTimers.clear();

    try {
      if (this.ws) {
        await this.ws.stop("shutdown");
      }
    } catch (wsError) {
      this.logger.warn("WS stop failed", { error: wsError.message });
    }

    if (this.config.tpslCleanupOnStop) {
      try {
        await this.#cleanupManagedTpSlOrders("shutdown_tpsl_cleanup");
      } catch (tpslError) {
        this.logger.warn("Failed to cleanup TP/SL orders on shutdown", { error: tpslError.message });
      }
    }

    if (this.config.cancelOpenOrdersOnStop) {
      try {
        await this.cancelAllOpenOrders();
      } catch (cancelError) {
        this.logger.error("Failed to cancel open orders", { error: cancelError.message });
      }
    }

    if (this.config.flattenPositionsOnStop) {
      try {
        await this.#flattenAllPositions();
      } catch (flattenError) {
        this.logger.error("Failed to flatten positions on shutdown", {
          error: flattenError.message,
        });
      }
    }

    this.rollups.flush(Date.now() + this.config.rollupIntervalSec * 1000);
    await this.dataLifecycle.runOnce();
    await this.#persistState();

    const report = generateReport({
      storage: this.storage,
      budgetSnapshot: this.budgetManager.snapshot(),
      windowMs: 24 * 3600 * 1000,
    });
    saveReport(this.storage, report, "shutdown");
    this.storage.appendImprovement({
      source: "shutdown_report",
      improvements: generateTopImprovements(report),
      summary: report.summary,
    });

    const positions = summarizeOpenPositions(this.lastUserState || {});

    this.logger.info("Graceful shutdown complete", {
      reason,
      budget: this.budgetManager.snapshot(),
      reportSummary: report.summary,
      openPositions: positions,
    });

    if (this.resolveStop) {
      this.resolveStop({ reason, report: report.summary, openPositions: positions });
    }
  }

  async #loadMeta() {
    const meta = await this.client.postInfo({ type: "meta" }, "meta");
    const universe = Array.isArray(meta?.universe) ? meta.universe : [];

    universe.forEach((asset, idx) => {
      const coin = String(asset.name || "");
      const szDecimals = normalizeInt(asset.szDecimals, 0);
      const priceDecimals = Math.max(0, 6 - szDecimals);
      const priceSigFigs = 5;
      this.assetsByCoin.set(coin, idx);
      this.assetMetaByCoin.set(coin, {
        coin,
        asset: idx,
        szDecimals,
        priceDecimals,
        priceSigFigs,
      });
    });

    const configured = [...this.config.coins];
    const coins = this.config.coinSelectionEnabled && this.selectedCoins.length
      ? this.selectedCoins
      : this.config.coins;
    for (const coin of coins) {
      if (!this.assetsByCoin.has(coin)) {
        throw new Error(`Coin ${coin} not found in Hyperliquid meta universe`);
      }
    }

    let universeCoins = configured;
    if (this.config.coinSelectionEnabled) {
      const filtered = universe
        .filter((asset) => !asset.isDelisted)
        .map((asset) => String(asset.name));
      const merged = [];
      const seen = new Set();
      for (const coin of [...configured, ...filtered]) {
        if (!coin || seen.has(coin)) {
          continue;
        }
        seen.add(coin);
        merged.push(coin);
        if (merged.length >= this.config.coinUniverseMax) {
          break;
        }
      }
      universeCoins = merged;
    }
    this.tradeUniverseCoins = universeCoins;
    this.coinSelector.registerCoins(universeCoins);
    if (!this.selectedCoins.length) {
      this.selectedCoins = universeCoins.slice(0, Math.max(1, this.config.maxActiveCoins));
    }

    this.logger.info("Loaded asset metadata", {
      coins: this.config.coins.map((c) => {
        const m = this.assetMetaByCoin.get(c);
        return {
          coin: c,
          asset: m?.asset,
          szDecimals: m?.szDecimals,
          priceDecimals: m?.priceDecimals,
          priceSigFigs: m?.priceSigFigs,
        };
      }),
      tradeUniverseSize: this.tradeUniverseCoins.length,
      selectedCoins: this.selectedCoins,
    });
  }

  async #primeUserState() {
    const userState = await this.client.fetchUserState();
    this.lastUserState = userState;
    const eq = this.feedback.updateEquity(userState);
    this.lastUnrealized = eq.unrealized;
  }

  async #runBackfill() {
    const end = Date.now();
    const start = end - this.config.backfillHours * 3600 * 1000;

    this.logger.info("Starting backfill", {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });

    for (const coin of this.config.coins) {
      await this.#backfillCandles(coin, start, end);
      await this.#backfillFunding(coin, start, end);
      await sleep(100);
    }

    await this.#pollFills(start, end);
  }

  async #backfillCandles(coin, startTime, endTime) {
    let cursor = startTime;
    let pages = 0;

    while (cursor < endTime && pages < 500) {
      pages += 1;
      const payload = {
        type: "candleSnapshot",
        req: {
          coin,
          interval: this.config.candleInterval,
          startTime: cursor,
          endTime,
        },
      };
      const res = await this.client.postInfo(payload, "candleSnapshot");
      const candles = Array.isArray(res) ? res : (res?.candles || []);

      if (!candles.length) {
        break;
      }

      let maxTs = cursor;
      for (const candle of candles) {
        const ts = Number(candle.t ?? candle.T ?? candle.time ?? Date.now());
        maxTs = Math.max(maxTs, ts);
        this.marketData.addCandle(coin, candle);
        this.storage.appendCandle({
          ts,
          coin,
          source: "backfill",
          candle,
        });
      }

      if (maxTs <= cursor) {
        break;
      }
      cursor = maxTs + 1;
    }

    this.logger.info("Backfilled candles", { coin, pages, upTo: cursor });
  }

  async #backfillFunding(coin, startTime, endTime) {
    let cursor = startTime;
    let pages = 0;

    while (cursor < endTime && pages < 500) {
      pages += 1;
      const payload = {
        type: "fundingHistory",
        coin,
        startTime: cursor,
        endTime,
      };
      const res = await this.client.postInfo(payload, "fundingHistory");
      const funding = Array.isArray(res) ? res : (res?.funding || []);

      if (!funding.length) {
        break;
      }

      let maxTs = cursor;
      for (const item of funding) {
        const ts = Number(item.time ?? item.timestamp ?? Date.now());
        maxTs = Math.max(maxTs, ts);
        this.storage.appendFunding({
          ts,
          coin,
          source: "backfill",
          funding: item,
        });
      }

      if (maxTs <= cursor) {
        break;
      }
      cursor = maxTs + 1;
    }

    this.logger.info("Backfilled funding", { coin, pages, upTo: cursor });
  }

  #initWs() {
    const subCoins = this.config.coinSelectionEnabled ? this.tradeUniverseCoins : this.config.coins;
    const subscriptions = [
      { type: "allMids" },
      { type: "userFills", user: this.client.accountAddress },
      { type: "orderUpdates", user: this.client.accountAddress },
      ...subCoins.flatMap((coin) => ([
        { type: "l2Book", coin },
        { type: "trades", coin },
        { type: "candle", coin, interval: this.config.candleInterval },
      ])),
    ];

    this.ws = new HyperliquidWsClient({
      config: this.config,
      logger: this.logger,
      budgetManager: this.budgetManager,
      storage: this.storage,
      subscriptions,
      onMessage: async (msg) => this.#handleWsMessage(msg),
      onLifecycle: async (event) => {
        this.storage.appendUserEvent("ws_lifecycle", {
          event,
        });
      },
    });
  }

  #startIntervals() {
    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        await this.#runStrategyCycle();
      });
    }, this.config.strategyIntervalMs));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        const now = Date.now();
        await this.#pollFills(this.lastFillCursor, now);
      });
    }, this.config.fillPollIntervalMs));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        if (this.config.budgetMode !== "quota") {
          return;
        }
        const status = await this.client.fetchBudgetStatus();
        if (!status) {
          this.logger.warn("Quota mode active but no status available; falling back to local counters");
          return;
        }
        this.budgetManager.applyQuotaStatus(status);
      });
    }, this.config.quotaPollIntervalMs));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        await this.#runReportingLoop();
      });
    }, this.config.reportIntervalMs));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        await this.#persistState();
      });
    }, this.config.persistIntervalMs));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        const now = Date.now();
        this.rollups.flush(now);
        if (now - this.lastLifecycleAt >= this.config.lifecycleIntervalMs) {
          await this.dataLifecycle.runOnce();
          this.lastLifecycleAt = now;
        }
      });
    }, Math.max(5000, Math.floor(this.config.rollupIntervalSec * 1000 / 2))));

    this.timers.push(setInterval(() => {
      this.#guarded(async () => {
        if (!this.config.coinSelectionEnabled) {
          return;
        }
        await this.#refreshSelectedCoins();
      });
    }, this.config.coinSelectionRefreshMs));
  }

  async #guarded(task) {
    if (!this.running || this.stopping) {
      return;
    }

    try {
      await task();
    } catch (error) {
      this.storage.appendError({
        where: "guarded_loop",
        error: error.message,
        stack: error.stack,
      });

      if (error instanceof BudgetExceededError) {
        await this.requestShutdown(error.message, error);
        return;
      }
      if (error instanceof RiskLimitError) {
        await this.requestShutdown(error.message, error);
        return;
      }
      if (error?.name === "AbortError") {
        this.logger.warn("Request aborted by timeout");
        return;
      }
      this.logger.error("Unhandled loop error", { error: error.message });
    }
  }

  async #handleWsMessage(msg) {
    const ts = Date.now();
    const channel = msg.channel || msg.subscription?.type || msg.type;
    const data = msg.data ?? msg;

    if (!channel) {
      return;
    }

    if (channel === "allMids") {
      this.marketData.ingestAllMids(data, ts);
      this.storage.appendMarketEvent("allMids", { data });
      return;
    }

    if (channel === "l2Book") {
      const coin = data.coin || data.asset;
      if (coin) {
        this.marketData.setBook(coin, data, ts);
        const book = this.marketData.lastBook(coin);
        this.rollups.recordBook({
          coin,
          spreadBps: Number(book?.spreadBps || 0),
          depthUsd: Math.min(Number(book?.bidDepth || 0), Number(book?.askDepth || 0)),
          mid: Number(book?.mid || this.marketData.mid(coin) || 0),
          ts,
        });
      }
      this.storage.appendMarketEvent("l2Book", { data });
      return;
    }

    if (channel === "trades") {
      const trades = Array.isArray(data) ? data : (data?.trades || []);
      for (const trade of trades) {
        const coin = inferCoinFromTrade(trade, data.coin);
        if (coin) {
          this.marketData.addTrade(coin, trade);
          if (trade.px) {
            this.marketData.setMid(coin, Number(trade.px), Number(trade.time || ts));
          }
        }
      }
      this.storage.appendMarketEvent("trades", { data });
      return;
    }

    if (channel === "candle") {
      const candle = data.candle || data;
      const coin = inferCoinFromCandle(candle, data.coin || data.s || data.symbol);
      if (coin) {
        this.marketData.addCandle(String(coin), candle);
      }
      this.storage.appendMarketEvent("candle", { data });
      return;
    }

    if (channel === "userFills") {
      const fills = Array.isArray(data) ? data : (data?.fills || []);
      const processed = this.feedback.ingestFills({
        fills,
        resolveOrderContext: (fill) => this.#resolveOrderContext(fill),
        marketData: this.marketData,
      });
      const count = processed.count;
      for (const fill of fills) {
        const cloid = fill?.cloid || fill?.clientOrderId;
        if (cloid) {
          this.openOrders.delete(cloid);
          if (this.orderTtlTimers.has(cloid)) {
            clearTimeout(this.orderTtlTimers.get(cloid));
            this.orderTtlTimers.delete(cloid);
          }
        }
      }
      for (const record of processed.records || []) {
        this.rollups.recordExecution(record);
        this.coinSelector.noteOrderOutcome({
          coin: record.coin,
          rejected: false,
          filled: true,
        });
      }
      if ((processed.records || []).length > 0) {
        await this.#handleProcessedFills(processed.records);
      }
      if (count > 0) {
        this.logger.info("Ingested fills from WS", { count });
      }
      this.storage.appendUserEvent("userFills", { data });
      return;
    }

    if (channel === "orderUpdates") {
      const updates = Array.isArray(data) ? data : (Array.isArray(data?.updates) ? data.updates : [data]);
      for (const update of updates) {
        const cloid = update?.cloid || update?.order?.cloid || update?.clientOrderId || null;
        const oid = update?.oid || update?.order?.oid || update?.orderId || null;
        const statusText = String(update?.status || update?.state || update?.orderStatus || "").toLowerCase();
        const terminal = statusText.includes("filled")
          || statusText.includes("canceled")
          || statusText.includes("cancelled")
          || statusText.includes("rejected")
          || statusText.includes("done")
          || statusText.includes("closed");
        if (terminal) {
          if (cloid) {
            this.openOrders.delete(cloid);
            if (this.orderTtlTimers.has(cloid)) {
              clearTimeout(this.orderTtlTimers.get(cloid));
              this.orderTtlTimers.delete(cloid);
            }
          }
          if (oid) {
            const ctx = this.orderContextsByOid.get(String(oid));
            if (ctx?.cloid) {
              this.openOrders.delete(ctx.cloid);
              if (this.orderTtlTimers.has(ctx.cloid)) {
                clearTimeout(this.orderTtlTimers.get(ctx.cloid));
                this.orderTtlTimers.delete(ctx.cloid);
              }
            }
          }
        }
      }
      this.storage.appendUserEvent("orderUpdates", { data });
      return;
    }

    this.storage.appendMarketEvent(channel, { data });
  }

  async #pollFills(startTime, endTime) {
    let cursor = startTime;
    let pages = 0;
    let maxTs = startTime;

    while (cursor < endTime && pages < 200) {
      pages += 1;
      const fills = await this.client.fetchFillsByTime(cursor, endTime);

      if (!fills.length) {
        break;
      }

      const processed = this.feedback.ingestFills({
        fills,
        resolveOrderContext: (fill) => this.#resolveOrderContext(fill),
        marketData: this.marketData,
      });
      this.logger.debug("Polled fills", { fetched: fills.length, processed: processed.count });
      for (const fill of fills) {
        const cloid = fill?.cloid || fill?.clientOrderId;
        if (cloid) {
          this.openOrders.delete(cloid);
          if (this.orderTtlTimers.has(cloid)) {
            clearTimeout(this.orderTtlTimers.get(cloid));
            this.orderTtlTimers.delete(cloid);
          }
        }
      }
      for (const record of processed.records || []) {
        this.rollups.recordExecution(record);
        this.coinSelector.noteOrderOutcome({
          coin: record.coin,
          rejected: false,
          filled: true,
        });
      }
      if ((processed.records || []).length > 0) {
        await this.#handleProcessedFills(processed.records);
      }

      for (const fill of fills) {
        const ts = safeNumber(fill.time ?? fill.timestamp, cursor);
        maxTs = Math.max(maxTs, ts);
      }

      if (maxTs <= cursor) {
        break;
      }
      cursor = maxTs + 1;
    }

    this.lastFillCursor = Math.max(this.lastFillCursor, maxTs);
  }

  async #handleProcessedFills(records) {
    if (!Array.isArray(records) || !records.length) {
      return;
    }
    const coinsNeedingProtection = new Set();
    const latestEntryContextByCoin = new Map();
    for (const record of records) {
      const coin = String(record?.coin || "");
      if (!coin) {
        continue;
      }
      const fillPx = Number(record?.fillPx || 0);
      const spreadBps = Number(this.marketData.lastBook(coin)?.spreadBps || 0);
      const slippageBps = Number(record?.slippageBps || 0);
      const notional = Number(record?.notional || 0);
      const plan = record?.protectionPlan && typeof record.protectionPlan === "object"
        ? record.protectionPlan
        : null;
      const isReduceOnly = Boolean(record?.reduceOnly);

      if (!isReduceOnly && plan) {
        this.positionProtectionPlansByCoin.set(coin, {
          coin,
          ...plan,
          entryPx: fillPx > 0 ? fillPx : Number(plan?.entryPx || 0),
          entryAt: Number(record?.fillTime || record?.ts || Date.now()),
          reason: String(record?.reason || plan?.kind || "strategy"),
          cloid: record?.cloid || null,
          side: record?.side || null,
          strategy: record?.strategy || null,
          regime: record?.regime || null,
          explanation: record?.explanation || null,
          dayKey: utcDayKey(record?.fillTime || record?.ts || Date.now()),
        });
      }

      if (!isReduceOnly) {
        const entrySnapshot = {
          coin,
          cloid: record?.cloid || null,
          side: record?.side || null,
          entryTs: Number(record?.fillTime || record?.ts || Date.now()),
          entryIso: new Date(Number(record?.fillTime || record?.ts || Date.now())).toISOString(),
          entryPx: fillPx > 0 ? fillPx : null,
          notional: notional > 0 ? notional : null,
          regime: record?.regime || null,
          strategy: record?.strategy || null,
          reason: String(record?.reason || record?.strategy || "unknown"),
          reasonCode: String(record?.explanation?.style || record?.reason || record?.strategy || "unknown"),
          features: record?.explanation?.feature || null,
          protectionPlan: plan ? {
            slPct: Number(plan?.slPct || 0) || null,
            tpPct: Number(plan?.tpPct || 0) || null,
            timeStopMs: Number(plan?.timeStopMs || 0) || null,
            timeStopProgressR: Number(plan?.timeStopProgressR || 0) || null,
            kind: String(plan?.kind || ""),
          } : null,
          maker: Boolean(record?.maker),
          taker: Boolean(record?.taker),
          tif: record?.tif || null,
          dayKey: utcDayKey(record?.fillTime || record?.ts || Date.now()),
        };
        this.lastEntrySnapshotByCoin.set(coin, entrySnapshot);
        this.storage.appendMetric({
          type: "entry_snapshot",
          ...entrySnapshot,
        });
      }

      this.storage.appendMetric({
        type: "fill_execution_summary",
        coin,
        cloid: record?.cloid || null,
        side: record?.side,
        fillPx,
        notional,
        maker: Boolean(record?.maker),
        taker: Boolean(record?.taker),
        tif: record?.tif || null,
        spreadBps,
        slippageBps,
        regime: record?.regime || null,
        slPct: Number(plan?.slPct || 0) || null,
        tpPct: Number(plan?.tpPct || 0) || null,
        whyStyle: String(record?.explanation?.style || record?.reason || record?.strategy || "unknown"),
        reason: String(record?.reason || record?.strategy || "unknown"),
      });

      if (!isReduceOnly) {
        const entryCtx = {
          coin,
          cloid: record?.cloid || null,
          side: record?.side || null,
          fillTime: Number(record?.fillTime || record?.ts || Date.now()),
          regime: record?.regime || null,
          strategy: record?.strategy || null,
          reason: String(record?.reason || record?.strategy || "unknown"),
          entryPx: fillPx > 0 ? fillPx : null,
          notional: notional > 0 ? notional : null,
          maker: Boolean(record?.maker),
          taker: Boolean(record?.taker),
          tif: record?.tif || null,
          explanation: record?.explanation || null,
          dayKey: utcDayKey(record?.fillTime || record?.ts || Date.now()),
        };
        latestEntryContextByCoin.set(coin, entryCtx);
        this.lastEntryContextByCoin.set(coin, entryCtx);
        coinsNeedingProtection.add(coin);
      }
    }

    for (const coin of coinsNeedingProtection) {
      const trigger = latestEntryContextByCoin.get(coin) || this.lastEntryContextByCoin.get(coin) || null;
      await this.#ensureProtectionForCoin(coin, {
        source: "entry_fill",
        strict: true,
        trigger,
      });
    }
    this._dailyExecutionCache = null;
  }

  async #runStrategyCycle() {
    this.cycleCounter += 1;

    await this.#updateAndScorePreviousCycle();
    await this.#refreshRiskSnapshot();
    this.#assertRiskWithinLimits();
    await this.#syncPositionTpSl();

    const decision = this.#selectBestSignal();
    if (!decision || !decision.signal) {
      this.storage.appendMetric({
        type: "cycle_no_signal",
        cycle: this.cycleCounter,
      });
      return;
    }

    if (decision.signal.blocked) {
      this.storage.appendMetric({
        type: "cycle_blocked",
        cycle: this.cycleCounter,
        decision,
      });
      return;
    }

    const execResult = await this.#executeSignal(decision);
    if (!execResult.submitted) {
      if (execResult.nonError) {
        this.storage.appendMetric({
          type: "cycle_guard_blocked",
          cycle: this.cycleCounter,
          decision,
          execResult,
        });
        return;
      }
      this.bandit.update({
        coin: decision.coin,
        regime: decision.regime,
        armId: decision.arm.id,
        reward: -5,
        error: true,
      });
      const canary = this.improvement.onCycleResult({
        rewardBps: -5,
        drawdownBps: Number(this.feedback.currentMetrics()?.drawdownBps || 0),
        error: true,
      });
      this.storage.appendMetric({
        type: "cycle_order_rejected",
        cycle: this.cycleCounter,
        decision,
        execResult,
        canary,
      });
      return;
    }

    this.pendingRewardContext = {
      cycle: this.cycleCounter,
      coin: decision.coin,
      regime: decision.regime,
      armId: decision.arm.id,
      signal: execResult.signal || decision.signal,
      baselineTotals: this.lastTotals,
      baselineUnrealized: this.lastUnrealized,
    };

    this.storage.appendMetric({
      type: "cycle_decision",
      cycle: this.cycleCounter,
      decision: {
        coin: decision.coin,
        regime: decision.regime,
        armId: decision.arm.id,
        strategy: decision.arm.strategy,
        signal: decision.signal,
      },
    });
  }

  async #updateAndScorePreviousCycle() {
    if (!this.pendingRewardContext) {
      return;
    }

    const userState = await this.client.fetchUserState();
    this.lastUserState = userState;
    const eq = this.feedback.updateEquity(userState);

    const metricsNow = rewardTotalsFromFeedback(this.feedback.currentMetrics());
    const deltaRealized = metricsNow.realizedPnl - this.pendingRewardContext.baselineTotals.realizedPnl;
    const deltaFees = metricsNow.fees - this.pendingRewardContext.baselineTotals.fees;
    const deltaSlip = metricsNow.slippageUsd - this.pendingRewardContext.baselineTotals.slippageUsd;
    const deltaNotional = metricsNow.notional - this.pendingRewardContext.baselineTotals.notional;
    const unrealizedDelta = Number(eq.unrealized || 0) - Number(this.pendingRewardContext.baselineUnrealized || 0);

    this.lastTotals = metricsNow;
    this.lastUnrealized = Number(eq.unrealized || 0);
    const budgetSnapshot = this.budgetManager.snapshot();
    for (const coin of this.config.coins) {
      this.rollups.recordHealth({
        coin,
        drawdownBps: Number(eq.drawdownBps || 0),
        isUp: true,
        apiCalls: Number(budgetSnapshot.dailyHttpCalls || 0),
        ts: Date.now(),
      });
    }

    const reward = this.feedback.computeReward({
      coin: this.pendingRewardContext.coin,
      armId: this.pendingRewardContext.armId,
      regime: this.pendingRewardContext.regime,
      realizedPnl: deltaRealized,
      fees: deltaFees,
      estimatedSlippage: deltaSlip,
      tradedNotional: Math.max(0, deltaNotional),
      inventoryNotional: inventoryNotional(userState),
      drawdownBps: Number(eq.drawdownBps || 0),
      unrealizedDelta,
    });

    this.bandit.update({
      coin: this.pendingRewardContext.coin,
      regime: this.pendingRewardContext.regime,
      armId: this.pendingRewardContext.armId,
      reward: reward.rewardBps,
      error: false,
    });
    this.coinSelector.updateReward({
      coin: this.pendingRewardContext.coin,
      regime: this.pendingRewardContext.regime,
      rewardBps: reward.rewardBps,
    });

    const canary = this.improvement.onCycleResult({
      rewardBps: reward.rewardBps,
      drawdownBps: Number(eq.drawdownBps || 0),
      error: false,
    });

    this.storage.appendMetric({
      type: "cycle_reward",
      cycle: this.cycleCounter,
      context: this.pendingRewardContext,
      reward,
      canary,
      deltas: {
        deltaRealized,
        deltaFees,
        deltaSlip,
        deltaNotional,
        unrealizedDelta,
      },
    });

    this.pendingRewardContext = null;
  }

  async #refreshSelectedCoins() {
    const qualityByCoin = {};
    for (const coin of this.tradeUniverseCoins) {
      const quality = this.marketData.executionQualityGate(coin, {
        maxSpreadBps: this.config.maxSpreadBps,
        minBookDepthUsd: this.config.minBookDepthUsd,
      });
      qualityByCoin[coin] = quality;
      this.coinSelector.observeMarketQuality({
        coin,
        spreadBps: Number(quality?.spreadBps || 0),
        depthUsd: Number(quality?.depth || 0),
        volBps: Number(this.marketData.volatility(coin, 30) || 0) * 10000,
        expectedFillProb: Number(quality?.expectedFillProb || 0),
      });
    }

    const picked = this.coinSelector.selectCoins({
      candidates: this.tradeUniverseCoins,
      regime: "global",
      maxActive: this.config.maxActiveCoins,
      qualityByCoin,
    });

    if (picked.selected.length > 0) {
      this.selectedCoins = picked.selected;
      this.storage.appendMetric({
        type: "coin_selection_refresh",
        selected: picked.selected,
        top: picked.scored.slice(0, 10),
      });
    }
  }

  #selectBestSignal() {
    const candidates = [];

    const tradeableCoins = this.config.coins
      .map((x) => String(x || "").toUpperCase())
      .filter((x) => x === "BTC" || x === "ETH");
    const selectedRaw = this.config.coinSelectionEnabled && this.selectedCoins.length
      ? this.selectedCoins
      : this.config.coins;
    const selected = selectedRaw
      .map((x) => String(x || "").toUpperCase())
      .filter((x) => tradeableCoins.includes(x));

    if (!selected.length) {
      return null;
    }
    for (const coin of selected) {
      if (this.#isCoinBlockedForTrading(coin)) {
        this.storage.appendMetric({
          type: "coin_skip_tpsl_blocked",
          coin,
          blockedUntil: this.tpslBlockedCoins.get(coin),
        });
        continue;
      }
      const regime = this.marketData.regime(coin);
      const arm = this.bandit.selectArm({ coin, regime });
      const quality = this.marketData.executionQualityGate(coin, {
        maxSpreadBps: this.config.maxSpreadBps,
        minBookDepthUsd: this.config.minBookDepthUsd,
      });
      const override = this.improvement.getOverride({ coin, regime, armId: arm.id });
      const mid = Number(this.marketData.mid(coin) || this.marketData.lastBook(coin)?.mid || 0);
      const expectedNotionalUsd = mid > 0 ? (mid * Number(this.config.orderSize || 0)) : 0;

      const signal = buildSignal({
        arm,
        coin,
        regime,
        marketData: this.marketData,
        orderSize: this.config.orderSize,
        maxSlippageBps: this.config.maxSlippageBps,
        qualityGate: quality,
        paramOverride: override,
        config: this.config,
        expectedNotionalUsd,
      });

      if (!signal) {
        continue;
      }

      this.coinSelector.observeMarketQuality({
        coin,
        spreadBps: Number(quality?.spreadBps || 0),
        depthUsd: Number(quality?.depth || 0),
        volBps: Number(this.marketData.volatility(coin, 30) || 0) * 10000,
        expectedFillProb: Number(quality?.expectedFillProb || 0),
      });

      if (signal.blocked) {
        candidates.push({ coin, regime, arm, signal, blocked: true, score: -Infinity });
        if (String(signal.reason || "").startsWith("NO_TRADE")) {
          this.storage.appendMetric({
            type: "no_trade_guard",
            coin,
            reason: signal.reason,
            detail: signal.explanation?.feature || null,
          });
        }
        continue;
      }

      const coinScore = this.coinSelector.scoreCoin({ coin, regime, quality });
      const score = scoreSignal(signal) + (coinScore * 0.5);
      candidates.push({
        coin,
        regime,
        arm,
        signal,
        override,
        coinScore,
        score,
      });
    }

    if (!candidates.length) return null;
    const executable = candidates.filter((x) => !x.signal?.blocked);
    if (!executable.length) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0];
    }

    executable.sort((a, b) => b.score - a.score);
    return executable[0];
  }

  #buildBootstrapSignal() {
    const fillsSoFar = Number(this.feedback.currentMetrics()?.global?.fills || 0);
    if (fillsSoFar > 0 || this.cycleCounter % 3 !== 0) {
      return null;
    }

    for (const coin of this.config.coins) {
      if (this.#isCoinBlockedForTrading(coin)) {
        continue;
      }
      const regime = this.marketData.regime(coin);
      const arm = this.bandit.selectArm({ coin, regime });
      const quality = this.marketData.executionQualityGate(coin, {
        maxSpreadBps: this.config.maxSpreadBps,
        minBookDepthUsd: this.config.minBookDepthUsd,
      });
      if (!quality.pass) {
        continue;
      }
      const book = this.marketData.lastBook(coin);
      if (!book?.bestBid || !book?.bestAsk) {
        continue;
      }
      const microRet = this.marketData.returns(coin, 2) || 0;
      const buy = microRet >= 0;
      const slip = this.config.maxSlippageBps / 10000;
      const limitPx = buy
        ? Number(book.bestAsk) * (1 + slip)
        : Number(book.bestBid) * (1 - slip);

      return {
        coin,
        regime,
        arm,
        score: 999,
        signal: {
          coin,
          side: buy ? "buy" : "sell",
          sz: this.config.orderSize,
          limitPx,
          tif: "Ioc",
          reduceOnly: false,
          postOnly: false,
          strategy: arm.id,
          regime,
          explanation: {
            style: "bootstrap_probe_ioc_until_first_fill",
            feature: { microRet, reason: "no_signal_yet" },
            quality,
          },
        },
      };
    }
    return null;
  }

  async #executeSignal(decision) {
    const { signal, coin, arm, regime } = decision;
    const asset = this.assetsByCoin.get(signal.coin);
    if (asset === undefined) {
      throw new Error(`Unknown asset for coin ${signal.coin}`);
    }
    const openPositions = summarizeOpenPositions(this.lastUserState || {});
    const coinPosition = openPositions.find((p) => String(p.coin || "") === String(signal.coin || "")) || null;
    const entryGuard = this.#evaluateEntryGuards({
      signal,
      coin,
      openPositions,
      coinPosition,
    });
    if (entryGuard.blocked) {
      this.storage.appendMetric({
        type: "entry_guard_block",
        coin,
        reason: entryGuard.reason,
        detail: entryGuard.detail || null,
      });
      return {
        submitted: false,
        nonError: true,
        outcome: {
          error: entryGuard.reason,
          status: "guard_blocked",
          detail: entryGuard.detail || null,
        },
      };
    }

    if (!signal.reduceOnly && coinPosition) {
      if (sameDirection(coinPosition.size, signal.side)) {
        return {
          submitted: false,
          nonError: true,
          outcome: {
            error: "PYRAMIDING_BLOCKED",
            status: "guard_blocked",
          },
        };
      }
      const flattened = await this.#flattenSinglePosition(coinPosition, `flip_flatten:${signal.side}`);
      const pendingFlip = {
        coin: String(signal.coin),
        requestedSide: String(signal.side),
        requestedAt: Date.now(),
        flattenSubmitted: Boolean(flattened),
        dayKey: utcDayKey(Date.now()),
      };
      this.pendingFlipByCoin.set(String(signal.coin), pendingFlip);
      this.storage.appendMetric({
        type: "flip_flatten_first",
        coin: signal.coin,
        fromSize: Number(coinPosition.size || 0),
        targetSide: signal.side,
        submitted: Boolean(flattened),
        flattenRequestedAt: Number(pendingFlip.requestedAt || 0),
      });
      return {
        submitted: false,
        nonError: true,
        outcome: {
          error: "FLIP_WAIT_FLAT",
          status: "flatten_submitted",
          detail: { flattened: Boolean(flattened) },
        },
      };
    }

    const hasCoinPosition = openPositions.some((p) => p.coin === signal.coin);
    if (
      !signal.reduceOnly
      && !hasCoinPosition
      && openPositions.length >= this.config.maxConcurrentPositions
    ) {
      throw new RiskLimitError("Risk hard limit breached: max concurrent positions", {
        openPositions: openPositions.length,
        limit: this.config.maxConcurrentPositions,
      });
    }

    const mid = this.marketData.mid(signal.coin) || signal.limitPx;
    let requestedSize = Number(signal.sz || 0);
    let riskSizing = null;
    if (!signal.reduceOnly && Number(signal?.protectionPlan?.slPct || 0) > 0) {
      riskSizing = this.#computeRiskBasedSize({
        coin: signal.coin,
        mid,
        slPct: Number(signal.protectionPlan.slPct),
      });
      if (Number(riskSizing?.size || 0) > 0) {
        requestedSize = Number(riskSizing.size);
      }
    }
    const maxOrderNotional = minPositive(this.config.tradeMaxNotionalUsd, this.config.riskMaxOrderNotionalUsd);
    const adjustedSize = adjustSizeForNotional({
      requestedSize,
      mid,
      minNotionalUsd: this.config.tradeMinNotionalUsd,
      maxNotionalUsd: maxOrderNotional,
    });
    const sizedSignal = {
      ...signal,
      sz: adjustedSize.size,
      sizing: adjustedSize,
      riskSizing,
    };

    const sideKey = `${signal.coin}:${signal.side}`;
    if (sizedSignal.tif === "Gtc" || sizedSignal.tif === "Alo") {
      const existing = Array.from(this.openOrders.values()).find((o) => o.sideKey === sideKey);
      if (existing) {
        await this.#cancelByCloid([{ asset, cloid: existing.cloid }], "replace_existing");
        this.openOrders.delete(existing.cloid);
      }
    }

    const primary = await this.#submitOrder({
      signal: sizedSignal,
      coin,
      regime,
      arm,
      asset,
      tagSuffix: "primary",
    });

    let finalResult = primary;
    let rejectionClass = classifyExchangeError(primary.outcome?.error || "");
    if (!primary.submitted) {
      if (
        this.config.orderRetryOnAloError
        && sizedSignal.tif === "Alo"
        && rejectionClass === "bad_alo_px"
        && Boolean(sizedSignal.allowAloAutoRetry)
      ) {
        const retrySignal = this.#buildAloFallbackIocSignal(sizedSignal);
        if (retrySignal) {
          this.storage.appendMetric({
            type: "retry_alo_to_ioc",
            cycle: this.cycleCounter,
            reason: primary.outcome?.error || "BadAloPx",
            original: sizedSignal,
            retry: retrySignal,
          });
          finalResult = await this.#submitOrder({
            signal: retrySignal,
            coin,
            regime,
            arm,
            asset,
            tagSuffix: "alo_retry_ioc",
          });
          rejectionClass = classifyExchangeError(finalResult.outcome?.error || "");
        }
      }

      if (
        !finalResult.submitted
        && this.config.orderRetryOnInvalidPrice
        && (rejectionClass === "invalid_price" || rejectionClass === "tick_or_lot_size" || rejectionClass === "invalid_size")
      ) {
        const retrySignal = this.#buildInvalidPriceRetrySignal(sizedSignal);
        if (retrySignal) {
          this.storage.appendMetric({
            type: "retry_invalid_price_or_lot",
            cycle: this.cycleCounter,
            reason: finalResult.outcome?.error || rejectionClass,
            original: sizedSignal,
            retry: retrySignal,
          });
          finalResult = await this.#submitOrder({
            signal: retrySignal,
            coin,
            regime,
            arm,
            asset,
            tagSuffix: "invalid_price_retry",
          });
          rejectionClass = classifyExchangeError(finalResult.outcome?.error || "");
        }
      }
    }

    if (!finalResult.submitted) {
      this.logger.warn("Order rejected", {
        coin,
        arm: arm.id,
        regime,
        error: finalResult.outcome?.error || "unknown",
        classified: rejectionClass,
        hint: this.#rejectionHint(rejectionClass),
      });
      this.storage.appendError({
        where: "order_submit",
        coin,
        armId: arm.id,
        regime,
        error: finalResult.outcome?.error || "unknown",
        raw: finalResult.rawResponse,
      });
      return {
        submitted: false,
        outcome: finalResult.outcome,
      };
    }

    const { outcome, cloid, sentAt, signal: usedSignal, rawResponse } = finalResult;
    const context = {
      cloid,
      oid: outcome.oid,
      coin: usedSignal.coin,
      asset,
      armId: arm.id,
      strategy: arm.strategy,
      regime,
      side: usedSignal.side,
      tif: usedSignal.tif,
      reduceOnly: Boolean(usedSignal.reduceOnly),
      postOnly: Boolean(usedSignal.postOnly),
      expectedPx: usedSignal.limitPx,
      size: usedSignal.sz,
      sentAt,
      explanation: usedSignal.explanation,
      reason: usedSignal.explanation?.style || usedSignal.strategy || arm.strategy,
      protectionPlan: usedSignal.protectionPlan || null,
      signalMid: Number(this.marketData.mid(usedSignal.coin) || 0),
    };

    this.orderContextsByCloid.set(cloid, context);
    if (outcome.oid) {
      this.orderContextsByOid.set(String(outcome.oid), context);
    }

    const record = {
      coin: usedSignal.coin,
      asset,
      cloid,
      side: usedSignal.side,
      limitPx: usedSignal.limitPx,
      size: usedSignal.sz,
      tif: usedSignal.tif,
      reduceOnly: Boolean(usedSignal.reduceOnly),
      postOnly: Boolean(usedSignal.postOnly),
      strategy: arm.id,
      regime,
      explanation: usedSignal.explanation,
      response: outcome,
      raw: rawResponse,
      sizing: usedSignal.sizing,
      protectionPlan: usedSignal.protectionPlan || null,
      reason: context.reason,
    };

    this.storage.appendOrderEvent(record);
    if (!Boolean(usedSignal.reduceOnly)) {
      const flipState = this.recentFlipCompletedByCoin.get(String(usedSignal.coin)) || null;
      this.storage.appendMetric({
        type: "entry_order_submitted",
        coin: usedSignal.coin,
        cloid,
        side: usedSignal.side,
        tif: usedSignal.tif,
        strategy: arm.strategy,
        regime,
        fromFlip: Boolean(flipState),
      });
      if (flipState) {
        const flatConfirmedAt = Number(flipState.flatConfirmedAt || 0);
        this.storage.appendMetric({
          type: "flip_new_entry_submitted",
          coin: usedSignal.coin,
          requestedSide: String(flipState.requestedSide || ""),
          flattenRequestedAt: Number(flipState.requestedAt || 0),
          flatConfirmedAt: flatConfirmedAt > 0 ? flatConfirmedAt : null,
          newEntryAt: sentAt,
          deltaMsFromFlatConfirm: flatConfirmedAt > 0 ? (sentAt - flatConfirmedAt) : null,
          cloid,
        });
        this.recentFlipCompletedByCoin.delete(String(usedSignal.coin));
      }
    }

    if (outcome.resting) {
      this.openOrders.set(cloid, {
        cloid,
        asset,
        coin: usedSignal.coin,
        side: usedSignal.side,
        sideKey,
        strategy: arm.id,
        regime,
        createdAt: sentAt,
        oid: outcome.oid,
      });
      if (usedSignal.tif === "Alo" && Number(usedSignal.ttlMs || 0) > 0) {
        this.#scheduleMakerOrderTtl({
          cloid,
          coin: usedSignal.coin,
          asset,
          signal: usedSignal,
          context,
        });
      }
    } else {
      this.openOrders.delete(cloid);
    }

    this.logger.info("Order submitted", {
      coin: usedSignal.coin,
      arm: arm.id,
      regime,
      side: usedSignal.side,
      px: usedSignal.limitPx,
      sz: usedSignal.sz,
      tif: usedSignal.tif,
      cloid,
      outcome,
    });

    return {
      submitted: true,
      outcome,
      signal: usedSignal,
    };
  }

  async #submitOrder({ signal, coin, regime, arm, asset, tagSuffix }) {
    const normalized = this.#normalizeSignalForExchange(signal);
    const normalizedSignal = normalized.signal;
    const meta = this.assetMetaByCoin.get(normalizedSignal.coin);
    if (!meta) {
      const message = `preflight_meta_missing:${normalizedSignal.coin}`;
      this.storage.appendError({
        where: "order_preflight",
        coin: normalizedSignal.coin,
        armId: arm.id,
        regime,
        error: message,
      });
      return {
        submitted: false,
        outcome: { error: message },
        signal: normalizedSignal,
      };
    }
    if (normalized.changed) {
      this.storage.appendMetric({
        type: "order_normalized",
        cycle: this.cycleCounter,
        coin,
        armId: arm.id,
        before: {
          limitPx: Number(signal.limitPx),
          sz: Number(signal.sz),
          tif: signal.tif,
        },
        after: {
          limitPx: Number(normalizedSignal.limitPx),
          sz: Number(normalizedSignal.sz),
          tif: normalizedSignal.tif,
        },
        normalization: normalized.normalization,
      });
    }

    const cloid = makeCloid();
    const order = {
      asset,
      isBuy: normalizedSignal.side === "buy",
      limitPx: normalizedSignal.limitPx,
      sz: normalizedSignal.sz,
      reduceOnly: Boolean(normalizedSignal.reduceOnly),
      orderType: { limit: { tif: normalizedSignal.tif } },
      cloid,
    };
    const orderWire = toOrderWire(order);
    const preflight = validatePerpOrderWire({
      px: orderWire.p,
      sz: orderWire.s,
      szDecimals: meta.szDecimals,
    });
    if (!preflight.ok) {
      const errorCode = `preflight_${preflight.reason}`;
      this.storage.appendMetric({
        type: "order_preflight_reject",
        cycle: this.cycleCounter,
        coin,
        armId: arm.id,
        regime,
        tif: normalizedSignal.tif,
        side: normalizedSignal.side,
        orderWire,
        preflight,
      });
      this.storage.appendError({
        where: "order_preflight",
        coin,
        armId: arm.id,
        regime,
        error: errorCode,
        detail: preflight.detail,
      });
      return {
        submitted: false,
        outcome: {
          error: errorCode,
          status: "blocked_preflight",
          detail: preflight.detail,
        },
        signal: normalizedSignal,
        cloid,
      };
    }

    const intent = {
      kind: "order",
      coin,
      regime,
      armId: arm.id,
      side: normalizedSignal.side,
      sz: Number(normalizedSignal.sz),
      limitPx: Number(normalizedSignal.limitPx),
      tif: normalizedSignal.tif,
      reduceOnly: Boolean(normalizedSignal.reduceOnly),
    };

    const duplicate = this.idempotency.seen(intent);
    if (duplicate && Date.now() - Number(duplicate.submittedAt || 0) < 10000) {
      this.storage.appendMetric({
        type: "idempotency_skip",
        cycle: this.cycleCounter,
        intent,
        duplicate,
      });
      return {
        submitted: false,
        outcome: { error: "idempotency_skip" },
        signal: normalizedSignal,
        cloid,
      };
    }

    const key = this.idempotency.markSubmitted(intent, { cloid });
    const action = makeOrderAction([orderWire]);
    const sentAt = Date.now();
    this.budgetManager.noteOrderSubmitted();
    const result = await this.client.postExchangeAction(action, {
      tag: `${coin}:${arm.id}:${tagSuffix}`,
    });
    const outcome = parseOrderResponse(result.response);
    this.idempotency.markResultByKey(key, outcome);

    const submitted = !outcome.error && (Boolean(outcome.oid) || Boolean(outcome.resting) || Boolean(outcome.filled));
    this.coinSelector.noteOrderOutcome({
      coin,
      rejected: !submitted,
      filled: Boolean(outcome.filled),
    });
    this.rollups.recordOrderResult({
      coin,
      submitted: submitted ? 1 : 0,
      rejected: submitted ? 0 : 1,
      canceled: false,
      ts: sentAt,
    });
    return {
      submitted,
      signal: normalizedSignal,
      cloid,
      sentAt,
      outcome,
      rawResponse: result.response,
    };
  }

  #buildAloFallbackIocSignal(signal) {
    const book = this.marketData.lastBook(signal.coin);
    if (!book) {
      return null;
    }

    const slip = this.config.maxSlippageBps / 10000;
    if (signal.side === "buy" && Number(book.bestAsk || 0) > 0) {
      return {
        ...signal,
        tif: "Ioc",
        postOnly: false,
        limitPx: Number(book.bestAsk) * (1 + slip),
      };
    }
    if (signal.side === "sell" && Number(book.bestBid || 0) > 0) {
      return {
        ...signal,
        tif: "Ioc",
        postOnly: false,
        limitPx: Number(book.bestBid) * (1 - slip),
      };
    }
    return null;
  }

  async #refreshRiskSnapshot(force = false) {
    const now = Date.now();
    if (!force && now - Number(this.riskSnapshot?.checkedAt || 0) < 30000) {
      return this.riskSnapshot;
    }

    this.lastUserState = await this.client.fetchUserState();

    const dayStart = now - (24 * 3600 * 1000);
    const executionRows = this.storage.readStream("execution", { maxLines: 60000 })
      .filter((x) => Number(x?.ts || 0) >= dayStart);
    const dailyPnl = executionRows.reduce((acc, row) => acc + Number(row?.realizedPnl || 0), 0);
    const drawdownBps = Number(this.feedback.currentMetrics()?.drawdownBps || 0);
    const openPositions = summarizeOpenPositions(this.lastUserState || {});
    this.lastOpenPositionsByCoin = new Map(
      openPositions.map((pos) => {
        const coin = String(pos?.coin || "");
        return [
          coin,
          {
            coin,
            size: Number(pos?.size || 0),
            side: Number(pos?.size || 0) >= 0 ? "buy" : "sell",
            entryPx: Number(pos?.entryPx || 0),
            markPx: Number(pos?.markPx || 0),
            unrealizedPnl: Number(pos?.unrealizedPnl || 0),
            updatedAt: now,
          },
        ];
      }).filter((x) => x[0]),
    );
    const positionNotional = inventoryNotional(this.lastUserState || {});
    const openOrders = this.openOrders.size;
    const openCoins = new Set(openPositions.map((p) => String(p.coin || "")));
    for (const coin of this.pendingFlipByCoin.keys()) {
      if (!openCoins.has(String(coin))) {
        const flip = this.pendingFlipByCoin.get(String(coin)) || null;
        const flatConfirmedAt = Date.now();
        if (flip) {
          const completed = {
            ...flip,
            flatConfirmedAt,
            dayKey: utcDayKey(flatConfirmedAt),
          };
          this.recentFlipCompletedByCoin.set(String(coin), completed);
          this.storage.appendMetric({
            type: "flip_flat_confirmed",
            coin: String(coin),
            requestedSide: String(flip.requestedSide || ""),
            flattenRequestedAt: Number(flip.requestedAt || 0),
            flatConfirmedAt,
            flattenCloid: flip.flattenCloid || null,
          });
        }
        this.pendingFlipByCoin.delete(String(coin));
      }
    }
    for (const coin of this.positionProtectionPlansByCoin.keys()) {
      if (!openCoins.has(String(coin))) {
        this.positionProtectionPlansByCoin.delete(String(coin));
      }
    }
    for (const coin of this.lastEntryContextByCoin.keys()) {
      if (!openCoins.has(String(coin))) {
        this.lastEntryContextByCoin.delete(String(coin));
      }
    }
    for (const coin of this.lastEntrySnapshotByCoin.keys()) {
      if (!openCoins.has(String(coin))) {
        this.lastEntrySnapshotByCoin.delete(String(coin));
      }
    }
    for (const [coin, row] of this.recentFlipCompletedByCoin.entries()) {
      const dayKey = String(row?.dayKey || "");
      if (dayKey && dayKey !== utcDayKey(now)) {
        this.recentFlipCompletedByCoin.delete(String(coin));
      }
    }

    this.riskSnapshot = {
      checkedAt: now,
      dailyPnl,
      drawdownBps,
      openOrders,
      openPositions: openPositions.length,
      positionNotional,
    };
    return this.riskSnapshot;
  }

  #assertRiskWithinLimits() {
    const risk = this.riskSnapshot || {};
    const reasons = [];
    if (Number(this.config.riskMaxDailyLossUsd || 0) > 0 && Number(risk.dailyPnl || 0) <= -Math.abs(this.config.riskMaxDailyLossUsd)) {
      reasons.push(`daily_loss_limit(${risk.dailyPnl.toFixed(4)})`);
    }
    if (Number(this.config.riskMaxDrawdownBps || 0) > 0 && Number(risk.drawdownBps || 0) >= Number(this.config.riskMaxDrawdownBps)) {
      reasons.push(`drawdown_limit(${Number(risk.drawdownBps || 0).toFixed(2)}bps)`);
    }
    if (Number(this.config.riskMaxPositionNotionalUsd || 0) > 0 && Number(risk.positionNotional || 0) >= Number(this.config.riskMaxPositionNotionalUsd)) {
      reasons.push(`position_notional_limit(${Number(risk.positionNotional || 0).toFixed(2)})`);
    }
    if (Number(this.config.riskMaxOpenOrders || 0) > 0 && Number(risk.openOrders || 0) >= Number(this.config.riskMaxOpenOrders)) {
      reasons.push(`open_orders_limit(${risk.openOrders})`);
    }
    if (Number(this.config.maxConcurrentPositions || 0) > 0 && Number(risk.openPositions || 0) > Number(this.config.maxConcurrentPositions)) {
      reasons.push(`open_positions_limit(${risk.openPositions})`);
    }

    if (reasons.length) {
      throw new RiskLimitError(`Risk hard limit breached: ${reasons.join(", ")}`, {
        reasons,
        risk,
      });
    }
  }

  async #flattenAllPositions() {
    if (this.config.tpslCleanupOnStop) {
      await this.#cleanupManagedTpSlOrders("flatten_cleanup");
    }

    const userState = await this.client.fetchUserState();
    this.lastUserState = userState;
    const positions = summarizeOpenPositions(userState);
    if (!positions.length) {
      if (this.config.tpslCleanupOnStop) {
        await this.#cleanupManagedTpSlOrders("flatten_post_cleanup");
      }
      return;
    }

    const slip = (this.config.maxSlippageBps / 10000) * 2;
    for (const pos of positions) {
      const coin = pos.coin;
      const asset = this.assetsByCoin.get(coin);
      const size = Math.abs(Number(pos.size || 0));
      if (asset === undefined || size <= 0) {
        continue;
      }
      const side = Number(pos.size || 0) > 0 ? "sell" : "buy";
      const book = this.marketData.lastBook(coin);
      const fallbackPx = Number(pos.entryPx || this.marketData.mid(coin) || 0);
      const px = side === "buy"
        ? Number(book?.bestAsk || fallbackPx) * (1 + slip)
        : Number(book?.bestBid || fallbackPx) * (1 - slip);

      const normalized = this.#normalizeSignalForExchange({
        coin,
        side,
        sz: size,
        limitPx: Math.max(0, px),
        tif: "Ioc",
        reduceOnly: true,
        postOnly: false,
      });
      const signal = normalized.signal;
      if (!(Number(signal.sz || 0) > 0) || !(Number(signal.limitPx || 0) > 0)) {
        continue;
      }

      const order = {
        asset,
        isBuy: signal.side === "buy",
        limitPx: signal.limitPx,
        sz: signal.sz,
        reduceOnly: true,
        orderType: { limit: { tif: "Ioc" } },
        cloid: makeCloid(),
      };
      const orderWire = toOrderWire(order);
      const meta = this.assetMetaByCoin.get(coin);
      const preflight = validatePerpOrderWire({
        px: orderWire.p,
        sz: orderWire.s,
        szDecimals: meta?.szDecimals ?? 0,
      });
      if (!preflight.ok) {
        this.storage.appendError({
          where: "risk_flatten_preflight",
          coin,
          error: `preflight_${preflight.reason}`,
          detail: preflight.detail,
        });
        this.logger.error("Risk flatten preflight blocked", {
          coin,
          reason: preflight.reason,
          detail: preflight.detail,
        });
        continue;
      }

      this.budgetManager.noteOrderSubmitted();
      const sentAt = Date.now();
      const res = await this.client.postExchangeAction(
        makeOrderAction([orderWire]),
        { tag: `risk_flatten:${coin}` },
      );
      const outcome = parseOrderResponse(res.response);
      const submitted = !outcome.error && (Boolean(outcome.filled) || Boolean(outcome.resting) || Boolean(outcome.oid));
      this.rollups.recordOrderResult({
        coin,
        submitted: submitted ? 1 : 0,
        rejected: submitted ? 0 : 1,
        canceled: 0,
        ts: sentAt,
      });

      this.storage.appendOrderEvent({
        type: "risk_flatten",
        coin,
        side,
        size: signal.sz,
        limitPx: signal.limitPx,
        response: outcome,
        raw: res.response,
      });

      this.logger.warn("Flatten position order submitted", {
        coin,
        side,
        size: signal.sz,
        px: signal.limitPx,
        outcome,
      });
    }

    if (this.config.tpslCleanupOnStop) {
      await this.#cleanupManagedTpSlOrders("flatten_post_cleanup");
    }
  }

  #buildInvalidPriceRetrySignal(signal) {
    const book = this.marketData.lastBook(signal.coin);
    if (!book) {
      return null;
    }

    const slip = this.config.maxSlippageBps / 10000;
    if (signal.side === "buy" && Number(book.bestAsk || 0) > 0) {
      return {
        ...signal,
        tif: "Ioc",
        postOnly: false,
        limitPx: Number(book.bestAsk) * (1 + slip),
      };
    }
    if (signal.side === "sell" && Number(book.bestBid || 0) > 0) {
      return {
        ...signal,
        tif: "Ioc",
        postOnly: false,
        limitPx: Number(book.bestBid) * (1 - slip),
      };
    }
    return null;
  }

  #normalizeSignalForExchange(signal) {
    const meta = this.assetMetaByCoin.get(signal.coin);
    if (!meta) {
      return { signal, changed: false, normalization: { reason: "meta_missing" } };
    }

    const mid = Number(this.marketData.mid(signal.coin) || signal.limitPx || 0);
    const sizePlan = normalizeSizeForAsset({
      requestedSize: Number(signal.sz || 0),
      mid,
      szDecimals: meta.szDecimals,
      minNotionalUsd: this.config.tradeMinNotionalUsd,
      maxNotionalUsd: this.config.tradeMaxNotionalUsd,
    });

    const priceMode = inferPriceRoundMode({
      side: signal.side,
      tif: signal.tif,
    });
    const pricePlan = normalizePriceForAsset({
      requestedPrice: Number(signal.limitPx || 0),
      maxPriceDecimals: meta.priceDecimals,
      maxSignificantFigures: meta.priceSigFigs,
      mode: priceMode,
    });

    const normalizedSignal = {
      ...signal,
      sz: sizePlan.size,
      limitPx: pricePlan.price,
      sizing: {
        ...(signal.sizing || {}),
        sizeNormalized: sizePlan,
      },
      normalization: {
        assetMeta: meta,
        sizePlan,
        pricePlan,
        priceRoundMode: priceMode,
      },
    };

    const changed = (
      Math.abs(Number(signal.sz || 0) - sizePlan.size) > 1e-10
      || Math.abs(Number(signal.limitPx || 0) - pricePlan.price) > 1e-10
    );

    return {
      signal: normalizedSignal,
      changed,
      normalization: normalizedSignal.normalization,
    };
  }

  #symbolRules(coin) {
    const safeCoin = String(coin || "").toUpperCase();
    const defaults = this.config.strategySymbolDefaults || {};
    const specific = (this.config.strategySymbolRules || {})[safeCoin] || {};
    return {
      ...defaults,
      ...specific,
    };
  }

  #dailyExecutionStats() {
    const now = Date.now();
    const dayKey = utcDayKey(now);
    if (this._dailyExecutionCache && this._dailyExecutionCache.dayKey === dayKey && (now - this._dailyExecutionCache.ts) < 5000) {
      return this._dailyExecutionCache.stats;
    }
    const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
    const rows = this.storage.readStream("execution", { maxLines: 60000 })
      .filter((x) => Number(x?.ts || 0) >= dayStart)
      .filter((x) => ["BTC", "ETH"].includes(String(x?.coin || "").toUpperCase()))
      .sort((a, b) => Number(a?.fillTime || a?.ts || 0) - Number(b?.fillTime || b?.ts || 0));
    let takerStreak = 0;
    let makerOnlyRestOfDay = false;
    for (const row of rows) {
      if (Boolean(row?.taker)) {
        takerStreak += 1;
        if (takerStreak >= Number(this.config.strategyConsecutiveTakerLimit || 2)) {
          makerOnlyRestOfDay = true;
        }
      } else {
        takerStreak = 0;
      }
    }
    const stats = {
      dayKey,
      fills: rows.length,
      takerFills: rows.filter((x) => Boolean(x?.taker)).length,
      makerOnlyRestOfDay,
    };
    this._dailyExecutionCache = {
      dayKey,
      ts: now,
      stats,
    };
    return stats;
  }

  #passesTakerGuard({ coin, side, notionalUsd }) {
    const rules = this.#symbolRules(coin);
    const spreadBps = Number(this.marketData.lastBook(coin)?.spreadBps || 0);
    if (!(spreadBps > 0) || spreadBps > Number(rules.takerSpreadBps || 0)) {
      return {
        pass: false,
        reason: "NO_TRADE_SPREAD",
        detail: {
          spreadBps,
          limit: Number(rules.takerSpreadBps || 0),
        },
      };
    }
    const slippageBps = Number(this.marketData.estimateSlippageBps(coin, {
      side,
      notionalUsd: Math.max(10, Number(notionalUsd || 0)),
    }) || 0);
    if (slippageBps > Number(rules.takerSlippageBps || 0)) {
      return {
        pass: false,
        reason: "NO_TRADE_SLIPPAGE",
        detail: {
          slippageBps,
          limit: Number(rules.takerSlippageBps || 0),
        },
      };
    }
    return {
      pass: true,
      reason: null,
      detail: {
        spreadBps,
        slippageBps,
      },
    };
  }

  #evaluateEntryGuards({ signal, coin, coinPosition }) {
    if (signal.reduceOnly) {
      return { blocked: false };
    }
    if (this.globalNoTradeReason) {
      return {
        blocked: true,
        reason: this.globalNoTradeReason,
      };
    }
    if (this.#isCoinBlockedForTrading(coin)) {
      return {
        blocked: true,
        reason: "COIN_BLOCKED",
      };
    }
    if (this.pendingFlipByCoin.has(String(coin))) {
      const flip = this.pendingFlipByCoin.get(String(coin)) || null;
      return {
        blocked: true,
        reason: "FLIP_WAIT_FLAT",
        detail: flip,
      };
    }
    if (coinPosition && sameDirection(coinPosition.size, signal.side)) {
      return {
        blocked: true,
        reason: "PYRAMIDING_BLOCKED",
      };
    }

    const dayStats = this.#dailyExecutionStats();
    if (dayStats.fills >= Number(this.config.strategyDailyFillLimit || 12)) {
      return {
        blocked: true,
        reason: "DAILY_TRADE_LIMIT",
        detail: dayStats,
      };
    }

    const isTakerIntent = String(signal.tif || "").toLowerCase() === "ioc";
    if (signal.makerOnly && isTakerIntent) {
      return {
        blocked: true,
        reason: "MAKER_ONLY_SIGNAL",
      };
    }
    if (isTakerIntent) {
      if (dayStats.takerFills >= Number(this.config.strategyDailyTakerFillLimit || 3)) {
        return {
          blocked: true,
          reason: "TAKER_LIMIT",
          detail: dayStats,
        };
      }
      if (dayStats.makerOnlyRestOfDay) {
        return {
          blocked: true,
          reason: "TAKER_STREAK_LIMIT",
          detail: dayStats,
        };
      }
      const mid = Number(this.marketData.mid(coin) || signal.limitPx || 0);
      const notional = Math.max(0, Number(signal.sz || 0) * Math.max(0, mid));
      const takerGuard = this.#passesTakerGuard({
        coin,
        side: signal.side,
        notionalUsd: notional,
      });
      if (!takerGuard.pass) {
        return {
          blocked: true,
          reason: takerGuard.reason,
          detail: takerGuard.detail,
        };
      }
    }

    return { blocked: false };
  }

  #computeRiskBasedSize({ coin, mid, slPct }) {
    const entryPx = Number(mid || 0);
    const sl = Number(slPct || 0) / 100;
    const equity = Number(this.feedback.currentMetrics()?.lastEquity || 0);
    if (!(entryPx > 0) || !(sl > 0) || !(equity > 0)) {
      return null;
    }
    const notionalRaw = (equity * 0.0015) / sl;
    const existingGross = Number(this.riskSnapshot?.positionNotional || inventoryNotional(this.lastUserState || {}) || 0);
    const coinCap = equity * 0.25;
    const totalRemain = Math.max(0, (equity * 0.50) - existingGross);
    const cappedNotional = Math.max(0, Math.min(notionalRaw, coinCap, totalRemain));
    const size = cappedNotional > 0 ? (cappedNotional / entryPx) : 0;
    return {
      coin,
      equity,
      slPct: Number(slPct || 0),
      notionalRaw,
      cappedNotional,
      coinCap,
      totalRemain,
      existingGross,
      size,
    };
  }

  #scheduleMakerOrderTtl({ cloid, coin, asset, signal, context }) {
    const ttlMs = Math.max(1, Number(signal?.ttlMs || 0));
    if (!(ttlMs > 0)) {
      return;
    }
    if (this.orderTtlTimers.has(cloid)) {
      clearTimeout(this.orderTtlTimers.get(cloid));
      this.orderTtlTimers.delete(cloid);
    }
    const timer = setTimeout(() => {
      this.#guarded(async () => {
        this.orderTtlTimers.delete(cloid);
        if (!this.openOrders.has(cloid)) {
          return;
        }
        await this.#cancelByCloid([{ asset, cloid }], "order_ttl_expired");
        this.openOrders.delete(cloid);
        this.storage.appendMetric({
          type: "order_ttl_cancel",
          coin,
          cloid,
          ttlMs,
          strategy: signal?.strategy || null,
        });

        if (!signal?.allowTakerAfterTtl) {
          return;
        }
        const rules = this.#symbolRules(coin);
        const initialMid = Number(context?.signalMid || 0);
        const nowMid = Number(this.marketData.mid(coin) || 0);
        if (!(initialMid > 0) || !(nowMid > 0)) {
          return;
        }
        const driftPct = Math.abs(((nowMid - initialMid) / initialMid) * 100);
        if (driftPct < Number(rules.trendTakerTriggerPct || signal?.takerTriggerMovePct || 999)) {
          return;
        }
        const guard = this.#evaluateEntryGuards({
          signal: {
            ...signal,
            tif: "Ioc",
            makerOnly: false,
          },
          coin,
          coinPosition: summarizeOpenPositions(this.lastUserState || {}).find((p) => String(p.coin) === String(coin)) || null,
        });
        if (guard.blocked) {
          this.storage.appendMetric({
            type: "ttl_taker_guard_block",
            coin,
            reason: guard.reason,
            detail: guard.detail || null,
          });
          return;
        }
        const iocSignal = {
          ...signal,
          tif: "Ioc",
          postOnly: false,
          makerOnly: false,
          allowTakerAfterTtl: false,
          ttlMs: 0,
          limitPx: Number(signal?.fallbackIocPx || signal?.limitPx || nowMid),
          allowAloAutoRetry: false,
        };
        const fallbackArm = {
          id: String(context?.armId || "ttl_taker_fallback"),
          strategy: String(context?.strategy || signal?.strategy || "strategy"),
        };
        const res = await this.#executeSignal({
          signal: iocSignal,
          coin,
          arm: fallbackArm,
          regime: String(context?.regime || signal?.regime || "unknown"),
        });
        this.storage.appendMetric({
          type: "ttl_taker_attempt",
          coin,
          cloid,
          driftPct,
          submitted: Boolean(res?.submitted),
          reason: res?.outcome?.error || null,
        });
      });
    }, ttlMs);
    this.orderTtlTimers.set(cloid, timer);
  }

  #markCoinBlockedForDay(coin, reason, detail = null) {
    const until = utcDayEndTs(Date.now());
    this.strategyBlockedCoins.set(String(coin), {
      until,
      reason: String(reason || "strategy_guard"),
      dayKey: utcDayKey(Date.now()),
    });
    this.storage.appendMetric({
      type: "strategy_coin_blocked",
      coin,
      reason: String(reason || "strategy_guard"),
      until,
      detail: detail && typeof detail === "object" ? detail : null,
    });
  }

  async #reconcileProtectionState() {
    this.globalNoTradeReason = null;
    await this.#bootstrapManagedTpSlState();
    this.lastUserState = await this.client.fetchUserState();
    const positions = summarizeOpenPositions(this.lastUserState || {});
    for (const pos of positions) {
      const coin = String(pos?.coin || "");
      if (!coin) {
        continue;
      }
      const ok = await this.#ensureProtectionForCoin(coin, {
        source: "reconcile",
        strict: true,
        trigger: {
          coin,
          cloid: null,
          side: Number(pos?.size || 0) > 0 ? "buy" : "sell",
          reason: "reconcile",
        },
      });
      if (!ok) {
        this.globalNoTradeReason = "NO_PROTECTION_RECONCILE";
        this.storage.appendMetric({
          type: "ensure_protection_reconcile_failed",
          coin,
          reason: "NO_PROTECTION_RECONCILE",
        });
      }
    }
  }

  async #ensureProtectionForCoin(coin, { source = "runtime", strict = false, trigger = null } = {}) {
    const startedAt = Date.now();
    const triggerCtx = (trigger && typeof trigger === "object")
      ? trigger
      : (this.lastEntryContextByCoin.get(String(coin)) || null);
    this.storage.appendMetric({
      type: "ensure_protection_start",
      coin,
      source,
      strict: Boolean(strict),
      triggerCloid: triggerCtx?.cloid || null,
      triggerSide: triggerCtx?.side || null,
      triggerReason: triggerCtx?.reason || null,
    });
    this.lastUserState = await this.client.fetchUserState();
    const position = summarizeOpenPositions(this.lastUserState || {})
      .find((x) => String(x.coin || "") === String(coin)) || null;
    if (!position) {
      this.tpslByCoin.delete(coin);
      this.positionProtectionPlansByCoin.delete(coin);
      this.storage.appendMetric({
        type: "ensure_protection_done",
        coin,
        source,
        strict: Boolean(strict),
        ok: true,
        hasPosition: false,
        hasSl: false,
        triggerCloid: triggerCtx?.cloid || null,
        triggerSide: triggerCtx?.side || null,
        latencyMs: Date.now() - startedAt,
      });
      return true;
    }

    const positionSide = Number(position?.size || 0) > 0 ? "long" : "short";
    const desired = this.#buildDesiredTpSlForPosition(position);
    if (!desired || desired.slPx === null || desired.slPx === undefined) {
      let flattened = false;
      if (strict) {
        flattened = await this.#flattenSinglePosition(position, `no_protection:${source}:plan_unavailable`);
        this.#markCoinBlockedForDay(coin, "NO_PROTECTION", {
          source,
          reason: "plan_unavailable",
          triggerCloid: triggerCtx?.cloid || null,
          triggerSide: triggerCtx?.side || null,
        });
      }
      this.storage.appendMetric({
        type: "ensure_protection_done",
        coin,
        source,
        strict: Boolean(strict),
        ok: false,
        hasPosition: true,
        hasSl: false,
        reason: "NO_PROTECTION_PLAN_UNAVAILABLE",
        triggerCloid: triggerCtx?.cloid || null,
        triggerSide: triggerCtx?.side || null,
        positionSide,
        positionSize: Number(position?.size || 0),
        flattened: Boolean(flattened),
        latencyMs: Date.now() - startedAt,
      });
      return false;
    }

    let state = this.tpslByCoin.get(coin) || null;
    if (!state?.slCloid) {
      const next = await this.#submitPositionTpSlOrders({
        coin,
        desired: {
          ...desired,
          tpPx: null,
        },
      });
      if (!next?.slCloid) {
        this.storage.appendError({
          where: "ensureProtection",
          coin,
          error: "NO_PROTECTION_SL_PLACE_FAILED",
          detail: {
            source,
            triggerCloid: triggerCtx?.cloid || null,
            triggerSide: triggerCtx?.side || null,
          },
        });
        let flattened = false;
        if (strict) {
          flattened = await this.#flattenSinglePosition(position, `no_protection:${source}:sl_place_failed`);
          this.#markCoinBlockedForDay(coin, "NO_PROTECTION", {
            source,
            reason: "sl_place_failed",
            triggerCloid: triggerCtx?.cloid || null,
            triggerSide: triggerCtx?.side || null,
          });
        }
        this.storage.appendMetric({
          type: "ensure_protection_done",
          coin,
          source,
          strict: Boolean(strict),
          ok: false,
          hasPosition: true,
          hasSl: false,
          reason: "NO_PROTECTION_SL_PLACE_FAILED",
          triggerCloid: triggerCtx?.cloid || null,
          triggerSide: triggerCtx?.side || null,
          positionSide,
          positionSize: Number(position?.size || 0),
          flattened: Boolean(flattened),
          latencyMs: Date.now() - startedAt,
        });
        return false;
      }
      state = mergeTpSlState(state, next);
      this.tpslByCoin.set(coin, state);
      this.storage.appendMetric({
        type: "ensure_protection_sl_ok",
        coin,
        source,
        slCloid: next?.slCloid || null,
        triggerCloid: triggerCtx?.cloid || null,
        triggerSide: triggerCtx?.side || null,
      });
    }

    if ((desired.tpPx !== null && desired.tpPx !== undefined) && !state?.tpCloid) {
      const nextTp = await this.#submitPositionTpSlOrders({
        coin,
        desired: {
          ...desired,
          slPx: null,
        },
      });
      if (nextTp?.tpCloid) {
        state = mergeTpSlState(state, nextTp);
        this.tpslByCoin.set(coin, state);
        this.storage.appendMetric({
          type: "ensure_protection_tp_ok",
          coin,
          source,
          tpCloid: nextTp?.tpCloid || null,
          triggerCloid: triggerCtx?.cloid || null,
          triggerSide: triggerCtx?.side || null,
        });
      } else {
        this.storage.appendError({
          where: "ensureProtection",
          coin,
          error: "TP_PLACE_FAILED_AFTER_SL",
          detail: {
            source,
          },
        });
        this.storage.appendMetric({
          type: "ensure_protection_tp_failed",
          coin,
          source,
          reason: "TP_PLACE_FAILED_AFTER_SL",
          triggerCloid: triggerCtx?.cloid || null,
          triggerSide: triggerCtx?.side || null,
        });
      }
    }
    this.tpslBlockedCoins.delete(coin);
    const finalState = this.tpslByCoin.get(coin) || {};
    const hasSl = Boolean(finalState?.slCloid);
    const donePayload = {
      type: "ensure_protection_done",
      coin,
      source,
      strict: Boolean(strict),
      ok: hasSl,
      hasPosition: true,
      hasSl,
      slCloid: finalState?.slCloid || null,
      tpCloid: finalState?.tpCloid || null,
      triggerCloid: triggerCtx?.cloid || null,
      triggerSide: triggerCtx?.side || null,
      positionSide,
      positionSize: Number(position?.size || 0),
      latencyMs: Date.now() - startedAt,
    };
    this.storage.appendMetric(donePayload);
    if (hasSl && Number(donePayload.latencyMs || 0) > 2000) {
      this.storage.appendMetric({
        type: "ensure_protection_slow",
        coin,
        source,
        latencyMs: Number(donePayload.latencyMs || 0),
        triggerCloid: triggerCtx?.cloid || null,
      });
    }
    return hasSl;
  }

  async #enforceTimeStopIfNeeded(position) {
    const coin = String(position?.coin || "");
    if (!coin) {
      return false;
    }
    const plan = this.positionProtectionPlansByCoin.get(coin);
    if (!plan || typeof plan !== "object") {
      return false;
    }
    const entryAt = Number(plan.entryAt || 0);
    const timeStopMs = Number(plan.timeStopMs || 0);
    if (!(entryAt > 0) || !(timeStopMs > 0)) {
      return false;
    }
    const now = Date.now();
    if ((now - entryAt) < timeStopMs) {
      return false;
    }
    const entryPx = Number(plan.entryPx || position?.entryPx || 0);
    const slPct = Number(plan.slPct || 0);
    if (!(entryPx > 0) || !(slPct > 0)) {
      return false;
    }
    const riskMovePx = entryPx * (slPct / 100);
    if (!(riskMovePx > 0)) {
      return false;
    }
    const markPx = Number(position?.markPx || this.marketData.mid(coin) || entryPx);
    const isLong = Number(position?.size || 0) > 0;
    const progressR = isLong
      ? ((markPx - entryPx) / riskMovePx)
      : ((entryPx - markPx) / riskMovePx);
    const needAtLeastR = Number(plan.timeStopProgressR || 0);
    if (progressR >= needAtLeastR) {
      return false;
    }
    const flattened = await this.#flattenSinglePosition(position, `time_stop:${coin}`);
    this.storage.appendMetric({
      type: "position_time_stop",
      coin,
      flattened: Boolean(flattened),
      progressR,
      thresholdR: needAtLeastR,
      elapsedMs: now - entryAt,
      limitMs: timeStopMs,
    });
    if (flattened) {
      this.pendingFlipByCoin.delete(coin);
    }
    return Boolean(flattened);
  }

  async #bootstrapManagedTpSlState() {
    if (!this.config.tpslEnabled) {
      return;
    }
    try {
      const rows = await this.client.fetchOpenOrders();
      let attached = 0;
      for (const row of rows) {
        const cloid = String(row?.cloid || "");
        const coin = String(row?.coin || row?.asset || "");
        if (!coin || !isManagedTpslCloid(cloid)) {
          continue;
        }
        const prev = this.tpslByCoin.get(coin) || {
          coin,
          side: null,
          size: 0,
          tpPx: null,
          slPx: null,
          tpCloid: null,
          slCloid: null,
          extraCloids: [],
          updatedAt: 0,
        };
        const expectedTp = makeManagedTpslCloid(coin, "tp");
        const expectedSl = makeManagedTpslCloid(coin, "sl");
        if (cloid === expectedTp) {
          prev.tpCloid = cloid;
        } else if (cloid === expectedSl) {
          prev.slCloid = cloid;
        }
        const extra = Array.isArray(prev.extraCloids) ? [...prev.extraCloids] : [];
        if (!extra.includes(cloid) && cloid !== prev.tpCloid && cloid !== prev.slCloid) {
          extra.push(cloid);
          attached += 1;
        }
        this.tpslByCoin.set(coin, {
          ...prev,
          extraCloids: extra.slice(-20),
        });
      }
      if (attached > 0) {
        this.logger.info("Bootstrapped managed TP/SL orders from openOrders", {
          attached,
          coins: Array.from(this.tpslByCoin.keys()),
        });
      }
    } catch (error) {
      this.logger.warn("Failed to bootstrap managed TP/SL state", { error: error.message });
    }
  }

  async #syncPositionTpSl() {
    if (!this.config.tpslEnabled) {
      return;
    }
    const tpBps = Number(this.config.tpslTakeProfitBps || 0);
    const slBps = Number(this.config.tpslStopLossBps || 0);
    if (!(tpBps > 0) && !(slBps > 0)) {
      return;
    }

    const positions = summarizeOpenPositions(this.lastUserState || {});
    const byCoin = new Map();
    for (const pos of positions) {
      const coin = String(pos?.coin || "");
      if (!coin) {
        continue;
      }
      if (Math.abs(Number(pos?.size || 0)) <= 0) {
        continue;
      }
      byCoin.set(coin, pos);
    }

    for (const [coin] of this.tpslByCoin.entries()) {
      if (byCoin.has(coin)) {
        continue;
      }
      const cancelResult = await this.#cancelTpSlForCoin(coin, "tpsl_position_closed");
      if (cancelResult?.allCanceled) {
        this.tpslByCoin.delete(coin);
      }
      this.positionProtectionPlansByCoin.delete(coin);
      this.pendingFlipByCoin.delete(coin);
    }

    for (const [coin, position] of byCoin.entries()) {
      const timedOut = await this.#enforceTimeStopIfNeeded(position);
      if (timedOut) {
        continue;
      }
      const protectedOk = await this.#ensureProtectionForCoin(coin, {
        source: "sync_precheck",
        strict: true,
      });
      if (!protectedOk) {
        continue;
      }
      const desired = this.#buildDesiredTpSlForPosition(position);
      if (!desired) {
        await this.#handleTpSlUnavailable(position, "tpsl_plan_unavailable");
        continue;
      }
      const current = this.tpslByCoin.get(coin) || null;
      if (!this.#shouldRefreshTpSl(current, desired)) {
        continue;
      }

      const now = Date.now();
      const cooldownMs = Math.max(0, Number(this.config.tpslRefreshCooldownMs || 15000));
      const lastAttempt = Number(this.tpslLastAttemptAtByCoin.get(coin) || 0);
      const urgentSizeChange = isUrgentTpSlSizeChange({
        currentSize: Number(current?.size || 0),
        desiredSize: Number(desired.size || 0),
        szDecimals: Number(desired?.meta?.szDecimals || 0),
        referencePx: Number(desired.referencePx || 0),
        minNotionalUsd: Number(this.config.tradeMinNotionalUsd || 0),
      });
      if (!urgentSizeChange && lastAttempt > 0 && (now - lastAttempt) < cooldownMs) {
        this.storage.appendMetric({
          type: "tpsl_refresh_cooldown_skip",
          coin,
          cooldownMs,
          elapsedMs: now - lastAttempt,
        });
        continue;
      }
      if (urgentSizeChange && lastAttempt > 0 && (now - lastAttempt) < cooldownMs) {
        this.storage.appendMetric({
          type: "tpsl_refresh_cooldown_bypass_size_change",
          coin,
          cooldownMs,
          elapsedMs: now - lastAttempt,
        });
      }
      this.tpslLastAttemptAtByCoin.set(coin, now);

      if (current) {
        const cancelResult = await this.#cancelTpSlForCoin(coin, "tpsl_refresh");
        if (!cancelResult?.allCanceled) {
          this.storage.appendMetric({
            type: "tpsl_refresh_skip_cancel_incomplete",
            coin,
            failedCount: cancelResult?.failedCount || 0,
          });
          continue;
        }
      }

      const next = await this.#submitPositionTpSlOrders({
        coin,
        desired,
      });

      if (next && (next.tpCloid || next.slCloid)) {
        this.tpslBlockedCoins.delete(coin);
        this.tpslByCoin.set(coin, next);
      } else {
        this.tpslByCoin.delete(coin);
        await this.#handleTpSlUnavailable(position, "tpsl_submit_unavailable");
      }
    }
  }

  #buildDesiredTpSlForPosition(position) {
    const coin = String(position?.coin || "");
    const meta = this.assetMetaByCoin.get(coin);
    const asset = this.assetsByCoin.get(coin);
    const activePlan = this.positionProtectionPlansByCoin.get(coin) || null;
    if (!meta || asset === undefined) {
      return null;
    }

    const rawSize = Math.abs(Number(position?.size || 0));
    const lotStep = 1 / (10 ** Math.max(0, Number(meta.szDecimals || 0)));
    const size = roundToStep(rawSize, lotStep, "floor");
    if (!(size > 0)) {
      this.storage.appendMetric({
        type: "tpsl_skip_min_size",
        coin,
        rawSize,
        roundedSize: size,
        lotStep,
      });
      return null;
    }

    const plannedEntryPx = Number(activePlan?.entryPx || 0);
    const entryPx = plannedEntryPx > 0 ? plannedEntryPx : Number(position?.entryPx || 0);
    const markPx = Number(position?.markPx || 0);
    let referencePx = entryPx;
    let referenceSource = "entryPx";
    if (entryPx > 0) {
      this.tpslEntryFallbackStreakByCoin.set(coin, 0);
    }
    if (!(referencePx > 0)) {
      referencePx = markPx;
      referenceSource = "markPx_fallback";
      const streak = Number(this.tpslEntryFallbackStreakByCoin.get(coin) || 0) + 1;
      this.tpslEntryFallbackStreakByCoin.set(coin, streak);
      this.storage.appendMetric({
        type: "tpsl_entry_fallback",
        coin,
        reason: referenceSource,
        streak,
        entryPx,
        markPx,
      });
      this.logger.warn("TP/SL entry price missing; using markPx fallback", {
        coin,
        streak,
      });
      if (streak > 1) {
        this.storage.appendError({
          where: "tpsl_plan",
          coin,
          error: "entry_price_missing_repeat_fallback_block",
          detail: {
            streak,
            entryPx,
            markPx,
          },
        });
        return null;
      }
    }
    if (!(referencePx > 0)) {
      this.storage.appendError({
        where: "tpsl_plan",
        coin,
        error: "reference_price_missing",
        detail: {
          entryPx,
          markPx,
        },
      });
      return null;
    }

    const minNotional = Number(this.config.tradeMinNotionalUsd || 0);
    if (minNotional > 0 && (size * referencePx) < minNotional) {
      this.storage.appendMetric({
        type: "tpsl_skip_min_notional",
        coin,
        size,
        referencePx,
        notional: size * referencePx,
        minNotional,
      });
      return null;
    }

    const tpBps = Number(activePlan?.tpPct || 0) > 0
      ? Number(activePlan.tpPct) * 100
      : Number(this.config.tpslTakeProfitBps || 0);
    const slBps = Number(activePlan?.slPct || 0) > 0
      ? Number(activePlan.slPct) * 100
      : Number(this.config.tpslStopLossBps || 0);
    if (!(tpBps > 0) && !(slBps > 0)) {
      return null;
    }

    const computed = computeTpSlTriggerPrices({
      entryPx: referencePx,
      positionSize: Number(position?.size || 0),
      tpBps,
      slBps,
    });
    const closeSide = computed.closeSide;
    const tpRaw = computed.tpRaw;
    const slRaw = computed.slRaw;
    if (!closeSide) {
      return null;
    }

    const tpPlan = tpRaw !== null
      ? normalizePriceForAsset({
        requestedPrice: tpRaw,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "nearest",
      })
      : null;
    const slPlan = slRaw !== null
      ? normalizePriceForAsset({
        requestedPrice: slRaw,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "nearest",
      })
      : null;
    const bounded = enforceTpSlBounds({
      closeSide,
      tpPx: tpPlan ? Number(tpPlan.price) : null,
      slPx: slPlan ? Number(slPlan.price) : null,
      entryPx,
      markPx,
      referencePx,
      meta,
    });
    if (!bounded.ok) {
      this.storage.appendError({
        where: "tpsl_plan",
        coin,
        error: bounded.reason || "tpsl_bounds_invalid",
        detail: bounded.detail || null,
      });
      return null;
    }

    return {
      coin,
      asset,
      closeSide,
      size: trimToDecimals(size, Math.max(0, Number(meta.szDecimals || 0))),
      tpPx: bounded.tpPx,
      slPx: bounded.slPx,
      referencePx,
      referenceSource,
      meta,
    };
  }

  #shouldRefreshTpSl(current, desired) {
    return shouldRefreshTpSlState(current, desired);
  }

  async #cancelTpSlForCoin(coin, reason = "tpsl_cancel") {
    const state = this.tpslByCoin.get(coin);
    if (!state) {
      return { allCanceled: true, canceledCount: 0, failedCount: 0 };
    }
    const cloids = Array.from(new Set([
      state.tpCloid,
      state.slCloid,
      ...(Array.isArray(state.extraCloids) ? state.extraCloids : []),
    ].filter(Boolean)));
    if (!cloids.length) {
      return { allCanceled: true, canceledCount: 0, failedCount: 0 };
    }

    const asset = this.assetsByCoin.get(coin);
    if (asset === undefined) {
      return { allCanceled: false, canceledCount: 0, failedCount: cloids.length };
    }

    const canceledCloids = new Set();
    const failedCloids = new Set();
    for (let i = 0; i < cloids.length; i += 10) {
      const chunk = cloids.slice(i, i + 10).map((cloid) => ({ asset, cloid }));
      try {
        await this.#cancelByCloid(chunk, reason);
        for (const item of chunk) {
          canceledCloids.add(item.cloid);
        }
      } catch (error) {
        this.logger.warn("TP/SL cancelByCloid chunk failed", {
          coin,
          reason,
          error: error.message,
        });
        for (const item of chunk) {
          failedCloids.add(item.cloid);
        }
      }
    }

    for (const cloid of canceledCloids) {
      const ctx = this.orderContextsByCloid.get(cloid);
      this.openOrders.delete(cloid);
      this.orderContextsByCloid.delete(cloid);
      if (ctx?.oid !== undefined && ctx?.oid !== null) {
        this.orderContextsByOid.delete(String(ctx.oid));
      }
    }

    if (failedCloids.size > 0) {
      const remaining = new Set([...failedCloids]);
      const nextState = {
        ...state,
        tpCloid: remaining.has(state.tpCloid) ? state.tpCloid : null,
        slCloid: remaining.has(state.slCloid) ? state.slCloid : null,
        extraCloids: (Array.isArray(state.extraCloids) ? state.extraCloids : []).filter((cloid) => remaining.has(cloid)),
        updatedAt: Date.now(),
      };
      this.tpslByCoin.set(coin, nextState);
      this.storage.appendError({
        where: "tpsl_cancel",
        coin,
        error: "cancel_retry_pending",
        detail: {
          reason,
          failedCount: failedCloids.size,
        },
      });
    }
    this.storage.appendMetric({
      type: "tpsl_cancelled",
      coin,
      reason,
      count: canceledCloids.size,
      failedCount: failedCloids.size,
    });
    return {
      allCanceled: failedCloids.size === 0,
      canceledCount: canceledCloids.size,
      failedCount: failedCloids.size,
    };
  }

  async #cleanupManagedTpSlOrders(reason = "tpsl_cleanup") {
    if (!this.config.tpslEnabled) {
      return;
    }
    await this.#bootstrapManagedTpSlState();
    for (const [coin] of this.tpslByCoin.entries()) {
      const cancelResult = await this.#cancelTpSlForCoin(coin, reason);
      if (cancelResult?.allCanceled) {
        this.tpslByCoin.delete(coin);
      }
    }
  }

  async #handleTpSlUnavailable(position, reason) {
    const coin = String(position?.coin || "");
    if (!coin) {
      return;
    }
    const now = Date.now();
    const blockMs = 10 * 60 * 1000;
    const blockedUntil = Math.max(Number(this.tpslBlockedCoins.get(coin) || 0), now + blockMs);
    this.tpslBlockedCoins.set(coin, blockedUntil);
    this.storage.appendMetric({
      type: "tpsl_coin_blocked",
      coin,
      reason,
      blockedUntil,
    });
    const lastEmergencyFlatten = Number(this.tpslLastEmergencyFlattenAtByCoin.get(coin) || 0);
    const emergencyCooldownMs = 5000;
    if (lastEmergencyFlatten > 0 && (now - lastEmergencyFlatten) < emergencyCooldownMs) {
      this.storage.appendMetric({
        type: "tpsl_emergency_flatten_cooldown_skip",
        coin,
        reason,
        elapsedMs: now - lastEmergencyFlatten,
      });
      return;
    }
    this.tpslLastEmergencyFlattenAtByCoin.set(coin, now);
    await this.#flattenSinglePosition(position, `tpsl_unavailable:${reason}`);
  }

  async #flattenSinglePosition(pos, reasonTag = "tpsl_unavailable") {
    const coin = String(pos?.coin || "");
    const asset = this.assetsByCoin.get(coin);
    const size = Math.abs(Number(pos?.size || 0));
    if (asset === undefined || !(size > 0)) {
      return false;
    }
    const side = Number(pos?.size || 0) > 0 ? "sell" : "buy";
    const book = this.marketData.lastBook(coin);
    const fallbackPx = Number(pos?.entryPx || this.marketData.mid(coin) || 0);
    const slip = (this.config.maxSlippageBps / 10000) * 2;
    const px = side === "buy"
      ? Number(book?.bestAsk || fallbackPx) * (1 + slip)
      : Number(book?.bestBid || fallbackPx) * (1 - slip);

    const normalized = this.#normalizeSignalForExchange({
      coin,
      side,
      sz: size,
      limitPx: Math.max(0, px),
      tif: "Ioc",
      reduceOnly: true,
      postOnly: false,
    });
    const signal = normalized.signal;
    if (!(Number(signal.sz || 0) > 0) || !(Number(signal.limitPx || 0) > 0)) {
      return false;
    }
    const order = {
      asset,
      isBuy: signal.side === "buy",
      limitPx: signal.limitPx,
      sz: signal.sz,
      reduceOnly: true,
      orderType: { limit: { tif: "Ioc" } },
      cloid: makeCloid(),
    };
    this.storage.appendMetric({
      type: "flatten_request",
      coin,
      side,
      size: Number(signal.sz || 0),
      limitPx: Number(signal.limitPx || 0),
      reasonTag,
      cloid: order.cloid,
    });
    const orderWire = toOrderWire(order);
    const meta = this.assetMetaByCoin.get(coin);
    const preflight = validatePerpOrderWire({
      px: orderWire.p,
      sz: orderWire.s,
      szDecimals: meta?.szDecimals ?? 0,
    });
    if (!preflight.ok) {
      this.storage.appendError({
        where: "tpsl_emergency_flatten_preflight",
        coin,
        error: `preflight_${preflight.reason}`,
        detail: preflight.detail,
      });
      return false;
    }

    this.budgetManager.noteOrderSubmitted();
    const sentAt = Date.now();
    const res = await this.client.postExchangeAction(makeOrderAction([orderWire]), {
      tag: reasonTag,
    });
    const outcome = parseOrderResponse(res.response);
    const submitted = !outcome.error && (Boolean(outcome.filled) || Boolean(outcome.resting) || Boolean(outcome.oid));
    this.rollups.recordOrderResult({
      coin,
      submitted: submitted ? 1 : 0,
      rejected: submitted ? 0 : 1,
      canceled: 0,
      ts: sentAt,
    });
    this.storage.appendOrderEvent({
      type: "tpsl_emergency_flatten",
      coin,
      cloid: order.cloid,
      side,
      size: signal.sz,
      limitPx: signal.limitPx,
      response: outcome,
      raw: res.response,
      reason: reasonTag,
      reduceOnly: true,
    });
    this.storage.appendMetric({
      type: "flatten_result",
      coin,
      side,
      cloid: order.cloid,
      submitted: Boolean(submitted),
      reasonTag,
      error: outcome.error || null,
    });
    if (!submitted) {
      this.storage.appendError({
        where: "tpsl_emergency_flatten",
        coin,
        error: outcome.error || "unknown",
      });
    }
    return submitted;
  }

  async #submitPositionTpSlOrders({ coin, desired }) {
    const plans = buildTpSlOrderRequests({
      coin,
      desired,
      isMarket: Boolean(this.config.tpslIsMarket),
    });
    if (!plans.length) {
      return null;
    }

    const preflightWires = [];
    for (const plan of plans) {
      let order = { ...plan.order };
      let orderWire = toOrderWire(order);
      let preflight = validatePerpOrderWire({
        px: orderWire.p,
        sz: orderWire.s,
        triggerPx: orderWire?.t?.trigger?.triggerPx,
        szDecimals: desired.meta.szDecimals,
      });
      let normalizedPx = null;
      let preflightRetried = false;

      if (!preflight.ok && String(preflight.reason || "").includes("price")) {
        const normalized = normalizePerpPriceForWire({
          px: orderWire?.t?.trigger?.triggerPx ?? orderWire.p,
          szDecimals: desired.meta.szDecimals,
          mode: "nearest",
        });
        if (normalized.ok && normalized.normalized) {
          normalizedPx = normalized.normalized;
          preflightRetried = true;
          order = {
            ...order,
            limitPx: Number(normalized.normalized),
            orderType: {
              trigger: {
                ...(order?.orderType?.trigger || {}),
                triggerPx: Number(normalized.normalized),
              },
            },
          };
          orderWire = toOrderWire(order);
          preflight = validatePerpOrderWire({
            px: orderWire.p,
            sz: orderWire.s,
            triggerPx: orderWire?.t?.trigger?.triggerPx,
            szDecimals: desired.meta.szDecimals,
          });
        }
      }

      if (!preflight.ok) {
        const errorCode = `preflight_${preflight.reason}`;
        this.storage.appendMetric({
          type: "tpsl_preflight_reject",
          coin,
          tpsl: plan.tpsl,
          orderWire,
          preflightRetried,
          normalizedPx,
          preflight,
        });
        this.storage.appendError({
          where: "tpsl_preflight",
          coin,
          tpsl: plan.tpsl,
          error: errorCode,
          status: "blocked_preflight",
          detail: {
            ...preflight.detail,
            side: desired.closeSide,
            rawPx: String(plan.triggerPx),
            normalizedPx,
            decimals: countDecimalPlaces(orderWire?.t?.trigger?.triggerPx ?? orderWire.p),
            sigfig: countSignificantFigures(orderWire?.t?.trigger?.triggerPx ?? orderWire.p),
            szDecimals: desired.meta.szDecimals,
            priceDecimals: desired.meta.priceDecimals,
          },
        });
        return null;
      }
      preflightWires.push({
        plan: {
          ...plan,
          triggerPx: Number(orderWire?.t?.trigger?.triggerPx ?? plan.triggerPx),
          order,
        },
        orderWire,
      });
    }

    const intent = {
      kind: "tpsl_bundle",
      coin,
      side: desired.closeSide,
      sz: Number(desired.size),
      tpTriggerPx: plans.find((x) => x.tpsl === "tp")?.triggerPx || null,
      slTriggerPx: plans.find((x) => x.tpsl === "sl")?.triggerPx || null,
      isMarket: Boolean(this.config.tpslIsMarket),
    };
    const duplicate = this.idempotency.seen(intent);
    if (duplicate && Date.now() - Number(duplicate.submittedAt || 0) < 10000) {
      return null;
    }
    const key = this.idempotency.markSubmitted(intent, {
      cloids: plans.map((x) => x.cloid),
    });

    const sentAt = Date.now();
    this.budgetManager.noteOrderSubmitted(preflightWires.length);
    const action = makeOrderAction(preflightWires.map((x) => x.orderWire), "positionTpsl");
    const result = await this.client.postExchangeAction(action, {
      tag: `tpsl:${coin}:bundle`,
    });
    const outcomes = parseOrderResponses(result.response, preflightWires.length);
    this.idempotency.markResultByKey(key, {
      status: result?.response?.status || null,
      statuses: outcomes.map((x) => x.rawStatus),
      error: outcomes.find((x) => x.error)?.error || null,
    });

    const submittedMap = {
      tp: null,
      sl: null,
    };

    for (let i = 0; i < preflightWires.length; i += 1) {
      const { plan } = preflightWires[i];
      const outcome = outcomes[i] || {};
      const submitted = Boolean(outcome.waitingForTrigger)
        || (!outcome.error && (Boolean(outcome.oid) || Boolean(outcome.resting) || Boolean(outcome.filled)));
      this.rollups.recordOrderResult({
        coin,
        submitted: submitted ? 1 : 0,
        rejected: submitted ? 0 : 1,
        canceled: 0,
        ts: sentAt,
      });

      this.storage.appendOrderEvent({
        type: "tpsl_submit",
        coin,
        tpsl: plan.tpsl,
        cloid: plan.cloid,
        triggerPx: Number(plan.triggerPx),
        size: Number(desired.size),
        response: outcome,
        raw: result.response,
      });

      if (!submitted) {
        this.storage.appendError({
          where: "tpsl_submit",
          coin,
          error: outcome.error || "unknown",
          tpsl: plan.tpsl,
        });
        continue;
      }

      const context = {
        cloid: plan.cloid,
        oid: outcome.oid,
        coin,
        asset: desired.asset,
        armId: "tpsl",
        strategy: "tpsl",
        regime: "protective",
        side: desired.closeSide,
        tif: "Trigger",
        reduceOnly: true,
        postOnly: false,
        expectedPx: Number(plan.triggerPx),
        size: Number(desired.size),
        sentAt,
        explanation: {
          style: "position_tpsl",
          tpsl: plan.tpsl,
        },
      };
      this.orderContextsByCloid.set(plan.cloid, context);
      if (outcome.oid) {
        this.orderContextsByOid.set(String(outcome.oid), context);
      }
      if (outcome.resting || outcome.waitingForTrigger) {
        this.openOrders.set(plan.cloid, {
          cloid: plan.cloid,
          asset: desired.asset,
          coin,
          side: desired.closeSide,
          sideKey: `tpsl:${coin}:${plan.tpsl}`,
          strategy: "tpsl",
          regime: "protective",
          createdAt: sentAt,
          oid: outcome.oid || null,
        });
      }
      submittedMap[plan.tpsl] = {
        cloid: plan.cloid,
        oid: outcome.oid,
      };
    }

    const requiresPair = plans.some((x) => x.tpsl === "tp") && plans.some((x) => x.tpsl === "sl");
    if (requiresPair && (!submittedMap.tp || !submittedMap.sl)) {
      const cleanup = [submittedMap.tp?.cloid, submittedMap.sl?.cloid].filter(Boolean);
      if (cleanup.length) {
        const asset = this.assetsByCoin.get(coin);
        if (asset !== undefined) {
          await this.#cancelByCloid(cleanup.map((cloid) => ({ asset, cloid })), "tpsl_partial_cleanup");
        }
        for (const cloid of cleanup) {
          const ctx = this.orderContextsByCloid.get(cloid);
          this.openOrders.delete(cloid);
          this.orderContextsByCloid.delete(cloid);
          if (ctx?.oid !== undefined && ctx?.oid !== null) {
            this.orderContextsByOid.delete(String(ctx.oid));
          }
        }
      }
      this.storage.appendError({
        where: "tpsl_submit",
        coin,
        error: "partial_bundle_rejected",
      });
      return null;
    }

    this.logger.info("TP/SL orders submitted", {
      coin,
      grouping: "positionTpsl",
      size: Number(desired.size),
      tp: submittedMap.tp ? {
        cloid: submittedMap.tp.cloid,
        triggerPx: Number(desired.tpPx),
      } : null,
      sl: submittedMap.sl ? {
        cloid: submittedMap.sl.cloid,
        triggerPx: Number(desired.slPx),
      } : null,
    });

    return {
      coin,
      side: desired.closeSide,
      size: desired.size,
      referencePx: desired.referencePx,
      referenceSource: desired.referenceSource,
      tpPx: desired.tpPx,
      slPx: desired.slPx,
      tpCloid: submittedMap.tp?.cloid || null,
      slCloid: submittedMap.sl?.cloid || null,
      extraCloids: [],
      updatedAt: Date.now(),
    };
  }

  #rejectionHint(code) {
    if (code === "invalid_price" || code === "tick_or_lot_size" || code === "invalid_size") {
      return "Check price/size quantization from meta.szDecimals";
    }
    if (code === "min_notional") {
      return "Increase TRADE_MIN_NOTIONAL_USD or account size";
    }
    if (code === "bad_alo_px") {
      return "Use post-only outside touch or fallback IOC";
    }
    if (code === "vault_not_registered") {
      return "Clear HYPERLIQUID_VAULT_ADDRESS unless using registered vault";
    }
    return "Inspect raw_http exchange response for details";
  }

  #resolveOrderContext(fill) {
    const cloid = fill.cloid || fill.clientOrderId || null;
    const oid = fill.oid || fill.orderId || null;

    if (cloid && this.orderContextsByCloid.has(cloid)) {
      return this.orderContextsByCloid.get(cloid);
    }

    if (oid && this.orderContextsByOid.has(String(oid))) {
      return this.orderContextsByOid.get(String(oid));
    }

    return null;
  }

  #coinByAsset(asset) {
    const target = Number(asset);
    for (const [coin, idx] of this.assetsByCoin.entries()) {
      if (Number(idx) === target) {
        return coin;
      }
    }
    return null;
  }

  async #cancelByCloid(cancels, reason = "cancel") {
    if (!cancels.length) {
      return;
    }
    this.budgetManager.noteCancelSubmitted(cancels.length);
    const action = makeCancelByCloidAction(cancels);
    const res = await this.client.postExchangeAction(action, { tag: reason });
    for (const cancel of cancels) {
      const coin = this.#coinByAsset(cancel.asset);
      if (coin) {
        this.rollups.recordOrderResult({
          coin,
          submitted: 0,
          rejected: 0,
          canceled: 1,
          ts: Date.now(),
        });
      }
    }
    this.storage.appendOrderEvent({
      type: "cancelByCloid",
      reason,
      cancels,
      raw: res.response,
    });
  }

  async cancelAllOpenOrders() {
    const local = Array.from(this.openOrders.values());
    if (local.length) {
      const cancels = local.map((o) => ({ asset: o.asset, cloid: o.cloid }));
      for (let i = 0; i < cancels.length; i += 10) {
        await this.#cancelByCloid(cancels.slice(i, i + 10), "shutdown_local");
      }
      for (const row of local) {
        if (this.orderTtlTimers.has(row.cloid)) {
          clearTimeout(this.orderTtlTimers.get(row.cloid));
          this.orderTtlTimers.delete(row.cloid);
        }
      }
      this.openOrders.clear();
      this.logger.info("Canceled locally tracked open orders", { count: local.length });
    }

    try {
      const rows = await this.client.fetchOpenOrders();
      const cancelsByOid = [];
      for (const row of rows) {
        const coin = row.coin || row.asset;
        const asset = this.assetsByCoin.get(coin);
        const oid = safeNumber(row.oid, null);
        if (asset !== undefined && oid !== null) {
          cancelsByOid.push({ asset, oid });
        }
      }

      if (cancelsByOid.length) {
        for (let i = 0; i < cancelsByOid.length; i += 10) {
          const chunk = cancelsByOid.slice(i, i + 10);
          this.budgetManager.noteCancelSubmitted(chunk.length);
          const action = makeCancelAction(chunk);
          const res = await this.client.postExchangeAction(action, { tag: "shutdown_api" });
          for (const cancel of chunk) {
            const coin = this.#coinByAsset(cancel.asset);
            if (coin) {
              this.rollups.recordOrderResult({
                coin,
                submitted: 0,
                rejected: 0,
                canceled: 1,
                ts: Date.now(),
              });
            }
          }
          this.storage.appendOrderEvent({
            type: "cancelByOid",
            cancels: chunk,
            raw: res.response,
          });
        }
        this.logger.info("Canceled open orders fetched from API", { count: cancelsByOid.length });
      }
    } catch (error) {
      this.logger.warn("Failed to cancel API-reported open orders", { error: error.message });
      this.storage.appendError({
        where: "cancelAllOpenOrders",
        error: error.message,
      });
    }
  }

  async #runReportingLoop() {
    const now = Date.now();

    const report = generateReport({
      storage: this.storage,
      budgetSnapshot: this.budgetManager.snapshot(),
      windowMs: 24 * 3600 * 1000,
    });
    saveReport(this.storage, report, "periodic");
    const improvements = generateTopImprovements(report);
    this.storage.appendImprovement({
      source: "periodic_report",
      improvements,
      summary: report.summary,
    });
    this.lastReportAt = now;

    this.logger.info("Periodic report", {
      summary: report.summary,
      stability: report.stability,
    });

    if (report?.stability?.overall === "fail") {
      this.storage.appendMetric({
        type: "stability_fail",
        stability: report.stability,
      });
      this.logger.error("Stability gate failed", {
        action: this.config.stabilityFailAction,
        violations: report.stability.violations,
      });
      if (this.config.stabilityFailAction === "shutdown") {
        const reason = (report.stability.violations || []).join("; ").slice(0, 240) || "unknown";
        await this.requestShutdown(`stability_fail:${reason}`);
        return;
      }
    } else if (report?.stability?.overall === "warn") {
      this.storage.appendMetric({
        type: "stability_warn",
        stability: report.stability,
      });
      this.logger.warn("Stability gate warning", {
        metrics: (report.stability.metrics || []).filter((m) => m.status === "warn").map((m) => m.key),
      });
    }

    if (!this.gptAdvisor?.isEnabled()) {
      return;
    }

    if (now - this.lastGptReportAt < this.config.gptReportIntervalMs) {
      return;
    }

    let proposal;
    try {
      proposal = await this.gptAdvisor.generateProposal({
        report,
        arms: defaultArms(),
      });
    } catch (error) {
      const message = String(error?.message || "");
      const gptBudgetLikely = /budget|max call|max cost|max token|daily token|openai/i.test(message);
      if (gptBudgetLikely && this.config.openaiBudgetExceededAction === "disable") {
        this.logger.warn("Disabling GPT due to budget limit", { error: message });
        this.config.gptEnabled = false;
        this.storage.appendMetric({
          type: "gpt_disabled_due_to_budget",
          error: message,
        });
        return;
      }
      throw error;
    }

    this.storage.appendReport({
      tag: "gpt_proposal",
      proposal,
    });

    if (proposal?.proposal?.coinActions?.length) {
      const applied = [];
      for (const action of proposal.proposal.coinActions) {
        if (!this.assetsByCoin.has(action.coin)) {
          continue;
        }
        if (!this.tradeUniverseCoins.includes(action.coin)) {
          continue;
        }
        const result = this.coinSelector.applyCoinAction({
          action: action.action,
          coin: action.coin,
        });
        if (result.applied) {
          applied.push(result);
        }
      }
      if (applied.length) {
        this.storage.appendMetric({
          type: "gpt_coin_actions_applied",
          applied,
        });
      }
    }

    if (proposal?.proposal?.stop?.suggest) {
      await this.requestShutdown(`gpt_stop_suggestion:${proposal?.proposal?.stop?.reason || "unspecified"}`);
      return;
    }

    if (proposal?.proposal?.changes?.length) {
      const started = this.improvement.startCanary(proposal.proposal, this.cycleCounter);
      this.storage.appendMetric({
        type: "gpt_canary_start_attempt",
        started,
        cycle: this.cycleCounter,
        changes: proposal.proposal.changes,
      });
    }

    this.lastGptReportAt = now;
  }

  async #persistState() {
    const runtimeState = {
      lastFillCursor: this.lastFillCursor,
      openOrders: Array.from(this.openOrders.values()),
      orderContextsByCloid: Array.from(this.orderContextsByCloid.values()).slice(-3000),
      orderContextsByOid: Array.from(this.orderContextsByOid.entries()).map(([oid, ctx]) => ({ oid, ...ctx })).slice(-3000),
      tpslByCoin: Array.from(this.tpslByCoin.values()),
      tpslEntryFallbackStreakByCoin: Array.from(this.tpslEntryFallbackStreakByCoin.entries()).map(([coin, streak]) => ({ coin, streak })),
      tpslLastAttemptAtByCoin: Array.from(this.tpslLastAttemptAtByCoin.entries()).map(([coin, ts]) => ({ coin, ts })),
      tpslLastEmergencyFlattenAtByCoin: Array.from(this.tpslLastEmergencyFlattenAtByCoin.entries()).map(([coin, ts]) => ({ coin, ts })),
      tpslBlockedCoins: Array.from(this.tpslBlockedCoins.entries()).map(([coin, until]) => ({ coin, until })),
      strategyBlockedCoins: Array.from(this.strategyBlockedCoins.entries()).map(([coin, row]) => ({
        coin,
        until: Number(row?.until || 0),
        reason: String(row?.reason || ""),
        dayKey: String(row?.dayKey || ""),
      })),
      positionProtectionPlansByCoin: Array.from(this.positionProtectionPlansByCoin.values()),
      lastEntryContextByCoin: Array.from(this.lastEntryContextByCoin.values()),
      lastEntrySnapshotByCoin: Array.from(this.lastEntrySnapshotByCoin.values()),
      lastOpenPositionsByCoin: Array.from(this.lastOpenPositionsByCoin.values()),
      pendingFlipByCoin: Array.from(this.pendingFlipByCoin.values()),
      recentFlipCompletedByCoin: Array.from(this.recentFlipCompletedByCoin.values()),
      globalNoTradeReason: this.globalNoTradeReason,
      cycleCounter: this.cycleCounter,
      pendingRewardContext: this.pendingRewardContext,
      lastTotals: this.lastTotals,
      lastUnrealized: this.lastUnrealized,
      lastReportAt: this.lastReportAt,
      lastGptReportAt: this.lastGptReportAt,
      lastLifecycleAt: this.lastLifecycleAt,
      selectedCoins: this.selectedCoins,
      riskSnapshot: this.riskSnapshot,
      savedAt: new Date().toISOString(),
    };

    this.storage.saveState("runtime-state", runtimeState);
    this.storage.saveState("bandit-state", this.bandit.snapshot());
    this.storage.saveState("feedback-state", this.feedback.snapshot());
    this.storage.saveState("idempotency-state", this.idempotency.snapshot());
    this.storage.saveState("improvement-state", this.improvement.snapshot());
    this.storage.saveState("coin-selector-state", this.coinSelector.snapshot());
    this.budgetManager.save();
  }

  #logRecentExchangeErrors() {
    const rows = this.storage.readStream("raw_http", { maxLines: 5000 });
    const recent = rows
      .filter((r) => String(r.label || "").startsWith("exchange:"))
      .slice(-200)
      .map((r) => ({ row: r, error: extractExchangeError(r) }))
      .filter((x) => Boolean(x.error));

    if (!recent.length) {
      return;
    }

    const latest = recent[recent.length - 1];
    const cause = redactSensitiveText(latest.error);
    this.logger.warn("Recent exchange rejection detected from raw_http", {
      label: latest.row.label,
      cause,
      classified: classifyExchangeError(cause),
    });
  }

  #logNextSteps() {
    this.logger.info("NEXT_STEPS", {
      priority1_execution_quality: "Add expected_fill_prob gate and switch Alo/IOC by short-term impact estimate",
      priority2_learning: "Use regime-level adaptive exploration (lower UCB exploration when reward variance spikes)",
      priority3_operations: "Use dedicated Agent Wallet for production and set HYPERLIQUID_REQUIRE_AGENT_WALLET=true",
      priority4_debugging: "Add exchange_error_code index stream derived from raw_http for fast reject root-cause search",
    });
  }

  #isCoinBlockedForTrading(coin) {
    const guard = this.strategyBlockedCoins.get(String(coin));
    if (guard && Number(guard.until || 0) > 0) {
      if (Date.now() < Number(guard.until)) {
        return true;
      }
      this.strategyBlockedCoins.delete(String(coin));
    }
    const until = Number(this.tpslBlockedCoins.get(coin) || 0);
    if (!(until > 0)) {
      return false;
    }
    if (Date.now() >= until) {
      this.tpslBlockedCoins.delete(coin);
      return false;
    }
    return true;
  }
}

function parseOrderResponse(response) {
  return parseOrderResponses(response, 1)[0] || {
    oid: null,
    resting: null,
    filled: null,
    error: extractResponseError(response),
    status: response?.status || null,
    rawStatus: null,
    waitingForTrigger: false,
  };
}

function parseOrderResponses(response, expectedCount = 1) {
  const statuses = response?.response?.data?.statuses || response?.data?.statuses || [];
  const count = Math.max(1, Number(expectedCount) || 1);
  const responseError = extractResponseError(response);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const status = statuses[i] ?? {};
    const waitingForTrigger = String(status || "").toLowerCase() === "waitingfortrigger";
    const statusObj = status && typeof status === "object" ? status : {};
    let error = statusObj.error || null;
    if (!error && String(response?.status || "").toLowerCase() === "err" && !waitingForTrigger) {
      error = responseError || "exchange_error";
    }
    out.push({
      oid: statusObj?.resting?.oid || statusObj?.filled?.oid || null,
      resting: statusObj?.resting || null,
      filled: statusObj?.filled || null,
      error,
      status: response?.status || null,
      rawStatus: status,
      waitingForTrigger,
    });
  }
  return out;
}

function mergeTpSlState(current, next) {
  const base = current && typeof current === "object" ? current : {};
  const incoming = next && typeof next === "object" ? next : {};
  return {
    coin: incoming.coin || base.coin || null,
    side: incoming.side || base.side || null,
    size: Number(incoming.size ?? base.size ?? 0),
    referencePx: Number(incoming.referencePx ?? base.referencePx ?? 0),
    referenceSource: incoming.referenceSource || base.referenceSource || null,
    tpPx: incoming.tpPx ?? base.tpPx ?? null,
    slPx: incoming.slPx ?? base.slPx ?? null,
    tpCloid: incoming.tpCloid || base.tpCloid || null,
    slCloid: incoming.slCloid || base.slCloid || null,
    extraCloids: Array.isArray(incoming.extraCloids)
      ? incoming.extraCloids
      : (Array.isArray(base.extraCloids) ? base.extraCloids : []),
    updatedAt: Date.now(),
  };
}

function extractResponseError(response) {
  if (typeof response?.error === "string" && response.error) {
    return response.error;
  }
  if (String(response?.status || "").toLowerCase() === "err") {
    if (typeof response?.response === "string") {
      return response.response;
    }
    if (typeof response?.response?.error === "string") {
      return response.response.error;
    }
    if (typeof response?.message === "string") {
      return response.message;
    }
    return JSON.stringify(response?.response || response);
  }
  return null;
}

export function computeTpSlTriggerPrices({
  entryPx,
  positionSize,
  tpBps,
  slBps,
}) {
  const px = Number(entryPx || 0);
  const size = Number(positionSize || 0);
  if (!(px > 0) || size === 0) {
    return {
      closeSide: null,
      tpRaw: null,
      slRaw: null,
    };
  }
  const isLong = size > 0;
  const closeSide = isLong ? "sell" : "buy";
  return {
    closeSide,
    tpRaw: Number(tpBps || 0) > 0
      ? (isLong ? px * (1 + Number(tpBps) / 10000) : px * (1 - Number(tpBps) / 10000))
      : null,
    slRaw: Number(slBps || 0) > 0
      ? (isLong ? px * (1 - Number(slBps) / 10000) : px * (1 + Number(slBps) / 10000))
      : null,
  };
}

export function shouldRefreshTpSlState(current, desired) {
  if (!current) {
    return true;
  }
  if (Array.isArray(current.extraCloids) && current.extraCloids.length > 0) {
    return true;
  }
  if (String(current.side || "") !== String(desired.closeSide || "")) {
    return true;
  }
  const lotStep = 1 / (10 ** Math.max(0, Number(desired?.meta?.szDecimals || 0)));
  if (Math.abs(Number(current.size || 0) - Number(desired.size || 0)) > (lotStep / 2)) {
    return true;
  }
  const priceStep = 10 ** (-Math.max(0, Number(desired?.meta?.priceDecimals || 0)));
  const referencePx = Number(desired?.referencePx || 0);
  const minReferenceMove = Math.max(priceStep, referencePx > 0 ? (referencePx * 0.0002) : 0);
  if (Math.abs(Number(current.referencePx || 0) - referencePx) > minReferenceMove) {
    return true;
  }
  if (desired.tpPx !== null) {
    if (!current.tpCloid) {
      return true;
    }
    if (Math.abs(Number(current.tpPx || 0) - Number(desired.tpPx || 0)) > (priceStep / 2)) {
      return true;
    }
  }
  if (desired.slPx !== null) {
    if (!current.slCloid) {
      return true;
    }
    if (Math.abs(Number(current.slPx || 0) - Number(desired.slPx || 0)) > (priceStep / 2)) {
      return true;
    }
  }
  return false;
}

export function buildTpSlOrderRequests({ coin, desired, isMarket }) {
  if (!(Number(desired?.size || 0) > 0)) {
    return [];
  }
  if (desired?.closeSide !== "buy" && desired?.closeSide !== "sell") {
    return [];
  }
  const out = [];
  if (desired?.slPx !== null && desired?.slPx !== undefined) {
    out.push({
      tpsl: "sl",
      triggerPx: Number(desired.slPx),
      cloid: makeManagedTpslCloid(coin, "sl"),
      order: {
        asset: desired.asset,
        isBuy: desired.closeSide === "buy",
        limitPx: Number(desired.slPx),
        sz: Number(desired.size),
        reduceOnly: true,
        orderType: {
          trigger: {
            isMarket: Boolean(isMarket),
            triggerPx: Number(desired.slPx),
            tpsl: "sl",
          },
        },
        cloid: makeManagedTpslCloid(coin, "sl"),
      },
    });
  }
  if (desired?.tpPx !== null && desired?.tpPx !== undefined) {
    out.push({
      tpsl: "tp",
      triggerPx: Number(desired.tpPx),
      cloid: makeManagedTpslCloid(coin, "tp"),
      order: {
        asset: desired.asset,
        isBuy: desired.closeSide === "buy",
        limitPx: Number(desired.tpPx),
        sz: Number(desired.size),
        reduceOnly: true,
        orderType: {
          trigger: {
            isMarket: Boolean(isMarket),
            triggerPx: Number(desired.tpPx),
            tpsl: "tp",
          },
        },
        cloid: makeManagedTpslCloid(coin, "tp"),
      },
    });
  }
  return out;
}

function isUrgentTpSlSizeChange({
  currentSize,
  desiredSize,
  szDecimals,
  referencePx,
  minNotionalUsd,
}) {
  const lotStep = 1 / (10 ** Math.max(0, Number(szDecimals || 0)));
  const sizeDelta = Math.abs(Number(desiredSize || 0) - Number(currentSize || 0));
  if (sizeDelta >= (lotStep - 1e-12)) {
    return true;
  }
  const notionalDelta = sizeDelta * Math.max(0, Number(referencePx || 0));
  const threshold = Math.max(1, Number(minNotionalUsd || 0) * 0.5);
  return notionalDelta >= threshold;
}

function enforceTpSlBounds({
  closeSide,
  tpPx,
  slPx,
  entryPx,
  markPx,
  referencePx,
  meta,
}) {
  const hasTp = tpPx !== null && tpPx !== undefined;
  const hasSl = slPx !== null && slPx !== undefined;
  if (!hasTp && !hasSl) {
    return {
      ok: true,
      tpPx: null,
      slPx: null,
      detail: null,
    };
  }
  const entry = Number(entryPx || 0);
  const mark = Number(markPx || 0);
  const ref = Number(referencePx || 0);
  const anchors = [entry, mark].filter((x) => x > 0);
  const hi = anchors.length ? Math.max(...anchors) : ref;
  const lo = anchors.length ? Math.min(...anchors) : ref;
  const base = Math.max(hi, lo, Number(tpPx || 0), Number(slPx || 0), ref, 1);
  const tick = priceStep({
    price: base,
    maxPriceDecimals: Number(meta?.priceDecimals || 0),
    maxSignificantFigures: Number(meta?.priceSigFigs || 5),
  });
  if (!(tick > 0)) {
    return {
      ok: false,
      reason: "tpsl_tick_unavailable",
      detail: {
        closeSide,
        entryPx: entry,
        markPx: mark,
        referencePx: ref,
      },
    };
  }

  let nextTp = hasTp ? Number(tpPx) : null;
  let nextSl = hasSl ? Number(slPx) : null;
  if (closeSide === "sell") {
    const minTp = Math.max(hi, ref) + tick;
    const maxSl = Math.max(tick, Math.min(lo, ref) - tick);
    if (nextTp !== null) {
      nextTp = Math.max(nextTp, minTp);
      nextTp = Number(normalizePriceForAsset({
        requestedPrice: nextTp,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "ceil",
      }).price);
    }
    if (nextSl !== null) {
      nextSl = Math.min(nextSl, maxSl);
      nextSl = Number(normalizePriceForAsset({
        requestedPrice: nextSl,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "floor",
      }).price);
    }
    if (nextTp !== null && !(nextTp > Math.max(hi, ref))) {
      return { ok: false, reason: "tpsl_tp_not_above_long_anchor", detail: { nextTp, hi, ref, tick } };
    }
    if (nextSl !== null && !(nextSl < Math.min(lo, ref))) {
      return { ok: false, reason: "tpsl_sl_not_below_long_anchor", detail: { nextSl, lo, ref, tick } };
    }
  } else if (closeSide === "buy") {
    const maxTp = Math.max(tick, Math.min(lo, ref) - tick);
    const minSl = Math.max(hi, ref) + tick;
    if (nextTp !== null) {
      nextTp = Math.min(nextTp, maxTp);
      nextTp = Number(normalizePriceForAsset({
        requestedPrice: nextTp,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "floor",
      }).price);
    }
    if (nextSl !== null) {
      nextSl = Math.max(nextSl, minSl);
      nextSl = Number(normalizePriceForAsset({
        requestedPrice: nextSl,
        maxPriceDecimals: meta.priceDecimals,
        maxSignificantFigures: meta.priceSigFigs,
        mode: "ceil",
      }).price);
    }
    if (nextTp !== null && !(nextTp < Math.min(lo, ref))) {
      return { ok: false, reason: "tpsl_tp_not_below_short_anchor", detail: { nextTp, lo, ref, tick } };
    }
    if (nextSl !== null && !(nextSl > Math.max(hi, ref))) {
      return { ok: false, reason: "tpsl_sl_not_above_short_anchor", detail: { nextSl, hi, ref, tick } };
    }
  } else {
    return {
      ok: false,
      reason: "tpsl_close_side_invalid",
      detail: { closeSide },
    };
  }

  if (nextTp !== null && nextSl !== null) {
    if (closeSide === "sell" && !(nextTp > nextSl)) {
      return {
        ok: false,
        reason: "tpsl_long_ordering_invalid",
        detail: { nextTp, nextSl, tick },
      };
    }
    if (closeSide === "buy" && !(nextTp < nextSl)) {
      return {
        ok: false,
        reason: "tpsl_short_ordering_invalid",
        detail: { nextTp, nextSl, tick },
      };
    }
  }

  return {
    ok: true,
    tpPx: nextTp,
    slPx: nextSl,
    detail: {
      tick,
      hi,
      lo,
      referencePx: ref,
    },
  };
}

function scoreSignal(signal) {
  if (!signal || signal.blocked) {
    return -Infinity;
  }

  const f = signal.explanation?.feature || {};
  if (f.score !== undefined) {
    return Math.abs(Number(f.score));
  }
  if (f.z !== undefined) {
    return Math.abs(Number(f.z));
  }
  return 0.1;
}

function adjustSizeForNotional({ requestedSize, mid, minNotionalUsd, maxNotionalUsd }) {
  const px = Number(mid || 0);
  const req = Math.max(0, Number(requestedSize || 0));
  if (!(px > 0) || req <= 0) {
    return {
      size: req,
      requestedSize: req,
      requestedNotional: 0,
      finalNotional: 0,
      adjusted: false,
      reason: "invalid_mid_or_size",
    };
  }

  const requestedNotional = req * px;
  const minSize = minNotionalUsd > 0 ? minNotionalUsd / px : req;
  const maxSize = maxNotionalUsd > 0 ? maxNotionalUsd / px : req;
  let size = req;
  let reason = "none";
  if (requestedNotional < minNotionalUsd) {
    size = Math.max(size, minSize);
    reason = "raised_to_min_notional";
  }
  if (maxNotionalUsd > 0 && size * px > maxNotionalUsd) {
    size = Math.min(size, maxSize);
    reason = reason === "none" ? "capped_to_max_notional" : `${reason}+capped_to_max_notional`;
  }
  size = Number(size.toFixed(8));
  const finalNotional = size * px;

  return {
    size,
    requestedSize: req,
    requestedNotional,
    finalNotional,
    adjusted: Math.abs(size - req) > 1e-10,
    reason,
    minNotionalUsd,
    maxNotionalUsd,
  };
}

function classifyExchangeError(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return "unknown";
  if (m.includes("vault not registered")) return "vault_not_registered";
  if (m.includes("badalopx") || (m.includes("alo") && m.includes("bad"))) return "bad_alo_px";
  if (m.includes("mintraden") || m.includes("min trade") || m.includes("min notional")) return "min_notional";
  if (m.includes("invalid price")) return "invalid_price";
  if (m.includes("invalid size")) return "invalid_size";
  if (m.includes("tick") || m.includes("lot")) return "tick_or_lot_size";
  if (m.includes("insufficient") && m.includes("margin")) return "insufficient_margin";
  if (m.includes("not approved") || m.includes("notapproved")) return "not_approved";
  return "other";
}

function redactSensitiveText(value) {
  if (!value) {
    return value;
  }
  return String(value).replace(/0x[a-fA-F0-9]{8,}/g, (m) => `${m.slice(0, 6)}***${m.slice(-4)}`);
}

function minPositive(a, b) {
  const x = Number(a || 0);
  const y = Number(b || 0);
  if (x > 0 && y > 0) {
    return Math.min(x, y);
  }
  if (x > 0) {
    return x;
  }
  if (y > 0) {
    return y;
  }
  return 0;
}

function makeManagedTpslCloid(coin, kind = "tp") {
  const kindNibble = String(kind || "").toLowerCase() === "sl" ? "2" : "1";
  const seed = String(coin || "na").toLowerCase();
  const prefix = `${TPSL_CLOID_PREFIX_HEX}${kindNibble}`;
  const digest = crypto.createHash("sha256").update(`tpsl:${seed}:${kindNibble}`).digest("hex");
  const needed = Math.max(0, 32 - prefix.length);
  return `0x${prefix}${digest.slice(0, needed)}`;
}

function isManagedTpslCloid(cloid) {
  const value = String(cloid || "").toLowerCase();
  return value.startsWith(`0x${TPSL_CLOID_PREFIX_HEX}`);
}

class RiskLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RiskLimitError";
    this.details = details;
  }
}

function normalizeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

function normalizeSizeForAsset({
  requestedSize,
  mid,
  szDecimals,
  minNotionalUsd,
  maxNotionalUsd,
}) {
  const rawSize = Math.max(0, Number(requestedSize || 0));
  const px = Number(mid || 0);
  const lotStep = 1 / (10 ** Math.max(0, szDecimals));

  if (!(rawSize > 0)) {
    return {
      size: 0,
      lotStep,
      adjusted: false,
      reason: "invalid_requested_size",
      requestedSize: rawSize,
    };
  }

  let size = roundToStep(rawSize, lotStep, "ceil");
  let reason = "rounded_to_lot_step";
  const minSize = px > 0 && minNotionalUsd > 0 ? minNotionalUsd / px : 0;
  const maxSize = px > 0 && maxNotionalUsd > 0 ? maxNotionalUsd / px : Infinity;

  if (size < minSize) {
    size = roundToStep(minSize, lotStep, "ceil");
    reason = "raised_to_min_notional_then_lot";
  }

  if (Number.isFinite(maxSize) && size > maxSize) {
    size = roundToStep(maxSize, lotStep, "floor");
    reason = reason === "rounded_to_lot_step" ? "capped_to_max_notional_then_lot" : `${reason}+capped_to_max_notional`;
  }

  if (size <= 0) {
    size = lotStep;
    reason = `${reason}+clamped_to_min_lot`;
  }

  size = trimToDecimals(size, Math.max(0, szDecimals));
  const requestedNotional = px > 0 ? rawSize * px : null;
  const finalNotional = px > 0 ? size * px : null;

  return {
    size,
    requestedSize: rawSize,
    adjusted: Math.abs(size - rawSize) > 1e-10,
    reason,
    lotStep,
    szDecimals,
    requestedNotional,
    finalNotional,
  };
}

function normalizePriceForAsset({
  requestedPrice,
  maxPriceDecimals,
  maxSignificantFigures,
  mode = "nearest",
}) {
  const px = Number(requestedPrice || 0);
  if (!(px > 0)) {
    return {
      price: 0,
      adjusted: false,
      reason: "invalid_requested_price",
      requestedPrice: px,
      step: null,
    };
  }

  const step = priceStep({
    price: px,
    maxPriceDecimals,
    maxSignificantFigures,
  });

  const quantized = roundToStep(px, step, mode);
  const price = trimToDecimals(Math.max(step, quantized), Math.max(0, maxPriceDecimals));

  return {
    price,
    requestedPrice: px,
    adjusted: Math.abs(price - px) > 1e-10,
    reason: "price_sigfig_and_decimals_quantized",
    step,
    maxPriceDecimals,
    maxSignificantFigures,
    mode,
  };
}

function inferPriceRoundMode({ side, tif }) {
  const s = String(side || "").toLowerCase();
  const t = String(tif || "").toLowerCase();
  const isBuy = s === "buy";

  if (t === "alo") {
    return isBuy ? "floor" : "ceil";
  }
  return isBuy ? "ceil" : "floor";
}

function priceStep({ price, maxPriceDecimals, maxSignificantFigures }) {
  const absPrice = Math.abs(Number(price || 0));
  const safeDecimals = Math.max(0, normalizeInt(maxPriceDecimals, 0));
  const safeSigFigs = Math.max(1, normalizeInt(maxSignificantFigures, 5));
  const decimalStep = 10 ** (-safeDecimals);

  if (!(absPrice > 0)) {
    return decimalStep;
  }

  const exponent = Math.floor(Math.log10(absPrice));
  const sigStep = 10 ** (exponent - safeSigFigs + 1);
  return Math.max(decimalStep, sigStep);
}

function roundToStep(value, step, mode = "nearest") {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) {
    return v;
  }
  const scaled = v / s;
  let units;
  if (mode === "floor") {
    units = Math.floor(scaled + 1e-12);
  } else if (mode === "ceil") {
    units = Math.ceil(scaled - 1e-12);
  } else {
    units = Math.round(scaled);
  }
  return units * s;
}

function trimToDecimals(value, decimals) {
  const safe = Math.max(0, normalizeInt(decimals, 0));
  const factor = 10 ** safe;
  return Math.round(Number(value) * factor) / factor;
}

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
