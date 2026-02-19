import path from "node:path";
import { loadEnvFile } from "./utils/fs.mjs";

const NETWORK_DEFAULTS = {
  mainnet: {
    httpUrl: "https://api.hyperliquid.xyz",
    wsUrl: "wss://api.hyperliquid.xyz/ws",
    source: "a",
  },
  testnet: {
    httpUrl: "https://api.hyperliquid-testnet.xyz",
    wsUrl: "wss://api.hyperliquid-testnet.xyz/ws",
    source: "b",
  },
};

function parseNumber(name, value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number`);
  }
  return n;
}

function parseInteger(name, value, fallback) {
  const n = parseNumber(name, value, fallback);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePercent(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const raw = String(value).trim();
  if (raw.endsWith("%")) {
    const pct = Number(raw.slice(0, -1));
    if (!Number.isFinite(pct)) {
      throw new Error("Percent value is invalid");
    }
    return pct / 100;
  }
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber)) {
    throw new Error("Percent value is invalid");
  }
  return asNumber > 1 ? asNumber / 100 : asNumber;
}

function parseCsv(value, fallbackCsv) {
  return (value || fallbackCsv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseOptionalCsv(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseMode(value, allowed, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error(`Invalid mode '${value}'. Allowed: ${allowed.join(", ")}`);
  }
  return normalized;
}

function parseUtcClock(name, value, fallback) {
  const raw = String(value || fallback || "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new Error(`${name} must be HH:MM in UTC`);
  }
  return `${match[1]}:${match[2]}`;
}

function ensureRequired(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (!missing.length) {
    return;
  }
  const message = [
    "Missing required .env.local values:",
    ...missing.map((k) => `- ${k}`),
    "Create .env.local from .env.local.example and fill values.",
  ].join("\n");
  const err = new Error(message);
  err.code = "ENV_MISSING";
  throw err;
}

export function loadConfig(cwd = process.cwd()) {
  const envFromFile = loadEnvFile(path.join(cwd, ".env.local"));
  const env = { ...envFromFile, ...process.env };
  const stateDir = env.STATE_DIR || path.join(cwd, "data", "state");

  const network = parseMode(env.HYPERLIQUID_NETWORK || "mainnet", ["mainnet", "testnet"], "mainnet");
  const defaults = NETWORK_DEFAULTS[network];

  const required = [
    "HYPERLIQUID_ACCOUNT_ADDRESS",
    "HYPERLIQUID_API_WALLET_PRIVATE_KEY",
    "API_BUDGET_MODE",
  ];

  const openaiEnabled = parseBoolean(env.OPENAI_ENABLED, parseBoolean(env.GPT_ENABLED, false));
  if (openaiEnabled) {
    required.push("OPENAI_API_KEY");
  }
  ensureRequired(env, required);

  return {
    network,
    source: defaults.source,
    httpUrl: env.HYPERLIQUID_HTTP_URL || defaults.httpUrl,
    wsUrl: env.HYPERLIQUID_WS_URL || defaults.wsUrl,
    accountAddress: env.HYPERLIQUID_ACCOUNT_ADDRESS,
    apiWalletPrivateKey: env.HYPERLIQUID_API_WALLET_PRIVATE_KEY,
    vaultAddress: env.HYPERLIQUID_VAULT_ADDRESS || "",
    vaultModeEnabled: parseBoolean(env.HYPERLIQUID_VAULT_MODE_ENABLED, false),

    coins: parseCsv(env.TRADING_COINS, "ETH"),
    candleInterval: env.MARKET_DATA_CANDLE_INTERVAL || "1m",
    backfillHours: parseInteger("BACKFILL_HOURS", env.BACKFILL_HOURS, 24),
    strategyIntervalMs: parseInteger("TRADING_LOOP_INTERVAL_MS", env.TRADING_LOOP_INTERVAL_MS, 15000),
    fillPollIntervalMs: parseInteger("FILL_POLL_INTERVAL_MS", env.FILL_POLL_INTERVAL_MS, 15000),
    quotaPollIntervalMs: parseInteger("QUOTA_POLL_INTERVAL_MS", env.QUOTA_POLL_INTERVAL_MS, 30000),
    wsWatchdogIntervalMs: parseInteger("WS_WATCHDOG_INTERVAL_MS", env.WS_WATCHDOG_INTERVAL_MS, 5000),
    wsMessageTimeoutMs: parseInteger("WS_MESSAGE_TIMEOUT_MS", env.WS_MESSAGE_TIMEOUT_MS, 60000),
    reportIntervalMs: parseInteger("REPORT_INTERVAL_MS", env.REPORT_INTERVAL_MS, 3600000),
    persistIntervalMs: parseInteger("PERSIST_INTERVAL_MS", env.PERSIST_INTERVAL_MS, 30000),
    orderSize: parseNumber("TRADE_ORDER_SIZE", env.TRADE_ORDER_SIZE, 0.001),
    maxSlippageBps: parseNumber("TRADE_MAX_SLIPPAGE_BPS", env.TRADE_MAX_SLIPPAGE_BPS, 15),
    maxSpreadBps: parseNumber("TRADE_MAX_SPREAD_BPS", env.TRADE_MAX_SPREAD_BPS, 20),
    minBookDepthUsd: parseNumber("TRADE_MIN_BOOK_DEPTH_USD", env.TRADE_MIN_BOOK_DEPTH_USD, 5000),
    tradeMinNotionalUsd: parseNumber("TRADE_MIN_NOTIONAL_USD", env.TRADE_MIN_NOTIONAL_USD, 12),
    tradeMaxNotionalUsd: parseNumber("TRADE_MAX_NOTIONAL_USD", env.TRADE_MAX_NOTIONAL_USD, 40),
    orderRetryOnAloError: parseBoolean(env.ORDER_RETRY_ON_ALO_ERROR, true),
    orderRetryOnInvalidPrice: parseBoolean(env.ORDER_RETRY_ON_INVALID_PRICE, true),
    requireAgentWallet: parseBoolean(env.HYPERLIQUID_REQUIRE_AGENT_WALLET, false),
    maxActiveCoins: parseInteger("MAX_ACTIVE_COINS", env.MAX_ACTIVE_COINS, 2),
    maxConcurrentPositions: parseInteger("MAX_CONCURRENT_POSITIONS", env.MAX_CONCURRENT_POSITIONS, 2),
    dailyLossMode: parseMode(env.DAILY_LOSS_MODE || "utc_day", ["rolling24h", "utc_day"], "utc_day"),
    riskMaxDailyLossUsd: parseNumber("RISK_MAX_DAILY_LOSS_USD", env.RISK_MAX_DAILY_LOSS_USD, 15),
    riskMaxDrawdownBps: parseNumber("RISK_MAX_DRAWDOWN_BPS", env.RISK_MAX_DRAWDOWN_BPS, 450),
    riskMaxPositionNotionalUsd: parseNumber("RISK_MAX_POSITION_NOTIONAL_USD", env.RISK_MAX_POSITION_NOTIONAL_USD, 120),
    riskMaxOrderNotionalUsd: parseNumber("RISK_MAX_ORDER_NOTIONAL_USD", env.RISK_MAX_ORDER_NOTIONAL_USD, 40),
    riskMaxOpenOrders: parseInteger("RISK_MAX_OPEN_ORDERS", env.RISK_MAX_OPEN_ORDERS, 8),
    openOrdersReconcileIntervalMs: parseInteger("OPEN_ORDERS_RECONCILE_INTERVAL_MS", env.OPEN_ORDERS_RECONCILE_INTERVAL_MS, 45000),
    openOrdersReconcileMaxFailures: parseInteger("OPEN_ORDERS_RECONCILE_MAX_FAILURES", env.OPEN_ORDERS_RECONCILE_MAX_FAILURES, 3),
    tpslEnabled: parseBoolean(env.TPSL_ENABLED, true),
    tpslTakeProfitBps: parseNumber("TP_BPS", env.TP_BPS, 80),
    tpslStopLossBps: parseNumber("SL_BPS", env.SL_BPS, 50),
    tpslIsMarket: parseBoolean(env.TPSL_IS_MARKET, true),
    tpslCleanupOnStop: parseBoolean(env.TPSL_CLEANUP_ON_STOP, true),
    tpslRefreshCooldownMs: parseInteger("TPSL_REFRESH_COOLDOWN_MS", env.TPSL_REFRESH_COOLDOWN_MS, 15000),
    flattenPositionsOnStop: parseBoolean(env.FLATTEN_POSITIONS_ON_STOP, true),
    coinSelectionEnabled: parseBoolean(env.COIN_SELECTION_ENABLED, true),
    coinUniverseMax: parseInteger("COIN_UNIVERSE_MAX", env.COIN_UNIVERSE_MAX, 30),
    coinSelectionRefreshMs: parseInteger("COIN_SELECTION_REFRESH_MS", env.COIN_SELECTION_REFRESH_MS, 300000),
    coinCooldownMs: parseInteger("COIN_COOLDOWN_MS", env.COIN_COOLDOWN_MS, 900000),
    coinRejectStreakLimit: parseInteger("COIN_REJECT_STREAK_LIMIT", env.COIN_REJECT_STREAK_LIMIT, 3),
    strategyDailyFillLimit: parseInteger("STRATEGY_DAILY_FILL_LIMIT", env.STRATEGY_DAILY_FILL_LIMIT, 12),
    strategyDailyTakerFillLimit: parseInteger("STRATEGY_DAILY_TAKER_FILL_LIMIT", env.STRATEGY_DAILY_TAKER_FILL_LIMIT, 3),
    strategyConsecutiveTakerLimit: parseInteger("STRATEGY_CONSECUTIVE_TAKER_LIMIT", env.STRATEGY_CONSECUTIVE_TAKER_LIMIT, 2),
    strategyDataStaleCandleMs: parseInteger("STRATEGY_DATA_STALE_CANDLE_MS", env.STRATEGY_DATA_STALE_CANDLE_MS, 90000),
    strategyDataStaleBookMs: parseInteger("STRATEGY_DATA_STALE_BOOK_MS", env.STRATEGY_DATA_STALE_BOOK_MS, 20000),
    strategyDataStaleTradesMs: parseInteger("STRATEGY_DATA_STALE_TRADES_MS", env.STRATEGY_DATA_STALE_TRADES_MS, 20000),
    strategyTurbulenceAtrMedianMult: parseNumber("STRATEGY_TURBULENCE_ATR_MEDIAN_MULT", env.STRATEGY_TURBULENCE_ATR_MEDIAN_MULT, 1.8),
    strategyTrendAdxMin: parseNumber("STRATEGY_TREND_ADX_MIN", env.STRATEGY_TREND_ADX_MIN, 20),
    strategyRangeAdxMax: parseNumber("STRATEGY_RANGE_ADX_MAX", env.STRATEGY_RANGE_ADX_MAX, 15),
    strategyTrendEmaGapBpsMin: parseNumber("STRATEGY_TREND_EMA_GAP_BPS_MIN", env.STRATEGY_TREND_EMA_GAP_BPS_MIN, 8),
    strategyRangeEmaGapBpsMax: parseNumber("STRATEGY_RANGE_EMA_GAP_BPS_MAX", env.STRATEGY_RANGE_EMA_GAP_BPS_MAX, 4),
    strategyTrendBreakoutLookbackBars: parseInteger("STRATEGY_TREND_BREAKOUT_LOOKBACK_BARS", env.STRATEGY_TREND_BREAKOUT_LOOKBACK_BARS, 20),
    strategyTrendBreakoutConfirmBars: parseInteger("STRATEGY_TREND_BREAKOUT_CONFIRM_BARS", env.STRATEGY_TREND_BREAKOUT_CONFIRM_BARS, 2),
    strategyTrendBreakoutBufferBps: parseNumber("STRATEGY_TREND_BREAKOUT_BUFFER_BPS", env.STRATEGY_TREND_BREAKOUT_BUFFER_BPS, 3),
    strategyTrendBreakoutMinBodyRatio: parseNumber("STRATEGY_TREND_BREAKOUT_MIN_BODY_RATIO", env.STRATEGY_TREND_BREAKOUT_MIN_BODY_RATIO, 0.35),
    strategyTrendBreakoutMaxRet1mPct: parseNumber("STRATEGY_TREND_BREAKOUT_MAX_RET_1M_PCT", env.STRATEGY_TREND_BREAKOUT_MAX_RET_1M_PCT, 1.2),
    strategyTrendFlowWindowSec: parseInteger("STRATEGY_TREND_FLOW_WINDOW_SEC", env.STRATEGY_TREND_FLOW_WINDOW_SEC, 20),
    strategyTrendAggressorRatioMin: parseNumber("STRATEGY_TREND_AGGRESSOR_RATIO_MIN", env.STRATEGY_TREND_AGGRESSOR_RATIO_MIN, 0.55),
    strategyTrendImbalanceThreshold: parseNumber("STRATEGY_TREND_IMBALANCE_THRESHOLD", env.STRATEGY_TREND_IMBALANCE_THRESHOLD, 0.10),
    strategyRangeZEntry: parseNumber("STRATEGY_RANGE_Z_ENTRY", env.STRATEGY_RANGE_Z_ENTRY, 2.0),
    strategyRangeNoBreakoutBars: parseInteger("STRATEGY_RANGE_NO_BREAKOUT_BARS", env.STRATEGY_RANGE_NO_BREAKOUT_BARS, 2),
    strategyRangeMaxAtrPct: parseNumber("STRATEGY_RANGE_MAX_ATR_PCT", env.STRATEGY_RANGE_MAX_ATR_PCT, 0.90),
    strategyRangeMaxRet1mPct: parseNumber("STRATEGY_RANGE_MAX_RET_1M_PCT", env.STRATEGY_RANGE_MAX_RET_1M_PCT, 0.45),
    strategyMaxEntriesPerCoinPerHour: parseInteger("STRATEGY_MAX_ENTRIES_PER_COIN_PER_HOUR", env.STRATEGY_MAX_ENTRIES_PER_COIN_PER_HOUR, 4),
    strategyEntryCooldownMs: parseInteger("STRATEGY_ENTRY_COOLDOWN_MS", env.STRATEGY_ENTRY_COOLDOWN_MS, 180000),
    strategyRestartNoTradeMs: parseInteger("STRATEGY_RESTART_NO_TRADE_MS", env.STRATEGY_RESTART_NO_TRADE_MS, 300000),
    strategyRegimeMinHoldMs: parseInteger("STRATEGY_REGIME_MIN_HOLD_MS", env.STRATEGY_REGIME_MIN_HOLD_MS, 600000),
    strategyRegimeConfirmBars: parseInteger("STRATEGY_REGIME_CONFIRM_BARS", env.STRATEGY_REGIME_CONFIRM_BARS, 2),
    strategyRegimeFlipWindowMs: parseInteger("STRATEGY_REGIME_FLIP_WINDOW_MS", env.STRATEGY_REGIME_FLIP_WINDOW_MS, 1800000),
    strategyRegimeFlipMaxInWindow: parseInteger("STRATEGY_REGIME_FLIP_MAX_IN_WINDOW", env.STRATEGY_REGIME_FLIP_MAX_IN_WINDOW, 4),
    strategyRegimeFlipCooldownMs: parseInteger("STRATEGY_REGIME_FLIP_COOLDOWN_MS", env.STRATEGY_REGIME_FLIP_COOLDOWN_MS, 300000),
    strategyMinEdgeBaseBps: parseNumber("STRATEGY_MIN_EDGE_BASE_BPS", env.STRATEGY_MIN_EDGE_BASE_BPS, 8),
    strategyMinEdgeVolK: parseNumber("STRATEGY_MIN_EDGE_VOL_K", env.STRATEGY_MIN_EDGE_VOL_K, 1.5),
    strategyMinEdgeSafetyBufferBps: parseNumber("STRATEGY_MIN_EDGE_SAFETY_BUFFER_BPS", env.STRATEGY_MIN_EDGE_SAFETY_BUFFER_BPS, 1),
    strategyMinEdgeFallbackSlippageBps: parseNumber("STRATEGY_MIN_EDGE_FALLBACK_SLIPPAGE_BPS", env.STRATEGY_MIN_EDGE_FALLBACK_SLIPPAGE_BPS, 2),
    strategyMinEdgeMakerSlipFactor: parseNumber("STRATEGY_MIN_EDGE_MAKER_SLIP_FACTOR", env.STRATEGY_MIN_EDGE_MAKER_SLIP_FACTOR, 0.65),
    strategyFeeMakerBps: parseNumber("STRATEGY_FEE_MAKER_BPS", env.STRATEGY_FEE_MAKER_BPS, 1.8),
    strategyFeeTakerBps: parseNumber("STRATEGY_FEE_TAKER_BPS", env.STRATEGY_FEE_TAKER_BPS, 3.6),
    strategyFeeRefreshMs: parseInteger("STRATEGY_FEE_REFRESH_MS", env.STRATEGY_FEE_REFRESH_MS, 300000),
    strategyTrendMakerTtlMs: parseInteger("STRATEGY_TREND_MAKER_TTL_MS", env.STRATEGY_TREND_MAKER_TTL_MS, 8000),
    strategyRangeMakerTtlMs: parseInteger("STRATEGY_RANGE_MAKER_TTL_MS", env.STRATEGY_RANGE_MAKER_TTL_MS, 10000),
    strategyTrendSlAtrMult: parseNumber("STRATEGY_TREND_SL_ATR_MULT", env.STRATEGY_TREND_SL_ATR_MULT, 1.2),
    strategyTrendSlMinPct: parseNumber("STRATEGY_TREND_SL_MIN_PCT", env.STRATEGY_TREND_SL_MIN_PCT, 0.45),
    strategyTrendSlMaxPct: parseNumber("STRATEGY_TREND_SL_MAX_PCT", env.STRATEGY_TREND_SL_MAX_PCT, 0.90),
    strategyTrendTpMult: parseNumber("STRATEGY_TREND_TP_MULT", env.STRATEGY_TREND_TP_MULT, 1.3),
    strategyTrendTimeStopMs: parseInteger("STRATEGY_TREND_TIME_STOP_MS", env.STRATEGY_TREND_TIME_STOP_MS, 12 * 60 * 1000),
    strategyTrendTimeStopProgressR: parseNumber("STRATEGY_TREND_TIME_STOP_PROGRESS_R", env.STRATEGY_TREND_TIME_STOP_PROGRESS_R, 0.4),
    strategyRangeSlAtrMult: parseNumber("STRATEGY_RANGE_SL_ATR_MULT", env.STRATEGY_RANGE_SL_ATR_MULT, 1.5),
    strategyRangeSlMinPct: parseNumber("STRATEGY_RANGE_SL_MIN_PCT", env.STRATEGY_RANGE_SL_MIN_PCT, 0.55),
    strategyRangeSlMaxPct: parseNumber("STRATEGY_RANGE_SL_MAX_PCT", env.STRATEGY_RANGE_SL_MAX_PCT, 1.2),
    strategyRangeOneRTpMult: parseNumber("STRATEGY_RANGE_ONE_R_TP_MULT", env.STRATEGY_RANGE_ONE_R_TP_MULT, 1.0),
    strategyRangeTimeStopMs: parseInteger("STRATEGY_RANGE_TIME_STOP_MS", env.STRATEGY_RANGE_TIME_STOP_MS, 6 * 60 * 1000),
    strategyRangeTimeStopProgressR: parseNumber("STRATEGY_RANGE_TIME_STOP_PROGRESS_R", env.STRATEGY_RANGE_TIME_STOP_PROGRESS_R, 0.3),
    strategySymbolDefaults: {
      makerSpreadBps: parseNumber("STRATEGY_DEFAULT_MAKER_MAX_SPREAD_BPS", env.STRATEGY_DEFAULT_MAKER_MAX_SPREAD_BPS, 10),
      takerSpreadBps: parseNumber("STRATEGY_DEFAULT_TAKER_MAX_SPREAD_BPS", env.STRATEGY_DEFAULT_TAKER_MAX_SPREAD_BPS, 16),
      makerSlippageBps: parseNumber("STRATEGY_DEFAULT_MAKER_MAX_SLIPPAGE_BPS", env.STRATEGY_DEFAULT_MAKER_MAX_SLIPPAGE_BPS, 10),
      takerSlippageBps: parseNumber("STRATEGY_DEFAULT_TAKER_MAX_SLIPPAGE_BPS", env.STRATEGY_DEFAULT_TAKER_MAX_SLIPPAGE_BPS, 12),
      turbulenceRet1mPct: parseNumber("STRATEGY_DEFAULT_TURBULENCE_RET_1M_PCT", env.STRATEGY_DEFAULT_TURBULENCE_RET_1M_PCT, 0.65),
      trendTakerTriggerPct: parseNumber("STRATEGY_DEFAULT_TREND_TAKER_TRIGGER_PCT", env.STRATEGY_DEFAULT_TREND_TAKER_TRIGGER_PCT, 0.18),
    },
    strategySymbolRules: {
      BTC: {
        makerSpreadBps: parseNumber("BTC_MAKER_MAX_SPREAD_BPS", env.BTC_MAKER_MAX_SPREAD_BPS, 6),
        takerSpreadBps: parseNumber("BTC_TAKER_MAX_SPREAD_BPS", env.BTC_TAKER_MAX_SPREAD_BPS, 10),
        makerSlippageBps: parseNumber("BTC_MAKER_MAX_SLIPPAGE_BPS", env.BTC_MAKER_MAX_SLIPPAGE_BPS, 6),
        takerSlippageBps: parseNumber("BTC_TAKER_MAX_SLIPPAGE_BPS", env.BTC_TAKER_MAX_SLIPPAGE_BPS, 7),
        turbulenceRet1mPct: parseNumber("BTC_TURBULENCE_RET_1M_PCT", env.BTC_TURBULENCE_RET_1M_PCT, 0.45),
        trendTakerTriggerPct: parseNumber("BTC_TREND_TAKER_TRIGGER_PCT", env.BTC_TREND_TAKER_TRIGGER_PCT, 0.12),
      },
      ETH: {
        makerSpreadBps: parseNumber("ETH_MAKER_MAX_SPREAD_BPS", env.ETH_MAKER_MAX_SPREAD_BPS, 10),
        takerSpreadBps: parseNumber("ETH_TAKER_MAX_SPREAD_BPS", env.ETH_TAKER_MAX_SPREAD_BPS, 16),
        makerSlippageBps: parseNumber("ETH_MAKER_MAX_SLIPPAGE_BPS", env.ETH_MAKER_MAX_SLIPPAGE_BPS, 10),
        takerSlippageBps: parseNumber("ETH_TAKER_MAX_SLIPPAGE_BPS", env.ETH_TAKER_MAX_SLIPPAGE_BPS, 10),
        turbulenceRet1mPct: parseNumber("ETH_TURBULENCE_RET_1M_PCT", env.ETH_TURBULENCE_RET_1M_PCT, 0.65),
        trendTakerTriggerPct: parseNumber("ETH_TREND_TAKER_TRIGGER_PCT", env.ETH_TREND_TAKER_TRIGGER_PCT, 0.18),
      },
    },

    budgetMode: parseMode(env.API_BUDGET_MODE || "counter", ["counter", "quota"], "counter"),
    budgetDailyMaxHttpCalls: parseInteger("API_BUDGET_DAILY_MAX_HTTP_CALLS", env.API_BUDGET_DAILY_MAX_HTTP_CALLS, 20000),
    budgetHourlyMaxHttpCalls: parseInteger("API_BUDGET_HOURLY_MAX_HTTP_CALLS", env.API_BUDGET_HOURLY_MAX_HTTP_CALLS, 2000),
    budgetMaxWsReconnects: parseInteger("API_BUDGET_MAX_WS_RECONNECTS", env.API_BUDGET_MAX_WS_RECONNECTS, 50),
    budgetDailyMaxOrders: parseInteger("API_BUDGET_DAILY_MAX_ORDERS", env.API_BUDGET_DAILY_MAX_ORDERS, 2000),
    budgetDailyMaxCancels: parseInteger("API_BUDGET_DAILY_MAX_CANCELS", env.API_BUDGET_DAILY_MAX_CANCELS, 3000),
    budgetShutdownThreshold: parsePercent(env.API_BUDGET_SHUTDOWN_THRESHOLD, 0.1),
    budgetStatusEndpoint: env.API_BUDGET_STATUS_ENDPOINT || "",

    gptEnabled: openaiEnabled,
    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-4.1-mini",
    openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    openaiBudgetExceededAction: parseMode(env.OPENAI_BUDGET_EXCEEDED_ACTION || "disable", ["disable", "shutdown"], "disable"),
    gptDailyMaxTokens: parseInteger("GPT_DAILY_MAX_TOKENS", env.GPT_DAILY_MAX_TOKENS || env.OPENAI_DAILY_MAX_TOKENS, 200000),
    gptMaxCostUsd: parseNumber("GPT_MAX_COST_USD", env.GPT_MAX_COST_USD || env.OPENAI_MAX_COST_USD, 2.0),
    openaiMaxCalls: parseInteger("OPENAI_MAX_CALLS", env.OPENAI_MAX_CALLS || env.GPT_MAX_CALLS, 100),
    gptReportIntervalMs: parseInteger("GPT_REPORT_INTERVAL_MS", env.GPT_REPORT_INTERVAL_MS, 3600000),
    gptMaxInputChars: parseInteger("GPT_MAX_INPUT_CHARS", env.GPT_MAX_INPUT_CHARS, 12000),
    gptCanaryCycles: parseInteger("GPT_CANARY_CYCLES", env.GPT_CANARY_CYCLES, 40),
    gptProposalQuarantineCycles: parseInteger("GPT_PROPOSAL_QUARANTINE_CYCLES", env.GPT_PROPOSAL_QUARANTINE_CYCLES, 200),
    gptEstimatedUsdPer1kTokens: parseNumber("GPT_ESTIMATED_USD_PER_1K_TOKENS", env.GPT_ESTIMATED_USD_PER_1K_TOKENS, 0.002),

    banditExplorationCoef: parseNumber("BANDIT_EXPLORATION_COEF", env.BANDIT_EXPLORATION_COEF, 1.4),
    banditDecay: parseNumber("BANDIT_DECAY", env.BANDIT_DECAY, 0.995),
    unrealizedRewardWeight: parseNumber("UNREALIZED_REWARD_WEIGHT", env.UNREALIZED_REWARD_WEIGHT, 0.15),
    inventoryPenaltyBps: parseNumber("INVENTORY_PENALTY_BPS", env.INVENTORY_PENALTY_BPS, 1.5),
    drawdownPenaltyBps: parseNumber("DRAWDOWN_PENALTY_BPS", env.DRAWDOWN_PENALTY_BPS, 2.5),

    canaryMinRewardDeltaBps: parseNumber("CANARY_MIN_REWARD_DELTA_BPS", env.CANARY_MIN_REWARD_DELTA_BPS, 0),
    canaryRollbackDrawdownBps: parseNumber("CANARY_ROLLBACK_DRAWDOWN_BPS", env.CANARY_ROLLBACK_DRAWDOWN_BPS, 50),
    canaryRollbackErrorRate: parseNumber("CANARY_ROLLBACK_ERROR_RATE", env.CANARY_ROLLBACK_ERROR_RATE, 0.25),
    stabilityMinOrders: parseInteger("STABILITY_MIN_ORDERS", env.STABILITY_MIN_ORDERS, 10),
    stabilityMinCancelAttempts: parseInteger("STABILITY_MIN_CANCEL_ATTEMPTS", env.STABILITY_MIN_CANCEL_ATTEMPTS, 3),
    stabilityMinFillRate: parseNumber("STABILITY_MIN_FILL_RATE", env.STABILITY_MIN_FILL_RATE, 0.02),
    stabilityMaxRejectRate: parseNumber("STABILITY_MAX_REJECT_RATE", env.STABILITY_MAX_REJECT_RATE, 0.35),
    stabilityMaxSlippageBps: parseNumber("STABILITY_MAX_SLIPPAGE_BPS", env.STABILITY_MAX_SLIPPAGE_BPS, 18),
    stabilityMaxExceptionRate: parseNumber("STABILITY_MAX_EXCEPTION_RATE", env.STABILITY_MAX_EXCEPTION_RATE, 0.2),
    stabilityMaxCancelErrorRate: parseNumber("STABILITY_MAX_CANCEL_ERROR_RATE", env.STABILITY_MAX_CANCEL_ERROR_RATE, 0.8),
    stabilityMaxWsReconnectRatio: parseNumber("STABILITY_MAX_WS_RECONNECT_RATIO", env.STABILITY_MAX_WS_RECONNECT_RATIO, 0.8),
    stabilityMaxDrawdownBps: parseNumber("STABILITY_MAX_DRAWDOWN_BPS", env.STABILITY_MAX_DRAWDOWN_BPS, 350),
    stabilityFailAction: parseMode(env.STABILITY_FAIL_ACTION || "shutdown", ["warn", "shutdown"], "shutdown"),

    cancelOpenOrdersOnStop: parseBoolean(env.CANCEL_OPEN_ORDERS_ON_STOP, true),
    shutdownCleanupMaxRetries: parseInteger("SHUTDOWN_CLEANUP_MAX_RETRIES", env.SHUTDOWN_CLEANUP_MAX_RETRIES, 3),
    shutdownCleanupBackoffBaseMs: parseInteger("SHUTDOWN_CLEANUP_BACKOFF_BASE_MS", env.SHUTDOWN_CLEANUP_BACKOFF_BASE_MS, 500),
    dataDir: env.DATA_DIR || path.join(cwd, "data"),
    stateDir,
    streamDir: env.STREAM_DIR || path.join(cwd, "data", "streams"),
    rollupDir: env.ROLLUP_DIR || path.join(cwd, "data", "rollups"),
    runtimeKillSwitchFile: env.RUNTIME_KILL_SWITCH_FILE || path.join(stateDir, "KILL_SWITCH"),
    lineChannelId: env.LINE_CHANNEL_ID || "",
    lineChannelSecret: env.LINE_CHANNEL_SECRET || "",
    lineChannelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN || "",
    publicBaseUrl: env.PUBLIC_BASE_URL || "",
    lineWebhookPath: env.LINE_WEBHOOK_PATH || "/line/webhook",
    lineWebhookHost: env.LINE_WEBHOOK_HOST || "0.0.0.0",
    lineWebhookPort: parseInteger("LINE_WEBHOOK_PORT", env.LINE_WEBHOOK_PORT, 8787),
    lineAllowedUserIds: parseOptionalCsv(env.LINE_ALLOWED_USER_IDS),
    lineAskQuestionEnabled: parseBoolean(env.LINE_ASKQUESTION_ENABLED, true),
    lineAskQuestionCooldownMs: parseInteger("LINE_ASKQUESTION_COOLDOWN_MS", env.LINE_ASKQUESTION_COOLDOWN_MS, 300000),
    askQuestionCooldownMs: parseInteger(
      "ASKQUESTION_COOLDOWN_MS",
      env.ASKQUESTION_COOLDOWN_MS ?? env.LINE_ASKQUESTION_COOLDOWN_MS,
      1800000,
    ),
    askQuestionDailyMax: parseInteger("ASKQUESTION_DAILY_MAX", env.ASKQUESTION_DAILY_MAX, 8),
    askQuestionReasonCooldownMs: parseInteger(
      "ASKQUESTION_REASON_COOLDOWN_MS",
      env.ASKQUESTION_REASON_COOLDOWN_MS,
      7200000,
    ),
    askQuestionTtlDefaultActionFlat: parseMode(
      env.ASKQUESTION_TTL_DEFAULT_ACTION_FLAT || "hold",
      ["hold", "resume", "pause", "flatten", "cancel_orders"],
      "hold",
    ).toUpperCase(),
    askQuestionTtlDefaultActionInPosition: parseMode(
      env.ASKQUESTION_TTL_DEFAULT_ACTION_IN_POSITION || "flatten",
      ["hold", "resume", "pause", "flatten", "cancel_orders"],
      "flatten",
    ).toUpperCase(),
    dailyEvalEnabled: parseBoolean(env.DAILY_EVAL_ENABLED, true),
    dailyEvalAtUtc: parseUtcClock("DAILY_EVAL_AT_UTC", env.DAILY_EVAL_AT_UTC, "00:10"),
    llmExternalOnlyMode: true,
    rawMaxFileMb: parseNumber("RAW_MAX_FILE_MB", env.RAW_MAX_FILE_MB, 200),
    rawKeepDays: parseInteger("RAW_KEEP_DAYS", env.RAW_KEEP_DAYS, 3),
    compressedKeepDays: parseInteger("COMPRESSED_KEEP_DAYS", env.COMPRESSED_KEEP_DAYS, 30),
    rollupKeepDays: parseInteger("ROLLUP_KEEP_DAYS", env.ROLLUP_KEEP_DAYS, 365),
    rollupIntervalSec: parseInteger("ROLLUP_INTERVAL_SEC", env.ROLLUP_INTERVAL_SEC, 60),
    lifecycleIntervalMs: parseInteger("LIFECYCLE_INTERVAL_MS", env.LIFECYCLE_INTERVAL_MS, 60000),
    reportRawLookbackHours: parseNumber("REPORT_RAW_LOOKBACK_HOURS", env.REPORT_RAW_LOOKBACK_HOURS, 24),
    logLevel: env.LOG_LEVEL || "info",

    replaySpeed: parseNumber("REPLAY_SPEED", env.REPLAY_SPEED, 20),
    replayMaxEvents: parseInteger("REPLAY_MAX_EVENTS", env.REPLAY_MAX_EVENTS, 0),
  };
}
