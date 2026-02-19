const HEADER = "BOT_DECISION_V1";
const ACTIONS = new Set([
  "APPROVE",
  "REJECT",
  "PAUSE",
  "RESUME",
  "FLATTEN",
  "CANCEL_ORDERS",
  "CUSTOM",
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

export function parseBotDecisionMessage(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (!lines.length || lines[0] !== HEADER) {
    return {
      ok: false,
      error: "header_missing",
      message: `先頭行に ${HEADER} が必要です`,
    };
  }

  const values = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    values[key] = value;
  }

  const action = String(values.action || "").toUpperCase();
  if (!ACTIONS.has(action)) {
    return {
      ok: false,
      error: "invalid_action",
      message: "action が不正です",
    };
  }

  const coinRaw = String(values.coin || "ALL").toUpperCase();
  const coin = COINS.has(coinRaw) ? coinRaw : null;
  if (!coin) {
    return {
      ok: false,
      error: "invalid_coin",
      message: "coin は BTC / ETH / ALL のみ有効です",
    };
  }

  const size = parsePositiveNumber(values.size);
  if (values.size !== undefined && size === null) {
    return {
      ok: false,
      error: "invalid_size",
      message: "size は正の数値で指定してください",
    };
  }

  const ttlSec = parseTtlSec(values.ttl_sec);
  if (values.ttl_sec !== undefined && ttlSec === null) {
    return {
      ok: false,
      error: "invalid_ttl_sec",
      message: "ttl_sec は0以上86400以下の整数で指定してください",
    };
  }

  const reason = values.reason ? String(values.reason).slice(0, 200) : "";
  return {
    ok: true,
    command: {
      header: HEADER,
      action,
      coin,
      size,
      reason,
      ttlSec,
      rawText: String(text || ""),
    },
  };
}

export function buildDecisionTemplate({
  action = "APPROVE",
  coin = "ALL",
  size = null,
  reason = "human_decision",
  ttlSec = 300,
} = {}) {
  const lines = [
    HEADER,
    `action=${String(action || "APPROVE").toUpperCase()}`,
    `coin=${String(coin || "ALL").toUpperCase()}`,
    `size=${size === null || size === undefined ? "" : Number(size)}`,
    `reason=${String(reason || "human_decision")}`,
    `ttl_sec=${ttlSec === null || ttlSec === undefined ? "" : Math.max(0, Math.floor(Number(ttlSec) || 0))}`,
  ];
  return lines.join("\n");
}

export function decisionTemplateHeader() {
  return HEADER;
}
