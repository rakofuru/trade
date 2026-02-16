function clampArray(arr, maxLen) {
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}

function stdev(values) {
  if (!values.length) {
    return 0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

const SUPPORTED_INTERVALS = ["1m", "5m", "15m"];

function intervalToMs(interval) {
  if (interval === "1m") return 60_000;
  if (interval === "5m") return 5 * 60_000;
  if (interval === "15m") return 15 * 60_000;
  return null;
}

function bucketStartTs(ts, interval) {
  const ms = intervalToMs(interval);
  if (!ms) {
    return Number(ts || 0);
  }
  const safe = Number(ts || 0);
  return Math.floor(safe / ms) * ms;
}

function normalizeTradeSide(sideRaw) {
  const side = String(sideRaw || "").toLowerCase();
  if (!side) return null;
  if (
    side === "b"
    || side === "buy"
    || side === "bid"
    || side === "long"
    || side.includes("buy")
    || side.includes("bid")
    || side.includes("long")
  ) {
    return "buy";
  }
  if (
    side === "a"
    || side === "s"
    || side === "sell"
    || side === "ask"
    || side === "short"
    || side.includes("sell")
    || side.includes("ask")
    || side.includes("short")
  ) {
    return "sell";
  }
  return null;
}

export class MarketDataBuffer {
  constructor({ coins, maxPoints = 4000 }) {
    this.coins = coins;
    this.maxPoints = maxPoints;
    this.mids = new Map();
    this.books = new Map();
    this.trades = new Map();
    this.candles = new Map();

    for (const coin of coins) {
      this.mids.set(coin, []);
      this.books.set(coin, null);
      this.trades.set(coin, []);
      this.candles.set(coin, {
        "1m": [],
        "5m": [],
        "15m": [],
      });
    }
  }

  setMid(coin, mid, ts = Date.now()) {
    if (!this.mids.has(coin)) {
      this.mids.set(coin, []);
    }
    const arr = this.mids.get(coin);
    arr.push({ ts, mid: Number(mid) });
    clampArray(arr, this.maxPoints);
  }

  setBook(coin, book, ts = Date.now()) {
    const levels = normalizeBookLevels(book.levels || book.data || []);
    const bestBid = levels.bids.length ? levels.bids[0].px : null;
    const bestAsk = levels.asks.length ? levels.asks[0].px : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const mid = bestBid && bestAsk ? (bestAsk + bestBid) / 2 : this.mid(coin);
    const spreadBps = mid && spread !== null ? (spread / mid) * 10000 : null;

    const bidDepth = levels.bids.slice(0, 5).reduce((acc, x) => acc + x.px * x.sz, 0);
    const askDepth = levels.asks.slice(0, 5).reduce((acc, x) => acc + x.px * x.sz, 0);

    this.books.set(coin, {
      ts,
      bestBid,
      bestAsk,
      spread,
      spreadBps,
      mid,
      bidDepth,
      askDepth,
      levels,
      raw: book,
    });

    if (mid) {
      this.setMid(coin, mid, ts);
    }
  }

  addTrade(coin, trade) {
    if (!this.trades.has(coin)) {
      this.trades.set(coin, []);
    }
    const arr = this.trades.get(coin);
    arr.push({
      ts: Number(trade.time || trade.ts || Date.now()),
      px: Number(trade.px ?? trade.price ?? 0),
      sz: Number(trade.sz ?? trade.size ?? 0),
      side: normalizeTradeSide(trade.side || trade.dir || trade.aggressor || trade.takerSide),
      raw: trade,
    });
    clampArray(arr, this.maxPoints);
  }

  addCandle(coin, candle) {
    if (!this.candles.has(coin)) {
      this.candles.set(coin, {
        "1m": [],
        "5m": [],
        "15m": [],
      });
    }
    const store = this.candles.get(coin);
    const oneMin = store["1m"];
    const candleTs = bucketStartTs(Number(candle.t ?? candle.time ?? Date.now()), "1m");
    const normalized = {
      ts: candleTs,
      open: Number(candle.o ?? candle.open ?? 0),
      high: Number(candle.h ?? candle.high ?? 0),
      low: Number(candle.l ?? candle.low ?? 0),
      close: Number(candle.c ?? candle.close ?? 0),
      volume: Number(candle.v ?? candle.volume ?? 0),
      raw: candle,
    };

    upsertCandle(oneMin, normalized);
    clampArray(oneMin, this.maxPoints);
    this.#updateAggregatedFromOneMinute(coin, normalized, "5m");
    this.#updateAggregatedFromOneMinute(coin, normalized, "15m");
  }

  #updateAggregatedFromOneMinute(coin, oneMinCandle, targetInterval) {
    const store = this.candles.get(coin);
    const target = store?.[targetInterval];
    if (!target) {
      return;
    }
    const bucketTs = bucketStartTs(oneMinCandle.ts, targetInterval);
    const existing = target.length ? target[target.length - 1] : null;
    if (existing && Number(existing.ts) === Number(bucketTs)) {
      existing.high = Math.max(Number(existing.high || 0), Number(oneMinCandle.high || 0));
      existing.low = Math.min(Number(existing.low || 0), Number(oneMinCandle.low || 0));
      existing.close = Number(oneMinCandle.close || existing.close || 0);
      existing.volume = Number(existing.volume || 0) + Number(oneMinCandle.volume || 0);
      existing.raw = {
        aggregatedFrom: "1m",
        interval: targetInterval,
      };
      return;
    }

    target.push({
      ts: bucketTs,
      open: Number(oneMinCandle.open || 0),
      high: Number(oneMinCandle.high || 0),
      low: Number(oneMinCandle.low || 0),
      close: Number(oneMinCandle.close || 0),
      volume: Number(oneMinCandle.volume || 0),
      raw: {
        aggregatedFrom: "1m",
        interval: targetInterval,
      },
    });
    clampArray(target, this.maxPoints);
  }

  ingestAllMids(data, ts = Date.now()) {
    for (const [coin, mid] of Object.entries(data || {})) {
      this.setMid(coin, Number(mid), ts);
    }
  }

  mid(coin) {
    const arr = this.mids.get(coin) || [];
    return arr.length ? arr[arr.length - 1].mid : null;
  }

  lastBook(coin) {
    return this.books.get(coin) || null;
  }

  candlesByInterval(coin, interval = "1m") {
    const normalized = SUPPORTED_INTERVALS.includes(interval) ? interval : "1m";
    const store = this.candles.get(coin) || {};
    return store[normalized] || [];
  }

  latestCandle(coin, interval = "1m") {
    const arr = this.candlesByInterval(coin, interval);
    return arr.length ? arr[arr.length - 1] : null;
  }

  returns(coin, lookback, interval = "1m") {
    const source = interval === "tick" ? (this.mids.get(coin) || []) : this.candlesByInterval(coin, interval);
    if (source.length <= lookback) {
      return null;
    }
    const a = Number((source[source.length - 1].close ?? source[source.length - 1].mid) || 0);
    const b = Number((source[source.length - 1 - lookback].close ?? source[source.length - 1 - lookback].mid) || 0);
    if (!(a > 0) || !(b > 0)) {
      return null;
    }
    return (a - b) / b;
  }

  volatility(coin, lookback, interval = "1m") {
    const source = interval === "tick" ? (this.mids.get(coin) || []) : this.candlesByInterval(coin, interval);
    if (source.length < lookback + 1) {
      return null;
    }
    const slice = source.slice(-(lookback + 1));
    const rets = [];
    for (let i = 1; i < slice.length; i += 1) {
      const prev = Number((slice[i - 1].close ?? slice[i - 1].mid) || 0);
      const curr = Number((slice[i].close ?? slice[i].mid) || 0);
      if (prev > 0) {
        rets.push((curr - prev) / prev);
      }
    }
    return stdev(rets);
  }

  zScore(coin, length, interval = "1m") {
    const arr = this.candlesByInterval(coin, interval);
    if (arr.length < length) {
      return null;
    }
    const slice = arr.slice(-length).map((x) => Number(x.close || 0));
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sigma = stdev(slice);
    if (sigma === 0) {
      return 0;
    }
    return (slice[slice.length - 1] - mean) / sigma;
  }

  trendStrength(coin, lookback, interval = "1m") {
    const arr = this.candlesByInterval(coin, interval);
    if (arr.length < lookback + 1) {
      return null;
    }
    const first = Number(arr[arr.length - 1 - lookback].close || 0);
    const last = Number(arr[arr.length - 1].close || 0);
    const vol = this.volatility(coin, lookback, interval) || 0;
    if (!(first > 0) || vol <= 1e-9) {
      return 0;
    }
    return ((last - first) / first) / vol;
  }

  regime(coin) {
    const book = this.lastBook(coin);
    const spreadBps = Number(book?.spreadBps ?? 999);
    const vol = Number(this.volatility(coin, 30, "1m") ?? 0);
    const trend = Math.abs(Number(this.trendStrength(coin, 30, "1m") ?? 0));

    const volRegime = vol > 0.002 ? "highvol" : "lowvol";
    const trendRegime = trend > 1.5 ? "trend" : "range";
    const spreadRegime = spreadBps > 10 ? "wide" : "tight";

    return `${volRegime}_${trendRegime}_${spreadRegime}`;
  }

  executionQualityGate(coin, { maxSpreadBps, minBookDepthUsd }) {
    const book = this.lastBook(coin);
    if (!book) {
      return {
        pass: false,
        reason: "book_missing",
      };
    }

    if (!Number.isFinite(book.spreadBps) || book.spreadBps > maxSpreadBps) {
      return {
        pass: false,
        reason: "spread_too_wide",
        spreadBps: book.spreadBps,
      };
    }

    const depth = Math.min(book.bidDepth || 0, book.askDepth || 0);
    if (depth < minBookDepthUsd) {
      return {
        pass: false,
        reason: "book_too_thin",
        depth,
      };
    }

    const vol = Number(this.volatility(coin, 20, "1m") || 0);
    const spreadNorm = Math.max(0.1, Number(book.spreadBps || 0) / Math.max(1, maxSpreadBps));
    const depthNorm = clamp(depth / Math.max(1, minBookDepthUsd), 0, 4);
    const volPenalty = clamp(vol / 0.003, 0, 2);
    const expectedFillProb = clamp((depthNorm / (spreadNorm + volPenalty + 0.25)) / 2, 0, 1);

    return {
      pass: true,
      spreadBps: book.spreadBps,
      depth,
      bidDepth: book.bidDepth,
      askDepth: book.askDepth,
      expectedFillProb,
      volatility: vol,
    };
  }

  ema(coin, interval, length) {
    const candles = this.candlesByInterval(coin, interval);
    return emaFromCandles(candles, length);
  }

  emaSeries(coin, interval, length) {
    const candles = this.candlesByInterval(coin, interval);
    return emaSeriesFromCandles(candles, length);
  }

  adx(coin, interval, length = 14) {
    const candles = this.candlesByInterval(coin, interval);
    return adxFromCandles(candles, length);
  }

  atrPercent(coin, interval, length = 14) {
    const candles = this.candlesByInterval(coin, interval);
    const atr = atrFromCandles(candles, length);
    const lastClose = Number(candles.length ? candles[candles.length - 1].close : 0);
    if (!(atr > 0) || !(lastClose > 0)) {
      return null;
    }
    return (atr / lastClose) * 100;
  }

  atrPercentSeries(coin, interval, length = 14, limit = 120) {
    const candles = this.candlesByInterval(coin, interval);
    return atrPercentSeriesFromCandles(candles, length, limit);
  }

  vwap(coin, interval = "1m", length = 60) {
    const candles = this.candlesByInterval(coin, interval);
    if (candles.length < length) {
      return null;
    }
    const slice = candles.slice(-length);
    let sumPv = 0;
    let sumV = 0;
    for (const c of slice) {
      const close = Number(c.close || 0);
      const vol = Number(c.volume || 0);
      if (close > 0 && vol > 0) {
        sumPv += close * vol;
        sumV += vol;
      }
    }
    if (!(sumV > 0)) {
      return null;
    }
    return sumPv / sumV;
  }

  zScoreFromVwap(coin, interval = "1m", length = 60) {
    const candles = this.candlesByInterval(coin, interval);
    if (candles.length < length) {
      return null;
    }
    const slice = candles.slice(-length);
    const closes = slice.map((x) => Number(x.close || 0)).filter((x) => x > 0);
    if (!closes.length) {
      return null;
    }
    const current = closes[closes.length - 1];
    const vwap = this.vwap(coin, interval, length);
    if (!(vwap > 0)) {
      return null;
    }
    const sigma = stdev(closes);
    if (sigma <= 1e-12) {
      return 0;
    }
    return (current - vwap) / sigma;
  }

  top5Imbalance(coin) {
    const book = this.lastBook(coin);
    const bids = Array.isArray(book?.levels?.bids) ? book.levels.bids.slice(0, 5) : [];
    const asks = Array.isArray(book?.levels?.asks) ? book.levels.asks.slice(0, 5) : [];
    const bidSum = bids.reduce((acc, lv) => acc + Number(lv.sz || 0), 0);
    const askSum = asks.reduce((acc, lv) => acc + Number(lv.sz || 0), 0);
    const denom = bidSum + askSum;
    if (!(denom > 0)) {
      return 0;
    }
    return (bidSum - askSum) / denom;
  }

  estimateSlippageBps(coin, { side, notionalUsd }) {
    const book = this.lastBook(coin);
    const levels = book?.levels;
    const mid = Number(book?.mid || this.mid(coin) || 0);
    if (!(mid > 0) || !levels) {
      return null;
    }
    const targetNotional = Math.max(0, Number(notionalUsd || 0));
    if (!(targetNotional > 0)) {
      return 0;
    }

    const direction = String(side || "").toLowerCase();
    const ladder = direction === "sell" ? levels.bids : levels.asks;
    if (!Array.isArray(ladder) || !ladder.length) {
      return null;
    }

    let remaining = targetNotional;
    let worstPx = Number(ladder[0].px || 0);
    for (const lv of ladder) {
      const px = Number(lv.px || 0);
      const sz = Number(lv.sz || 0);
      if (!(px > 0) || !(sz > 0)) {
        continue;
      }
      const levelNotional = px * sz;
      if (levelNotional <= 0) {
        continue;
      }
      worstPx = px;
      remaining -= Math.min(levelNotional, remaining);
      if (remaining <= 0) {
        break;
      }
    }

    if (remaining > 0) {
      // Treat insufficient depth as high impact.
      return 999;
    }
    if (!(worstPx > 0)) {
      return null;
    }
    if (direction === "buy") {
      return Math.max(0, ((worstPx - mid) / mid) * 10000);
    }
    return Math.max(0, ((mid - worstPx) / mid) * 10000);
  }

  recentAggressiveVolumeRatio(coin, windowSec = 20, direction = "buy") {
    const trades = this.trades.get(coin) || [];
    if (!trades.length) {
      return null;
    }
    const now = Date.now();
    const since = now - (Math.max(1, Number(windowSec || 20)) * 1000);
    const recent = trades.filter((t) => Number(t.ts || 0) >= since);
    if (!recent.length) {
      return null;
    }
    const want = String(direction || "buy").toLowerCase() === "sell" ? "sell" : "buy";
    let allVol = 0;
    let sideVol = 0;
    for (const t of recent) {
      const sz = Math.max(0, Number(t.sz || 0));
      if (!(sz > 0)) {
        continue;
      }
      allVol += sz;
      if (t.side === want) {
        sideVol += sz;
      }
    }
    if (!(allVol > 0)) {
      return null;
    }
    return sideVol / allVol;
  }

  hasStaleData(coin, {
    candleMaxAgeMs = 90_000,
    bookMaxAgeMs = 20_000,
    tradesMaxAgeMs = 20_000,
  } = {}) {
    const now = Date.now();
    const lastCandle = this.latestCandle(coin, "1m");
    const lastBook = this.lastBook(coin);
    const trades = this.trades.get(coin) || [];
    const lastTrade = trades.length ? trades[trades.length - 1] : null;

    const stale = [];
    if (!lastCandle || (now - Number(lastCandle.ts || 0)) > Number(candleMaxAgeMs || 0)) {
      stale.push("candle");
    }
    if (!lastBook || (now - Number(lastBook.ts || 0)) > Number(bookMaxAgeMs || 0)) {
      stale.push("l2book");
    }
    if (!lastTrade || (now - Number(lastTrade.ts || 0)) > Number(tradesMaxAgeMs || 0)) {
      stale.push("trades");
    }
    return {
      stale: stale.length > 0,
      channels: stale,
    };
  }

  recentCloseReturnPct(coin, interval = "1m", bars = 1) {
    const candles = this.candlesByInterval(coin, interval);
    if (candles.length <= bars) {
      return null;
    }
    const nowClose = Number(candles[candles.length - 1].close || 0);
    const prevClose = Number(candles[candles.length - 1 - bars].close || 0);
    if (!(nowClose > 0) || !(prevClose > 0)) {
      return null;
    }
    return ((nowClose - prevClose) / prevClose) * 100;
  }
}

function normalizeBookLevels(rawLevels) {
  const bids = [];
  const asks = [];

  if (Array.isArray(rawLevels) && rawLevels.length >= 2) {
    const [rawBids, rawAsks] = rawLevels;
    if (Array.isArray(rawBids)) {
      for (const lv of rawBids) {
        const px = Number(lv.px ?? lv[0] ?? 0);
        const sz = Number(lv.sz ?? lv[1] ?? 0);
        if (px > 0 && sz > 0) {
          bids.push({ px, sz });
        }
      }
    }

    if (Array.isArray(rawAsks)) {
      for (const lv of rawAsks) {
        const px = Number(lv.px ?? lv[0] ?? 0);
        const sz = Number(lv.sz ?? lv[1] ?? 0);
        if (px > 0 && sz > 0) {
          asks.push({ px, sz });
        }
      }
    }
  }

  bids.sort((a, b) => b.px - a.px);
  asks.sort((a, b) => a.px - b.px);
  return { bids, asks };
}

function upsertCandle(arr, candle) {
  if (!arr.length) {
    arr.push(candle);
    return;
  }
  const last = arr[arr.length - 1];
  if (Number(last.ts) === Number(candle.ts)) {
    arr[arr.length - 1] = candle;
    return;
  }
  if (Number(last.ts) < Number(candle.ts)) {
    arr.push(candle);
    return;
  }
  // Backfill can occasionally insert out-of-order bars.
  const idx = arr.findIndex((x) => Number(x.ts) === Number(candle.ts));
  if (idx >= 0) {
    arr[idx] = candle;
    return;
  }
  arr.push(candle);
  arr.sort((a, b) => Number(a.ts) - Number(b.ts));
}

function emaSeriesFromCandles(candles, length) {
  const n = Math.max(1, Number(length || 1));
  if (candles.length < n) {
    return [];
  }
  const k = 2 / (n + 1);
  const out = [];
  let ema = null;
  for (let i = 0; i < candles.length; i += 1) {
    const close = Number(candles[i].close || 0);
    if (!(close > 0)) {
      continue;
    }
    if (ema === null) {
      if (i < n - 1) {
        continue;
      }
      const seed = candles.slice(i - n + 1, i + 1)
        .map((x) => Number(x.close || 0))
        .filter((x) => x > 0);
      if (seed.length < n) {
        continue;
      }
      ema = seed.reduce((a, b) => a + b, 0) / seed.length;
    } else {
      ema = (close * k) + (ema * (1 - k));
    }
    out.push({
      ts: Number(candles[i].ts || 0),
      value: ema,
    });
  }
  return out;
}

function emaFromCandles(candles, length) {
  const series = emaSeriesFromCandles(candles, length);
  if (!series.length) {
    return null;
  }
  return Number(series[series.length - 1].value || 0);
}

function atrFromCandles(candles, length = 14) {
  const n = Math.max(1, Number(length || 14));
  if (candles.length < n + 1) {
    return null;
  }
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const high = Number(curr.high || 0);
    const low = Number(curr.low || 0);
    const prevClose = Number(prev.close || 0);
    if (!(high > 0) || !(low > 0) || !(prevClose > 0)) {
      continue;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < n) {
    return null;
  }
  let atr = average(trs.slice(0, n));
  for (let i = n; i < trs.length; i += 1) {
    atr = ((atr * (n - 1)) + trs[i]) / n;
  }
  return atr;
}

function atrPercentSeriesFromCandles(candles, length = 14, limit = 120) {
  const n = Math.max(1, Number(length || 14));
  if (candles.length < n + 1) {
    return [];
  }
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const high = Number(curr.high || 0);
    const low = Number(curr.low || 0);
    const prevClose = Number(prev.close || 0);
    if (!(high > 0) || !(low > 0) || !(prevClose > 0)) {
      trs.push(0);
      continue;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < n) {
    return [];
  }
  const out = [];
  let atr = average(trs.slice(0, n));
  let candleIdx = n;
  let close = Number(candles[candleIdx].close || 0);
  if (close > 0) {
    out.push((atr / close) * 100);
  }
  for (let i = n; i < trs.length; i += 1) {
    atr = ((atr * (n - 1)) + trs[i]) / n;
    candleIdx += 1;
    close = Number(candles[candleIdx]?.close || 0);
    if (close > 0) {
      out.push((atr / close) * 100);
    }
  }
  if (out.length > limit) {
    return out.slice(-limit);
  }
  return out;
}

function adxFromCandles(candles, length = 14) {
  const n = Math.max(2, Number(length || 14));
  if (candles.length < (n * 2) + 1) {
    return null;
  }
  const tr = [];
  const plusDm = [];
  const minusDm = [];

  for (let i = 1; i < candles.length; i += 1) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const upMove = Number(curr.high || 0) - Number(prev.high || 0);
    const downMove = Number(prev.low || 0) - Number(curr.low || 0);
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const h = Number(curr.high || 0);
    const l = Number(curr.low || 0);
    const pc = Number(prev.close || 0);
    tr.push(Math.max(
      h - l,
      Math.abs(h - pc),
      Math.abs(l - pc),
    ));
  }

  let trN = sum(tr.slice(0, n));
  let plusN = sum(plusDm.slice(0, n));
  let minusN = sum(minusDm.slice(0, n));
  if (!(trN > 0)) {
    return null;
  }

  const dx = [];
  for (let i = n; i < tr.length; i += 1) {
    const plusDi = trN > 0 ? (100 * plusN / trN) : 0;
    const minusDi = trN > 0 ? (100 * minusN / trN) : 0;
    const denom = plusDi + minusDi;
    dx.push(denom > 0 ? (100 * Math.abs(plusDi - minusDi) / denom) : 0);

    trN = trN - (trN / n) + tr[i];
    plusN = plusN - (plusN / n) + plusDm[i];
    minusN = minusN - (minusN / n) + minusDm[i];
  }
  if (dx.length < n) {
    return null;
  }
  let adx = average(dx.slice(0, n));
  for (let i = n; i < dx.length; i += 1) {
    adx = ((adx * (n - 1)) + dx[i]) / n;
  }
  return adx;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
