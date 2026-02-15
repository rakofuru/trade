import { MarketDataBuffer } from "./market-data.mjs";
import { ContextualBandit, defaultArms } from "./bandit.mjs";
import { buildSignal } from "./strategy-engine.mjs";

export async function runReplay({ config, logger, storage }) {
  const allMids = storage.readStream("market_allMids", { maxLines: config.replayMaxEvents || undefined });
  const books = storage.readStream("market_l2Book", { maxLines: config.replayMaxEvents || undefined });
  const trades = storage.readStream("market_trades", { maxLines: config.replayMaxEvents || undefined });

  const events = [];
  for (const row of allMids) {
    events.push({ ts: Number(row.ts || 0), type: "allMids", data: row.data || row });
  }
  for (const row of books) {
    events.push({ ts: Number(row.ts || 0), type: "l2Book", data: row.data || row });
  }
  for (const row of trades) {
    events.push({ ts: Number(row.ts || 0), type: "trades", data: row.data || row });
  }

  events.sort((a, b) => a.ts - b.ts);

  if (!events.length) {
    return {
      summary: {
        trades: 0,
        totalPnl: 0,
        avgRewardBps: 0,
        winRate: 0,
      },
      count: 0,
      note: "No replayable market data found in data/streams",
    };
  }

  const marketData = new MarketDataBuffer({ coins: config.coins });
  const bandit = new ContextualBandit({
    arms: defaultArms(),
    explorationCoef: config.banditExplorationCoef,
    decay: config.banditDecay,
    initialState: storage.loadState("bandit-state", null),
  });

  const midsByCoin = buildMidIndex(events, config.coins);

  let pointer = 0;
  let cycleTs = events[0].ts;
  const endTs = events[events.length - 1].ts;
  const results = [];

  while (cycleTs <= endTs) {
    while (pointer < events.length && events[pointer].ts <= cycleTs) {
      ingestReplayEvent(marketData, events[pointer]);
      pointer += 1;
    }

    const coin = config.coins[Math.floor(results.length % config.coins.length)];
    const regime = marketData.regime(coin);
    const arm = bandit.selectArm({ coin, regime });
    const quality = marketData.executionQualityGate(coin, {
      maxSpreadBps: config.maxSpreadBps,
      minBookDepthUsd: config.minBookDepthUsd,
    });

    const signal = buildSignal({
      arm,
      coin,
      regime,
      marketData,
      orderSize: config.orderSize,
      maxSlippageBps: config.maxSlippageBps,
      qualityGate: quality,
    });

    if (signal && !signal.blocked) {
      const entry = marketData.mid(coin);
      const exit = futureMid(midsByCoin[coin] || [], cycleTs + config.strategyIntervalMs * 4);
      if (entry && exit) {
        const side = signal.side === "buy" ? 1 : -1;
        const ret = side * ((exit - entry) / entry);
        const notional = entry * signal.sz;
        const pnl = ret * notional;
        const fee = notional * 0.0005;
        const slippage = notional * 0.0002;
        const rewardBps = ((pnl - fee - slippage) / Math.max(notional, 1e-9)) * 10000;

        bandit.update({ coin, regime, armId: arm.id, reward: rewardBps });

        const rec = {
          ts: cycleTs,
          coin,
          regime,
          armId: arm.id,
          side: signal.side,
          entry,
          exit,
          pnl,
          fee,
          slippage,
          rewardBps,
        };
        results.push(rec);
        storage.appendReplayEvent(rec);
      }
    }

    cycleTs += Math.max(1000, Math.floor(config.strategyIntervalMs / Math.max(1, config.replaySpeed)));
  }

  const summary = summarize(results);
  logger.info("Replay finished", summary);
  return { summary, count: results.length };
}

function ingestReplayEvent(marketData, event) {
  if (event.type === "allMids") {
    marketData.ingestAllMids(event.data, event.ts);
    return;
  }

  if (event.type === "l2Book") {
    const coin = event.data.coin || event.data.asset;
    if (coin) {
      marketData.setBook(coin, event.data, event.ts);
    }
    return;
  }

  if (event.type === "trades") {
    const rows = Array.isArray(event.data?.trades) ? event.data.trades : (Array.isArray(event.data) ? event.data : []);
    for (const trade of rows) {
      const coin = trade.coin || event.data.coin;
      if (coin) {
        marketData.addTrade(coin, trade);
        if (trade.px) {
          marketData.setMid(coin, Number(trade.px), Number(trade.time || event.ts));
        }
      }
    }
  }
}

function buildMidIndex(events, coins) {
  const out = {};
  for (const coin of coins) {
    out[coin] = [];
  }

  for (const ev of events) {
    if (ev.type !== "allMids") {
      continue;
    }
    for (const [coin, px] of Object.entries(ev.data || {})) {
      if (!out[coin]) {
        out[coin] = [];
      }
      out[coin].push({ ts: ev.ts, px: Number(px) });
    }
  }

  for (const coin of Object.keys(out)) {
    out[coin].sort((a, b) => a.ts - b.ts);
  }
  return out;
}

function futureMid(rows, targetTs) {
  for (const row of rows) {
    if (row.ts >= targetTs) {
      return row.px;
    }
  }
  return rows.length ? rows[rows.length - 1].px : null;
}

function summarize(results) {
  if (!results.length) {
    return {
      trades: 0,
      totalPnl: 0,
      avgRewardBps: 0,
      winRate: 0,
    };
  }

  const totalPnl = results.reduce((a, b) => a + b.pnl, 0);
  const avgRewardBps = results.reduce((a, b) => a + b.rewardBps, 0) / results.length;
  const wins = results.filter((x) => x.pnl > 0).length;

  return {
    trades: results.length,
    totalPnl,
    avgRewardBps,
    winRate: wins / results.length,
  };
}
