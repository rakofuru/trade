#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRows, readStreamRows } from "./analyze-ops.mjs";

const DEFAULT_CHAIN_LIMIT = 20;
const DEFAULT_DAY_OFFSET = 1;

function parseArgs(argv) {
  const out = {
    appDir: process.cwd(),
    streamDir: null,
    outputDir: null,
    day: null,
    dayOffset: DEFAULT_DAY_OFFSET,
    chainLimit: DEFAULT_CHAIN_LIMIT,
    save: true,
    summaryOnly: false,
    jsonOnly: false,
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
    if (arg === "--summary-only") {
      out.summaryOnly = true;
      continue;
    }
    if (arg === "--json-only") {
      out.jsonOnly = true;
      continue;
    }
    if (arg === "--no-save") {
      out.save = false;
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
    if (arg === "--output-dir" && next !== null) {
      out.outputDir = String(consume());
      continue;
    }
    if (arg === "--day" && next !== null) {
      out.day = String(consume());
      continue;
    }
    if (arg === "--day-offset" && next !== null) {
      out.dayOffset = Math.max(0, Number(consume() || DEFAULT_DAY_OFFSET));
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
    "Usage: node ops/daily-summary.mjs [options]",
    "",
    "Options:",
    "  --app-dir <path>       App root (default: cwd)",
    "  --stream-dir <path>    Stream directory (default: <app-dir>/data/streams)",
    "  --output-dir <path>    Output directory (default: <app-dir>/data/reports)",
    "  --day <YYYY-MM-DD>     UTC day to summarize (default: now - day-offset)",
    "  --day-offset <n>       Offset days from UTC now (default: 1)",
    "  --chain-limit <n>      Recent chain limit (default: 20)",
    "  --no-save              Do not write files",
    "  --summary-only         Print summary only",
    "  --json-only            Print JSON only",
    "  --help                 Show this help",
  ].join("\n");
}

function toUtcDayFromOffset(offsetDays) {
  const now = Date.now();
  const shifted = now - (Math.max(0, Number(offsetDays || 0)) * 24 * 3600 * 1000);
  return new Date(shifted).toISOString().slice(0, 10);
}

function assertUtcDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`--day must be YYYY-MM-DD (UTC): ${value}`);
  }
  return String(value);
}

function utcDayWindow(dayUtc) {
  const day = assertUtcDay(dayUtc);
  const since = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(since)) {
    throw new Error(`invalid UTC day: ${day}`);
  }
  const until = since + (24 * 3600 * 1000) - 1;
  return {
    day,
    sinceTs: since,
    untilTs: until,
    sinceLabel: `${day} 00:00:00 UTC`,
    untilLabel: `${day} 23:59:59 UTC`,
  };
}

function statusLabel(value, fallback = "WARN") {
  const s = String(value || "").toUpperCase();
  if (s === "PASS" || s === "WARN" || s === "FAIL") {
    return s;
  }
  return fallback;
}

export function buildDailySummary(baseReport, { dayUtc }) {
  const invStatus = baseReport?.invariantStatus || {};
  const invA = baseReport?.invariants?.A || {};
  const invB = baseReport?.invariants?.B || {};
  const invC = baseReport?.invariants?.C || {};
  const noProtection = baseReport?.noProtection || {};
  const flip = baseReport?.flattenOrdering || {};
  const absenceTop = Array.isArray(baseReport?.tradeAbsenceReasons?.top)
    ? baseReport.tradeAbsenceReasons.top
    : [];

  return {
    kind: "daily_summary_v1",
    generatedAt: new Date().toISOString(),
    dayUtc,
    window: baseReport?.window || {},
    conclusion: String(baseReport?.conclusion || "WATCH"),
    invariantStatus: {
      A: statusLabel(invStatus.A, invA.pass ? "PASS" : "FAIL"),
      B: statusLabel(invStatus.B, invB.pass ? "PASS" : "FAIL"),
      C: statusLabel(invStatus.C, invC.pass ? "PASS" : "FAIL"),
    },
    invariants: {
      A: {
        status: statusLabel(invStatus.A, invA.pass ? "PASS" : "FAIL"),
        noProtectionIncidentCount: Number(invA.noProtectionIncidentCount || 0),
        slowProtectionCount: Number(invA?.protectionLatencyMs?.violationCount || 0),
        graceMs: Number(invA?.protectionLatencyMs?.graceMs || 0),
      },
      B: {
        status: statusLabel(invStatus.B, invB.pass ? "PASS" : "FAIL"),
        sameDirectionAddCount: Number(invB.sameDirectionAddCount || 0),
        flipOrderingViolationCount: Number(invB.flipOrderingViolationCount || 0),
      },
      C: {
        status: statusLabel(invStatus.C, invC.pass ? "PASS" : "FAIL"),
        takerThresholdViolationCount: Number(invC.takerThresholdViolationCount || 0),
      },
    },
    fillsByCoin: baseReport?.fillsByCoin || {},
    guardCounts: baseReport?.guardCounts || {},
    tradeAbsenceReasons: {
      counts: baseReport?.tradeAbsenceReasons?.counts || {},
      top: absenceTop,
    },
    noProtection: {
      count: Number(noProtection.count || 0),
      causeCounts: noProtection.causeCounts || {},
      incidents: Array.isArray(noProtection.incidents) ? noProtection.incidents : [],
    },
    flipOrdering: {
      violationCount: Number(flip.violationCount || 0),
      violations: Array.isArray(flip.violations) ? flip.violations : [],
    },
    executionQuality: baseReport?.executionQuality || {},
    recentChains: Array.isArray(baseReport?.recentChains) ? baseReport.recentChains : [],
    dataSources: baseReport?.dataSources || {},
  };
}

function fmtBps(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(3)}bps` : "n/a";
}

function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

export function renderDailySummary(summary) {
  const lines = [];
  lines.push(`# Daily Ops Summary (${summary.dayUtc} UTC)`);
  lines.push("");
  lines.push(`- Window (UTC): ${summary?.window?.sinceIso || "n/a"} -> ${summary?.window?.untilIso || "n/a"}`);
  lines.push(`- Conclusion: ${summary?.conclusion || "WATCH"}`);
  lines.push("");
  lines.push("## Invariants");
  lines.push(`- Invariant A: ${summary?.invariants?.A?.status || "WARN"} (no_protection=${Number(summary?.invariants?.A?.noProtectionIncidentCount || 0)}, slow_sl=${Number(summary?.invariants?.A?.slowProtectionCount || 0)})`);
  lines.push(`- Invariant B: ${summary?.invariants?.B?.status || "WARN"} (same_direction_add=${Number(summary?.invariants?.B?.sameDirectionAddCount || 0)}, flip_violation=${Number(summary?.invariants?.B?.flipOrderingViolationCount || 0)})`);
  lines.push(`- Invariant C: ${summary?.invariants?.C?.status || "WARN"} (taker_threshold_violation=${Number(summary?.invariants?.C?.takerThresholdViolationCount || 0)})`);
  lines.push("");

  const causeCounts = summary?.noProtection?.causeCounts || {};
  const causeKeys = Object.keys(causeCounts).sort();
  lines.push("## NO_PROTECTION");
  lines.push(`- Count: ${Number(summary?.noProtection?.count || 0)}`);
  if (causeKeys.length) {
    for (const key of causeKeys) {
      lines.push(`- Cause ${key}: ${Number(causeCounts[key] || 0)}`);
    }
  } else {
    lines.push("- Cause breakdown: none");
  }
  const incidents = Array.isArray(summary?.noProtection?.incidents) ? summary.noProtection.incidents : [];
  if (incidents.length) {
    const sample = incidents[0];
    lines.push(`- Sample: coin=${sample.coin || "n/a"} side=${sample.side || "n/a"} cloid=${sample.cloid || "n/a"} cause=${sample.causeCategory || "UNKNOWN"} prev=${sample?.precedingEvent?.type || sample?.precedingEvent?.where || "n/a"}`);
  }
  lines.push("");

  lines.push("## Flip Ordering");
  lines.push(`- Violations: ${Number(summary?.flipOrdering?.violationCount || 0)} (flatten -> flat_confirmed -> new)`);
  lines.push("");

  lines.push("## Maker/Taker By Coin");
  const fillsByCoin = summary?.fillsByCoin || {};
  const coins = Object.keys(fillsByCoin).sort();
  if (!coins.length) {
    lines.push("- No fills");
  } else {
    for (const coin of coins) {
      const row = fillsByCoin[coin];
      lines.push(`- ${coin}: fills=${Number(row.fills || 0)} maker=${Number(row.makerFills || 0)} taker=${Number(row.takerFills || 0)} maker_ratio=${fmtPct(row.makerRatio)}`);
    }
  }
  lines.push("");

  const spread = summary?.executionQuality?.spreadBps || {};
  const slippage = summary?.executionQuality?.slippageBps || {};
  lines.push("## Execution Quality");
  lines.push(`- spread_bps p50/p90/p99: ${fmtBps(spread.p50)} / ${fmtBps(spread.p90)} / ${fmtBps(spread.p99)}`);
  lines.push(`- slippage_bps p50/p90/p99: ${fmtBps(slippage.p50)} / ${fmtBps(slippage.p90)} / ${fmtBps(slippage.p99)}`);
  lines.push("");

  lines.push("## Trade Absence Top Reasons");
  const top = Array.isArray(summary?.tradeAbsenceReasons?.top) ? summary.tradeAbsenceReasons.top : [];
  if (!top.length) {
    lines.push("- none");
  } else {
    for (const row of top.slice(0, 10)) {
      lines.push(`- ${row.reason}: ${Number(row.count || 0)}`);
    }
  }
  return lines.join("\n");
}

function writeFileSafe(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function generateDailySummary({
  appDir,
  streamDir,
  outputDir,
  day,
  chainLimit,
}) {
  const window = utcDayWindow(day);
  const rows = readStreamRows(streamDir, {
    sinceTs: window.sinceTs,
    untilTs: window.untilTs,
    includeStreams: ["execution", "metrics", "orders", "errors"],
  });
  const report = analyzeRows({
    rows,
    sinceTs: window.sinceTs,
    untilTs: window.untilTs,
    sinceLabel: window.sinceLabel,
    untilLabel: window.untilLabel,
    chainLimit,
  });
  const summary = buildDailySummary(report, { dayUtc: window.day });

  const saveDir = path.join(outputDir, window.day);
  const jsonPath = path.join(saveDir, "daily-summary.json");
  const mdPath = path.join(saveDir, "daily-summary.md");

  return {
    appDir,
    streamDir,
    outputDir,
    dayUtc: window.day,
    report,
    summary,
    paths: {
      dir: saveDir,
      jsonPath,
      mdPath,
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const appDir = path.resolve(String(opts.appDir || process.cwd()));
  const streamDir = path.resolve(String(opts.streamDir || path.join(appDir, "data", "streams")));
  const outputDir = path.resolve(String(opts.outputDir || path.join(appDir, "data", "reports")));
  const day = opts.day ? assertUtcDay(opts.day) : toUtcDayFromOffset(opts.dayOffset);

  const generated = generateDailySummary({
    appDir,
    streamDir,
    outputDir,
    day,
    chainLimit: opts.chainLimit,
  });

  const summaryText = renderDailySummary(generated.summary);
  const jsonText = `${JSON.stringify(generated.summary)}\n`;

  if (opts.save) {
    writeFileSafe(generated.paths.jsonPath, `${JSON.stringify(generated.summary, null, 2)}\n`);
    writeFileSafe(generated.paths.mdPath, `${summaryText}\n`);
  }

  if (!opts.jsonOnly) {
    console.log(summaryText);
    if (opts.save) {
      console.log(`[daily-summary] saved_json=${generated.paths.jsonPath}`);
      console.log(`[daily-summary] saved_md=${generated.paths.mdPath}`);
    }
  }
  if (!opts.summaryOnly) {
    process.stdout.write(jsonText);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  main().catch((error) => {
    console.error(`[daily-summary] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

