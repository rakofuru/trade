function stdev(values) {
  if (!values.length) {
    return 0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function bucketKey(intervalStart, coin) {
  return `${intervalStart}|${coin}`;
}

function ensureBucket(map, intervalStart, intervalEnd, coin) {
  const key = bucketKey(intervalStart, coin);
  if (!map.has(key)) {
    map.set(key, {
      key,
      intervalStart,
      intervalEnd,
      coin,
      spreads: [],
      depths: [],
      mids: [],
      funding: [],
      ordersSubmitted: 0,
      ordersRejected: 0,
      ordersCanceled: 0,
      fills: 0,
      slippageBps: [],
      feesUsd: 0,
      pnlUsd: 0,
      notionalUsd: 0,
      drawdownBpsMax: 0,
      uptimeSamples: 0,
      uptimeUpSamples: 0,
      apiCallsStart: null,
      apiCallsEnd: null,
    });
  }
  return map.get(key);
}

function avg(values) {
  if (!values || !values.length) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values) {
  return (values || []).reduce((a, b) => a + b, 0);
}

export class RollupManager {
  constructor({ config, storage, logger }) {
    this.config = config;
    this.storage = storage;
    this.logger = logger;
    this.intervalMs = Math.max(10, Number(config.rollupIntervalSec || 60)) * 1000;
    this.buckets = new Map();
  }

  recordBook({ coin, spreadBps, depthUsd, mid, ts = Date.now() }) {
    if (!coin) {
      return;
    }
    const bucket = this.#bucketFor(ts, coin);
    if (Number.isFinite(Number(spreadBps))) {
      bucket.spreads.push(Number(spreadBps));
    }
    if (Number.isFinite(Number(depthUsd))) {
      bucket.depths.push(Number(depthUsd));
    }
    if (Number.isFinite(Number(mid)) && Number(mid) > 0) {
      bucket.mids.push(Number(mid));
      if (bucket.mids.length > 200) {
        bucket.mids.splice(0, bucket.mids.length - 200);
      }
    }
  }

  recordFunding({ coin, fundingRate, ts = Date.now() }) {
    if (!coin) {
      return;
    }
    const bucket = this.#bucketFor(ts, coin);
    if (Number.isFinite(Number(fundingRate))) {
      bucket.funding.push(Number(fundingRate));
    }
  }

  recordOrderResult({ coin, submitted, rejected, canceled = false, ts = Date.now() }) {
    if (!coin) {
      return;
    }
    const bucket = this.#bucketFor(ts, coin);
    if (submitted) {
      bucket.ordersSubmitted += 1;
    }
    if (rejected) {
      bucket.ordersRejected += 1;
    }
    if (canceled) {
      bucket.ordersCanceled += 1;
    }
  }

  recordExecution(executionRecord) {
    if (!executionRecord || !executionRecord.coin) {
      return;
    }
    const ts = Number(executionRecord.fillTime || executionRecord.ts || Date.now());
    const bucket = this.#bucketFor(ts, executionRecord.coin);
    bucket.fills += 1;
    bucket.feesUsd += Number(executionRecord.feeUsd || 0);
    bucket.pnlUsd += Number(executionRecord.realizedPnl || 0);
    bucket.notionalUsd += Number(executionRecord.notional || 0);
    if (Number.isFinite(Number(executionRecord.slippageBps))) {
      bucket.slippageBps.push(Number(executionRecord.slippageBps));
    }
  }

  recordHealth({ coin, drawdownBps = 0, isUp = true, apiCalls = null, ts = Date.now() }) {
    if (!coin) {
      return;
    }
    const bucket = this.#bucketFor(ts, coin);
    bucket.drawdownBpsMax = Math.max(bucket.drawdownBpsMax, Number(drawdownBps || 0));
    bucket.uptimeSamples += 1;
    if (isUp) {
      bucket.uptimeUpSamples += 1;
    }
    if (apiCalls !== null && apiCalls !== undefined) {
      const n = Number(apiCalls);
      if (Number.isFinite(n)) {
        if (bucket.apiCallsStart === null) {
          bucket.apiCallsStart = n;
        }
        bucket.apiCallsEnd = n;
      }
    }
  }

  flush(nowTs = Date.now()) {
    const ready = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.intervalEnd <= nowTs) {
        ready.push(bucket);
      }
    }
    ready.sort((a, b) => a.intervalStart - b.intervalStart);

    for (const bucket of ready) {
      const vol = this.#computeVolBps(bucket.mids);
      const ordersAttempted = bucket.ordersSubmitted + bucket.ordersRejected;
      const apiCalls = (
        bucket.apiCallsStart !== null
        && bucket.apiCallsEnd !== null
        && bucket.apiCallsEnd >= bucket.apiCallsStart
      )
        ? bucket.apiCallsEnd - bucket.apiCallsStart
        : 0;

      this.storage.appendRollup("coin_rollup", {
        ts: bucket.intervalStart,
        intervalStart: bucket.intervalStart,
        intervalEnd: bucket.intervalEnd,
        intervalSec: this.intervalMs / 1000,
        coin: bucket.coin,
        spread_bps: avg(bucket.spreads),
        depth_usd: avg(bucket.depths),
        vol_bps: vol,
        funding: avg(bucket.funding),
        orders_submitted: bucket.ordersSubmitted,
        orders_rejected: bucket.ordersRejected,
        orders_canceled: bucket.ordersCanceled,
        order_reject_rate: ordersAttempted > 0 ? bucket.ordersRejected / ordersAttempted : 0,
        fills: bucket.fills,
        fill_rate: bucket.ordersSubmitted > 0 ? bucket.fills / bucket.ordersSubmitted : 0,
        slippage_bps: avg(bucket.slippageBps),
        fees_usd: bucket.feesUsd,
        pnl_usd: bucket.pnlUsd,
        notional_usd: bucket.notionalUsd,
        drawdown_bps: bucket.drawdownBpsMax,
        uptime: bucket.uptimeSamples > 0 ? bucket.uptimeUpSamples / bucket.uptimeSamples : 1,
        api_calls: apiCalls,
      });
      this.buckets.delete(bucket.key);
    }

    if (ready.length > 0) {
      this.logger.debug("Flushed rollup buckets", { count: ready.length });
    }
    return ready.length;
  }

  #bucketFor(ts, coin) {
    const start = Math.floor(Number(ts || Date.now()) / this.intervalMs) * this.intervalMs;
    const end = start + this.intervalMs;
    return ensureBucket(this.buckets, start, end, coin);
  }

  #computeVolBps(mids) {
    if (!Array.isArray(mids) || mids.length < 3) {
      return 0;
    }
    const rets = [];
    for (let i = 1; i < mids.length; i += 1) {
      const prev = Number(mids[i - 1]);
      const curr = Number(mids[i]);
      if (prev > 0 && curr > 0) {
        rets.push((curr - prev) / prev);
      }
    }
    return stdev(rets) * 10000;
  }
}

export function mergeRollupRows(rows) {
  const summary = {
    executionCount: 0,
    orderCount: 0,
    errorCount: 0,
    totalNotional: 0,
    totalPnl: 0,
    totalFees: 0,
    totalSlippageUsd: 0,
    makerRatio: 0,
    exchangeErrCount: 0,
  };
  const byCoin = {};

  for (const row of rows || []) {
    const coin = row.coin || "unknown";
    if (!byCoin[coin]) {
      byCoin[coin] = {
        count: 0,
        notional: 0,
        pnl: 0,
        fees: 0,
        slippageUsd: 0,
        maker: 0,
        taker: 0,
        wins: 0,
        losses: 0,
        avgLatencyMs: 0,
        winRate: 0,
        rewardProxyBps: 0,
      };
    }

    const fills = Number(row.fills || 0);
    const fees = Number(row.fees_usd || 0);
    const pnl = Number(row.pnl_usd || 0);
    const slipBps = Number(row.slippage_bps || 0);
    const notional = Number(row.notional_usd || row.notional || 0);
    const slipUsd = notional > 0 ? (slipBps / 10000) * notional : 0;
    const rejects = Number(row.orders_rejected || 0);
    const submits = Number(row.orders_submitted || 0);

    summary.executionCount += fills;
    summary.orderCount += submits;
    summary.errorCount += rejects;
    summary.totalNotional += notional;
    summary.totalPnl += pnl;
    summary.totalFees += fees;
    summary.totalSlippageUsd += slipUsd;
    summary.exchangeErrCount += rejects;

    byCoin[coin].count += fills;
    byCoin[coin].notional += notional;
    byCoin[coin].pnl += pnl;
    byCoin[coin].fees += fees;
    byCoin[coin].slippageUsd += slipUsd;
  }

  for (const value of Object.values(byCoin)) {
    const total = value.wins + value.losses;
    value.winRate = total > 0 ? value.wins / total : 0;
    value.rewardProxyBps = value.notional > 0
      ? ((value.pnl - value.fees - value.slippageUsd) / value.notional) * 10000
      : 0;
  }

  return { summary, byCoin };
}
