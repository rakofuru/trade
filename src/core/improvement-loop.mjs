export class ImprovementLoop {
  constructor({ config, storage, initialState = null }) {
    this.config = config;
    this.storage = storage;

    this.approvedOverrides = initialState?.approvedOverrides || [];
    this.canary = initialState?.canary || null;
    this.quarantine = initialState?.quarantine || {};
  }

  snapshot() {
    return {
      approvedOverrides: this.approvedOverrides,
      canary: this.canary,
      quarantine: this.quarantine,
      savedAt: new Date().toISOString(),
    };
  }

  currentOverrides() {
    if (this.canary?.active) {
      return this.canary.proposedOverrides;
    }
    return this.approvedOverrides;
  }

  getOverride({ coin, regime, armId }) {
    for (const item of this.currentOverrides()) {
      if (item.armId !== armId) {
        continue;
      }
      if (item.coin !== "ALL" && item.coin !== coin) {
        continue;
      }
      if (item.regime !== "ALL" && item.regime !== regime) {
        continue;
      }
      return item;
    }
    return null;
  }

  startCanary(proposal, cycleId) {
    if (!proposal || !proposal.changes || !proposal.changes.length) {
      return { started: false, reason: "empty_proposal" };
    }
    if (this.canary?.active) {
      return { started: false, reason: "canary_active" };
    }

    this.#pruneQuarantine(cycleId);
    const proposalIds = Array.from(new Set([
      ...(proposal.proposals || []).map((x) => String(x?.id || "")),
      ...proposal.changes.map((x) => String(x?.proposalId || "")),
    ].filter(Boolean)));
    const blocked = proposalIds.filter((id) => this.#isQuarantined(id, cycleId));
    if (blocked.length > 0) {
      this.storage.appendMetric({
        type: "proposal_quarantine_blocked",
        cycleId,
        blocked,
      });
      return { started: false, reason: "proposal_quarantined", blocked };
    }

    this.canary = {
      active: true,
      startedAtCycle: cycleId,
      remainingCycles: this.config.gptCanaryCycles,
      baselineOverrides: this.approvedOverrides,
      proposedOverrides: proposal.changes,
      metrics: {
        rewardBpsSum: 0,
        rewardCount: 0,
        errors: 0,
        maxDrawdownBps: 0,
      },
      proposalIds,
      proposal,
    };

    this.storage.appendMetric({
      type: "canary_started",
      cycleId,
      proposal,
    });

    return { started: true };
  }

  onCycleResult({ rewardBps, error = false, drawdownBps = 0 }) {
    if (!this.canary?.active) {
      return { active: false };
    }

    this.canary.remainingCycles -= 1;
    this.canary.metrics.rewardBpsSum += Number(rewardBps || 0);
    this.canary.metrics.rewardCount += 1;
    this.canary.metrics.errors += error ? 1 : 0;
    this.canary.metrics.maxDrawdownBps = Math.max(this.canary.metrics.maxDrawdownBps, Number(drawdownBps || 0));

    if (this.canary.remainingCycles > 0) {
      return { active: true, finished: false };
    }

    const avgReward = this.canary.metrics.rewardCount > 0
      ? this.canary.metrics.rewardBpsSum / this.canary.metrics.rewardCount
      : 0;
    const errorRate = this.canary.metrics.rewardCount > 0
      ? this.canary.metrics.errors / this.canary.metrics.rewardCount
      : 0;

    const pass =
      avgReward >= this.config.canaryMinRewardDeltaBps
      && this.canary.metrics.maxDrawdownBps <= this.config.canaryRollbackDrawdownBps
      && errorRate <= this.config.canaryRollbackErrorRate;

    if (pass) {
      this.approvedOverrides = this.canary.proposedOverrides;
      this.storage.appendMetric({
        type: "canary_accepted",
        avgReward,
        errorRate,
        maxDrawdownBps: this.canary.metrics.maxDrawdownBps,
        overrides: this.approvedOverrides,
      });
      this.canary = null;
      return { active: false, finished: true, accepted: true, avgReward, errorRate };
    }

    const rollbackTo = this.canary.baselineOverrides;
    this.approvedOverrides = rollbackTo;
    const untilCycle = cycleIdFromResult(this.canary.startedAtCycle, this.config.gptProposalQuarantineCycles);
    for (const id of this.canary.proposalIds || []) {
      this.quarantine[id] = {
        untilCycle,
        reason: "canary_rejected",
        rejectedAtCycle: this.canary.startedAtCycle,
      };
    }
    this.storage.appendMetric({
      type: "canary_rejected",
      avgReward,
      errorRate,
      maxDrawdownBps: this.canary.metrics.maxDrawdownBps,
      rollbackTo,
      proposalIds: this.canary.proposalIds || [],
    });

    this.canary = null;
    return { active: false, finished: true, accepted: false, avgReward, errorRate };
  }

  #isQuarantined(id, cycleId) {
    const q = this.quarantine[id];
    if (!q) {
      return false;
    }
    return Number(q.untilCycle || 0) >= Number(cycleId || 0);
  }

  #pruneQuarantine(cycleId) {
    for (const [id, q] of Object.entries(this.quarantine)) {
      if (Number(q?.untilCycle || 0) < Number(cycleId || 0)) {
        delete this.quarantine[id];
      }
    }
  }
}

function cycleIdFromResult(baseCycle, quarantineCycles) {
  return Number(baseCycle || 0) + Math.max(1, Number(quarantineCycles || 1));
}
