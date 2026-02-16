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

function buildTrendSignal({
  coin,
  regime,
  marketData,
  orderSize,
  maxSlippageBps,
  qualityGate,
  config,
  symbolRules,
}) {
  const isUp = regime === "TREND_UP";
  const side = isUp ? "buy" : "sell";
  const book = marketData.lastBook(coin);
  const candles = marketData.candlesByInterval(coin, "1m");
  if (!book || candles.length < 30) {
    return null;
  }

  const emaSeries = marketData.emaSeries(coin, "1m", 20);
  if (emaSeries.length < 2) {
    return null;
  }
  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const emaNow = Number(emaSeries[emaSeries.length - 1].value || 0);
  const emaPrev = Number(emaSeries[emaSeries.length - 2].value || 0);
  if (!(emaNow > 0) || !(emaPrev > 0)) {
    return null;
  }

  const pullbackRecovered = isUp
    ? (Number(prevCandle.close || 0) < emaPrev && Number(currentCandle.close || 0) > emaNow)
    : (Number(prevCandle.close || 0) > emaPrev && Number(currentCandle.close || 0) < emaNow);
  if (!pullbackRecovered) {
    return null;
  }

  const aggressorRatio = marketData.recentAggressiveVolumeRatio(
    coin,
    Number(config.strategyTrendFlowWindowSec || 20),
    isUp ? "buy" : "sell",
  );
  if (!(Number(aggressorRatio || 0) >= Number(config.strategyTrendAggressorRatioMin || 0.55))) {
    return {
      blocked: true,
      reason: "TREND_FLOW_WEAK",
      coin,
      explanation: {
        aggressorRatio: Number(aggressorRatio || 0),
        min: Number(config.strategyTrendAggressorRatioMin || 0.55),
      },
    };
  }

  const imbalance = Number(marketData.top5Imbalance(coin) || 0);
  const imbalanceTh = Number(config.strategyTrendImbalanceThreshold || 0.1);
  if ((isUp && imbalance < imbalanceTh) || (!isUp && imbalance > -imbalanceTh)) {
    return {
      blocked: true,
      reason: "TREND_IMBALANCE_WEAK",
      coin,
      explanation: {
        imbalance,
        minAbs: imbalanceTh,
      },
    };
  }

  const mid = Number(book.mid || marketData.mid(coin) || 0);
  if (!(mid > 0)) {
    return null;
  }
  const tick = inferTick(book, mid);
  const makerPx = makerEntryPrice({ side, book, tick });
  if (!(makerPx > 0)) {
    return null;
  }

  const atrPct = Number(marketData.atrPercent(coin, "1m", 14) || 0);
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
    strategy: "trend_pullback",
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
      style: "trend_pullback_continuation",
      feature: {
        pullbackRecovered,
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
    return null;
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
    return null;
  }

  if (!hasNoBreakout(candles, Number(config.strategyRangeNoBreakoutBars || 2))) {
    return {
      blocked: true,
      reason: "RANGE_BREAKOUT_RISK",
      coin,
      explanation: {
        z,
      },
    };
  }

  const mid = Number(book.mid || marketData.mid(coin) || 0);
  if (!(mid > 0)) {
    return null;
  }
  const tick = inferTick(book, mid);
  const makerPx = makerEntryPrice({ side, book, tick });
  if (!(makerPx > 0)) {
    return null;
  }

  const atrPct = Number(marketData.atrPercent(coin, "1m", 14) || 0);
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
        z,
        zEntry,
        vwap,
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
}) {
  if (!qualityGate?.pass) {
    return {
      blocked: true,
      reason: qualityGate?.reason || "NO_TRADE_QUALITY_GATE",
      coin,
      armId: arm?.id || "n/a",
      explanation: {
        style: "quality_gate",
        feature: qualityGate || {},
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

  const symbolRules = selectSymbolRules(config, safeCoin);
  const noTrade = calcNoTradeGuards({
    coin: safeCoin,
    marketData,
    config,
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
        feature: noTrade.detail,
      },
    };
  }

  const regimeResult = classifyRegime({
    coin: safeCoin,
    marketData,
    config,
    symbolRules,
  });
  const nextRegime = regimeResult.regime;
  if (nextRegime === "NO_TRADE" || nextRegime === "TURBULENCE") {
    return {
      blocked: true,
      reason: nextRegime === "TURBULENCE" ? "NO_TRADE_TURBULENCE" : "NO_TRADE_REGIME",
      coin: safeCoin,
      armId: arm?.id || "n/a",
      regime: nextRegime,
      explanation: {
        style: "regime_filter",
        feature: regimeResult.detail,
      },
    };
  }

  const trend = buildTrendSignal({
    coin: safeCoin,
    regime: nextRegime,
    marketData,
    orderSize,
    maxSlippageBps,
    qualityGate,
    config,
    symbolRules,
  });
  if (trend?.blocked) {
    return {
      ...trend,
      armId: arm?.id || "n/a",
    };
  }
  if (trend && (nextRegime === "TREND_UP" || nextRegime === "TREND_DOWN")) {
    return trend;
  }

  const rangeSignal = buildRangeSignal({
    coin: safeCoin,
    regime: nextRegime,
    marketData,
    orderSize,
    qualityGate,
    config,
  });
  if (rangeSignal?.blocked) {
    return {
      ...rangeSignal,
      armId: arm?.id || "n/a",
    };
  }
  if (rangeSignal) {
    return rangeSignal;
  }

  return null;
}
