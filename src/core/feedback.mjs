function createBucket() {
  return {
    trades: 0,
    fills: 0,
    realizedPnl: 0,
    fees: 0,
    slippageUsd: 0,
    notional: 0,
    wins: 0,
    losses: 0,
    maker: 0,
    taker: 0,
    latencyMsSum: 0,
    latencySamples: 0,
    rewardBpsSum: 0,
    rewardSamples: 0,
    rewardSqSum: 0,
    maxDrawdownBps: 0,
    errors: 0,
  };
}

function updateBucket(bucket, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number") {
      bucket[k] = (bucket[k] || 0) + v;
    }
  }
}

function ensureMapBucket(mapObj, key) {
  if (!mapObj[key]) {
    mapObj[key] = createBucket();
  }
  return mapObj[key];
}

export class FeedbackLoop {
  constructor({ storage, config, initialState = null }) {
    this.storage = storage;
    this.config = config;

    this.metrics = {
      global: createBucket(),
      byArm: {},
      byCoin: {},
      byRegime: {},
      byExecType: {},
      drawdownBps: 0,
      peakEquity: null,
      lastEquity: null,
      lastUnrealized: 0,
    };

    this.seenFills = new Set();
    this.recentExecution = [];

    if (initialState) {
      this.load(initialState);
    }
  }

  load(state) {
    if (!state || typeof state !== "object") {
      return;
    }

    this.metrics = {
      ...this.metrics,
      ...(state.metrics || {}),
      global: {
        ...createBucket(),
        ...(state.metrics?.global || {}),
      },
      byArm: state.metrics?.byArm || {},
      byCoin: state.metrics?.byCoin || {},
      byRegime: state.metrics?.byRegime || {},
      byExecType: state.metrics?.byExecType || {},
    };

    this.seenFills = new Set(state.seenFills || []);
    this.recentExecution = Array.isArray(state.recentExecution) ? state.recentExecution : [];
  }

  snapshot() {
    return {
      metrics: this.metrics,
      seenFills: Array.from(this.seenFills).slice(-10000),
      recentExecution: this.recentExecution.slice(-500),
      savedAt: new Date().toISOString(),
    };
  }

  ingestFills({ fills, resolveOrderContext, marketData }) {
    const delta = {
      realizedPnl: 0,
      fees: 0,
      slippageUsd: 0,
      tradedNotional: 0,
      maker: 0,
      taker: 0,
      wins: 0,
      losses: 0,
      count: 0,
      latencyMsSum: 0,
      latencySamples: 0,
      records: [],
    };

    for (const fill of fills) {
      const key = fill.hash || `${fill.oid || "oid"}:${fill.time || fill.timestamp || Date.now()}:${fill.coin || ""}`;
      if (this.seenFills.has(key)) {
        continue;
      }
      this.seenFills.add(key);
      if (this.seenFills.size > 20000) {
        const first = this.seenFills.values().next().value;
        this.seenFills.delete(first);
      }

      const coin = fill.coin || fill.asset || "unknown";
      const px = Number(fill.px ?? fill.price ?? 0);
      const sz = Math.abs(Number(fill.sz ?? fill.size ?? 0));
      const notional = Math.max(0, px * sz);
      const realizedPnl = Number(fill.closedPnl ?? fill.realizedPnl ?? 0);
      const fee = Math.abs(Number(fill.fee ?? fill.fees ?? 0));
      const isBuy = inferIsBuy(fill);
      const context = resolveOrderContext(fill) || {};

      const mid = marketData.mid(coin);
      const buySide = isBuy ?? (String(context?.side || "").toLowerCase() === "buy");
      const estSlip = mid && px ? (buySide ? Math.max(0, px - mid) : Math.max(0, mid - px)) * sz : 0;
      const slipBps = notional > 0 ? (estSlip / notional) * 10000 : 0;
      const feeBps = notional > 0 ? (fee / notional) * 10000 : 0;

      const expectedPx = Number(context.expectedPx || mid || px || 0);
      const execSlipUsd = expectedPx > 0 ? Math.max(0, Math.abs(px - expectedPx) * sz) : estSlip;
      const execSlipBps = notional > 0 ? (execSlipUsd / notional) * 10000 : slipBps;

      const fillTime = Number(fill.time ?? fill.timestamp ?? Date.now());
      const latencyMs = context.sentAt ? Math.max(0, fillTime - context.sentAt) : null;

      const liquidity = String(fill.liquidity || fill.liq || context.liquidityHint || "").toLowerCase();
      const maker = liquidity.includes("maker") || liquidity.includes("add") || context.postOnly;
      const taker = !maker;

      const bucketPatch = {
        fills: 1,
        trades: 1,
        realizedPnl,
        fees: fee,
        slippageUsd: execSlipUsd,
        notional,
        wins: realizedPnl > 0 ? 1 : 0,
        losses: realizedPnl < 0 ? 1 : 0,
        maker: maker ? 1 : 0,
        taker: taker ? 1 : 0,
        latencyMsSum: latencyMs ?? 0,
        latencySamples: latencyMs === null ? 0 : 1,
      };

      updateBucket(this.metrics.global, bucketPatch);
      updateBucket(ensureMapBucket(this.metrics.byCoin, coin), bucketPatch);
      updateBucket(ensureMapBucket(this.metrics.byArm, context.armId || "unknown"), bucketPatch);
      updateBucket(ensureMapBucket(this.metrics.byRegime, context.regime || "unknown"), bucketPatch);
      updateBucket(ensureMapBucket(this.metrics.byExecType, maker ? "maker" : "taker"), bucketPatch);

      delta.count += 1;
      delta.realizedPnl += realizedPnl;
      delta.fees += fee;
      delta.slippageUsd += execSlipUsd;
      delta.tradedNotional += notional;
      delta.maker += maker ? 1 : 0;
      delta.taker += taker ? 1 : 0;
      delta.wins += realizedPnl > 0 ? 1 : 0;
      delta.losses += realizedPnl < 0 ? 1 : 0;
      if (latencyMs !== null) {
        delta.latencyMsSum += latencyMs;
        delta.latencySamples += 1;
      }

      const executionRecord = {
        ts: Date.now(),
        fillTime,
        coin,
        armId: context.armId || "unknown",
        regime: context.regime || "unknown",
        side: buySide ? "buy" : "sell",
        maker: maker,
        taker: taker,
        expectedPx,
        fillPx: px,
        size: sz,
        notional,
        slippageBps: execSlipBps,
        feeBps,
        slippageUsd: execSlipUsd,
        feeUsd: fee,
        realizedPnl,
        latencyMs,
        tif: context.tif || null,
        reduceOnly: Boolean(context.reduceOnly),
      };

      this.recentExecution.push(executionRecord);
      if (this.recentExecution.length > 1000) {
        this.recentExecution.splice(0, this.recentExecution.length - 1000);
      }

      this.storage.appendFill({ fill, executionRecord, context });
      this.storage.appendExecutionEvent(executionRecord);
      delta.records.push(executionRecord);
    }

    return delta;
  }

  updateEquity(userState) {
    const accountValue = extractAccountValue(userState);
    const unrealized = extractUnrealizedPnl(userState);

    const prev = this.metrics.lastEquity;
    this.metrics.lastEquity = accountValue;
    this.metrics.lastUnrealized = unrealized;

    if (accountValue !== null) {
      if (this.metrics.peakEquity === null) {
        this.metrics.peakEquity = accountValue;
      }
      this.metrics.peakEquity = Math.max(this.metrics.peakEquity, accountValue);
      if (this.metrics.peakEquity > 0) {
        this.metrics.drawdownBps = ((this.metrics.peakEquity - accountValue) / this.metrics.peakEquity) * 10000;
      }
    }

    return {
      accountValue,
      prevEquity: prev,
      unrealized,
      drawdownBps: this.metrics.drawdownBps,
    };
  }

  computeReward({
    coin,
    armId,
    regime,
    realizedPnl,
    fees,
    estimatedSlippage,
    tradedNotional,
    inventoryNotional,
    drawdownBps,
    unrealizedDelta,
  }) {
    const inventoryPenalty = (Math.abs(inventoryNotional) * this.config.inventoryPenaltyBps) / 10000;
    const drawdownPenalty = (Math.max(0, drawdownBps) * this.config.drawdownPenaltyBps * Math.max(tradedNotional, 1)) / (10000 * 10000);
    const unrealizedTerm = (Number(unrealizedDelta) || 0) * this.config.unrealizedRewardWeight;

    const rewardUsd =
      Number(realizedPnl || 0)
      - Number(fees || 0)
      - Number(estimatedSlippage || 0)
      - inventoryPenalty
      - drawdownPenalty
      + unrealizedTerm;

    const rewardBps = tradedNotional > 0 ? (rewardUsd / tradedNotional) * 10000 : 0;

    const bucketPatch = {
      rewardBpsSum: rewardBps,
      rewardSamples: 1,
      rewardSqSum: rewardBps * rewardBps,
      maxDrawdownBps: Math.max(0, drawdownBps),
    };
    updateBucket(this.metrics.global, bucketPatch);
    updateBucket(ensureMapBucket(this.metrics.byCoin, coin), bucketPatch);
    updateBucket(ensureMapBucket(this.metrics.byArm, armId), bucketPatch);
    updateBucket(ensureMapBucket(this.metrics.byRegime, regime), bucketPatch);

    return {
      rewardUsd,
      rewardBps,
      components: {
        realizedPnl: Number(realizedPnl || 0),
        fees: Number(fees || 0),
        estimatedSlippage: Number(estimatedSlippage || 0),
        inventoryPenalty,
        drawdownPenalty,
        unrealizedTerm,
      },
    };
  }

  currentMetrics() {
    return {
      ...this.metrics,
      global: summarizeBucket(this.metrics.global),
    };
  }
}

function summarizeBucket(bucket) {
  const total = bucket.wins + bucket.losses;
  return {
    ...bucket,
    winRate: total > 0 ? bucket.wins / total : 0,
    avgRewardBps: bucket.rewardSamples > 0 ? bucket.rewardBpsSum / bucket.rewardSamples : 0,
    rewardVariance: bucket.rewardSamples > 0
      ? (bucket.rewardSqSum / bucket.rewardSamples) - ((bucket.rewardBpsSum / bucket.rewardSamples) ** 2)
      : 0,
    avgLatencyMs: bucket.latencySamples > 0 ? bucket.latencyMsSum / bucket.latencySamples : 0,
  };
}

export function extractAccountValue(userState) {
  if (!userState || typeof userState !== "object") {
    return null;
  }

  const candidates = [
    userState.marginSummary?.accountValue,
    userState.crossMarginSummary?.accountValue,
    userState.accountValue,
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

export function extractUnrealizedPnl(userState) {
  const rows = userState?.assetPositions || [];
  let total = 0;
  for (const row of rows) {
    const p = row.position || row;
    const v = Number(p?.unrealizedPnl ?? 0);
    if (Number.isFinite(v)) {
      total += v;
    }
  }
  return total;
}

export function summarizeOpenPositions(userState) {
  const positions = [];
  const raw = userState?.assetPositions || [];
  for (const p of raw) {
    const pos = p.position || p;
    if (!pos) continue;
    const size = Number(pos.szi ?? pos.sz ?? 0);
    if (!size) continue;
    positions.push({
      coin: pos.coin || pos.asset,
      size,
      entryPx: Number(pos.entryPx ?? 0),
      markPx: Number(pos.markPx ?? 0),
      unrealizedPnl: Number(pos.unrealizedPnl ?? 0),
    });
  }
  return positions;
}

export function inventoryNotional(userState) {
  const rows = userState?.assetPositions || [];
  let total = 0;
  for (const row of rows) {
    const p = row.position || row;
    const size = Number(p?.szi ?? p?.sz ?? 0);
    const mark = Number(p?.markPx ?? p?.entryPx ?? 0);
    if (Number.isFinite(size) && Number.isFinite(mark)) {
      total += Math.abs(size * mark);
    }
  }
  return total;
}

function inferIsBuy(fill) {
  const primary = String(fill?.side || "").toLowerCase();
  if (primary === "b" || primary === "buy" || primary === "bid" || primary === "long") {
    return true;
  }
  if (primary === "a" || primary === "s" || primary === "sell" || primary === "ask" || primary === "short") {
    return false;
  }
  if (primary.includes("buy") || primary.includes("long")) {
    return true;
  }
  if (primary.includes("sell") || primary.includes("short")) {
    return false;
  }

  const dir = String(fill?.dir || "").toLowerCase();
  if (dir.includes("open long") || dir.includes("close short")) {
    return true;
  }
  if (dir.includes("open short") || dir.includes("close long")) {
    return false;
  }
  return null;
}
