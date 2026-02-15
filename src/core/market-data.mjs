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
      this.candles.set(coin, []);
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
      side: trade.side || trade.dir || "",
      raw: trade,
    });
    clampArray(arr, this.maxPoints);
  }

  addCandle(coin, candle) {
    if (!this.candles.has(coin)) {
      this.candles.set(coin, []);
    }
    const arr = this.candles.get(coin);
    arr.push({
      ts: Number(candle.t ?? candle.time ?? Date.now()),
      open: Number(candle.o ?? candle.open ?? 0),
      high: Number(candle.h ?? candle.high ?? 0),
      low: Number(candle.l ?? candle.low ?? 0),
      close: Number(candle.c ?? candle.close ?? 0),
      volume: Number(candle.v ?? candle.volume ?? 0),
      raw: candle,
    });
    clampArray(arr, this.maxPoints);
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

  returns(coin, lookback) {
    const arr = this.mids.get(coin) || [];
    if (arr.length <= lookback) {
      return null;
    }
    const a = arr[arr.length - 1].mid;
    const b = arr[arr.length - 1 - lookback].mid;
    if (!b) {
      return null;
    }
    return (a - b) / b;
  }

  volatility(coin, lookback) {
    const arr = this.mids.get(coin) || [];
    if (arr.length < lookback + 1) {
      return null;
    }
    const slice = arr.slice(-(lookback + 1));
    const rets = [];
    for (let i = 1; i < slice.length; i += 1) {
      const prev = slice[i - 1].mid;
      const curr = slice[i].mid;
      if (prev > 0) {
        rets.push((curr - prev) / prev);
      }
    }
    return stdev(rets);
  }

  zScore(coin, length) {
    const arr = this.mids.get(coin) || [];
    if (arr.length < length) {
      return null;
    }
    const slice = arr.slice(-length).map((x) => x.mid);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sigma = stdev(slice);
    if (sigma === 0) {
      return 0;
    }
    return (slice[slice.length - 1] - mean) / sigma;
  }

  trendStrength(coin, lookback) {
    const arr = this.mids.get(coin) || [];
    if (arr.length < lookback + 1) {
      return null;
    }
    const first = arr[arr.length - 1 - lookback].mid;
    const last = arr[arr.length - 1].mid;
    const vol = this.volatility(coin, lookback) || 0;
    if (vol <= 1e-9) {
      return 0;
    }
    return ((last - first) / first) / vol;
  }

  regime(coin) {
    const book = this.lastBook(coin);
    const spreadBps = Number(book?.spreadBps ?? 999);
    const vol = Number(this.volatility(coin, 30) ?? 0);
    const trend = Math.abs(Number(this.trendStrength(coin, 30) ?? 0));

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

    const vol = Number(this.volatility(coin, 20) || 0);
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
