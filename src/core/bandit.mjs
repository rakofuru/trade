export function defaultArms() {
  return [
    {
      id: "momentum_fast",
      strategy: "momentum",
      params: { lookback: 8, volLookback: 30, signalThreshold: 0.85, tif: "Ioc", skewBps: 0 },
    },
    {
      id: "momentum_slow",
      strategy: "momentum",
      params: { lookback: 20, volLookback: 60, signalThreshold: 1.05, tif: "Ioc", skewBps: 0 },
    },
    {
      id: "mean_revert_tight",
      strategy: "mean_reversion",
      params: { lookback: 30, zEntry: 1.1, quoteBps: 5, tif: "Alo" },
    },
    {
      id: "mean_revert_wide",
      strategy: "mean_reversion",
      params: { lookback: 50, zEntry: 1.8, quoteBps: 9, tif: "Gtc" },
    },
  ];
}

function keyForContext(coin, regime) {
  return `${coin}::${regime}`;
}

function ensureArmState(ctxState, armId) {
  if (!ctxState[armId]) {
    ctxState[armId] = {
      pulls: 0,
      rewardSum: 0,
      rewardSqSum: 0,
      avgReward: 0,
      lastReward: 0,
      errors: 0,
    };
  }
  return ctxState[armId];
}

export class ContextualBandit {
  constructor({ arms, explorationCoef = 1.4, decay = 0.995, initialState = null }) {
    this.arms = arms;
    this.explorationCoef = explorationCoef;
    this.decay = decay;
    this.totalPulls = 0;
    this.contexts = {};

    if (initialState) {
      this.load(initialState);
    }
  }

  load(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    this.totalPulls = Number(snapshot.totalPulls || 0);
    this.contexts = { ...(snapshot.contexts || {}) };
  }

  snapshot() {
    return {
      totalPulls: this.totalPulls,
      explorationCoef: this.explorationCoef,
      decay: this.decay,
      arms: this.arms,
      contexts: this.contexts,
      savedAt: new Date().toISOString(),
    };
  }

  selectArm({ coin, regime }) {
    const key = keyForContext(coin, regime);
    const ctx = this.contexts[key] || {};

    for (const arm of this.arms) {
      if (!ctx[arm.id] || ctx[arm.id].pulls < 1) {
        return arm;
      }
    }

    let best = this.arms[0];
    let bestScore = -Infinity;
    const total = Math.max(this.totalPulls, 1);

    for (const arm of this.arms) {
      const st = ensureArmState(ctx, arm.id);
      const avg = st.avgReward;
      const bonus = this.explorationCoef * Math.sqrt((2 * Math.log(total + 1)) / Math.max(st.pulls, 1e-9));
      const score = avg + bonus;
      if (score > bestScore) {
        bestScore = score;
        best = arm;
      }
    }

    this.contexts[key] = ctx;
    return best;
  }

  update({ coin, regime, armId, reward, error = false }) {
    const key = keyForContext(coin, regime);
    const ctx = this.contexts[key] || {};

    for (const arm of this.arms) {
      const st = ensureArmState(ctx, arm.id);
      st.pulls *= this.decay;
      st.rewardSum *= this.decay;
      st.rewardSqSum *= this.decay;
      st.errors *= this.decay;
      st.avgReward = st.pulls > 0 ? st.rewardSum / st.pulls : 0;
    }

    const st = ensureArmState(ctx, armId);
    st.pulls += 1;
    st.rewardSum += reward;
    st.rewardSqSum += reward * reward;
    st.lastReward = reward;
    if (error) {
      st.errors += 1;
    }
    st.avgReward = st.rewardSum / Math.max(st.pulls, 1e-9);

    this.contexts[key] = ctx;
    this.totalPulls += 1;
  }

  armStats({ coin, regime, armId }) {
    const ctx = this.contexts[keyForContext(coin, regime)] || {};
    return ctx[armId] || null;
  }
}