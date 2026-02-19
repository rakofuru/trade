#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStreamRows } from "./analyze-ops.mjs";

const DEFAULT_HOURS = 24;
const DEFAULT_TOP_N = 10;

function parseArgs(argv) {
  const out = {
    appDir: process.cwd(),
    streamDir: null,
    hours: DEFAULT_HOURS,
    since: null,
    until: null,
    format: "table",
    coin: null,
    topN: DEFAULT_TOP_N,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    const next = i + 1 < argv.length ? argv[i + 1] : null;
    const consume = () => {
      i += 1;
      return next;
    };

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--app-dir" && next !== null) {
      out.appDir = String(consume());
      continue;
    }
    if (arg === "--stream-dir" && next !== null) {
      out.streamDir = String(consume());
      continue;
    }
    if (arg === "--hours" && next !== null) {
      out.hours = Math.max(1, Number(consume() || DEFAULT_HOURS));
      continue;
    }
    if (arg === "--since" && next !== null) {
      out.since = String(consume());
      continue;
    }
    if (arg === "--until" && next !== null) {
      out.until = String(consume());
      continue;
    }
    if (arg === "--format" && next !== null) {
      out.format = String(consume() || "table").toLowerCase();
      continue;
    }
    if (arg === "--coin" && next !== null) {
      out.coin = String(consume() || "").toUpperCase();
      continue;
    }
    if (arg === "--top" && next !== null) {
      out.topN = Math.max(1, Math.min(100, Number(consume() || DEFAULT_TOP_N)));
      continue;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node ops/strategy-decision-report.mjs [options]",
    "",
    "Options:",
    "  --app-dir <path>       App root (default: cwd)",
    "  --stream-dir <path>    Stream dir (default: <app-dir>/data/streams)",
    "  --hours <n>            Lookback hours when --since omitted (default: 24)",
    "  --since <spec>         UTC ISO, epoch(sec/ms), or relative like '24 hours ago'",
    "  --until <spec>         UTC ISO, epoch(sec/ms), or relative like 'now'",
    "  --format <table|md|json>  Output format (default: table)",
    "  --coin <BTC|ETH>       Optional coin filter",
    "  --top <n>              Top N reason rows (default: 10)",
    "  --help                 Show this help",
  ].join("\n");
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimeSpec(spec, nowMs = Date.now()) {
  const raw = String(spec || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "now") return nowMs;
  if (/^\d+$/.test(raw)) {
    if (raw.length <= 10) return Number(raw) * 1000;
    return Number(raw);
  }
  const rel = lower.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago$/);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2];
    let ms = 0;
    if (unit.startsWith("m")) ms = amount * 60 * 1000;
    else if (unit.startsWith("h")) ms = amount * 3600 * 1000;
    else ms = amount * 24 * 3600 * 1000;
    return nowMs - ms;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAction(action) {
  const normalized = String(action || "").toLowerCase();
  if (normalized === "entry" || normalized === "skip" || normalized === "exit") {
    return normalized;
  }
  return "skip";
}

function normalizeReasonCode(value) {
  const raw = String(value || "").trim();
  if (raw) {
    return raw;
  }
  return "unknown";
}

function normalizeCoin(value) {
  const normalized = String(value || "").toUpperCase().trim();
  return normalized || "UNKNOWN";
}

function normalizeRegime(value) {
  return String(value || "unknown").trim() || "unknown";
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map.set(String(key), Number(map.get(String(key)) || 0) + amount);
}

function mean(values) {
  if (!values.length) return null;
  const total = values.reduce((acc, v) => acc + v, 0);
  return total / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function summarizeField(rows, key) {
  const values = rows
    .map((row) => toFiniteNumber(row?.[key], null))
    .filter((v) => v !== null);
  return {
    count: values.length,
    avg: mean(values),
    median: median(values),
  };
}

function mapToSortedRows(map, rowBuilder) {
  return Array.from(map.entries())
    .map(([key, value]) => rowBuilder(key, value))
    .sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));
}

function reasonTop(rows, action, topN) {
  const map = new Map();
  const filtered = rows.filter((row) => row.action === action);
  for (const row of filtered) {
    increment(map, row.reasonCode, 1);
  }
  const total = filtered.length;
  return Array.from(map.entries())
    .map(([reasonCode, count]) => ({
      reasonCode,
      count: Number(count || 0),
      ratio: total > 0 ? Number(count || 0) / total : null,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.reasonCode).localeCompare(String(b.reasonCode));
    })
    .slice(0, Math.max(1, Number(topN || DEFAULT_TOP_N)));
}

function containsInsensitive(text, token) {
  return String(text || "").toLowerCase().includes(String(token || "").toLowerCase());
}

function computeSkipRatios(skipRows) {
  const skipTotal = skipRows.length;
  const ratio = (n) => (skipTotal > 0 ? n / skipTotal : null);
  const minEdgeCount = skipRows.filter((row) => (
    containsInsensitive(row.reasonCode, "minedge")
    || containsInsensitive(row.reasonCode, "min_edge")
    || containsInsensitive(row.reasonCode, "breakout_minedge")
  )).length;
  const churnCount = skipRows.filter((row) => containsInsensitive(row.reasonCode, "churn")).length;
  const cooldownCount = skipRows.filter((row) => containsInsensitive(row.reasonCode, "cooldown")).length;
  const restartWarmupCount = skipRows.filter((row) => (
    containsInsensitive(row.reasonCode, "restart_warmup")
    || (containsInsensitive(row.reasonCode, "restart") && containsInsensitive(row.reasonCode, "warmup"))
    || containsInsensitive(row.reasonCode, "warmup")
  )).length;
  return {
    skipTotal,
    minEdgeSkipCount: minEdgeCount,
    minEdgeSkipRatio: ratio(minEdgeCount),
    churnSkipCount: churnCount,
    churnSkipRatio: ratio(churnCount),
    cooldownSkipCount: cooldownCount,
    cooldownSkipRatio: ratio(cooldownCount),
    restartWarmupSkipCount: restartWarmupCount,
    restartWarmupSkipRatio: ratio(restartWarmupCount),
  };
}

function maybeRealizedPnl(row) {
  const keys = [
    "realizedPnl",
    "closedPnl",
    "realizedPnlUsd",
  ];
  for (const key of keys) {
    const n = toFiniteNumber(row?.[key], null);
    if (n !== null) return n;
  }
  return null;
}

function buildExecutionLink({
  entryRows,
  executionRows,
}) {
  const byContext = new Map();
  const byCloid = new Map();
  for (const row of entryRows) {
    const contextId = String(row?.strategyContextId || "").trim();
    const cloid = String(row?.cloid || "").trim();
    if (contextId) {
      byContext.set(contextId, row);
    }
    if (cloid) {
      byCloid.set(cloid, row);
    }
  }

  let matchedExecutionCount = 0;
  let realizedPnlUsd = 0;
  const matchedEntryContexts = new Set();
  const matchedEntryCloids = new Set();
  for (const row of executionRows) {
    const realized = maybeRealizedPnl(row);
    if (realized === null) {
      continue;
    }
    const contextId = String(
      row?.strategyContextId
      || row?.explanation?.feature?.strategyContextId
      || "",
    ).trim();
    const cloid = String(row?.cloid || "").trim();
    const entryByContext = contextId ? byContext.get(contextId) : null;
    const entryByCloid = !entryByContext && cloid ? byCloid.get(cloid) : null;
    const matched = entryByContext || entryByCloid || null;
    if (!matched) {
      continue;
    }
    matchedExecutionCount += 1;
    realizedPnlUsd += realized;
    if (entryByContext) {
      matchedEntryContexts.add(contextId);
    } else if (entryByCloid) {
      matchedEntryCloids.add(cloid);
    }
  }

  const matchedEntryCount = matchedEntryContexts.size + matchedEntryCloids.size;
  const method = matchedExecutionCount > 0 ? "strategyContextId_or_cloid" : "n/a";
  return {
    method,
    entryCount: entryRows.length,
    matchedEntryCount,
    matchedExecutionCount,
    realizedPnlUsd: matchedExecutionCount > 0 ? realizedPnlUsd : null,
  };
}

export function buildStrategyDecisionReport({
  metricsRows = [],
  executionRows = [],
  sinceTs = null,
  untilTs = null,
  sinceLabel = null,
  untilLabel = null,
  coin = null,
  topN = DEFAULT_TOP_N,
} = {}) {
  const coinFilter = coin ? normalizeCoin(coin) : null;
  const decisions = (metricsRows || [])
    .filter((row) => String(row?.type || "") === "strategy_decision")
    .filter((row) => {
      const ts = toFiniteNumber(row?.ts, null);
      if (ts === null) return false;
      if (sinceTs !== null && ts < sinceTs) return false;
      if (untilTs !== null && ts > untilTs) return false;
      return true;
    })
    .map((row) => ({
      ts: Number(row.ts),
      action: normalizeAction(row?.action),
      reasonCode: normalizeReasonCode(row?.reasonCode),
      coin: normalizeCoin(row?.coin),
      regime: normalizeRegime(row?.regime),
      ret1mPct: toFiniteNumber(row?.ret1mPct, null),
      atrPct: toFiniteNumber(row?.atrPct, null),
      breakoutBps: toFiniteNumber(row?.breakoutBps, null),
      minEdgeBps: toFiniteNumber(row?.minEdgeBps, null),
      cooldownRemainingMs: toFiniteNumber(row?.cooldownRemainingMs, null),
      regimeHoldRemainingMs: toFiniteNumber(row?.regimeHoldRemainingMs, null),
      churnScore: toFiniteNumber(row?.churnScore, null),
      cloid: row?.cloid || null,
      strategyContextId: row?.strategyContextId || null,
    }))
    .filter((row) => (coinFilter ? row.coin === coinFilter : true));

  const byActionMap = new Map([["entry", 0], ["skip", 0], ["exit", 0]]);
  const byCoinMap = new Map();
  const byRegimeMap = new Map();

  for (const row of decisions) {
    increment(byActionMap, row.action, 1);

    if (!byCoinMap.has(row.coin)) {
      byCoinMap.set(row.coin, {
        entry: 0,
        skip: 0,
        exit: 0,
        total: 0,
      });
    }
    const coinBucket = byCoinMap.get(row.coin);
    coinBucket[row.action] += 1;
    coinBucket.total += 1;

    if (!byRegimeMap.has(row.regime)) {
      byRegimeMap.set(row.regime, {
        entry: 0,
        skip: 0,
        exit: 0,
        total: 0,
      });
    }
    const regimeBucket = byRegimeMap.get(row.regime);
    regimeBucket[row.action] += 1;
    regimeBucket.total += 1;
  }

  const skipRows = decisions.filter((row) => row.action === "skip");
  const entryRows = decisions.filter((row) => row.action === "entry");
  const exitRows = decisions.filter((row) => row.action === "exit");

  const filteredExecutionRows = (executionRows || [])
    .filter((row) => {
      const ts = toFiniteNumber(row?.ts, null);
      if (ts === null) return false;
      if (sinceTs !== null && ts < sinceTs) return false;
      if (untilTs !== null && ts > untilTs) return false;
      return true;
    })
    .filter((row) => {
      if (!coinFilter) return true;
      return normalizeCoin(row?.coin) === coinFilter;
    });

  const report = {
    kind: "strategy_decision_report_v1",
    generatedAt: new Date().toISOString(),
    window: {
      sinceTs,
      untilTs,
      sinceIso: sinceTs !== null ? new Date(Number(sinceTs)).toISOString() : null,
      untilIso: untilTs !== null ? new Date(Number(untilTs)).toISOString() : null,
      sinceLabel: sinceLabel || null,
      untilLabel: untilLabel || null,
    },
    filter: {
      coin: coinFilter || null,
    },
    summary: {
      total: decisions.length,
      entry: Number(byActionMap.get("entry") || 0),
      skip: Number(byActionMap.get("skip") || 0),
      exit: Number(byActionMap.get("exit") || 0),
    },
    byCoin: mapToSortedRows(byCoinMap, (key, value) => ({
      key,
      coin: key,
      ...value,
    })),
    byRegime: mapToSortedRows(byRegimeMap, (key, value) => ({
      key,
      regime: key,
      ...value,
    })),
    reasons: {
      skipTop: reasonTop(decisions, "skip", topN),
      entryTop: reasonTop(decisions, "entry", topN),
    },
    stats: {
      ret1mPct: summarizeField(decisions, "ret1mPct"),
      atrPct: summarizeField(decisions, "atrPct"),
      breakoutBps: summarizeField(decisions, "breakoutBps"),
      minEdgeBps: summarizeField(decisions, "minEdgeBps"),
    },
    ratios: computeSkipRatios(skipRows),
    executionLink: buildExecutionLink({
      entryRows,
      executionRows: filteredExecutionRows,
    }),
    dataSources: {
      decisionRows: decisions.length,
      entryRows: entryRows.length,
      skipRows: skipRows.length,
      exitRows: exitRows.length,
      executionRows: filteredExecutionRows.length,
    },
  };
  return report;
}

function pct(v) {
  if (v === null || v === undefined || v === "") return "n/a";
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

function num(v, digits = 4) {
  if (v === null || v === undefined || v === "") return "n/a";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function pad(text, width, right = false) {
  const s = String(text ?? "");
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return right ? `${fill}${s}` : `${s}${fill}`;
}

export function renderStrategyDecisionTable(report) {
  const lines = [];
  lines.push(`Window (UTC): ${report?.window?.sinceIso || "n/a"} -> ${report?.window?.untilIso || "n/a"}`);
  if (report?.window?.sinceLabel || report?.window?.untilLabel) {
    lines.push(`Window Label: since="${report?.window?.sinceLabel || ""}" until="${report?.window?.untilLabel || ""}"`);
  }
  lines.push(`Filter: coin=${report?.filter?.coin || "ALL"}`);
  lines.push("");
  lines.push(`Total decisions: ${Number(report?.summary?.total || 0)} (entry=${Number(report?.summary?.entry || 0)}, skip=${Number(report?.summary?.skip || 0)}, exit=${Number(report?.summary?.exit || 0)})`);
  lines.push("");

  const coinRows = report?.byCoin || [];
  lines.push("By Coin:");
  if (!coinRows.length) {
    lines.push("  none");
  } else {
    const headers = ["Coin", "Total", "Entry", "Skip", "Exit"];
    const rows = coinRows.map((row) => [
      row.coin,
      String(Number(row.total || 0)),
      String(Number(row.entry || 0)),
      String(Number(row.skip || 0)),
      String(Number(row.exit || 0)),
    ]);
    const widths = headers.map((h, idx) => Math.max(h.length, ...rows.map((r) => r[idx].length)));
    lines.push(`  ${headers.map((h, idx) => pad(h, widths[idx], idx > 0)).join("  ")}`);
    lines.push(`  ${headers.map((_, idx) => "-".repeat(widths[idx])).join("  ")}`);
    for (const row of rows) {
      lines.push(`  ${row.map((cell, idx) => pad(cell, widths[idx], idx > 0)).join("  ")}`);
    }
  }
  lines.push("");

  const regimeRows = report?.byRegime || [];
  lines.push("By Regime:");
  if (!regimeRows.length) {
    lines.push("  none");
  } else {
    const headers = ["Regime", "Total", "Entry", "Skip", "Exit"];
    const rows = regimeRows.map((row) => [
      row.regime,
      String(Number(row.total || 0)),
      String(Number(row.entry || 0)),
      String(Number(row.skip || 0)),
      String(Number(row.exit || 0)),
    ]);
    const widths = headers.map((h, idx) => Math.max(h.length, ...rows.map((r) => r[idx].length)));
    lines.push(`  ${headers.map((h, idx) => pad(h, widths[idx], idx > 0)).join("  ")}`);
    lines.push(`  ${headers.map((_, idx) => "-".repeat(widths[idx])).join("  ")}`);
    for (const row of rows) {
      lines.push(`  ${row.map((cell, idx) => pad(cell, widths[idx], idx > 0)).join("  ")}`);
    }
  }
  lines.push("");

  lines.push("Skip Reason Top:");
  for (const row of report?.reasons?.skipTop || []) {
    lines.push(`  - ${row.reasonCode}: ${Number(row.count || 0)} (${pct(row.ratio)})`);
  }
  if (!(report?.reasons?.skipTop || []).length) {
    lines.push("  none");
  }
  lines.push("");

  lines.push("Entry Reason Breakdown:");
  for (const row of report?.reasons?.entryTop || []) {
    lines.push(`  - ${row.reasonCode}: ${Number(row.count || 0)} (${pct(row.ratio)})`);
  }
  if (!(report?.reasons?.entryTop || []).length) {
    lines.push("  none");
  }
  lines.push("");

  lines.push("Feature Stats (avg / median):");
  lines.push(`  ret1mPct: ${num(report?.stats?.ret1mPct?.avg, 4)} / ${num(report?.stats?.ret1mPct?.median, 4)} (n=${Number(report?.stats?.ret1mPct?.count || 0)})`);
  lines.push(`  atrPct: ${num(report?.stats?.atrPct?.avg, 4)} / ${num(report?.stats?.atrPct?.median, 4)} (n=${Number(report?.stats?.atrPct?.count || 0)})`);
  lines.push(`  breakoutBps: ${num(report?.stats?.breakoutBps?.avg, 3)} / ${num(report?.stats?.breakoutBps?.median, 3)} (n=${Number(report?.stats?.breakoutBps?.count || 0)})`);
  lines.push(`  minEdgeBps: ${num(report?.stats?.minEdgeBps?.avg, 3)} / ${num(report?.stats?.minEdgeBps?.median, 3)} (n=${Number(report?.stats?.minEdgeBps?.count || 0)})`);
  lines.push("");

  lines.push("Skip Ratios:");
  lines.push(`  minEdge: ${Number(report?.ratios?.minEdgeSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.minEdgeSkipRatio)})`);
  lines.push(`  churn: ${Number(report?.ratios?.churnSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.churnSkipRatio)})`);
  lines.push(`  cooldown: ${Number(report?.ratios?.cooldownSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.cooldownSkipRatio)})`);
  lines.push(`  restartWarmup: ${Number(report?.ratios?.restartWarmupSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.restartWarmupSkipRatio)})`);
  lines.push("");

  const link = report?.executionLink || {};
  lines.push("Execution Link:");
  lines.push(`  method=${link.method || "n/a"} entries=${Number(link.entryCount || 0)} matchedEntries=${Number(link.matchedEntryCount || 0)} matchedExec=${Number(link.matchedExecutionCount || 0)} realizedPnlUsd=${num(link.realizedPnlUsd, 4)}`);
  return lines.join("\n");
}

export function renderStrategyDecisionMarkdown(report) {
  const lines = [];
  lines.push("# Strategy Decision Report");
  lines.push("");
  lines.push(`- Window (UTC): ${report?.window?.sinceIso || "n/a"} -> ${report?.window?.untilIso || "n/a"}`);
  lines.push(`- Filter coin: ${report?.filter?.coin || "ALL"}`);
  lines.push(`- Total: ${Number(report?.summary?.total || 0)} (entry=${Number(report?.summary?.entry || 0)}, skip=${Number(report?.summary?.skip || 0)}, exit=${Number(report?.summary?.exit || 0)})`);
  lines.push("");

  lines.push("## By Coin");
  lines.push("| Coin | Total | Entry | Skip | Exit |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of report?.byCoin || []) {
    lines.push(`| ${row.coin} | ${Number(row.total || 0)} | ${Number(row.entry || 0)} | ${Number(row.skip || 0)} | ${Number(row.exit || 0)} |`);
  }
  if (!(report?.byCoin || []).length) {
    lines.push("| n/a | 0 | 0 | 0 | 0 |");
  }
  lines.push("");

  lines.push("## By Regime");
  lines.push("| Regime | Total | Entry | Skip | Exit |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of report?.byRegime || []) {
    lines.push(`| ${row.regime} | ${Number(row.total || 0)} | ${Number(row.entry || 0)} | ${Number(row.skip || 0)} | ${Number(row.exit || 0)} |`);
  }
  if (!(report?.byRegime || []).length) {
    lines.push("| n/a | 0 | 0 | 0 | 0 |");
  }
  lines.push("");

  lines.push("## Skip Reason Top");
  if (!(report?.reasons?.skipTop || []).length) {
    lines.push("- none");
  } else {
    for (const row of report.reasons.skipTop) {
      lines.push(`- ${row.reasonCode}: ${Number(row.count || 0)} (${pct(row.ratio)})`);
    }
  }
  lines.push("");

  lines.push("## Entry Reason Breakdown");
  if (!(report?.reasons?.entryTop || []).length) {
    lines.push("- none");
  } else {
    for (const row of report.reasons.entryTop) {
      lines.push(`- ${row.reasonCode}: ${Number(row.count || 0)} (${pct(row.ratio)})`);
    }
  }
  lines.push("");

  lines.push("## Feature Stats (avg / median)");
  lines.push(`- ret1mPct: ${num(report?.stats?.ret1mPct?.avg, 4)} / ${num(report?.stats?.ret1mPct?.median, 4)} (n=${Number(report?.stats?.ret1mPct?.count || 0)})`);
  lines.push(`- atrPct: ${num(report?.stats?.atrPct?.avg, 4)} / ${num(report?.stats?.atrPct?.median, 4)} (n=${Number(report?.stats?.atrPct?.count || 0)})`);
  lines.push(`- breakoutBps: ${num(report?.stats?.breakoutBps?.avg, 3)} / ${num(report?.stats?.breakoutBps?.median, 3)} (n=${Number(report?.stats?.breakoutBps?.count || 0)})`);
  lines.push(`- minEdgeBps: ${num(report?.stats?.minEdgeBps?.avg, 3)} / ${num(report?.stats?.minEdgeBps?.median, 3)} (n=${Number(report?.stats?.minEdgeBps?.count || 0)})`);
  lines.push("");

  lines.push("## Skip Ratios");
  lines.push(`- minEdge: ${Number(report?.ratios?.minEdgeSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.minEdgeSkipRatio)})`);
  lines.push(`- churn: ${Number(report?.ratios?.churnSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.churnSkipRatio)})`);
  lines.push(`- cooldown: ${Number(report?.ratios?.cooldownSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.cooldownSkipRatio)})`);
  lines.push(`- restartWarmup: ${Number(report?.ratios?.restartWarmupSkipCount || 0)}/${Number(report?.ratios?.skipTotal || 0)} (${pct(report?.ratios?.restartWarmupSkipRatio)})`);
  lines.push("");

  const link = report?.executionLink || {};
  lines.push("## Execution Link");
  lines.push(`- method: ${link.method || "n/a"}`);
  lines.push(`- entries: ${Number(link.entryCount || 0)}`);
  lines.push(`- matchedEntries: ${Number(link.matchedEntryCount || 0)}`);
  lines.push(`- matchedExec: ${Number(link.matchedExecutionCount || 0)}`);
  lines.push(`- realizedPnlUsd: ${num(link.realizedPnlUsd, 4)}`);
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!["table", "json", "md"].includes(opts.format)) {
    throw new Error(`--format must be table|json|md (got: ${opts.format})`);
  }
  if (opts.coin && !["BTC", "ETH"].includes(opts.coin)) {
    throw new Error(`--coin must be BTC or ETH (got: ${opts.coin})`);
  }

  const appDir = path.resolve(String(opts.appDir || process.cwd()));
  const streamDir = path.resolve(String(opts.streamDir || path.join(appDir, "data", "streams")));

  const nowMs = Date.now();
  const untilTs = opts.until ? parseTimeSpec(opts.until, nowMs) : nowMs;
  if (!Number.isFinite(untilTs)) {
    throw new Error(`invalid --until: ${opts.until}`);
  }
  const sinceTs = opts.since
    ? parseTimeSpec(opts.since, nowMs)
    : (untilTs - (Math.max(1, Number(opts.hours || DEFAULT_HOURS)) * 3600 * 1000));
  if (!Number.isFinite(sinceTs)) {
    throw new Error(`invalid --since: ${opts.since}`);
  }

  const rows = readStreamRows(streamDir, {
    sinceTs,
    untilTs,
    includeStreams: ["metrics", "execution"],
  });
  const metricsRows = rows.filter((row) => String(row?.__stream || "") === "metrics");
  const executionRows = rows.filter((row) => String(row?.__stream || "") === "execution");
  const report = buildStrategyDecisionReport({
    metricsRows,
    executionRows,
    sinceTs,
    untilTs,
    sinceLabel: opts.since || `${Number(opts.hours || DEFAULT_HOURS)} hours ago`,
    untilLabel: opts.until || "now",
    coin: opts.coin || null,
    topN: opts.topN,
  });

  if (opts.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (opts.format === "md") {
    console.log(renderStrategyDecisionMarkdown(report));
    return;
  }
  console.log(renderStrategyDecisionTable(report));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`[strategy-decision-report] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
