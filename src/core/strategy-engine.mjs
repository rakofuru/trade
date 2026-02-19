function round(value, digits = 8) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function selectSymbolRules(config, coin) {
  const safeCoin = String(coin || "").toUpperCase();
  const defaults = config.strategySymbolDefaults || {};
  const specific = (config.strategySymbolRules || {})[safeCoin] || {};
  return {
    ...defaults,
    ...specific,
  };
}

const entryPacingByCoin = new Map();
const regimeStateByCoin = new Map();
const feeCacheByUserKey = new Map();
let strategyProcessStartedAt = Date.now();

function normalizeBps(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    if (raw.endsWith("%")) {
      const pct = Number(raw.slice(0, -1));
      if (!Number.isFinite(pct)) {
        return null;
      }
      return pct * 100;
    }
    const asNumber = Number(raw);
    if (!Number.isFinite(asNumber)) {
      return null;
    }
    return normalizeBps(asNumber);
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }

  // Fractional fee rates (e.g. 0.0002 => 2bps).
  if (n < 0.05) {
    return n * 10000;
  }
  // Assume already bps if larger scalar.
  return n;
}

function deepCollectNumericByKey(obj, matcher, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) {
    return [];
  }
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      out.push(...deepCollectNumericByKey(value, matcher, depth + 1));
      continue;
    }
    if (!matcher(String(key || "").toLowerCase())) {
      continue;
    }
    const bps = normalizeBps(value);
    if (Number.isFinite(bps) && bps >= 0) {
      out.push(bps);
    }
  }
  return out;
}

function parseUserFeesBps(payload, fallbackMakerBps, fallbackTakerBps) {
  const root = payload && typeof payload === "object" ? payload : {};
  const candidates = [
    root,
    root.data,
    root.result,
    root.userFees,
    root.feeRates,
    root.fees,
  ].filter((x) => x && typeof x === "object");

  const makerKeys = [
    "maker", "makerfee", "makerfeerate", "add", "addrate", "useraddrate", "makerbps",
  ];
  const takerKeys = [
    "taker", "takerfee", "takerfeerate", "cross", "crossrate", "usercrossrate", "takerbps",
  ];
  const pickByKeys = (obj, keys) => {
    for (const key of keys) {
      if (!(key in obj)) {
        continue;
      }
      const bps = normalizeBps(obj[key]);
      if (Number.isFinite(bps) && bps >= 0) {
        return bps;
      }
    }
    return null;
  };

  let makerBps = null;
  let takerBps = null;
  for (const c of candidates) {
    if (makerBps === null) {
      makerBps = pickByKeys(c, makerKeys);
    }
    if (takerBps === null) {
      takerBps = pickByKeys(c, takerKeys);
    }
  }

  if (makerBps === null) {
    const vals = deepCollectNumericByKey(root, (k) => k.includes("maker") || k.includes("add"));
    if (vals.length) {
      makerBps = Math.min(...vals);
    }
  }
  if (takerBps === null) {
    const vals = deepCollectNumericByKey(root, (k) => k.includes("taker") || k.includes("cross"));
    if (vals.length) {
      takerBps = Math.max(...vals);
    }
  }

  return {
    makerBps: Number.isFinite(makerBps) ? makerBps : Number(fallbackMakerBps || 0),
    takerBps: Number.isFinite(takerBps) ? takerBps : Number(fallbackTakerBps || 0),
  };
}

function userFeeCacheKey(config) {
  const baseUrl = String(config?.httpUrl || "").trim();
  const user = String(config?.accountAddress || "").trim().toLowerCase();
  return `${baseUrl}|${user}`;
}

function feeFallback(config) {
  return {
    makerBps: Math.max(0, Number(config?.strategyFeeMakerBps ?? 1.8)),
    takerBps: Math.max(0, Number(config?.strategyFeeTakerBps ?? 3.6)),
  };
}

function maybeRefreshUserFees(config) {
  const key = userFeeCacheKey(config);
  if (!key || key === "|") {
    return;
  }
  if (!feeCacheByUserKey.has(key)) {
    const fallback = feeFallback(config);
    feeCacheByUserKey.set(key, {
      makerBps: fallback.makerBps,
      takerBps: fallback.takerBps,
      source: "fee_fallback",
      updatedAt: 0,
      lastAttemptAt: 0,
      inFlight: null,
    });
  }
  const state = feeCacheByUserKey.get(key);
  const now = Date.now();
  const refreshMs = Math.max(30_000, Number(config?.strategyFeeRefreshMs ?? 300_000));
  if (state.inFlight) {
    return;
  }
  if (state.lastAttemptAt > 0 && (now - state.lastAttemptAt) < refreshMs) {
    return;
  }
  const httpUrl = String(config?.httpUrl || "").trim();
  const accountAddress = String(config?.accountAddress || "").trim();
  if (!httpUrl || !accountAddress) {
    return;
  }

  state.lastAttemptAt = now;
  state.inFlight = (async () => {
    try {
      const response = await fetch(`${httpUrl}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "userFees",
          user: accountAddress,
        }),
      });
      if (!response.ok) {
        throw new Error(`userFees_http_${response.status}`);
      }
      const payload = await response.json();
      const fallback = feeFallback(config);
      const parsed = parseUserFeesBps(payload, fallback.makerBps, fallback.takerBps);
      state.makerBps = Math.max(0, Number(parsed.makerBps || fallback.makerBps));
      state.takerBps = Math.max(0, Number(parsed.takerBps || fallback.takerBps));
      state.source = "userFees";
      state.updatedAt = Date.now();
    } catch {
      // keep previous cached value and fallback source
      if (!(Number(state.updatedAt || 0) > 0)) {
        const fallback = feeFallback(config);
        state.makerBps = fallback.makerBps;
        state.takerBps = fallback.takerBps;
        state.source = "fee_fallback";
      }
    } finally {
      state.inFlight = null;
    }
  })();
}

function currentFeeSnapshot(config) {
  const key = userFeeCacheKey(config);
  if (!feeCacheByUserKey.has(key)) {
    const fallback = feeFallback(config);
    feeCacheByUserKey.set(key, {
      makerBps: fallback.makerBps,
      takerBps: fallback.takerBps,
      source: "fee_fallback",
      updatedAt: 0,
      lastAttemptAt: 0,
      inFlight: null,
    });
  }
  maybeRefreshUserFees(config);
  const state = feeCacheByUserKey.get(key);
  return {
    makerBps: Math.max(0, Number(state?.makerBps || feeFallback(config).makerBps)),
    takerBps: Math.max(0, Number(state?.takerBps || feeFallback(config).takerBps)),
    source: String(state?.source || "fee_fallback"),
    updatedAt: Number(state?.updatedAt || 0),
  };
}

function computeMinEdgeBps({
  coin,
  side,
  marketData,
  expectedNotionalUsd,
  atrPct,
  feeSnapshot,
  config,
  preferTakerCost = false,
}) {
  const baseBufferBps = Math.max(0, Number(config?.strategyMinEdgeBaseBps ?? 8));
  const safetyBufferBps = Math.max(0, Number(config?.strategyMinEdgeSafetyBufferBps ?? 1));
  const fallbackSlipBps = Math.max(0, Number(config?.strategyMinEdgeFallbackSlippageBps ?? 2));
  const makerSlipFactor = clamp(Number(config?.strategyMinEdgeMakerSlipFactor ?? 0.65), 0, 1);
  const volK = Math.max(0, Number(config?.strategyMinEdgeVolK ?? 1.5));

  const l2SlipRaw = marketData.estimateSlippageBps(coin, {
    side,
    notionalUsd: Math.max(5, Number(expectedNotionalUsd || 0)),
  });
  const l2SlipBps = Number.isFinite(Number(l2SlipRaw)) && Number(l2SlipRaw) >= 0
    ? Number(l2SlipRaw)
    : fallbackSlipBps;
  const effectiveSlippageBps = preferTakerCost
    ? l2SlipBps
    : (l2SlipBps * makerSlipFactor);
  const feeBps = preferTakerCost
    ? Number(feeSnapshot?.takerBps || 0)
    : Number(feeSnapshot?.makerBps || 0);
  const volAdjBps = Math.max(0, Number(atrPct || 0)) * volK;
  const minEdgeBps = feeBps + effectiveSlippageBps + baseBufferBps + safetyBufferBps + volAdjBps;

  return {
    minEdgeBps,
    feeBps,
    l2SlipBps,
    effectiveSlippageBps,
    baseBufferBps,
    safetyBufferBps,
    volAdjBps,
    feeSource: String(feeSnapshot?.source || "fee_fallback"),
  };
}

function resolveRegimeWithHysteresis({
  coin,
  candidateRegime,
  nowTs,
  config,
}) {
  const safeCoin = String(coin || "").toUpperCase();
  const now = Number(nowTs || Date.now());
  const minHoldMs = Math.max(0, Number(config?.strategyRegimeMinHoldMs ?? 600_000));
  const confirmBars = Math.max(1, Number(config?.strategyRegimeConfirmBars ?? 2));
  const flipWindowMs = Math.max(60_000, Number(config?.strategyRegimeFlipWindowMs ?? (30 * 60 * 1000)));
  const flipMaxInWindow = Math.max(1, Number(config?.strategyRegimeFlipMaxInWindow ?? 4));
  const flipCooldownMs = Math.max(0, Number(config?.strategyRegimeFlipCooldownMs ?? (5 * 60 * 1000)));

  if (!regimeStateByCoin.has(safeCoin)) {
    regimeStateByCoin.set(safeCoin, {
      stableRegime: String(candidateRegime || "NO_TRADE"),
      pendingRegime: null,
      pendingCount: 0,
      lastSwitchAt: now,
      flipTs: [],
      churnUntil: 0,
    });
  }
  const state = regimeStateByCoin.get(safeCoin);
  state.flipTs = (state.flipTs || [])
    .map((x) => Number(x || 0))
    .filter((x) => Number.isFinite(x) && (now - x) <= flipWindowMs);

  if (Number(state.churnUntil || 0) > now) {
    return {
      blocked: true,
      reason: "NO_TRADE_REGIME_FLIP_CHURN",
      reasonCode: "regime_flip_churn",
      regime: "NO_TRADE",
      detail: {
        stableRegime: state.stableRegime,
        candidateRegime: String(candidateRegime || "NO_TRADE"),
        churnUntil: Number(state.churnUntil || 0),
        waitMs: Number(state.churnUntil || 0) - now,
        flipsInWindow: state.flipTs.length,
      },
    };
  }

  if (String(candidateRegime || "") === String(state.stableRegime || "")) {
    state.pendingRegime = null;
    state.pendingCount = 0;
    regimeStateByCoin.set(safeCoin, state);
    return {
      blocked: false,
      regime: state.stableRegime,
      detail: {
        stableRegime: state.stableRegime,
        candidateRegime: candidateRegime,
        pendingCount: 0,
      },
    };
  }

  if (String(state.pendingRegime || "") === String(candidateRegime || "")) {
    state.pendingCount += 1;
  } else {
    state.pendingRegime = String(candidateRegime || "");
    state.pendingCount = 1;
  }

  const holdRemainingMs = Math.max(0, minHoldMs - (now - Number(state.lastSwitchAt || 0)));
  const confirmRemainingBars = Math.max(0, confirmBars - Number(state.pendingCount || 0));
  if (holdRemainingMs > 0 || confirmRemainingBars > 0) {
    regimeStateByCoin.set(safeCoin, state);
    return {
      blocked: true,
      reason: "NO_TRADE_REGIME_HOLD",
      reasonCode: "regime_hold",
      regime: "NO_TRADE",
      detail: {
        stableRegime: state.stableRegime,
        candidateRegime: String(candidateRegime || "NO_TRADE"),
        holdRemainingMs,
        confirmRemainingBars,
        pendingCount: Number(state.pendingCount || 0),
      },
    };
  }

  state.stableRegime = String(candidateRegime || "NO_TRADE");
  state.pendingRegime = null;
  state.pendingCount = 0;
  state.lastSwitchAt = now;
  state.flipTs.push(now);
  if (state.flipTs.length > flipMaxInWindow) {
    state.churnUntil = now + flipCooldownMs;
    regimeStateByCoin.set(safeCoin, state);
    return {
      blocked: true,
      reason: "NO_TRADE_REGIME_FLIP_CHURN",
      reasonCode: "regime_flip_churn",
      regime: "NO_TRADE",
      detail: {
        stableRegime: state.stableRegime,
        candidateRegime: String(candidateRegime || "NO_TRADE"),
        churnUntil: Number(state.churnUntil || 0),
        waitMs: Number(state.churnUntil || 0) - now,
        flipsInWindow: state.flipTs.length,
      },
    };
  }

  regimeStateByCoin.set(safeCoin, state);
  return {
    blocked: false,
    regime: state.stableRegime,
    detail: {
      stableRegime: state.stableRegime,
      switched: true,
      flipsInWindow: state.flipTs.length,
    },
  };
}

function coerceConfig(config, paramOverride = null) {
  if (!paramOverride || typeof paramOverride !== "object") {
    return config || {};
  }
  return {
    ...(config || {}),
    ...paramOverride,
  };
}

function entryPacingGate({
  coin,
  nowTs,
  maxEntriesPerHour,
  cooldownMs,
}) {
  const safeCoin = String(coin || "").toUpperCase();
  const now = Number(nowTs || Date.now());
  const maxPerHour = Math.max(1, Number(maxEntriesPerHour || 0));
  const coolMs = Math.max(0, Number(cooldownMs || 0));

  if (!entryPacingByCoin.has(safeCoin)) {
    entryPacingByCoin.set(safeCoin, {
      recentEntries: [],
      lastEntryAt: 0,
    });
  }
  const state = entryPacingByCoin.get(safeCoin);
  state.recentEntries = (state.recentEntries || [])
    .map((x) => Number(x || 0))
    .filter((x) => Number.isFinite(x) && (now - x) <= 3600_000);

  if (coolMs > 0 && Number(state.lastEntryAt || 0) > 0) {
    const waitMs = coolMs - (now - Number(state.lastEntryAt || 0));
    if (waitMs > 0) {
      return {
        blocked: true,
        reason: "NO_TRADE_ENTRY_COOLDOWN",
        reasonCode: "cooldown",
        detail: {
          cooldownMs: coolMs,
          waitMs,
          lastEntryAt: Number(state.lastEntryAt || 0),
        },
      };
    }
  }

  if (state.recentEntries.length >= maxPerHour) {
    const oldest = Number(state.recentEntries[0] || now);
    const waitMs = Math.max(0, 3600_000 - (now - oldest));
    return {
      blocked: true,
      reason: "NO_TRADE_ENTRY_HOURLY_LIMIT",
      reasonCode: "hourly_limit",
      detail: {
        limit: maxPerHour,
        used: state.recentEntries.length,
        waitMs,
      },
    };
  }

  state.recentEntries.push(now);
  state.lastEntryAt = now;
  entryPacingByCoin.set(safeCoin, state);
  return {
    blocked: false,
    detail: {
      limit: maxPerHour,
      used: state.recentEntries.length,
      cooldownMs: coolMs,
    },
  };
}

export function resetStrategyStateForTests() {
  entryPacingByCoin.clear();
  regimeStateByCoin.clear();
  feeCacheByUserKey.clear();
  strategyProcessStartedAt = Date.now();
}

function makerEntryPrice({ side, book, tick }) {
  const bestBid = Number(book?.bestBid || 0);
  const bestAsk = Number(book?.bestAsk || 0);
  if (!(bestBid > 0) || !(bestAsk > 0) || !(tick > 0)) {
    return null;
  }
  if (String(side || "").toLowerCase() === "buy") {
    const px = bestBid + tick;
    return Math.min(bestAsk - (tick * 0.25), Math.max(bestBid, px));
  }
  const px = bestAsk - tick;
  return Math.max(bestBid + (tick * 0.25), Math.min(bestAsk, px));
}

function inferTick(book, mid) {
  const spread = Number(book?.spread || 0);
  const anchor = Number(mid || 0);
  if (spread > 0) {
    return Math.max(spread * 0.2, anchor * 0.00001);
  }
  if (anchor > 0) {
    return anchor * 0.00001;
  }
  return 0;
}

function calcNoTradeGuards({
  coin,
  marketData,
  config,
  symbolRules,
  expectedNotionalUsd,
}) {
  const stale = marketData.hasStaleData(coin, {
    candleMaxAgeMs: Number(config.strategyDataStaleCandleMs || 90_000),
    bookMaxAgeMs: Number(config.strategyDataStaleBookMs || 20_000),
    tradesMaxAgeMs: Number(config.strategyDataStaleTradesMs || 20_000),
  });
  if (stale.stale) {
    return {
      blocked: true,
      reason: "NO_TRADE_STALE_DATA",
      detail: stale,
    };
  }

  const book = marketData.lastBook(coin);
  const spreadBps = Number(book?.spreadBps || 0);
  if (!(spreadBps > 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_BOOK_MISSING",
      detail: {
        spreadBps,
      },
    };
  }

  if (spreadBps > Number(symbolRules.makerSpreadBps || 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_SPREAD",
      detail: {
        spreadBps,
        limit: Number(symbolRules.makerSpreadBps || 0),
      },
    };
  }

  const makerSlip = marketData.estimateSlippageBps(coin, {
    side: "buy",
    notionalUsd: Math.max(5, Number(expectedNotionalUsd || 0)),
  });
  if (makerSlip !== null && Number(makerSlip) > Number(symbolRules.makerSlippageBps || 999)) {
    return {
      blocked: true,
      reason: "NO_TRADE_SLIPPAGE",
      detail: {
        makerSlipBps: Number(makerSlip),
        limit: Number(symbolRules.makerSlippageBps || 0),
      },
    };
  }

  return {
    blocked: false,
    reason: null,
    detail: {
      spreadBps,
      makerSlipBps: makerSlip,
    },
  };
}

export function classifyRegime({
  coin,
  marketData,
  config,
  symbolRules,
}) {
  const atrPct = Number(marketData.atrPercent(coin, "1m", 14) || 0);
  const atrSeries = marketData.atrPercentSeries(coin, "1m", 14, 120);
  const atrMedian = median(atrSeries);
  const ret1mPct = Math.abs(Number(marketData.recentCloseReturnPct(coin, "1m", 1) || 0));

  const ema20_15m = Number(marketData.ema(coin, "15m", 20) || 0);
  const ema50_15m = Number(marketData.ema(coin, "15m", 50) || 0);
  const adx5m = Number(marketData.adx(coin, "5m", 14) || 0);
  const emaGapBps = (ema50_15m > 0 && ema20_15m > 0)
    ? Math.abs(((ema20_15m - ema50_15m) / ema50_15m) * 10000)
    : 0;

  if (
    (atrMedian > 0 && atrPct >= (atrMedian * Number(config.strategyTurbulenceAtrMedianMult || 1.8)))
    || ret1mPct >= Number(symbolRules.turbulenceRet1mPct || 999)
  ) {
    return {
      regime: "TURBULENCE",
      detail: {
        atrPct,
        atrMedian,
        ret1mPct,
      },
    };
  }

  const trendAdx = Number(config.strategyTrendAdxMin || 20);
  const rangeAdx = Number(config.strategyRangeAdxMax || 15);
  const trendEmaGapMin = Number(config.strategyTrendEmaGapBpsMin || 8);
  const rangeEmaGapMax = Number(config.strategyRangeEmaGapBpsMax || 4);

  if (adx5m >= trendAdx && emaGapBps >= trendEmaGapMin && ema20_15m > 0 && ema50_15m > 0) {
    return {
      regime: ema20_15m > ema50_15m ? "TREND_UP" : "TREND_DOWN",
      detail: {
        atrPct,
        adx5m,
        ema20_15m,
        ema50_15m,
        emaGapBps,
        ret1mPct,
      },
    };
  }

  if (adx5m <= rangeAdx && emaGapBps <= rangeEmaGapMax) {
    return {
      regime: "RANGE",
      detail: {
        atrPct,
        adx5m,
        ema20_15m,
        ema50_15m,
        emaGapBps,
        ret1mPct,
      },
    };
  }

  return {
    regime: "NO_TRADE",
    detail: {
      atrPct,
      adx5m,
      ema20_15m,
      ema50_15m,
      emaGapBps,
      ret1mPct,
    },
  };
}

function candleBodyRatio(candle) {
  const open = Number(candle?.open || 0);
  const close = Number(candle?.close || 0);
  const high = Number(candle?.high || 0);
  const low = Number(candle?.low || 0);
  const span = Math.max(1e-12, high - low);
  return Math.abs(close - open) / span;
}

function computeBreakoutContext({
  candles,
  side,
  lookbackBars,
  confirmBars,
  bufferBps,
}) {
  const lookback = Math.max(5, Number(lookbackBars || 20));
  const confirm = Math.max(1, Number(confirmBars || 2));
  const needed = lookback + confirm + 1;
  if (!Array.isArray(candles) || candles.length < needed) {
    return null;
  }

  const reference = candles.slice(-(lookback + confirm), -confirm);
  const confirmSlice = candles.slice(-confirm);
  if (!reference.length || !confirmSlice.length) {
    return null;
  }

  const sign = String(side || "").toLowerCase() === "sell" ? -1 : 1;
  const level = sign > 0
    ? Math.max(...reference.map((x) => Number(x.high || 0)))
    : Math.min(...reference.map((x) => Number(x.low || 0)));
  if (!(level > 0)) {
    return null;
  }

  const threshold = sign > 0
    ? level * (1 + (Number(bufferBps || 0) / 10000))
    : level * (1 - (Number(bufferBps || 0) / 10000));
  const refLastClose = Number(reference[reference.length - 1]?.close || 0);
  const confirms = confirmSlice.every((c) => {
    const close = Number(c?.close || 0);
    return sign > 0 ? close > threshold : close < threshold;
  });
  const wasBelowOrAt = sign > 0 ? refLastClose <= threshold : refLastClose >= threshold;
  const latestClose = Number(confirmSlice[confirmSlice.length - 1]?.close || 0);
  const breakDistancePct = Math.abs(((latestClose - level) / level) * 100);

  return {
    confirms,
    wasBelowOrAt,
    level,
    threshold,
    latestClose,
    breakDistancePct,
  };
}

function buildTrendSignal({
  coin,
  regime,
  marketData,
  orderSize,
  expectedNotionalUsd,
  maxSlippageBps,
  qualityGate,
  config,
  symbolRules,
  feeSnapshot,
}) {
  if (regime !== "TREND_UP" && regime !== "TREND_DOWN") {
    return null;
  }
  const isUp = regime === "TREND_UP";
  const side = isUp ? "buy" : "sell";
  const book = marketData.lastBook(coin);
  const candles = marketData.candlesByInterval(coin, "1m");
  if (!book || candles.length < 60) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_DATA",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "trend_data_missing",
          hasBook: Boolean(book),
          candleCount: Array.isArray(candles) ? candles.length : 0,
          minCandles: 60,
        },
      },
    };
  }

  const breakout = computeBreakoutContext({
    candles,
    side,
    lookbackBars: Number(config.strategyTrendBreakoutLookbackBars || 20),
    confirmBars: Number(config.strategyTrendBreakoutConfirmBars || 2),
    bufferBps: Number(config.strategyTrendBreakoutBufferBps || 3),
  });
  if (!breakout || !breakout.confirms || !breakout.wasBelowOrAt) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_BREAKOUT_CONFIRM",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "breakout_not_confirmed",
          breakoutFound: Boolean(breakout),
          confirms: Boolean(breakout?.confirms),
          wasBelowOrAt: Boolean(breakout?.wasBelowOrAt),
          breakoutDistancePct: Number(breakout?.breakDistancePct || 0),
        },
      },
    };
  }

  const currentCandle = candles[candles.length - 1];
  const bodyRatio = candleBodyRatio(currentCandle);
  const minBodyRatio = Number(config.strategyTrendBreakoutMinBodyRatio || 0.35);
  if (bodyRatio < minBodyRatio) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_BREAKOUT_BODY",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "breakout_body_fail",
          bodyRatio,
          minBodyRatio,
        },
      },
    };
  }

  const ret1mPct = Math.abs(Number(marketData.recentCloseReturnPct(coin, "1m", 1) || 0));
  const maxRet1mPct = Number(config.strategyTrendBreakoutMaxRet1mPct || 1.2);
  if (ret1mPct > maxRet1mPct) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_BREAKOUT_SPIKE",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "breakout_spike_fail",
          ret1mPct,
          maxRet1mPct,
        },
      },
    };
  }

  const atrPct = Number(marketData.atrPercent(coin, "1m", 14) || 0);
  const breakoutBps = Number(breakout.breakDistancePct || 0) * 100;
  const minEdge = computeMinEdgeBps({
    coin,
    side,
    marketData,
    expectedNotionalUsd,
    atrPct,
    feeSnapshot,
    config,
    // trend entries can fallback to IOC; keep minEdge conservative.
    preferTakerCost: true,
  });
  if (!(breakoutBps >= Number(minEdge.minEdgeBps || 0))) {
    return {
      blocked: true,
      reason: "NO_TRADE_BREAKOUT_MIN_EDGE",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "breakout_minEdge_fail",
          breakoutBps,
          minEdgeBps: Number(minEdge.minEdgeBps || 0),
          feeBps: Number(minEdge.feeBps || 0),
          slippageBps: Number(minEdge.effectiveSlippageBps || 0),
          l2SlipBps: Number(minEdge.l2SlipBps || 0),
          baseBufferBps: Number(minEdge.baseBufferBps || 0),
          safetyBufferBps: Number(minEdge.safetyBufferBps || 0),
          volAdjBps: Number(minEdge.volAdjBps || 0),
          feeSource: minEdge.feeSource,
          ret1mPct,
          atrPct,
        },
      },
    };
  }

  const aggressorRatio = marketData.recentAggressiveVolumeRatio(
    coin,
    Number(config.strategyTrendFlowWindowSec || 20),
    isUp ? "buy" : "sell",
  );
  if (!(Number(aggressorRatio || 0) >= Number(config.strategyTrendAggressorRatioMin || 0.55))) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_FLOW_WEAK",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "trend_flow_weak",
          aggressorRatio: Number(aggressorRatio || 0),
          min: Number(config.strategyTrendAggressorRatioMin || 0.55),
          breakoutBps,
          minEdgeBps: Number(minEdge.minEdgeBps || 0),
          ret1mPct,
          atrPct,
        },
      },
    };
  }

  const imbalance = Number(marketData.top5Imbalance(coin) || 0);
  const imbalanceTh = Number(config.strategyTrendImbalanceThreshold || 0.1);
  if ((isUp && imbalance < imbalanceTh) || (!isUp && imbalance > -imbalanceTh)) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_IMBALANCE_WEAK",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "trend_imbalance_weak",
          imbalance,
          minAbs: imbalanceTh,
          breakoutBps,
          minEdgeBps: Number(minEdge.minEdgeBps || 0),
          ret1mPct,
          atrPct,
        },
      },
    };
  }

  const mid = Number(book.mid || marketData.mid(coin) || 0);
  if (!(mid > 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_BOOK_INVALID",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "book_mid_invalid",
          mid,
        },
      },
    };
  }
  const tick = inferTick(book, mid);
  const makerPx = makerEntryPrice({ side, book, tick });
  if (!(makerPx > 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_TREND_PRICE_INVALID",
      coin,
      explanation: {
        style: "trend_breakout_filter",
        feature: {
          reasonCode: "maker_price_invalid",
          tick,
          bestBid: Number(book?.bestBid || 0),
          bestAsk: Number(book?.bestAsk || 0),
          mid,
        },
      },
    };
  }

  const slPct = clamp(
    Math.max(Number(config.strategyTrendSlMinPct || 0.45), Number(config.strategyTrendSlAtrMult || 1.2) * atrPct),
    Number(config.strategyTrendSlMinPct || 0.45),
    Number(config.strategyTrendSlMaxPct || 0.90),
  );
  const tpPct = Number(config.strategyTrendTpMult || 1.3) * slPct;

  const slip = maxSlippageBps / 10000;
  const fallbackPx = side === "buy"
    ? Number(book.bestAsk || makerPx) * (1 + slip)
    : Number(book.bestBid || makerPx) * (1 - slip);

  return {
    coin,
    side,
    sz: orderSize,
    limitPx: round(makerPx, 6),
    fallbackIocPx: round(fallbackPx, 6),
    tif: "Alo",
    reduceOnly: false,
    postOnly: true,
    strategy: "trend_breakout",
    regime,
    ttlMs: Number(config.strategyTrendMakerTtlMs || 8000),
    allowTakerAfterTtl: true,
    takerTriggerMovePct: Number(symbolRules.trendTakerTriggerPct || 0.12),
    makerOnly: false,
    protectionPlan: {
      kind: "trend",
      slPct,
      tpPct,
      timeStopMs: Number(config.strategyTrendTimeStopMs || (12 * 60 * 1000)),
      timeStopProgressR: Number(config.strategyTrendTimeStopProgressR || 0.4),
    },
    explanation: {
      style: "trend_breakout_continuation",
      feature: {
        reasonCode: "trend_breakout_entry",
        breakoutLevel: Number(breakout.level || 0),
        breakoutThreshold: Number(breakout.threshold || 0),
        breakoutDistancePct: Number(breakout.breakDistancePct || 0),
        breakoutBps,
        minEdgeBps: Number(minEdge.minEdgeBps || 0),
        feeBps: Number(minEdge.feeBps || 0),
        slippageBps: Number(minEdge.effectiveSlippageBps || 0),
        l2SlipBps: Number(minEdge.l2SlipBps || 0),
        baseBufferBps: Number(minEdge.baseBufferBps || 0),
        safetyBufferBps: Number(minEdge.safetyBufferBps || 0),
        volAdjBps: Number(minEdge.volAdjBps || 0),
        feeSource: minEdge.feeSource,
        expectedNotionalUsd: Number(expectedNotionalUsd || 0),
        ret1mPct,
        atrPct,
        bodyRatio,
        aggressorRatio: Number(aggressorRatio || 0),
        imbalance,
        spreadBps: Number(book.spreadBps || 0),
        slPct,
        tpPct,
      },
      quality: qualityGate,
    },
  };
}

function buildRangeSignal({
  coin,
  regime,
  marketData,
  orderSize,
  qualityGate,
  config,
}) {
  if (regime !== "RANGE") {
    return null;
  }
  const book = marketData.lastBook(coin);
  const candles = marketData.candlesByInterval(coin, "1m");
  if (!book || candles.length < 80) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_DATA",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "range_data_missing",
          hasBook: Boolean(book),
          candleCount: Array.isArray(candles) ? candles.length : 0,
          minCandles: 80,
        },
      },
    };
  }

  const z = Number(marketData.zScoreFromVwap(coin, "1m", 60) || 0);
  const zEntry = Number(config.strategyRangeZEntry || 2.0);
  let side = null;
  if (z <= -zEntry) {
    side = "buy";
  } else if (z >= zEntry) {
    side = "sell";
  }
  if (!side) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_Z_SCORE",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "range_z_not_extreme",
          z,
          zEntry,
        },
      },
    };
  }

  const atrPct = Number(marketData.atrPercent(coin, "1m", 14) || 0);
  const maxAtrPct = Number(config.strategyRangeMaxAtrPct || 0.90);
  if (atrPct > maxAtrPct) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_ATR",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "range_atr_block",
          atrPct,
          maxAtrPct,
          z,
          zEntry,
        },
      },
    };
  }

  const ret1mPct = Math.abs(Number(marketData.recentCloseReturnPct(coin, "1m", 1) || 0));
  const maxRet1mPct = Number(config.strategyRangeMaxRet1mPct || 0.45);
  if (ret1mPct > maxRet1mPct) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_SHOCK",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "range_shock_block",
          ret1mPct,
          maxRet1mPct,
          atrPct,
          z,
          zEntry,
        },
      },
    };
  }

  if (!hasNoBreakout(candles, Number(config.strategyRangeNoBreakoutBars || 2))) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_BREAKOUT_RISK",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "range_breakout_risk",
          z,
          zEntry,
          ret1mPct,
          atrPct,
        },
      },
    };
  }

  const mid = Number(book.mid || marketData.mid(coin) || 0);
  if (!(mid > 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_BOOK_INVALID",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "book_mid_invalid",
          mid,
          z,
          zEntry,
          ret1mPct,
          atrPct,
        },
      },
    };
  }
  const tick = inferTick(book, mid);
  const makerPx = makerEntryPrice({ side, book, tick });
  if (!(makerPx > 0)) {
    return {
      blocked: true,
      reason: "NO_TRADE_RANGE_PRICE_INVALID",
      coin,
      explanation: {
        style: "range_filter",
        feature: {
          reasonCode: "maker_price_invalid",
          tick,
          bestBid: Number(book?.bestBid || 0),
          bestAsk: Number(book?.bestAsk || 0),
          mid,
          z,
          zEntry,
          ret1mPct,
          atrPct,
        },
      },
    };
  }

  const slPct = clamp(
    Math.max(Number(config.strategyRangeSlMinPct || 0.55), Number(config.strategyRangeSlAtrMult || 1.5) * atrPct),
    Number(config.strategyRangeSlMinPct || 0.55),
    Number(config.strategyRangeSlMaxPct || 1.2),
  );
  const oneRTargetPct = Number(config.strategyRangeOneRTpMult || 1.0) * slPct;
  const vwap = Number(marketData.vwap(coin, "1m", 60) || 0);
  const tpPct = pickRangeTakeProfitPct({
    side,
    entryPx: makerPx,
    oneRTargetPct,
    vwap,
  });

  return {
    coin,
    side,
    sz: orderSize,
    limitPx: round(makerPx, 6),
    fallbackIocPx: null,
    tif: "Alo",
    reduceOnly: false,
    postOnly: true,
    strategy: "range_vwap_reversion",
    regime,
    ttlMs: Number(config.strategyRangeMakerTtlMs || 10000),
    allowTakerAfterTtl: false,
    takerTriggerMovePct: null,
    makerOnly: true,
    protectionPlan: {
      kind: "range",
      slPct,
      tpPct,
      timeStopMs: Number(config.strategyRangeTimeStopMs || (6 * 60 * 1000)),
      timeStopProgressR: Number(config.strategyRangeTimeStopProgressR || 0.3),
    },
    explanation: {
      style: "range_vwap_mean_reversion",
      feature: {
        reasonCode: "range_reversion_entry",
        z,
        zEntry,
        vwap,
        ret1mPct,
        atrPct,
        slPct,
        tpPct,
        spreadBps: Number(book.spreadBps || 0),
      },
      quality: qualityGate,
    },
  };
}

function pickRangeTakeProfitPct({
  side,
  entryPx,
  oneRTargetPct,
  vwap,
}) {
  const entry = Number(entryPx || 0);
  const tp1Pct = Number(oneRTargetPct || 0);
  const candidates = [];
  if (entry > 0 && tp1Pct > 0) {
    candidates.push(tp1Pct);
  }
  if (entry > 0 && vwap > 0) {
    const favorable = side === "buy" ? vwap > entry : vwap < entry;
    if (favorable) {
      candidates.push(Math.abs(((vwap - entry) / entry) * 100));
    }
  }
  if (!candidates.length) {
    return Math.max(0.1, tp1Pct);
  }
  return Math.min(...candidates);
}

function hasNoBreakout(candles, bars = 2) {
  const n = Math.max(2, Number(bars || 2));
  if (candles.length < n + 1) {
    return false;
  }
  const recent = candles.slice(-(n + 1));
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (Number(curr.high || 0) > Number(prev.high || 0)) {
      return false;
    }
    if (Number(curr.low || 0) < Number(prev.low || 0)) {
      return false;
    }
  }
  return true;
}

function median(values) {
  const arr = (values || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  if (!arr.length) {
    return 0;
  }
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 0) {
    return (arr[mid - 1] + arr[mid]) / 2;
  }
  return arr[mid];
}

export function buildSignal({
  arm,
  coin,
  regime,
  marketData,
  orderSize,
  maxSlippageBps,
  qualityGate,
  paramOverride = null,
  config = {},
  expectedNotionalUsd = 0,
  nowTs = Date.now(),
}) {
  const now = Number(nowTs || Date.now());
  const reasonCodeFromReason = (reason) => String(reason || "unknown")
    .toLowerCase()
    .replace(/^no_trade_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";

  if (!qualityGate?.pass) {
    const reason = qualityGate?.reason || "NO_TRADE_QUALITY_GATE";
    return {
      blocked: true,
      reason,
      coin,
      armId: arm?.id || "n/a",
      explanation: {
        style: "quality_gate",
        feature: {
          ...(qualityGate || {}),
          reasonCode: reasonCodeFromReason(reason),
        },
      },
    };
  }
  const safeCoin = String(coin || "").toUpperCase();
  if (!["BTC", "ETH"].includes(safeCoin)) {
    return {
      blocked: true,
      reason: "NO_TRADE_UNSUPPORTED_SYMBOL",
      coin,
      armId: arm?.id || "n/a",
    };
  }

  const strategyConfig = coerceConfig(config, paramOverride);
  const restartNoTradeMs = Math.max(0, Number(strategyConfig.strategyRestartNoTradeMs ?? 300000));
  const elapsedSinceStartMs = Math.max(0, now - strategyProcessStartedAt);
  if (restartNoTradeMs > 0 && elapsedSinceStartMs < restartNoTradeMs) {
    return {
      blocked: true,
      reason: "NO_TRADE_RESTART_WARMUP",
      coin: safeCoin,
      armId: arm?.id || "n/a",
      regime: "NO_TRADE",
      explanation: {
        style: "restart_warmup_guard",
        feature: {
          reasonCode: "restart_warmup",
          restartNoTradeMs,
          elapsedSinceStartMs,
          waitMs: restartNoTradeMs - elapsedSinceStartMs,
        },
      },
    };
  }

  const symbolRules = selectSymbolRules(strategyConfig, safeCoin);
  const noTrade = calcNoTradeGuards({
    coin: safeCoin,
    marketData,
    config: strategyConfig,
    symbolRules,
    expectedNotionalUsd,
  });
  if (noTrade.blocked) {
    return {
      blocked: true,
      reason: noTrade.reason,
      coin: safeCoin,
      armId: arm?.id || "n/a",
      regime: "NO_TRADE",
      explanation: {
        style: "no_trade_guard",
        feature: {
          ...(noTrade.detail || {}),
          reasonCode: reasonCodeFromReason(noTrade.reason),
        },
      },
    };
  }

  const regimeResult = classifyRegime({
    coin: safeCoin,
    marketData,
    config: strategyConfig,
    symbolRules,
  });
  const candidateRegime = String(regimeResult.regime || "NO_TRADE");
  if (candidateRegime === "NO_TRADE" || candidateRegime === "TURBULENCE") {
    const reason = candidateRegime === "TURBULENCE" ? "NO_TRADE_TURBULENCE" : "NO_TRADE_REGIME";
    return {
      blocked: true,
      reason,
      coin: safeCoin,
      armId: arm?.id || "n/a",
      regime: candidateRegime,
      explanation: {
        style: "regime_filter",
        feature: {
          ...(regimeResult.detail || {}),
          reasonCode: reasonCodeFromReason(reason),
          candidateRegime,
        },
      },
    };
  }

  const hysteresis = resolveRegimeWithHysteresis({
    coin: safeCoin,
    candidateRegime,
    nowTs: now,
    config: strategyConfig,
  });
  if (hysteresis.blocked) {
    return {
      blocked: true,
      reason: hysteresis.reason || "NO_TRADE_REGIME_HOLD",
      coin: safeCoin,
      armId: arm?.id || "n/a",
      regime: String(hysteresis.regime || "NO_TRADE"),
      explanation: {
        style: "regime_hysteresis_guard",
        feature: {
          ...(hysteresis.detail || {}),
          reasonCode: String(hysteresis.reasonCode || reasonCodeFromReason(hysteresis.reason)),
          candidateRegime,
        },
      },
    };
  }
  const nextRegime = String(hysteresis.regime || candidateRegime);
  const feeSnapshot = currentFeeSnapshot(strategyConfig);

  const trend = buildTrendSignal({
    coin: safeCoin,
    regime: nextRegime,
    marketData,
    orderSize,
    expectedNotionalUsd,
    maxSlippageBps,
    qualityGate,
    config: strategyConfig,
    symbolRules,
    feeSnapshot,
  });
  if (trend?.blocked) {
    return {
      ...trend,
      armId: arm?.id || "n/a",
      regime: nextRegime,
      explanation: {
        style: trend.explanation?.style || "trend_breakout_filter",
        feature: {
          ...(trend.explanation?.feature || {}),
          reasonCode: String(
            trend.explanation?.feature?.reasonCode
            || trend.explanation?.reasonCode
            || reasonCodeFromReason(trend.reason),
          ),
          candidateRegime,
          stableRegime: nextRegime,
        },
      },
    };
  }
  if (trend && (nextRegime === "TREND_UP" || nextRegime === "TREND_DOWN")) {
    const configuredMaxEntries = Number(strategyConfig.strategyMaxEntriesPerCoinPerHour);
    const configuredCooldownMs = Number(strategyConfig.strategyEntryCooldownMs);
    const pace = entryPacingGate({
      coin: safeCoin,
      nowTs,
      maxEntriesPerHour: Number.isFinite(configuredMaxEntries) && configuredMaxEntries > 0
        ? configuredMaxEntries
        : 4,
      cooldownMs: Number.isFinite(configuredCooldownMs) && configuredCooldownMs >= 0
        ? configuredCooldownMs
        : (3 * 60 * 1000),
    });
    if (pace.blocked) {
      return {
        blocked: true,
        reason: pace.reason,
        coin: safeCoin,
        armId: arm?.id || "n/a",
        regime: nextRegime,
        explanation: {
          style: "entry_pacing_guard",
          feature: {
            ...(pace.detail || {}),
            reasonCode: String(pace.reasonCode || reasonCodeFromReason(pace.reason)),
          },
        },
      };
    }
    return {
      ...trend,
      explanation: {
        ...(trend.explanation || {}),
        feature: {
          ...((trend.explanation && trend.explanation.feature) ? trend.explanation.feature : {}),
          reasonCode: String(
            trend.explanation?.feature?.reasonCode
            || trend.explanation?.reasonCode
            || "trend_breakout_entry"
          ),
          candidateRegime,
          stableRegime: nextRegime,
          feeSnapshot: {
            makerBps: Number(feeSnapshot?.makerBps || 0),
            takerBps: Number(feeSnapshot?.takerBps || 0),
            source: String(feeSnapshot?.source || "fee_fallback"),
          },
          entryPacing: pace.detail,
        },
      },
    };
  }

  const rangeSignal = buildRangeSignal({
    coin: safeCoin,
    regime: nextRegime,
    marketData,
    orderSize,
    qualityGate,
    config: strategyConfig,
  });
  if (rangeSignal?.blocked) {
    return {
      ...rangeSignal,
      armId: arm?.id || "n/a",
      regime: nextRegime,
      explanation: {
        style: rangeSignal.explanation?.style || "range_filter",
        feature: {
          ...(rangeSignal.explanation?.feature || {}),
          reasonCode: String(
            rangeSignal.explanation?.feature?.reasonCode
            || rangeSignal.explanation?.reasonCode
            || reasonCodeFromReason(rangeSignal.reason),
          ),
          candidateRegime,
          stableRegime: nextRegime,
        },
      },
    };
  }
  if (rangeSignal) {
    const configuredMaxEntries = Number(strategyConfig.strategyMaxEntriesPerCoinPerHour);
    const configuredCooldownMs = Number(strategyConfig.strategyEntryCooldownMs);
    const pace = entryPacingGate({
      coin: safeCoin,
      nowTs,
      maxEntriesPerHour: Number.isFinite(configuredMaxEntries) && configuredMaxEntries > 0
        ? configuredMaxEntries
        : 4,
      cooldownMs: Number.isFinite(configuredCooldownMs) && configuredCooldownMs >= 0
        ? configuredCooldownMs
        : (3 * 60 * 1000),
    });
    if (pace.blocked) {
      return {
        blocked: true,
        reason: pace.reason,
        coin: safeCoin,
        armId: arm?.id || "n/a",
        regime: nextRegime,
        explanation: {
          style: "entry_pacing_guard",
          feature: {
            ...(pace.detail || {}),
            reasonCode: String(pace.reasonCode || reasonCodeFromReason(pace.reason)),
          },
        },
      };
    }
    return {
      ...rangeSignal,
      explanation: {
        ...(rangeSignal.explanation || {}),
        feature: {
          ...((rangeSignal.explanation && rangeSignal.explanation.feature) ? rangeSignal.explanation.feature : {}),
          reasonCode: String(
            rangeSignal.explanation?.feature?.reasonCode
            || rangeSignal.explanation?.reasonCode
            || "range_reversion_entry"
          ),
          candidateRegime,
          stableRegime: nextRegime,
          entryPacing: pace.detail,
        },
      },
    };
  }

  return null;
}
