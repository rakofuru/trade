function round(value, digits = 8) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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
}) {
  if (!qualityGate.pass) {
    return {
      blocked: true,
      reason: qualityGate.reason,
      coin,
      armId: arm.id,
      qualityGate,
    };
  }

  const params = {
    ...arm.params,
    ...(paramOverride?.params || {}),
  };

  if (Number(qualityGate?.expectedFillProb || 0) > 0 && Number(qualityGate.expectedFillProb) < 0.2) {
    return {
      blocked: true,
      reason: "expected_fill_prob_too_low",
      coin,
      armId: arm.id,
      qualityGate,
    };
  }

  const mid = marketData.mid(coin);
  if (!mid || !Number.isFinite(mid)) {
    return null;
  }

  if (arm.strategy === "momentum") {
    const lookback = Number(params.lookback);
    const volLookback = Number(params.volLookback || Math.max(lookback * 2, 20));
    const threshold = Number(params.signalThreshold);

    const ret = marketData.returns(coin, lookback);
    const vol = marketData.volatility(coin, volLookback);
    const trend = marketData.trendStrength(coin, lookback) ?? 0;

    if (ret === null || vol === null || vol <= 1e-9) {
      return null;
    }

    const score = ret / vol;
    if (Math.abs(score) < threshold) {
      return null;
    }

    const buy = score > 0;
    const slip = maxSlippageBps / 10000;
    const skew = Number(params.skewBps || 0) / 10000;
    const multiplier = buy ? 1 + slip + skew : 1 - slip - skew;

    return {
      coin,
      side: buy ? "buy" : "sell",
      sz: orderSize,
      limitPx: round(mid * multiplier, 6),
      tif: params.tif || "Ioc",
      reduceOnly: false,
      postOnly: false,
      strategy: arm.id,
      regime,
      explanation: {
        style: "momentum_vol_normalized",
        feature: { ret, vol, score, threshold, trend },
        quality: qualityGate,
      },
    };
  }

  if (arm.strategy === "mean_reversion") {
    const lookback = Number(params.lookback);
    const zEntry = Number(params.zEntry);
    const quoteBps = Number(params.quoteBps || 6) / 10000;

    const z = marketData.zScore(coin, lookback);
    const trend = Math.abs(marketData.trendStrength(coin, lookback) ?? 0);
    const book = marketData.lastBook(coin);

    if (z === null) {
      return null;
    }
    if (Math.abs(z) < zEntry) {
      return null;
    }

    // Avoid strong-trend adverse selection when trying to mean-revert.
    if (trend > 2.5) {
      return {
        blocked: true,
        reason: "adverse_selection_trend",
        coin,
        armId: arm.id,
        regime,
        explanation: { z, zEntry, trend, spreadBps: book?.spreadBps ?? null },
      };
    }

    const buy = z < 0;
    const multiplier = buy ? 1 - quoteBps : 1 + quoteBps;
    const tif = params.tif || "Alo";

    let limitPx = round(mid * multiplier, 6);
    if (tif.toLowerCase() === "alo") {
      const bestBid = Number(book?.bestBid ?? 0);
      const bestAsk = Number(book?.bestAsk ?? 0);
      const spread = Number(book?.spread ?? 0);
      const eps = Math.max(mid * 0.00005, spread > 0 ? spread * 0.6 : mid * 0.00005);
      if (buy && bestBid > 0) {
        limitPx = round(Math.min(limitPx, bestBid - eps), 6);
      }
      if (!buy && bestAsk > 0) {
        limitPx = round(Math.max(limitPx, bestAsk + eps), 6);
      }
    }

    return {
      coin,
      side: buy ? "buy" : "sell",
      sz: orderSize,
      limitPx,
      tif,
      reduceOnly: false,
      postOnly: tif.toLowerCase() === "alo",
      strategy: arm.id,
      regime,
      explanation: {
        style: "mean_reversion_with_microstructure_filter",
        feature: {
          z,
          zEntry,
          trend,
          spreadBps: book?.spreadBps ?? null,
          depth: Math.min(book?.bidDepth || 0, book?.askDepth || 0),
        },
        quality: qualityGate,
      },
    };
  }

  return null;
}
