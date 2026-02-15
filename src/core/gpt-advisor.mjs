import { sanitizeForExternal } from "../utils/sanitize.mjs";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const PARAM_BOUNDS = {
  lookback: { min: 5, max: 80 },
  volLookback: { min: 10, max: 120 },
  signalThreshold: { min: 0.4, max: 2.5 },
  zEntry: { min: 0.5, max: 3.0 },
  quoteBps: { min: 1, max: 25 },
  skewBps: { min: -10, max: 10 },
};

function estimateTokensByChars(text) {
  return Math.ceil((text || "").length / 4);
}

function pickRepresentativeTrades(trades, limit = 8) {
  if (!Array.isArray(trades) || !trades.length) {
    return [];
  }
  const sorted = [...trades].sort((a, b) => Number(a.realizedPnl || 0) - Number(b.realizedPnl || 0));
  const worst = sorted.slice(0, Math.ceil(limit / 2));
  const best = sorted.slice(-Math.floor(limit / 2));
  const result = [...worst, ...best].map((x) => ({
    coin: x.coin,
    armId: x.armId,
    regime: x.regime,
    notional: x.notional,
    realizedPnl: x.realizedPnl,
    feeUsd: x.feeUsd,
    slippageBps: x.slippageBps,
    maker: x.maker,
    latencyMs: x.latencyMs,
  }));
  return result;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    // try fenced block
    const match = String(text).match(/```json\s*([\s\S]*?)\s*```/i);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
    const objMatch = String(text).match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class GptAdvisor {
  constructor({ config, logger, budgetManager, storage }) {
    this.config = config;
    this.logger = logger;
    this.budgetManager = budgetManager;
    this.storage = storage;
  }

  isEnabled() {
    return this.config.gptEnabled;
  }

  async healthcheck() {
    if (!this.isEnabled()) {
      return { enabled: false, ok: true };
    }

    const prompt = "Return JSON only: {\"ok\":true}";
    const result = await this.#callChat(prompt, 120);
    const parsed = parseJsonObject(result.text);
    const ok = Boolean(parsed?.ok);
    return {
      enabled: true,
      ok,
      model: this.config.openaiModel,
      usage: result.usage,
      raw: result.text,
    };
  }

  async generateProposal({ report, arms }) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        proposal: null,
      };
    }

    const compact = {
      summary: report.summary,
      byArm: report.byArm,
      byCoin: report.byCoin,
      byRegime: report.byRegime,
      byType: report.byType,
      errors: (report.errors || []).slice(-10),
      representativeTrades: pickRepresentativeTrades(report.recentTrades || [], 10),
      allowedArms: (arms || []).map((a) => ({
        id: a.id,
        strategy: a.strategy,
        params: a.params,
      })),
      constraints: {
        noDirectOrders: true,
        modifyOnlyListedParams: Object.keys(PARAM_BOUNDS),
        allowedProposalTypes: ["coin", "param", "ops", "strategy"],
        maxProposals: 8,
      },
    };

    const safeCompact = sanitizeForExternal(compact);
    let jsonText = JSON.stringify(safeCompact);
    if (jsonText.length > this.config.gptMaxInputChars) {
      jsonText = jsonText.slice(0, this.config.gptMaxInputChars);
    }

    const prompt = [
      "You are a crypto trading diagnostics and optimization assistant.",
      "Goal: improve long-run net profitability while reducing avoidable execution loss and reject overhead.",
      "Output strict JSON only. No markdown, no prose.",
      "Rules:",
      "- Never suggest direct order decisions.",
      "- Keep changes conservative and reversible.",
      "- Focus on coin universe selection, parameter updates, ops hardening, strategy suggestions.",
      "- Use this exact schema:",
      "{",
      '  "summary": {"diagnosis": string, "confidence": number},',
      '  "proposals": [{"id": string, "type":"coin|param|ops|strategy", "change": object, "expectedImpact": string, "risk": string, "tests": [string], "rollback": string}],',
      '  "stop": {"suggest": boolean, "reason": string, "severity": "low|medium|high"},',
      '  "alerts": [string],',
      '  "meta": {"horizon": string, "priority": "low|medium|high"}',
      "}",
      "Input:",
      jsonText,
    ].join("\n");

    const result = await this.#callChat(prompt, 900);
    const parsed = parseJsonObject(result.text);

    const validated = validateProposal(parsed, arms);
    this.storage.appendReport({
      tag: "gpt_proposal_raw",
      usage: result.usage,
      parsed,
      validated,
    });

    return {
      enabled: true,
      usage: result.usage,
      proposal: validated,
      raw: result.text,
    };
  }

  async #callChat(prompt, maxTokens) {
    const snapshot = this.budgetManager.snapshot();
    if (Number(snapshot?.gpt?.calls || 0) >= Number(this.config.openaiMaxCalls || 0)) {
      throw new Error("OpenAI daily call budget reached");
    }

    const endpoint = `${this.config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.config.openaiModel,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      throw new Error(`OpenAI API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }

    const content = json?.choices?.[0]?.message?.content || "";
    const usage = {
      promptTokens: Number(json?.usage?.prompt_tokens || estimateTokensByChars(prompt)),
      completionTokens: Number(json?.usage?.completion_tokens || estimateTokensByChars(content)),
    };
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
    usage.estimatedCostUsd = (usage.totalTokens / 1000) * this.config.gptEstimatedUsdPer1kTokens;

    this.budgetManager.noteGptUsage({
      totalTokens: usage.totalTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
    });

    this.storage.appendMetric({
      type: "gpt_usage",
      usage,
      model: this.config.openaiModel,
    });

    return {
      text: content,
      usage,
    };
  }
}

export function validateProposal(raw, arms) {
  const allowedArmIds = new Set((arms || []).map((a) => a.id));
  const out = {
    summary: {
      diagnosis: typeof raw?.summary?.diagnosis === "string" ? raw.summary.diagnosis : "",
      confidence: clamp(Number(raw?.summary?.confidence || 0), 0, 1),
    },
    proposals: [],
    changes: [],
    coinActions: [],
    opActions: [],
    strategyIdeas: [],
    alerts: Array.isArray(raw?.alerts) ? raw.alerts.slice(0, 20).map((x) => String(x)) : [],
    stop: {
      suggest: Boolean(raw?.stop?.suggest),
      reason: String(raw?.stop?.reason || ""),
      severity: ["low", "medium", "high"].includes(String(raw?.stop?.severity || "").toLowerCase())
        ? String(raw.stop.severity).toLowerCase()
        : "low",
    },
    meta: {
      horizon: String(raw?.meta?.horizon || ""),
      priority: ["low", "medium", "high"].includes(String(raw?.meta?.priority || "").toLowerCase())
        ? String(raw.meta.priority).toLowerCase()
        : "low",
    },
    schemaValid: true,
  };

  const proposals = Array.isArray(raw?.proposals) ? raw.proposals : [];
  for (const p of proposals.slice(0, 8)) {
    const type = String(p?.type || "").toLowerCase();
    if (!["coin", "param", "ops", "strategy"].includes(type)) {
      continue;
    }
    const normalized = {
      id: String(p?.id || ""),
      type,
      change: p?.change && typeof p.change === "object" ? p.change : {},
      expectedImpact: String(p?.expectedImpact || ""),
      risk: String(p?.risk || ""),
      tests: Array.isArray(p?.tests) ? p.tests.slice(0, 10).map((x) => String(x)) : [],
      rollback: String(p?.rollback || ""),
    };
    out.proposals.push(normalized);

    if (type === "param") {
      const armId = String(normalized.change?.armId || "");
      if (!allowedArmIds.has(armId)) {
        continue;
      }
      const params = {};
      for (const [key, value] of Object.entries(normalized.change?.params || {})) {
        if (!PARAM_BOUNDS[key]) {
          continue;
        }
        const n = Number(value);
        if (!Number.isFinite(n)) {
          continue;
        }
        params[key] = clamp(n, PARAM_BOUNDS[key].min, PARAM_BOUNDS[key].max);
      }
      if (!Object.keys(params).length) {
        continue;
      }
      out.changes.push({
        coin: String(normalized.change?.coin || "ALL"),
        regime: String(normalized.change?.regime || "ALL"),
        armId,
        params,
        reason: normalized.expectedImpact || normalized.risk || "",
        proposalId: normalized.id,
      });
      continue;
    }

    if (type === "coin") {
      const action = String(normalized.change?.action || "").toLowerCase();
      const coin = String(normalized.change?.coin || "").toUpperCase();
      if (coin && ["add", "remove", "cooldown"].includes(action)) {
        out.coinActions.push({
          action,
          coin,
          reason: normalized.expectedImpact || normalized.risk || "",
          proposalId: normalized.id,
        });
      }
      continue;
    }

    if (type === "ops") {
      out.opActions.push({
        change: normalized.change,
        reason: normalized.expectedImpact || normalized.risk || "",
        proposalId: normalized.id,
      });
      continue;
    }

    if (type === "strategy") {
      out.strategyIdeas.push({
        change: normalized.change,
        reason: normalized.expectedImpact || normalized.risk || "",
        proposalId: normalized.id,
      });
    }
  }

  if (!raw || typeof raw !== "object" || !Array.isArray(raw?.proposals)) {
    out.schemaValid = false;
  }

  return out;
}
