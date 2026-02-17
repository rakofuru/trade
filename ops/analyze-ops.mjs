#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const DEFAULT_CHAIN_LIMIT = 20;
const PROTECTION_GRACE_MS = 2000;
const DEFAULT_SYMBOL_LIMITS = {
  BTC: {
    takerSpreadBps: 10,
    takerSlippageBps: 7,
  },
  ETH: {
    takerSpreadBps: 16,
    takerSlippageBps: 10,
  },
};

export function parseArgs(argv) {
  const out = {
    input: null,
    streamDir: null,
    sinceEpoch: null,
    untilEpoch: null,
    sinceLabel: null,
    untilLabel: null,
    chainLimit: DEFAULT_CHAIN_LIMIT,
    summaryOnly: false,
    jsonOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--summary-only") {
      out.summaryOnly = true;
      continue;
    }
    if (arg === "--json-only") {
      out.jsonOnly = true;
      continue;
    }
    const next = i + 1 < argv.length ? argv[i + 1] : null;
    const consume = () => {
      i += 1;
      return next;
    };
    if (arg === "--input" && next !== null) {
      out.input = consume();
      continue;
    }
    if (arg === "--stream-dir" && next !== null) {
      out.streamDir = consume();
      continue;
    }
    if (arg === "--since-epoch" && next !== null) {
      out.sinceEpoch = toFiniteNumber(consume(), null);
      continue;
    }
    if (arg === "--until-epoch" && next !== null) {
      out.untilEpoch = toFiniteNumber(consume(), null);
      continue;
    }
    if (arg === "--since-label" && next !== null) {
      out.sinceLabel = consume();
      continue;
    }
    if (arg === "--until-label" && next !== null) {
      out.untilLabel = consume();
      continue;
    }
    if (arg === "--chain-limit" && next !== null) {
      out.chainLimit = Math.max(1, Math.min(100, Number(toFiniteNumber(consume(), DEFAULT_CHAIN_LIMIT))));
      continue;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node ops/analyze-ops.mjs [options]",
    "",
    "Options:",
    "  --input <file>         Read journal/log input from file instead of stdin",
    "  --stream-dir <dir>     Optional stream directory (data/streams) for enriched analysis",
    "  --since-epoch <sec>    Inclusive UTC epoch seconds lower bound",
    "  --until-epoch <sec>    Inclusive UTC epoch seconds upper bound",
    "  --since-label <text>   Human label for window start",
    "  --until-label <text>   Human label for window end",
    "  --chain-limit <n>      Number of recent entry/protection/exit chains (default: 20)",
    "  --summary-only         Print summary only",
    "  --json-only            Print JSON only",
    "  --help                 Show this help",
  ].join("\n");
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTs(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const direct = toFiniteNumber(row.ts ?? row.time ?? row.timestamp, null);
  if (direct !== null) {
    return direct;
  }
  if (row.isoTime) {
    const parsed = Date.parse(String(row.isoTime));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return Boolean(value);
}

function upperCoin(value) {
  return String(value || "").toUpperCase().trim();
}

function startsWithIsoTs(line) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line);
}

function parseJsonLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line.startsWith("{") || !line.endsWith("}")) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseLoggerLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) {
    return null;
  }

  const normalized = startsWithIsoTs(line)
    ? line
    : (() => {
      const m = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[[A-Z]+\]\s+/);
      if (!m) return null;
      return line.slice(m.index);
    })();

  if (!normalized) {
    return null;
  }

  const m = normalized.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[([A-Z]+)\]\s+(.+)$/,
  );
  if (!m) {
    return null;
  }

  const ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) {
    return null;
  }

  let message = m[3];
  let meta = null;
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    const candidate = message.slice(jsonStart).trim();
    try {
      meta = JSON.parse(candidate);
      message = message.slice(0, jsonStart).trim();
    } catch {
      meta = null;
    }
  }

  return {
    ts,
    isoTime: new Date(ts).toISOString(),
    level: m[2].toLowerCase(),
    message,
    meta,
    __stream: "journal",
  };
}

export function parseInputText(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const jsonRow = parseJsonLine(line);
    if (jsonRow && typeof jsonRow === "object") {
      rows.push(jsonRow);
      continue;
    }

    const loggerRow = parseLoggerLine(line);
    if (loggerRow) {
      rows.push(loggerRow);
    }
  }
  return rows;
}

function listFilesRecursive(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

function streamNameFromPath(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^([^.]+?)(?:\.part\d+)?\.jsonl(?:\.gz)?$/);
  return m ? m[1] : null;
}

function parseJsonlContent(content) {
  const rows = [];
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") {
        rows.push(row);
      }
    } catch {
      // ignore broken lines
    }
  }
  return rows;
}

export function readStreamRows(streamDir, {
  sinceTs = null,
  untilTs = null,
  includeStreams = null,
} = {}) {
  if (!streamDir || !fs.existsSync(streamDir)) {
    return [];
  }
  const allow = includeStreams ? new Set(includeStreams) : null;
  const files = listFilesRecursive(streamDir)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"));

  const out = [];
  for (const file of files) {
    const streamName = streamNameFromPath(file);
    if (!streamName) continue;
    if (allow && !allow.has(streamName)) continue;

    let content = "";
    try {
      if (file.endsWith(".gz")) {
        const compressed = fs.readFileSync(file);
        content = zlib.gunzipSync(compressed).toString("utf8");
      } else {
        content = fs.readFileSync(file, "utf8");
      }
    } catch {
      continue;
    }

    const rows = parseJsonlContent(content);
    for (const row of rows) {
      const ts = toTs(row);
      if (ts === null) continue;
      if (sinceTs !== null && ts < sinceTs) continue;
      if (untilTs !== null && ts > untilTs) continue;
      out.push({
        ...row,
        __stream: streamName,
      });
    }
  }

  out.sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));
  return out;
}

function classifyRow(row) {
  const stream = String(row?.__stream || "");
  if (stream === "execution") return "execution";
  if (stream === "metrics") return "metric";
  if (stream === "orders") return "order";
  if (stream === "errors") return "error";

  if (stream === "journal") return "journal";

  if (row?.where && row?.error) return "error";
  if (row?.fillPx !== undefined && row?.coin) return "execution";
  if (row?.maker !== undefined || row?.taker !== undefined) return "execution";
  if (row?.response !== undefined || row?.cloid || row?.limitPx !== undefined) return "order";
  if (row?.type || row?.reason || row?.decision) return "metric";
  return "journal";
}

function extractReason(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.reason === "string" && row.reason.trim()) return row.reason.trim();
  if (typeof row.error === "string" && row.error.trim()) return row.error.trim();
  const decisionReason = row?.decision?.signal?.reason;
  if (typeof decisionReason === "string" && decisionReason.trim()) return decisionReason.trim();
  const outcomeError = row?.execResult?.outcome?.error;
  if (typeof outcomeError === "string" && outcomeError.trim()) return outcomeError.trim();
  const detailReason = row?.detail?.reason;
  if (typeof detailReason === "string" && detailReason.trim()) return detailReason.trim();
  return null;
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map.set(key, Number(map.get(key) || 0) + amount);
}

function toObjFromMap(map) {
  const out = {};
  for (const [k, v] of map.entries()) {
    out[k] = v;
  }
  return out;
}

function sortedCountEntries(map, limit = 10) {
  const arr = Array.from(map.entries())
    .map(([reason, count]) => ({
      reason: String(reason || ""),
      count: Number(count || 0),
    }))
    .filter((x) => x.reason.length > 0 && x.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.reason.localeCompare(b.reason);
    });
  return arr.slice(0, Math.max(1, Number(limit || 10)));
}

function invariantStatus(pass, { allowWarn = false, warn = false } = {}) {
  if (pass) return "PASS";
  if (allowWarn && warn) return "WARN";
  return "FAIL";
}

function deriveConclusion({ statusA, statusB, statusC, executionRowsCount, topAbsenceReasons }) {
  if (statusA !== "PASS" || statusB !== "PASS") {
    return "STOP_RECOMMENDED";
  }
  if (statusC !== "PASS") {
    return "WATCH";
  }
  if (Number(executionRowsCount || 0) === 0 && (topAbsenceReasons || []).length > 0) {
    return "WATCH";
  }
  return "OK";
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const w = idx - lo;
  return sortedValues[lo] * (1 - w) + sortedValues[hi] * w;
}

function distribution(values) {
  const nums = values
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!nums.length) {
    return {
      count: 0,
      p50: null,
      p90: null,
      p99: null,
      min: null,
      max: null,
    };
  }
  nums.sort((a, b) => a - b);
  return {
    count: nums.length,
    p50: quantile(nums, 0.50),
    p90: quantile(nums, 0.90),
    p99: quantile(nums, 0.99),
    min: nums[0],
    max: nums[nums.length - 1],
  };
}

function normalizeTimelineEvent(row, category) {
  const ts = toTs(row);
  const coin = upperCoin(row?.coin || row?.meta?.coin || row?.detail?.coin || null);
  const side = String(row?.side || row?.meta?.side || row?.detail?.side || "").toLowerCase() || null;
  const cloid = row?.cloid || row?.meta?.cloid || row?.detail?.cloid || row?.triggerCloid || null;
  const reason = extractReason(row);
  return {
    ts,
    category,
    type: row?.type || null,
    where: row?.where || null,
    message: row?.message || null,
    stream: row?.__stream || null,
    coin,
    side,
    cloid,
    reason,
    row,
  };
}

function findPrecedingEvent(timeline, index, coin) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ev = timeline[i];
    if (!ev) continue;
    if (coin && ev.coin && ev.coin !== coin) continue;
    if (ev.cloid || ev.side || ev.type || ev.where) {
      return {
        ts: ev.ts,
        isoTime: ev.ts ? new Date(ev.ts).toISOString() : null,
        category: ev.category,
        type: ev.type,
        where: ev.where,
        coin: ev.coin || null,
        side: ev.side || null,
        cloid: ev.cloid || null,
        reason: ev.reason || null,
      };
    }
  }
  return null;
}

function detectNoProtectionIncidents(timeline) {
  const incidents = [];
  for (let i = 0; i < timeline.length; i += 1) {
    const ev = timeline[i];
    const reason = String(ev.reason || "");
    const blockedNoProtection = ev.type === "strategy_coin_blocked" && reason === "NO_PROTECTION";
    const explicitNoProtection = reason.includes("NO_PROTECTION");
    const noProtectionError = String(ev.row?.error || "").includes("NO_PROTECTION");
    if (!blockedNoProtection && !explicitNoProtection && !noProtectionError) {
      continue;
    }
    incidents.push({
      ts: ev.ts,
      isoTime: ev.ts ? new Date(ev.ts).toISOString() : null,
      coin: ev.coin || null,
      type: ev.type || ev.where || ev.category,
      reason: reason || String(ev.row?.error || "NO_PROTECTION"),
      causeCategory: classifyNoProtectionCause(reason || String(ev.row?.error || "NO_PROTECTION")),
      side: ev.side || null,
      cloid: ev.cloid || null,
      precedingEvent: findPrecedingEvent(timeline, i, ev.coin || null),
    });
  }
  return incidents;
}

function classifyNoProtectionCause(reasonRaw) {
  const reason = String(reasonRaw || "").toUpperCase();
  if (reason.includes("SL_PLACE_FAILED")) return "SL_PLACE_FAILED";
  if (reason.includes("EMERGENCY_FLATTEN")) return "EMERGENCY_FLATTEN";
  if (reason.includes("TIMEOUT")) return "TIMEOUT";
  if (reason.includes("RECONCILE")) return "RECONCILE";
  if (reason.includes("NO_PROTECTION")) return "NO_PROTECTION";
  return "UNKNOWN";
}

function buildTradeAbsenceReasons(metricsRows, limit = 10) {
  const counts = new Map();
  for (const row of metricsRows) {
    if (!row || typeof row !== "object") continue;
    const type = String(row.type || "");
    if (type === "cycle_no_signal") {
      increment(counts, "cycle_no_signal", 1);
      continue;
    }
    if (type === "cycle_blocked") {
      const reason = String(
        row?.decision?.signal?.reason
        || row?.decision?.reason
        || extractReason(row)
        || "cycle_blocked_unknown",
      );
      increment(counts, reason, 1);
      continue;
    }
    if (type === "entry_guard_block") {
      increment(counts, String(extractReason(row) || "entry_guard_block"), 1);
      continue;
    }
    if (type === "no_trade_guard") {
      increment(counts, String(extractReason(row) || "NO_TRADE_UNKNOWN"), 1);
      continue;
    }
  }
  return {
    counts: toObjFromMap(counts),
    top: sortedCountEntries(counts, limit),
  };
}

function buildFlipViolations({ timeline, metricsRows, ordersRows }) {
  const violations = [];
  const stateByCoin = new Map();

  const sortedMetrics = [...metricsRows].sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));
  for (const row of sortedMetrics) {
    const ts = toTs(row);
    const coin = upperCoin(row?.coin);
    if (!coin || ts === null) continue;
    if (row.type === "flip_flatten_first") {
      stateByCoin.set(coin, {
        flattenRequestedAt: ts,
        targetSide: String(row?.targetSide || "").toLowerCase() || null,
        flatConfirmedAt: null,
      });
      continue;
    }
    if (row.type === "flip_flat_confirmed") {
      const prev = stateByCoin.get(coin);
      if (prev) {
        prev.flatConfirmedAt = ts;
      }
      continue;
    }
    if (row.type === "flip_new_entry_submitted") {
      const flatConfirmedAt = toFiniteNumber(row.flatConfirmedAt, null);
      const newEntryAt = toFiniteNumber(row.newEntryAt, ts);
      if (flatConfirmedAt === null || newEntryAt <= flatConfirmedAt) {
        violations.push({
          coin,
          reason: "FLIP_ORDERING_INVALID",
          flattenRequestedAt: toFiniteNumber(row.flattenRequestedAt, null),
          flatConfirmedAt,
          newEntryAt,
          cloid: row.cloid || null,
        });
      }
    }
  }

  const sortedOrders = [...ordersRows].sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));
  for (const row of sortedOrders) {
    const coin = upperCoin(row?.coin);
    const ts = toTs(row);
    if (!coin || ts === null) continue;

    const reduceOnly = boolValue(row?.reduceOnly);
    const type = String(row?.type || "");
    const strategy = String(row?.strategy || "");
    const isEntryLike = !reduceOnly
      && type !== "tpsl_submit"
      && type !== "tpsl_emergency_flatten"
      && strategy !== "tpsl";
    if (!isEntryLike) {
      continue;
    }
    const state = stateByCoin.get(coin);
    if (!state) {
      continue;
    }
    if (!Number.isFinite(state.flatConfirmedAt) || ts <= Number(state.flatConfirmedAt)) {
      violations.push({
        coin,
        reason: "ENTRY_BEFORE_FLAT_CONFIRMED",
        flattenRequestedAt: state.flattenRequestedAt,
        flatConfirmedAt: state.flatConfirmedAt,
        newEntryAt: ts,
        cloid: row?.cloid || null,
      });
    }
  }

  const sameDirectionAdds = [];
  const executionsByCoin = new Map();
  for (const ev of timeline) {
    if (ev.category !== "execution") continue;
    if (!ev.coin) continue;
    if (!executionsByCoin.has(ev.coin)) {
      executionsByCoin.set(ev.coin, []);
    }
    executionsByCoin.get(ev.coin).push(ev.row);
  }
  for (const [coin, rows] of executionsByCoin.entries()) {
    rows.sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));
    let openSide = null;
    for (const row of rows) {
      const reduceOnly = boolValue(row?.reduceOnly);
      const side = String(row?.side || "").toLowerCase();
      const ts = toTs(row);
      if (!side || ts === null) continue;
      if (reduceOnly) {
        openSide = null;
        continue;
      }
      if (openSide === side) {
        sameDirectionAdds.push({
          coin,
          side,
          ts,
          isoTime: new Date(ts).toISOString(),
          cloid: row?.cloid || null,
          reason: "SAME_DIRECTION_ADD_FILL",
        });
      }
      openSide = side;
    }
  }

  return {
    violations,
    sameDirectionAdds,
  };
}

function buildRecentChains({
  executionRows,
  metricsRows,
  chainLimit,
}) {
  const entries = executionRows
    .filter((x) => !boolValue(x?.reduceOnly))
    .sort((a, b) => Number(toTs(b) || 0) - Number(toTs(a) || 0))
    .slice(0, chainLimit);

  const ensureDone = metricsRows
    .filter((x) => x?.type === "ensure_protection_done")
    .sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));
  const exits = executionRows
    .filter((x) => boolValue(x?.reduceOnly))
    .sort((a, b) => Number(toTs(a) || 0) - Number(toTs(b) || 0));

  return entries.map((entry) => {
    const coin = upperCoin(entry?.coin);
    const entryTs = Number(toTs(entry) || 0);
    const entryCloid = entry?.cloid || null;
    const protection = ensureDone.find((x) => {
      if (upperCoin(x?.coin) !== coin) return false;
      const ts = Number(toTs(x) || 0);
      if (!(ts >= entryTs)) return false;
      const triggerCloid = x?.triggerCloid || x?.detail?.triggerCloid || null;
      if (entryCloid && triggerCloid) return triggerCloid === entryCloid;
      return ts - entryTs <= 10_000;
    }) || null;
    const exit = exits.find((x) => {
      if (upperCoin(x?.coin) !== coin) return false;
      const ts = Number(toTs(x) || 0);
      return ts > entryTs;
    }) || null;
    return {
      coin,
      entry: {
        ts: entryTs,
        isoTime: entryTs ? new Date(entryTs).toISOString() : null,
        cloid: entryCloid,
        side: entry?.side || null,
        maker: boolValue(entry?.maker),
        taker: boolValue(entry?.taker),
        fillPx: toFiniteNumber(entry?.fillPx, null),
        size: toFiniteNumber(entry?.size, null),
        regime: entry?.regime || null,
      },
      protection: protection
        ? {
          ts: toTs(protection),
          isoTime: toTs(protection) ? new Date(toTs(protection)).toISOString() : null,
          ok: boolValue(protection?.ok),
          hasSl: boolValue(protection?.hasSl),
          slCloid: protection?.slCloid || null,
          tpCloid: protection?.tpCloid || null,
          latencyMs: toFiniteNumber(protection?.latencyMs, null),
          source: protection?.source || null,
        }
        : null,
      exit: exit
        ? {
          ts: toTs(exit),
          isoTime: toTs(exit) ? new Date(toTs(exit)).toISOString() : null,
          cloid: exit?.cloid || null,
          side: exit?.side || null,
          fillPx: toFiniteNumber(exit?.fillPx, null),
          size: toFiniteNumber(exit?.size, null),
        }
        : null,
    };
  });
}

export function analyzeRows({
  rows,
  sinceTs = null,
  untilTs = null,
  sinceLabel = null,
  untilLabel = null,
  chainLimit = DEFAULT_CHAIN_LIMIT,
} = {}) {
  const normalized = (rows || [])
    .map((row) => ({ ...row, __ts: toTs(row) }))
    .filter((row) => row.__ts !== null)
    .filter((row) => (sinceTs === null ? true : row.__ts >= sinceTs))
    .filter((row) => (untilTs === null ? true : row.__ts <= untilTs));

  normalized.sort((a, b) => Number(a.__ts || 0) - Number(b.__ts || 0));

  const windowSince = sinceTs !== null
    ? sinceTs
    : (normalized.length ? Number(normalized[0].__ts) : null);
  const windowUntil = untilTs !== null
    ? untilTs
    : (normalized.length ? Number(normalized[normalized.length - 1].__ts) : null);

  const executionRows = [];
  const metricsRows = [];
  const ordersRows = [];
  const errorRows = [];
  const journalRows = [];
  const timeline = [];

  for (const row of normalized) {
    const category = classifyRow(row);
    if (category === "execution") executionRows.push(row);
    if (category === "metric") metricsRows.push(row);
    if (category === "order") ordersRows.push(row);
    if (category === "error") errorRows.push(row);
    if (category === "journal") journalRows.push(row);
    timeline.push(normalizeTimelineEvent(row, category));
  }
  timeline.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  const fillsByCoinMap = new Map();
  for (const row of executionRows) {
    const coin = upperCoin(row?.coin);
    if (!coin) continue;
    if (!fillsByCoinMap.has(coin)) {
      fillsByCoinMap.set(coin, {
        fills: 0,
        makerFills: 0,
        takerFills: 0,
      });
    }
    const bucket = fillsByCoinMap.get(coin);
    bucket.fills += 1;
    if (boolValue(row?.maker)) bucket.makerFills += 1;
    if (boolValue(row?.taker)) bucket.takerFills += 1;
  }
  const fillsByCoin = {};
  for (const [coin, bucket] of fillsByCoinMap.entries()) {
    fillsByCoin[coin] = {
      ...bucket,
      makerRatio: bucket.fills > 0 ? bucket.makerFills / bucket.fills : null,
    };
  }

  const noTradeByReasonMap = new Map();
  let dailyTradeLimitCount = 0;
  let dailyTakerLimitCount = 0;
  let takerLimitCount = 0;
  let takerStreakLimitCount = 0;
  for (const row of metricsRows) {
    const reason = extractReason(row);
    if (!reason) continue;
    if (reason.startsWith("NO_TRADE_")) {
      increment(noTradeByReasonMap, reason, 1);
    }
    if (reason === "DAILY_TRADE_LIMIT") dailyTradeLimitCount += 1;
    if (reason === "DAILY_TAKER_LIMIT") dailyTakerLimitCount += 1;
    if (reason === "TAKER_LIMIT") takerLimitCount += 1;
    if (reason === "TAKER_STREAK_LIMIT") takerStreakLimitCount += 1;
  }
  if (dailyTakerLimitCount === 0 && takerLimitCount > 0) {
    dailyTakerLimitCount = takerLimitCount;
  }

  const qualityRows = metricsRows.filter((x) => x?.type === "fill_execution_summary");
  const spreadByCoin = new Map();
  const slippageByCoin = new Map();
  const spreadAll = [];
  const slippageAll = [];
  const qualityByCloid = new Map();
  for (const row of qualityRows) {
    const coin = upperCoin(row?.coin);
    const spread = toFiniteNumber(row?.spreadBps, null);
    const slippage = toFiniteNumber(row?.slippageBps, null);
    if (coin) {
      if (!spreadByCoin.has(coin)) spreadByCoin.set(coin, []);
      if (!slippageByCoin.has(coin)) slippageByCoin.set(coin, []);
      if (spread !== null) {
        spreadByCoin.get(coin).push(spread);
        spreadAll.push(spread);
      }
      if (slippage !== null) {
        slippageByCoin.get(coin).push(slippage);
        slippageAll.push(slippage);
      }
    }
    if (row?.cloid) {
      qualityByCloid.set(String(row.cloid), row);
    }
  }
  if (!slippageAll.length) {
    for (const row of executionRows) {
      const val = toFiniteNumber(row?.slippageBps, null);
      if (val !== null) slippageAll.push(val);
      const coin = upperCoin(row?.coin);
      if (!coin) continue;
      if (!slippageByCoin.has(coin)) slippageByCoin.set(coin, []);
      if (val !== null) slippageByCoin.get(coin).push(val);
    }
  }

  const quality = {
    spreadBps: distribution(spreadAll),
    slippageBps: distribution(slippageAll),
    byCoin: {},
  };
  const allCoins = new Set([
    ...spreadByCoin.keys(),
    ...slippageByCoin.keys(),
    ...Object.keys(fillsByCoin),
  ]);
  for (const coin of allCoins) {
    quality.byCoin[coin] = {
      spreadBps: distribution(spreadByCoin.get(coin) || []),
      slippageBps: distribution(slippageByCoin.get(coin) || []),
    };
  }

  const takerThresholdViolations = [];
  for (const row of executionRows) {
    if (!boolValue(row?.taker)) continue;
    const coin = upperCoin(row?.coin);
    if (!coin) continue;
    const limits = DEFAULT_SYMBOL_LIMITS[coin] || null;
    if (!limits) continue;
    const qualityRow = row?.cloid ? qualityByCloid.get(String(row.cloid)) : null;
    const spread = toFiniteNumber(qualityRow?.spreadBps ?? row?.spreadBps, null);
    const slippage = toFiniteNumber(qualityRow?.slippageBps ?? row?.slippageBps, null);
    const spreadViolation = spread !== null && spread > Number(limits.takerSpreadBps);
    const slippageViolation = slippage !== null && slippage > Number(limits.takerSlippageBps);
    if (spreadViolation || slippageViolation) {
      takerThresholdViolations.push({
        ts: toTs(row),
        isoTime: toTs(row) ? new Date(toTs(row)).toISOString() : null,
        coin,
        side: row?.side || null,
        cloid: row?.cloid || null,
        spreadBps: spread,
        spreadLimitBps: Number(limits.takerSpreadBps),
        slippageBps: slippage,
        slippageLimitBps: Number(limits.takerSlippageBps),
      });
    }
  }

  const noProtectionIncidents = detectNoProtectionIncidents(timeline);
  const noProtectionCauseCountsMap = new Map();
  for (const incident of noProtectionIncidents) {
    increment(noProtectionCauseCountsMap, String(incident?.causeCategory || "UNKNOWN"), 1);
  }
  const ensureDoneRows = metricsRows.filter((x) => x?.type === "ensure_protection_done");
  const ensureLatencies = ensureDoneRows
    .map((x) => toFiniteNumber(x?.latencyMs, null))
    .filter((x) => x !== null);
  const protectionSlowViolations = ensureDoneRows
    .filter((x) => boolValue(x?.ok))
    .filter((x) => boolValue(x?.hasSl))
    .filter((x) => {
      const latencyMs = toFiniteNumber(x?.latencyMs, null);
      return latencyMs !== null && latencyMs > PROTECTION_GRACE_MS;
    })
    .map((x) => ({
      ts: toTs(x),
      isoTime: toTs(x) ? new Date(toTs(x)).toISOString() : null,
      coin: upperCoin(x?.coin),
      latencyMs: toFiniteNumber(x?.latencyMs, null),
      triggerCloid: x?.triggerCloid || x?.detail?.triggerCloid || null,
      source: x?.source || null,
    }));

  const flipAudit = buildFlipViolations({
    timeline,
    metricsRows,
    ordersRows,
  });

  const chains = buildRecentChains({
    executionRows,
    metricsRows,
    chainLimit,
  });

  const invariantA = {
    pass: noProtectionIncidents.length === 0 && protectionSlowViolations.length === 0,
    noProtectionIncidentCount: noProtectionIncidents.length,
    protectionLatencyMs: {
      graceMs: PROTECTION_GRACE_MS,
      distribution: distribution(ensureLatencies),
      violationCount: protectionSlowViolations.length,
    },
    incidents: noProtectionIncidents,
    slowProtectionViolations: protectionSlowViolations,
  };
  const invariantB = {
    pass: flipAudit.violations.length === 0 && flipAudit.sameDirectionAdds.length === 0,
    sameDirectionAddCount: flipAudit.sameDirectionAdds.length,
    sameDirectionAdds: flipAudit.sameDirectionAdds,
    flipOrderingViolationCount: flipAudit.violations.length,
    flipOrderingViolations: flipAudit.violations,
  };
  const invariantC = {
    pass: takerThresholdViolations.length === 0,
    takerThresholdViolationCount: takerThresholdViolations.length,
    takerThresholdViolations,
    spreadBps: quality.spreadBps,
    slippageBps: quality.slippageBps,
  };

  const tradeAbsenceReasons = buildTradeAbsenceReasons(metricsRows, 10);

  const statusA = invariantStatus(invariantA.pass);
  const statusB = invariantStatus(invariantB.pass);
  const statusC = invariantStatus(invariantC.pass, {
    allowWarn: true,
    warn: invariantC.takerThresholdViolationCount > 0 && invariantC.takerThresholdViolationCount <= 2,
  });
  const conclusion = deriveConclusion({
    statusA,
    statusB,
    statusC,
    executionRowsCount: executionRows.length,
    topAbsenceReasons: tradeAbsenceReasons.top,
  });

  return {
    generatedAt: new Date().toISOString(),
    window: {
      sinceTs: windowSince,
      untilTs: windowUntil,
      sinceIso: windowSince !== null ? new Date(windowSince).toISOString() : null,
      untilIso: windowUntil !== null ? new Date(windowUntil).toISOString() : null,
      sinceLabel: sinceLabel || null,
      untilLabel: untilLabel || null,
    },
    invariants: {
      A: invariantA,
      B: invariantB,
      C: invariantC,
    },
    invariantStatus: {
      A: statusA,
      B: statusB,
      C: statusC,
    },
    conclusion,
    fillsByCoin,
    guardCounts: {
      noTradeByReason: toObjFromMap(noTradeByReasonMap),
      dailyTradeLimitCount,
      dailyTakerLimitCount,
      takerLimitCount,
      takerStreakLimitCount,
    },
    tradeAbsenceReasons,
    noProtection: {
      count: noProtectionIncidents.length,
      causeCounts: toObjFromMap(noProtectionCauseCountsMap),
      incidents: noProtectionIncidents,
    },
    flattenOrdering: {
      violationCount: flipAudit.violations.length,
      violations: flipAudit.violations,
    },
    executionQuality: {
      spreadBps: quality.spreadBps,
      slippageBps: quality.slippageBps,
      byCoin: quality.byCoin,
      takerThresholdViolations,
    },
    recentChains: chains,
    dataSources: {
      totalRows: normalized.length,
      executionRows: executionRows.length,
      metricsRows: metricsRows.length,
      ordersRows: ordersRows.length,
      errorsRows: errorRows.length,
      journalRows: journalRows.length,
      streamRows: normalized.filter((x) => String(x.__stream || "").length > 0 && x.__stream !== "journal").length,
    },
  };
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBps(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${Number(value).toFixed(3)}bps`;
}

export function renderSummary(report) {
  const lines = [];
  lines.push(`[ops-report] window: since=${report?.window?.sinceIso || "n/a"} until=${report?.window?.untilIso || "n/a"}`);
  if (report?.window?.sinceLabel || report?.window?.untilLabel) {
    lines.push(`[ops-report] window-label: since="${report?.window?.sinceLabel || ""}" until="${report?.window?.untilLabel || ""}"`);
  }

  const fillsByCoin = report?.fillsByCoin || {};
  const coins = Object.keys(fillsByCoin).sort();
  for (const coin of coins) {
    const row = fillsByCoin[coin];
    lines.push(`[ops-report] fills ${coin}: total=${row.fills} maker=${row.makerFills} taker=${row.takerFills} maker_ratio=${formatPct(row.makerRatio)}`);
  }
  if (!coins.length) {
    lines.push("[ops-report] fills: no execution rows in window");
  }

  const guards = report?.guardCounts || {};
  const noTradeByReason = guards.noTradeByReason || {};
  const noTradeKeys = Object.keys(noTradeByReason).sort();
  if (noTradeKeys.length) {
    for (const reason of noTradeKeys) {
      lines.push(`[ops-report] guard ${reason}: ${noTradeByReason[reason]}`);
    }
  } else {
    lines.push("[ops-report] guard NO_TRADE_*: none");
  }
  lines.push(`[ops-report] guard DAILY_TRADE_LIMIT: ${Number(guards.dailyTradeLimitCount || 0)}`);
  lines.push(`[ops-report] guard DAILY_TAKER_LIMIT: ${Number(guards.dailyTakerLimitCount || 0)} (raw TAKER_LIMIT=${Number(guards.takerLimitCount || 0)})`);

  const invA = report?.invariants?.A || {};
  const invB = report?.invariants?.B || {};
  const invC = report?.invariants?.C || {};
  const invStatus = report?.invariantStatus || {};
  lines.push(`[ops-report] invariant A (protected positions): ${invStatus.A || (invA.pass ? "PASS" : "FAIL")} no_protection=${Number(invA.noProtectionIncidentCount || 0)} slow_sl=${Number(invA?.protectionLatencyMs?.violationCount || 0)}`);
  lines.push(`[ops-report] invariant B (no pyramiding/flip ordering): ${invStatus.B || (invB.pass ? "PASS" : "FAIL")} same_direction_add=${Number(invB.sameDirectionAddCount || 0)} flip_violations=${Number(invB.flipOrderingViolationCount || 0)}`);
  lines.push(`[ops-report] invariant C (execution quality): ${invStatus.C || (invC.pass ? "PASS" : "FAIL")} taker_threshold_violations=${Number(invC.takerThresholdViolationCount || 0)}`);
  lines.push(`[ops-report] conclusion: ${String(report?.conclusion || "n/a")}`);

  const noProtectionIncidents = report?.noProtection?.incidents || [];
  if (noProtectionIncidents.length) {
    const sample = noProtectionIncidents[0];
    lines.push(`[ops-report] NO_PROTECTION sample: coin=${sample.coin || "n/a"} reason=${sample.reason || "n/a"} cause=${sample.causeCategory || "UNKNOWN"} cloid=${sample.cloid || "n/a"} prev=${sample?.precedingEvent?.type || sample?.precedingEvent?.where || "n/a"}`);
  } else {
    lines.push("[ops-report] NO_PROTECTION: 0");
  }
  const npCauseCounts = report?.noProtection?.causeCounts || {};
  const causeKeys = Object.keys(npCauseCounts).sort();
  for (const key of causeKeys) {
    lines.push(`[ops-report] NO_PROTECTION_CAUSE ${key}: ${Number(npCauseCounts[key] || 0)}`);
  }

  const spread = report?.executionQuality?.spreadBps || {};
  const slippage = report?.executionQuality?.slippageBps || {};
  lines.push(`[ops-report] spread_bps p50/p90/p99: ${formatBps(spread.p50)} / ${formatBps(spread.p90)} / ${formatBps(spread.p99)}`);
  lines.push(`[ops-report] slippage_bps p50/p90/p99: ${formatBps(slippage.p50)} / ${formatBps(slippage.p90)} / ${formatBps(slippage.p99)}`);

  const topAbsence = report?.tradeAbsenceReasons?.top || [];
  if (topAbsence.length) {
    lines.push("[ops-report] no-trade/no-signal top reasons:");
    for (const row of topAbsence.slice(0, 5)) {
      lines.push(`[ops-report] reason ${row.reason}: ${Number(row.count || 0)}`);
    }
  }

  const chains = report?.recentChains || [];
  if (chains.length) {
    lines.push(`[ops-report] recent chains (latest ${chains.length}):`);
    for (const chain of chains.slice(0, 20)) {
      const p = chain.protection;
      const e = chain.exit;
      lines.push(
        `[ops-report] chain ${chain.coin} entry=${chain.entry.isoTime || "n/a"} cloid=${chain.entry.cloid || "n/a"} `
        + `protect=${p ? `${p.ok ? "ok" : "ng"}@${p.isoTime || "n/a"}` : "none"} `
        + `exit=${e ? `${e.isoTime || "n/a"}(${e.side || "?"})` : "open"}`,
      );
    }
  } else {
    lines.push("[ops-report] recent chains: none");
  }
  return lines.join("\n");
}

export async function analyzeFromCli(opts) {
  const {
    input,
    streamDir,
    sinceEpoch,
    untilEpoch,
    sinceLabel,
    untilLabel,
    chainLimit,
  } = opts;

  const sinceTs = sinceEpoch !== null ? Number(sinceEpoch) * 1000 : null;
  const untilTs = untilEpoch !== null ? Number(untilEpoch) * 1000 : null;

  const inputText = input
    ? fs.readFileSync(String(input), "utf8")
    : await readStdinText();
  const parsedInputRows = parseInputText(inputText);

  const streamRows = readStreamRows(streamDir, {
    sinceTs,
    untilTs,
    includeStreams: ["execution", "metrics", "orders", "errors"],
  });

  const rows = [...streamRows, ...parsedInputRows];
  return analyzeRows({
    rows,
    sinceTs,
    untilTs,
    sinceLabel,
    untilLabel,
    chainLimit,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const report = await analyzeFromCli(opts);
  if (!opts.jsonOnly) {
    console.log(renderSummary(report));
  }
  if (!opts.summaryOnly) {
    console.log(JSON.stringify(report));
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  main().catch((error) => {
    console.error(`[ops-report] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
