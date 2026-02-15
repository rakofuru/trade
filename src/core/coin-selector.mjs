function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function coinRegimeKey(coin, regime) {
  return `${coin}::${regime}`;
}

function createCoinState() {
  return {
    pulls: 0,
    rewardSum: 0,
    rewardSqSum: 0,
    avgReward: 0,
    orders: 0,
    rejects: 0,
    fills: 0,
    rejectStreak: 0,
    cooldownUntil: 0,
    spreadBps: null,
    depthUsd: null,
    volBps: null,
    expectedFillProb: null,
    lastUpdatedAt: 0,
  };
}

function createContextState() {
  return {
    pulls: 0,
    rewardSum: 0,
    rewardSqSum: 0,
    avgReward: 0,
  };
}

function variance(state) {
  if (!state || state.pulls <= 0) {
    return 0;
  }
  const mean = state.rewardSum / state.pulls;
  return Math.max(0, (state.rewardSqSum / state.pulls) - (mean ** 2));
}

export class CoinSelector {
  constructor({
    explorationCoef = 1.1,
    decay = 0.995,
    cooldownMs = 15 * 60 * 1000,
    rejectStreakLimit = 3,
    minDepthUsd = 5000,
    maxSpreadBps = 20,
    initialState = null,
  }) {
    this.explorationCoef = explorationCoef;
    this.decay = decay;
    this.cooldownMs = cooldownMs;
    this.rejectStreakLimit = rejectStreakLimit;
    this.minDepthUsd = minDepthUsd;
    this.maxSpreadBps = maxSpreadBps;

    this.totalPulls = 0;
    this.coinState = {};
    this.contextState = {};

    if (initialState) {
      this.load(initialState);
    }
  }

  load(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    this.totalPulls = Number(snapshot.totalPulls || 0);
    this.coinState = { ...(snapshot.coinState || {}) };
    this.contextState = { ...(snapshot.contextState || {}) };
  }

  snapshot() {
    return {
      totalPulls: this.totalPulls,
      explorationCoef: this.explorationCoef,
      decay: this.decay,
      cooldownMs: this.cooldownMs,
      rejectStreakLimit: this.rejectStreakLimit,
      coinState: this.coinState,
      contextState: this.contextState,
      savedAt: new Date().toISOString(),
    };
  }

  registerCoins(coins) {
    for (const coin of coins || []) {
      this.#ensureCoin(coin);
    }
  }

  observeMarketQuality({ coin, spreadBps, depthUsd, volBps, expectedFillProb }) {
    if (!coin) {
      return;
    }
    const st = this.#ensureCoin(coin);
    st.spreadBps = Number.isFinite(Number(spreadBps)) ? Number(spreadBps) : st.spreadBps;
    st.depthUsd = Number.isFinite(Number(depthUsd)) ? Number(depthUsd) : st.depthUsd;
    st.volBps = Number.isFinite(Number(volBps)) ? Number(volBps) : st.volBps;
    st.expectedFillProb = Number.isFinite(Number(expectedFillProb)) ? Number(expectedFillProb) : st.expectedFillProb;
    st.lastUpdatedAt = Date.now();
  }

  noteOrderOutcome({ coin, rejected = false, filled = false }) {
    if (!coin) {
      return;
    }
    const st = this.#ensureCoin(coin);
    st.orders += 1;
    if (rejected) {
      st.rejects += 1;
      st.rejectStreak += 1;
      if (st.rejectStreak >= this.rejectStreakLimit) {
        st.cooldownUntil = Date.now() + this.cooldownMs;
      }
      return;
    }
    st.rejectStreak = 0;
    if (filled) {
      st.fills += 1;
    }
  }

  updateReward({ coin, regime, rewardBps }) {
    if (!coin || !regime) {
      return;
    }
    const c = this.#ensureCoin(coin);
    const ctxKey = coinRegimeKey(coin, regime);
    const ctx = this.#ensureContext(ctxKey);
    const reward = Number(rewardBps || 0);

    this.#decayState(c);
    this.#decayState(ctx);

    c.pulls += 1;
    c.rewardSum += reward;
    c.rewardSqSum += reward * reward;
    c.avgReward = c.rewardSum / Math.max(c.pulls, 1e-9);

    ctx.pulls += 1;
    ctx.rewardSum += reward;
    ctx.rewardSqSum += reward * reward;
    ctx.avgReward = ctx.rewardSum / Math.max(ctx.pulls, 1e-9);
    this.totalPulls += 1;
  }

  isCoolingDown(coin, now = Date.now()) {
    const st = this.coinState[coin];
    return Boolean(st?.cooldownUntil && st.cooldownUntil > now);
  }

  selectCoins({ candidates, regime, maxActive = 2, qualityByCoin = {} }) {
    const now = Date.now();
    const rows = [];
    for (const coin of candidates || []) {
      const state = this.#ensureCoin(coin);
      const quality = qualityByCoin[coin] || {};
      const pass =
        !this.isCoolingDown(coin, now)
        && quality.pass !== false
        && (state.depthUsd === null || state.depthUsd >= this.minDepthUsd * 0.5)
        && (state.spreadBps === null || state.spreadBps <= this.maxSpreadBps * 2);

      const score = pass ? this.scoreCoin({ coin, regime, quality }) : -Infinity;
      rows.push({
        coin,
        pass,
        score,
        cooldownUntil: state.cooldownUntil,
      });
    }
    rows.sort((a, b) => b.score - a.score);

    const selected = rows.filter((x) => x.pass).slice(0, Math.max(1, maxActive)).map((x) => x.coin);
    if (selected.length === 0 && rows.length > 0) {
      const fallback = rows
        .filter((x) => !this.isCoolingDown(x.coin, now))
        .sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0))[0];
      if (fallback) {
        selected.push(fallback.coin);
      }
    }
    return { selected, scored: rows };
  }

  applyCoinAction({ action, coin, cooldownMs = null }) {
    if (!coin || !action) {
      return { applied: false, reason: "invalid_action" };
    }
    const st = this.#ensureCoin(coin);
    const now = Date.now();
    if (action === "cooldown") {
      st.cooldownUntil = now + (Number(cooldownMs) > 0 ? Number(cooldownMs) : this.cooldownMs);
      return { applied: true, action, coin, cooldownUntil: st.cooldownUntil };
    }
    if (action === "remove") {
      st.cooldownUntil = now + Math.max(this.cooldownMs, 2 * 3600 * 1000);
      return { applied: true, action, coin, cooldownUntil: st.cooldownUntil };
    }
    if (action === "add") {
      st.cooldownUntil = 0;
      return { applied: true, action, coin };
    }
    return { applied: false, reason: "unsupported_action" };
  }

  scoreCoin({ coin, regime, quality = {} }) {
    const st = this.#ensureCoin(coin);
    const ctx = this.#ensureContext(coinRegimeKey(coin, regime));
    const total = Math.max(1, this.totalPulls);
    const pulls = Math.max(1, st.pulls);
    const rewardMean = (Number(st.avgReward || 0) * 0.6) + (Number(ctx.avgReward || 0) * 0.4);

    const rejectRate = st.orders > 0 ? st.rejects / st.orders : 0;
    const fillRate = st.orders > 0 ? st.fills / st.orders : 0.5;
    const rewardVar = variance(st);

    const depth = Number(quality.depth || st.depthUsd || 0);
    const spread = Number(quality.spreadBps || st.spreadBps || 999);
    const liquidityFactor = clamp(depth / Math.max(1, this.minDepthUsd), 0.2, 1.8);
    const spreadPenalty = clamp(spread / Math.max(1, this.maxSpreadBps), 0.5, 3.5);
    const rejectPenalty = clamp(1 - rejectRate, 0.1, 1);
    const fillFactor = clamp(fillRate || st.expectedFillProb || 0.5, 0.1, 1);
    const variancePenalty = clamp(1 / (1 + rewardVar / 80), 0.25, 1);

    const adaptiveExploration =
      this.explorationCoef * rejectPenalty * liquidityFactor * fillFactor * variancePenalty / spreadPenalty;
    const bonus = adaptiveExploration * Math.sqrt((2 * Math.log(total + 1)) / pulls);

    return rewardMean + bonus - (rejectRate * 8) - Math.max(0, spread - this.maxSpreadBps) * 0.12;
  }

  #ensureCoin(coin) {
    if (!this.coinState[coin]) {
      this.coinState[coin] = createCoinState();
    }
    return this.coinState[coin];
  }

  #ensureContext(key) {
    if (!this.contextState[key]) {
      this.contextState[key] = createContextState();
    }
    return this.contextState[key];
  }

  #decayState(state) {
    state.pulls *= this.decay;
    state.rewardSum *= this.decay;
    state.rewardSqSum *= this.decay;
    state.avgReward = state.pulls > 0 ? state.rewardSum / state.pulls : 0;
  }
}
