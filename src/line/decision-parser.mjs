const HEADER_V1 = "BOT_DECISION_V1";
const HEADER_V2 = "BOT_DECISION_V2";
const HEADERS = [HEADER_V2];

const ACTIONS = new Set([
  "HOLD",
  "RESUME",
  "PAUSE",
  "FLATTEN",
  "CANCEL_ORDERS",
  "CUSTOM",
  // backward compatible
  "APPROVE",
  "REJECT",
]);
const COINS = new Set(["BTC", "ETH", "ALL"]);

function parsePositiveNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function parseTtlSec(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return null;
  }
  return Math.min(86400, n);
}

function findDecisionHeaderIndex(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || "").trim();
    if (HEADERS.includes(line)) {
      return i;
    }
  }
  return -1;
}

function parseBlockValues(lines, startIdx) {
  const header = String(lines[startIdx] || "").trim();
  const values = {};
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "").trim();
    if (!line) {
      if (Object.keys(values).length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith("```")) {
      if (Object.keys(values).length > 0) {
        break;
      }
      continue;
    }
    if (HEADERS.includes(line)) {
      break;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      if (Object.keys(values).length > 0) {
        break;
      }
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      values[key] = value;
    }
  }
  return { header, values };
}

export function parseBotDecisionMessage(text) {
  const lines = String(text || "").split(/\r?\n/);
  const startIdx = findDecisionHeaderIndex(lines);
  if (startIdx < 0) {
    return {
      ok: false,
      error: "header_missing",
      message: `本文に ${HEADER_V2} ブロックが必要です。`,
    };
  }
  const { header, values } = parseBlockValues(lines, startIdx);

  const action = String(values.action || "").toUpperCase();
  if (!ACTIONS.has(action)) {
    return {
      ok: false,
      error: "invalid_action",
      message: "action が不正です。",
    };
  }

  const coinRaw = String(values.coin || "ALL").toUpperCase();
  const coin = COINS.has(coinRaw) ? coinRaw : null;
  if (!coin) {
    return {
      ok: false,
      error: "invalid_coin",
      message: "coin は BTC / ETH / ALL のみ指定できます。",
    };
  }

  const size = parsePositiveNumber(values.size);
  if (values.size !== undefined && size === null) {
    return {
      ok: false,
      error: "invalid_size",
      message: "size は正の数値で指定してください。",
    };
  }

  const ttlSec = parseTtlSec(values.ttl_sec);
  if (values.ttl_sec !== undefined && ttlSec === null) {
    return {
      ok: false,
      error: "invalid_ttl_sec",
      message: "ttl_sec は 0〜86400 の整数で指定してください。",
    };
  }

  const reason = values.reason ? String(values.reason).slice(0, 200) : "";
  const questionId = values.questionid ? String(values.questionid).slice(0, 120) : "";

  return {
    ok: true,
    command: {
      header,
      version: 2,
      action,
      coin,
      size,
      reason,
      ttlSec,
      questionId,
      rawText: String(text || ""),
    },
  };
}

export function buildDecisionTemplate({
  version = 2,
  questionId = "",
  action = "HOLD",
  coin = "ALL",
  size = null,
  reason = "human_decision",
  ttlSec = 300,
} = {}) {
  const safeAction = String(action || "HOLD").toUpperCase();
  const safeTtl = ttlSec === null || ttlSec === undefined
    ? ""
    : Math.max(0, Math.floor(Number(ttlSec) || 0));

  if (Number(version) === 1) {
    const lines = [
      HEADER_V1,
      `action=${safeAction}`,
      `coin=${String(coin || "ALL").toUpperCase()}`,
      `size=${size === null || size === undefined ? "" : Number(size)}`,
      `reason=${String(reason || "human_decision")}`,
      `ttl_sec=${safeTtl}`,
    ];
    return lines.join("\n");
  }

  const lines = [
    HEADER_V2,
    `questionId=${String(questionId || "")}`,
    `action=${safeAction}`,
    `ttl_sec=${safeTtl}`,
    `reason=${String(reason || "human_decision")}`,
  ];
  return lines.join("\n");
}

export function decisionTemplateHeader(version = 2) {
  return Number(version) === 1 ? HEADER_V1 : HEADER_V2;
}
