import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/fs.mjs";

export class BudgetExceededError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "BudgetExceededError";
    this.details = details;
  }
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function utcHourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

export class BudgetManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.stateFile = path.join(config.stateDir, "budget-state.json");

    this.state = {
      dayKey: utcDayKey(),
      hourKey: utcHourKey(),
      dailyHttpCalls: 0,
      hourlyHttpCalls: 0,
      wsReconnects: 0,
      dailyOrders: 0,
      dailyCancels: 0,
      quota: {
        remaining: null,
        cap: null,
        used: null,
        remainingRatio: null,
        source: null,
        checkedAt: null,
      },
      gpt: {
        dayKey: utcDayKey(),
        dailyTokens: 0,
        estimatedCostUsd: 0,
        calls: 0,
      },
    };

    this.load();
  }

  load() {
    ensureDir(this.config.stateDir);
    const saved = readJson(this.stateFile, null);
    if (!saved) {
      return;
    }

    this.state = {
      ...this.state,
      ...saved,
      quota: {
        ...this.state.quota,
        ...(saved.quota || {}),
      },
      gpt: {
        ...this.state.gpt,
        ...(saved.gpt || {}),
      },
    };

    this.#rollWindowsIfNeeded();
  }

  save() {
    ensureDir(this.config.stateDir);
    writeJson(this.stateFile, this.state);
  }

  snapshot() {
    this.#rollWindowsIfNeeded();
    return {
      mode: this.config.budgetMode,
      dailyHttpCalls: this.state.dailyHttpCalls,
      hourlyHttpCalls: this.state.hourlyHttpCalls,
      wsReconnects: this.state.wsReconnects,
      dailyLimit: this.config.budgetDailyMaxHttpCalls,
      hourlyLimit: this.config.budgetHourlyMaxHttpCalls,
      reconnectLimit: this.config.budgetMaxWsReconnects,
      dailyOrderLimit: this.config.budgetDailyMaxOrders,
      dailyCancelLimit: this.config.budgetDailyMaxCancels,
      dailyOrders: this.state.dailyOrders,
      dailyCancels: this.state.dailyCancels,
      quota: { ...this.state.quota },
      threshold: this.config.budgetShutdownThreshold,
      gpt: {
        ...this.state.gpt,
        tokenLimit: this.config.gptDailyMaxTokens,
        costLimitUsd: this.config.gptMaxCostUsd,
        callLimit: this.config.openaiMaxCalls,
      },
    };
  }

  async noteHttpCall(label = "http") {
    this.#rollWindowsIfNeeded();
    this.state.dailyHttpCalls += 1;
    this.state.hourlyHttpCalls += 1;
    this.#checkCounterBudget(`HTTP call: ${label}`);
  }

  async noteWsReconnect() {
    this.#rollWindowsIfNeeded();
    this.state.wsReconnects += 1;
    if (this.state.wsReconnects >= this.config.budgetMaxWsReconnects) {
      throw new BudgetExceededError("WS reconnect limit exceeded", this.snapshot());
    }
  }

  noteGptUsage({ totalTokens, estimatedCostUsd }) {
    this.#rollWindowsIfNeeded();
    if (!this.config.gptEnabled) {
      return;
    }

    this.state.gpt.calls += 1;
    this.state.gpt.dailyTokens += Math.max(0, Number(totalTokens) || 0);
    this.state.gpt.estimatedCostUsd += Math.max(0, Number(estimatedCostUsd) || 0);

    if (this.state.gpt.dailyTokens >= this.config.gptDailyMaxTokens) {
      throw new BudgetExceededError("GPT daily token budget exceeded", this.snapshot());
    }
    if (this.state.gpt.estimatedCostUsd >= this.config.gptMaxCostUsd) {
      throw new BudgetExceededError("GPT max cost budget exceeded", this.snapshot());
    }
    if (this.state.gpt.calls >= this.config.openaiMaxCalls) {
      throw new BudgetExceededError("GPT max call budget exceeded", this.snapshot());
    }
  }

  noteOrderSubmitted(amount = 1) {
    this.#rollWindowsIfNeeded();
    this.state.dailyOrders += Math.max(1, Number(amount) || 1);
    if (this.state.dailyOrders >= this.config.budgetDailyMaxOrders) {
      throw new BudgetExceededError("Daily order budget exceeded", {
        count: this.state.dailyOrders,
        limit: this.config.budgetDailyMaxOrders,
      });
    }
  }

  noteCancelSubmitted(amount = 1) {
    this.#rollWindowsIfNeeded();
    this.state.dailyCancels += Math.max(1, Number(amount) || 1);
    if (this.state.dailyCancels >= this.config.budgetDailyMaxCancels) {
      throw new BudgetExceededError("Daily cancel budget exceeded", {
        count: this.state.dailyCancels,
        limit: this.config.budgetDailyMaxCancels,
      });
    }
  }

  applyQuotaStatus(status) {
    if (!status) {
      return;
    }

    this.state.quota = {
      remaining: status.remaining,
      cap: status.cap,
      used: status.used,
      remainingRatio: status.remainingRatio,
      source: status.source,
      checkedAt: new Date().toISOString(),
    };

    if (this.config.budgetMode === "quota") {
      const ratio = Number(status.remainingRatio);
      if (Number.isFinite(ratio) && ratio <= this.config.budgetShutdownThreshold) {
        throw new BudgetExceededError("Quota threshold reached", {
          threshold: this.config.budgetShutdownThreshold,
          quota: this.state.quota,
        });
      }
    }
  }

  #rollWindowsIfNeeded() {
    const dayKey = utcDayKey();
    const hourKey = utcHourKey();

    if (this.state.dayKey !== dayKey) {
      this.state.dayKey = dayKey;
      this.state.dailyHttpCalls = 0;
      this.state.wsReconnects = 0;
      this.state.dailyOrders = 0;
      this.state.dailyCancels = 0;
    }

    if (this.state.hourKey !== hourKey) {
      this.state.hourKey = hourKey;
      this.state.hourlyHttpCalls = 0;
    }

    if (this.state.gpt.dayKey !== dayKey) {
      this.state.gpt.dayKey = dayKey;
      this.state.gpt.dailyTokens = 0;
      this.state.gpt.estimatedCostUsd = 0;
      this.state.gpt.calls = 0;
    }
  }

  #checkCounterBudget(trigger) {
    const { dailyHttpCalls, hourlyHttpCalls } = this.state;
    if (dailyHttpCalls >= this.config.budgetDailyMaxHttpCalls) {
      throw new BudgetExceededError("Daily HTTP call budget exceeded", {
        trigger,
        count: dailyHttpCalls,
        limit: this.config.budgetDailyMaxHttpCalls,
      });
    }
    if (hourlyHttpCalls >= this.config.budgetHourlyMaxHttpCalls) {
      throw new BudgetExceededError("Hourly HTTP call budget exceeded", {
        trigger,
        count: hourlyHttpCalls,
        limit: this.config.budgetHourlyMaxHttpCalls,
      });
    }
  }
}
