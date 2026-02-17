#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRows, readStreamRows } from "./analyze-ops.mjs";

const DEFAULT_HOURS = 24;
const DEFAULT_CHAIN_LIMIT = 20;

function parseArgs(argv) {
  const out = {
    appDir: process.cwd(),
    streamDir: null,
    hours: DEFAULT_HOURS,
    since: null,
    until: null,
    format: "table",
    chainLimit: DEFAULT_CHAIN_LIMIT,
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
    if (arg === "--chain-limit" && next !== null) {
      out.chainLimit = Math.max(1, Math.min(100, Number(consume() || DEFAULT_CHAIN_LIMIT)));
      continue;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node ops/performance-report.mjs [options]",
    "",
    "Options:",
    "  --app-dir <path>       App root (default: cwd)",
    "  --stream-dir <path>    Stream dir (default: <app-dir>/data/streams)",
    "  --hours <n>            Lookback hours when --since is omitted (default: 24)",
    "  --since <spec>         UTC ISO, epoch(sec/ms), or relative like '6 hours ago'",
    "  --until <spec>         UTC ISO, epoch(sec/ms), or relative like 'now'",
    "  --format <table|md|json>  Output format (default: table)",
    "  --chain-limit <n>      Recent chain limit in invariant report (default: 20)",
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

function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

function usd(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : "n/a";
}

function bps(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(3) : "n/a";
}

function pad(str, width, alignRight = false) {
  const s = String(str);
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return alignRight ? `${fill}${s}` : `${s}${fill}`;
}

function computePerformance(executionRows) {
  const byCoin = new Map();
  const totals = {
    fills: 0,
    maker: 0,
    taker: 0,
    entries: 0,
    exits: 0,
    notional: 0,
    realizedPnl: 0,
    slippageBpsValues: [],
  };

  for (const row of executionRows) {
    const coin = String(row?.coin || "").toUpperCase().trim();
    if (!coin) continue;
    if (!byCoin.has(coin)) {
      byCoin.set(coin, {
        coin,
        fills: 0,
        maker: 0,
        taker: 0,
        entries: 0,
        exits: 0,
        notional: 0,
        realizedPnl: 0,
        slippageBpsValues: [],
      });
    }
    const bucket = byCoin.get(coin);
    const maker = Boolean(row?.maker);
    const taker = Boolean(row?.taker);
    const reduceOnly = Boolean(row?.reduceOnly);
    const notional = Number(row?.notional || 0);
    const realizedPnl = Number(
      row?.realizedPnl
      ?? row?.closedPnl
      ?? row?.realizedPnlUsd
      ?? 0,
    );
    const slip = toFiniteNumber(row?.slippageBps, null);

    bucket.fills += 1;
    if (maker) bucket.maker += 1;
    if (taker) bucket.taker += 1;
    if (reduceOnly) bucket.exits += 1;
    else bucket.entries += 1;
    if (Number.isFinite(notional)) bucket.notional += notional;
    if (Number.isFinite(realizedPnl)) bucket.realizedPnl += realizedPnl;
    if (slip !== null) bucket.slippageBpsValues.push(slip);

    totals.fills += 1;
    if (maker) totals.maker += 1;
    if (taker) totals.taker += 1;
    if (reduceOnly) totals.exits += 1;
    else totals.entries += 1;
    if (Number.isFinite(notional)) totals.notional += notional;
    if (Number.isFinite(realizedPnl)) totals.realizedPnl += realizedPnl;
    if (slip !== null) totals.slippageBpsValues.push(slip);
  }

  const rows = Array.from(byCoin.values())
    .map((x) => ({
      coin: x.coin,
      fills: x.fills,
      maker: x.maker,
      taker: x.taker,
      makerRatio: x.fills > 0 ? x.maker / x.fills : null,
      entries: x.entries,
      exits: x.exits,
      notionalUsd: x.notional,
      realizedPnlUsd: x.realizedPnl,
      avgSlippageBps: x.slippageBpsValues.length
        ? x.slippageBpsValues.reduce((a, b) => a + b, 0) / x.slippageBpsValues.length
        : null,
    }))
    .sort((a, b) => a.coin.localeCompare(b.coin));

  const summary = {
    fills: totals.fills,
    maker: totals.maker,
    taker: totals.taker,
    makerRatio: totals.fills > 0 ? totals.maker / totals.fills : null,
    entries: totals.entries,
    exits: totals.exits,
    notionalUsd: totals.notional,
    realizedPnlUsd: totals.realizedPnl,
    avgSlippageBps: totals.slippageBpsValues.length
      ? totals.slippageBpsValues.reduce((a, b) => a + b, 0) / totals.slippageBpsValues.length
      : null,
  };
  return { rows, summary };
}

export function buildPerformanceReport({
  streamDir,
  sinceTs,
  untilTs,
  sinceLabel,
  untilLabel,
  chainLimit = DEFAULT_CHAIN_LIMIT,
}) {
  const rows = readStreamRows(streamDir, {
    sinceTs,
    untilTs,
    includeStreams: ["execution", "metrics", "orders", "errors"],
  });
  const analysis = analyzeRows({
    rows,
    sinceTs,
    untilTs,
    sinceLabel,
    untilLabel,
    chainLimit,
  });
  const executionRows = rows.filter((x) => String(x?.__stream || "") === "execution");
  const performance = computePerformance(executionRows);
  return {
    generatedAt: new Date().toISOString(),
    window: analysis.window,
    conclusion: analysis.conclusion,
    invariantStatus: analysis.invariantStatus,
    invariants: analysis.invariants,
    performance,
    tradeAbsenceReasons: analysis.tradeAbsenceReasons,
    guardCounts: analysis.guardCounts,
    noProtection: analysis.noProtection,
    executionQuality: analysis.executionQuality,
    recentChains: analysis.recentChains,
    dataSources: analysis.dataSources,
  };
}

export function renderPerformanceTable(report) {
  const lines = [];
  lines.push(`Window (UTC): ${report?.window?.sinceIso || "n/a"} -> ${report?.window?.untilIso || "n/a"}`);
  if (report?.window?.sinceLabel || report?.window?.untilLabel) {
    lines.push(`Window Label: since="${report?.window?.sinceLabel || ""}" until="${report?.window?.untilLabel || ""}"`);
  }
  lines.push(`Conclusion: ${String(report?.conclusion || "WATCH")}`);
  lines.push(`Invariant A/B/C: ${report?.invariantStatus?.A || "WARN"} / ${report?.invariantStatus?.B || "WARN"} / ${report?.invariantStatus?.C || "WARN"}`);
  lines.push("");

  const headers = ["Coin", "Fills", "Maker", "Taker", "Maker%", "Entries", "Exits", "Notional(USD)", "RealizedPnL(USD)", "AvgSlip(bps)"];
  const rows = report?.performance?.rows || [];
  const view = rows.map((x) => ([
    x.coin,
    String(x.fills),
    String(x.maker),
    String(x.taker),
    pct(x.makerRatio),
    String(x.entries),
    String(x.exits),
    usd(x.notionalUsd),
    usd(x.realizedPnlUsd),
    bps(x.avgSlippageBps),
  ]));
  const totals = report?.performance?.summary || {};
  view.push([
    "TOTAL",
    String(Number(totals.fills || 0)),
    String(Number(totals.maker || 0)),
    String(Number(totals.taker || 0)),
    pct(totals.makerRatio),
    String(Number(totals.entries || 0)),
    String(Number(totals.exits || 0)),
    usd(totals.notionalUsd),
    usd(totals.realizedPnlUsd),
    bps(totals.avgSlippageBps),
  ]);

  const widths = headers.map((h, idx) => Math.max(
    h.length,
    ...view.map((row) => String(row[idx] || "").length),
  ));
  const rightAlign = new Set([1, 2, 3, 5, 6, 7, 8, 9]);
  const headerLine = headers
    .map((h, idx) => pad(h, widths[idx], rightAlign.has(idx)))
    .join("  ");
  const sepLine = headers
    .map((_, idx) => "-".repeat(widths[idx]))
    .join("  ");
  lines.push(headerLine);
  lines.push(sepLine);
  for (const row of view) {
    lines.push(row
      .map((cell, idx) => pad(String(cell || ""), widths[idx], rightAlign.has(idx)))
      .join("  "));
  }
  lines.push("");

  const top = report?.tradeAbsenceReasons?.top || [];
  lines.push("Top No-Trade / No-Signal Reasons:");
  if (!top.length) {
    lines.push("  none");
  } else {
    for (let i = 0; i < Math.min(top.length, 10); i += 1) {
      const row = top[i];
      lines.push(`  ${i + 1}. ${row.reason}: ${Number(row.count || 0)}`);
    }
  }
  return lines.join("\n");
}

export function renderPerformanceMarkdown(report) {
  const lines = [];
  lines.push("# Performance Report");
  lines.push("");
  lines.push(`- Window (UTC): ${report?.window?.sinceIso || "n/a"} -> ${report?.window?.untilIso || "n/a"}`);
  lines.push(`- Conclusion: ${String(report?.conclusion || "WATCH")}`);
  lines.push(`- Invariant A/B/C: ${report?.invariantStatus?.A || "WARN"} / ${report?.invariantStatus?.B || "WARN"} / ${report?.invariantStatus?.C || "WARN"}`);
  lines.push("");
  lines.push("| Coin | Fills | Maker | Taker | Maker% | Entries | Exits | Notional(USD) | RealizedPnL(USD) | AvgSlip(bps) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of report?.performance?.rows || []) {
    lines.push(`| ${row.coin} | ${row.fills} | ${row.maker} | ${row.taker} | ${pct(row.makerRatio)} | ${row.entries} | ${row.exits} | ${usd(row.notionalUsd)} | ${usd(row.realizedPnlUsd)} | ${bps(row.avgSlippageBps)} |`);
  }
  const total = report?.performance?.summary || {};
  lines.push(`| TOTAL | ${Number(total.fills || 0)} | ${Number(total.maker || 0)} | ${Number(total.taker || 0)} | ${pct(total.makerRatio)} | ${Number(total.entries || 0)} | ${Number(total.exits || 0)} | ${usd(total.notionalUsd)} | ${usd(total.realizedPnlUsd)} | ${bps(total.avgSlippageBps)} |`);
  lines.push("");
  lines.push("## Top No-Trade / No-Signal Reasons");
  const top = report?.tradeAbsenceReasons?.top || [];
  if (!top.length) {
    lines.push("- none");
  } else {
    for (const row of top.slice(0, 10)) {
      lines.push(`- ${row.reason}: ${Number(row.count || 0)}`);
    }
  }
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!["table", "md", "json"].includes(opts.format)) {
    throw new Error(`--format must be table|md|json (got: ${opts.format})`);
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

  const report = buildPerformanceReport({
    streamDir,
    sinceTs,
    untilTs,
    sinceLabel: opts.since || `${Number(opts.hours || DEFAULT_HOURS)} hours ago`,
    untilLabel: opts.until || "now",
    chainLimit: opts.chainLimit,
  });

  if (opts.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (opts.format === "md") {
    console.log(renderPerformanceMarkdown(report));
    return;
  }
  console.log(renderPerformanceTable(report));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`[performance-report] failed: ${error.message}`);
    process.exitCode = 1;
  }
}

