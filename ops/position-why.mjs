#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../src/utils/fs.mjs";
import { readStreamRows } from "./analyze-ops.mjs";

const DEFAULT_LOOKBACK_HOURS = 24 * 7;
const DEFAULT_MAX_FEATURES = 4;

function parseArgs(argv) {
  const out = {
    appDir: process.cwd(),
    streamDir: null,
    stateFile: null,
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    coin: null,
    format: "table",
    maxFeatures: DEFAULT_MAX_FEATURES,
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
    if (arg === "--state-file" && next !== null) {
      out.stateFile = String(consume());
      continue;
    }
    if (arg === "--hours" && next !== null) {
      out.lookbackHours = Math.max(1, Number(consume() || DEFAULT_LOOKBACK_HOURS));
      continue;
    }
    if (arg === "--coin" && next !== null) {
      out.coin = String(consume()).toUpperCase();
      continue;
    }
    if (arg === "--format" && next !== null) {
      const value = String(consume()).toLowerCase();
      if (value === "json" || value === "table" || value === "md") {
        out.format = value;
      }
      continue;
    }
    if (arg === "--max-features" && next !== null) {
      out.maxFeatures = Math.max(1, Math.min(12, Number(consume() || DEFAULT_MAX_FEATURES)));
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage: node ops/position-why.mjs [options]",
    "",
    "Options:",
    "  --app-dir <path>       App root (default: cwd)",
    "  --stream-dir <path>    Stream directory (default: <app-dir>/data/streams)",
    "  --state-file <path>    Runtime state file (default: <app-dir>/data/state/runtime-state.json)",
    "  --hours <n>            Lookback hours for entry snapshot evidence (default: 168)",
    "  --coin <symbol>        Filter by coin (e.g. BTC)",
    "  --format <table|md|json>  Output format (default: table)",
    "  --max-features <n>     Max feature keys in human summary (default: 4)",
    "  --help                 Show this help",
  ].join("\n");
}

function toTs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function toCoin(value) {
  return String(value || "").toUpperCase();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFeatureValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) >= 1000) return value.toFixed(2);
    if (Math.abs(value) >= 10) return value.toFixed(3);
    return value.toFixed(4);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 37)}...` : value;
  }
  return String(value);
}

function summarizeFeatures(featureObj, maxFeatures = DEFAULT_MAX_FEATURES) {
  if (!featureObj || typeof featureObj !== "object" || Array.isArray(featureObj)) {
    return null;
  }
  const entries = Object.entries(featureObj)
    .filter(([, v]) => {
      const t = typeof v;
      return t === "number" || t === "boolean" || t === "string";
    })
    .slice(0, Math.max(1, Number(maxFeatures || DEFAULT_MAX_FEATURES)));
  if (!entries.length) {
    return null;
  }
  return entries.map(([k, v]) => `${k}=${normalizeFeatureValue(v)}`).join(", ");
}

function ensureMapByCoin(rows) {
  const out = new Map();
  for (const row of toArray(rows)) {
    const coin = toCoin(row?.coin);
    if (!coin) continue;
    out.set(coin, row);
  }
  return out;
}

function inferSide({ side, size }) {
  const normalizedSide = String(side || "").toLowerCase();
  if (normalizedSide === "buy" || normalizedSide === "sell") {
    return normalizedSide;
  }
  const n = Number(size || 0);
  if (n > 0) return "buy";
  if (n < 0) return "sell";
  return null;
}

function fmtMaybeNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(digits);
}

function normalizeEntrySnapshot(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const coin = toCoin(row?.coin);
  if (!coin) {
    return null;
  }
  const entryTs = toTs(pickFirst(row.entryTs, row.fillTime, row.ts));
  return {
    coin,
    cloid: row.cloid || null,
    side: row.side || null,
    entryTs,
    entryIso: entryTs ? new Date(entryTs).toISOString() : null,
    entryPx: finiteNumber(row.entryPx),
    notional: finiteNumber(row.notional),
    regime: row.regime || null,
    strategy: row.strategy || null,
    reason: String(row.reason || row.strategy || "unknown"),
    reasonCode: String(row.reasonCode || row.reason || row.strategy || "unknown"),
    features: row.features || null,
    protectionPlan: row.protectionPlan || null,
    maker: Boolean(row.maker),
    taker: Boolean(row.taker),
    tif: row.tif || null,
    dayKey: row.dayKey || null,
    sourceTs: toTs(row.ts),
  };
}

function latestSnapshotMap(rows) {
  const out = new Map();
  for (const row of toArray(rows)) {
    const snap = normalizeEntrySnapshot(row);
    if (!snap) continue;
    const prev = out.get(snap.coin);
    const prevTs = toTs(prev?.entryTs ?? prev?.sourceTs) || 0;
    const nextTs = toTs(snap?.entryTs ?? snap?.sourceTs) || 0;
    if (!prev || nextTs >= prevTs) {
      out.set(snap.coin, snap);
    }
  }
  return out;
}

function latestByKey(rows, keyFn, tsFn = (row) => toTs(row?.ts ?? row?.fillTime) || 0) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const prev = out.get(key);
    const prevTs = prev ? tsFn(prev) : 0;
    const nextTs = tsFn(row);
    if (!prev || nextTs >= prevTs) {
      out.set(key, row);
    }
  }
  return out;
}

function pickLatestSnapshot(runtimeSnapshot, metricSnapshot) {
  if (runtimeSnapshot && metricSnapshot) {
    const rtTs = toTs(runtimeSnapshot.entryTs ?? runtimeSnapshot.sourceTs) || 0;
    const mtTs = toTs(metricSnapshot.entryTs ?? metricSnapshot.sourceTs) || 0;
    return mtTs >= rtTs ? metricSnapshot : runtimeSnapshot;
  }
  return metricSnapshot || runtimeSnapshot || null;
}

export function buildPositionWhyReport({
  runtimeState = {},
  executionRows = [],
  orderRows = [],
  metricsRows = [],
  coin = null,
  maxFeatures = DEFAULT_MAX_FEATURES,
  nowTs = Date.now(),
} = {}) {
  const targetCoin = coin ? toCoin(coin) : null;
  const planByCoin = ensureMapByCoin(runtimeState?.positionProtectionPlansByCoin);
  const entryByCoin = ensureMapByCoin(runtimeState?.lastEntryContextByCoin);
  const runtimeSnapshotByCoin = latestSnapshotMap(runtimeState?.lastEntrySnapshotByCoin || []);
  const metricSnapshotByCoin = latestSnapshotMap(
    toArray(metricsRows).filter((row) => String(row?.type || "") === "entry_snapshot"),
  );
  const openByCoin = ensureMapByCoin(runtimeState?.lastOpenPositionsByCoin);

  const entryExecutions = toArray(executionRows).filter((row) => !Boolean(row?.reduceOnly));
  const entryOrders = toArray(orderRows).filter((row) => !Boolean(row?.reduceOnly));
  const execByCloid = latestByKey(entryExecutions, (row) => String(row?.cloid || ""));
  const execByCoin = latestByKey(entryExecutions, (row) => toCoin(row?.coin));
  const orderByCloid = latestByKey(entryOrders, (row) => String(row?.cloid || ""));
  const orderByCoin = latestByKey(entryOrders, (row) => toCoin(row?.coin));

  const coinSet = new Set();
  for (const key of openByCoin.keys()) coinSet.add(key);
  if (coinSet.size === 0) {
    for (const key of planByCoin.keys()) coinSet.add(key);
    for (const key of entryByCoin.keys()) coinSet.add(key);
    for (const key of runtimeSnapshotByCoin.keys()) coinSet.add(key);
    for (const key of metricSnapshotByCoin.keys()) coinSet.add(key);
  }

  const positions = [];
  for (const c of Array.from(coinSet).sort()) {
    if (targetCoin && c !== targetCoin) {
      continue;
    }
    const open = openByCoin.get(c) || null;
    const plan = planByCoin.get(c) || null;
    const entry = entryByCoin.get(c) || null;
    const runtimeSnapshot = runtimeSnapshotByCoin.get(c) || null;
    const metricSnapshot = metricSnapshotByCoin.get(c) || null;
    const snapshot = pickLatestSnapshot(runtimeSnapshot, metricSnapshot);
    const snapshotSource = metricSnapshot
      ? "stream:metrics.entry_snapshot"
      : (runtimeSnapshot ? "state:lastEntrySnapshotByCoin" : null);

    const cloid = String(pickFirst(snapshot?.cloid, entry?.cloid, plan?.cloid) || "");
    const exec = cloid ? (execByCloid.get(cloid) || null) : null;
    const order = cloid ? (orderByCloid.get(cloid) || null) : null;
    const fallbackExec = exec || execByCoin.get(c) || null;
    const fallbackOrder = order || orderByCoin.get(c) || null;

    const explanation = snapshot?.features
      ? { style: snapshot.reasonCode, feature: snapshot.features }
      : (pickFirst(entry?.explanation, fallbackExec?.explanation, fallbackOrder?.explanation, plan?.explanation) || null);
    const reason = String(pickFirst(snapshot?.reason, entry?.reason, fallbackExec?.reason, fallbackOrder?.reason, plan?.reason, "unknown"));
    const strategy = String(pickFirst(snapshot?.strategy, entry?.strategy, fallbackExec?.strategy, fallbackOrder?.strategy, plan?.strategy, "unknown"));
    const regime = pickFirst(snapshot?.regime, entry?.regime, fallbackExec?.regime, fallbackOrder?.regime, plan?.regime);

    const size = finiteNumber(open?.size);
    const side = inferSide({
      side: pickFirst(open?.side, snapshot?.side, entry?.side, fallbackExec?.side, fallbackOrder?.side, plan?.side),
      size,
    });
    const entryPx = finiteNumber(pickFirst(snapshot?.entryPx, entry?.entryPx, plan?.entryPx, fallbackExec?.fillPx, fallbackOrder?.limitPx, open?.entryPx));
    const markPx = finiteNumber(open?.markPx);
    const unrealizedPnl = finiteNumber(open?.unrealizedPnl);
    const entryAt = toTs(pickFirst(snapshot?.entryTs, entry?.fillTime, plan?.entryAt, fallbackExec?.fillTime, fallbackExec?.ts, fallbackOrder?.ts));

    const why = String(pickFirst(snapshot?.reasonCode, explanation?.style, reason, strategy, "unknown"));
    const featureSummary = summarizeFeatures(pickFirst(snapshot?.features, explanation?.feature) || null, maxFeatures);
    const feedbackReady = Boolean(snapshot?.entryTs && snapshot?.reasonCode);

    positions.push({
      coin: c,
      side,
      size,
      entryPx,
      markPx,
      unrealizedPnl,
      entryAt,
      entryIso: entryAt ? new Date(entryAt).toISOString() : null,
      cloid: pickFirst(snapshot?.cloid, entry?.cloid, fallbackExec?.cloid, fallbackOrder?.cloid, plan?.cloid, null),
      regime: regime || null,
      strategy,
      reason,
      why,
      feedbackReady,
      snapshotSource,
      featureSummary,
      explanation: explanation || null,
      protection: {
        slPct: finiteNumber(pickFirst(snapshot?.protectionPlan?.slPct, plan?.slPct)),
        tpPct: finiteNumber(pickFirst(snapshot?.protectionPlan?.tpPct, plan?.tpPct)),
        timeStopMs: finiteNumber(pickFirst(snapshot?.protectionPlan?.timeStopMs, plan?.timeStopMs)),
        timeStopProgressR: finiteNumber(pickFirst(snapshot?.protectionPlan?.timeStopProgressR, plan?.timeStopProgressR)),
      },
      evidence: {
        runtimeOpenUpdatedAt: toTs(open?.updatedAt) || null,
        snapshotTs: toTs(snapshot?.entryTs ?? snapshot?.sourceTs) || null,
        executionTs: toTs(fallbackExec?.ts) || null,
        orderTs: toTs(fallbackOrder?.ts) || null,
      },
    });
  }

  return {
    kind: "position_why_v1",
    generatedAt: new Date(nowTs).toISOString(),
    status: positions.length ? "HAS_OPEN_POSITION" : "FLAT",
    openPositionCount: positions.length,
    feedbackReadyCount: positions.filter((x) => Boolean(x?.feedbackReady)).length,
    positions,
  };
}

function padRight(value, width) {
  const text = String(value ?? "");
  if (text.length >= width) return text;
  return `${text}${" ".repeat(width - text.length)}`;
}

function truncate(text, width) {
  const s = String(text ?? "");
  if (s.length <= width) return s;
  return `${s.slice(0, Math.max(0, width - 3))}...`;
}

export function renderPositionWhyTable(report) {
  const rows = Array.isArray(report?.positions) ? report.positions : [];
  const lines = [];
  lines.push(`[position-why] generated_at=${report?.generatedAt || "n/a"} status=${report?.status || "unknown"} open=${rows.length} feedback_ready=${Number(report?.feedbackReadyCount || 0)}`);
  if (!rows.length) {
    lines.push("[position-why] no open positions");
    return lines.join("\n");
  }

  const header = [
    padRight("Coin", 5),
    padRight("Side", 6),
    padRight("Size", 12),
    padRight("EntryPx", 12),
    padRight("UPnL", 12),
    padRight("Regime", 11),
    padRight("Strategy", 20),
    padRight("Why", 24),
    padRight("Snapshot", 9),
    "Features",
  ].join("  ");
  lines.push(header);
  lines.push("-".repeat(Math.min(180, header.length + 8)));

  for (const row of rows) {
    lines.push([
      padRight(row.coin || "", 5),
      padRight(row.side || "n/a", 6),
      padRight(fmtMaybeNumber(row.size, 6) || "n/a", 12),
      padRight(fmtMaybeNumber(row.entryPx, 4) || "n/a", 12),
      padRight(fmtMaybeNumber(row.unrealizedPnl, 4) || "n/a", 12),
      padRight(row.regime || "n/a", 11),
      padRight(truncate(row.strategy || "n/a", 20), 20),
      padRight(truncate(row.why || "n/a", 24), 24),
      padRight(row.feedbackReady ? "ready" : "missing", 9),
      truncate(row.featureSummary || "-", 120),
    ].join("  "));
  }
  return lines.join("\n");
}

export function renderPositionWhyMarkdown(report) {
  const rows = Array.isArray(report?.positions) ? report.positions : [];
  const lines = [];
  lines.push("# Position Why");
  lines.push("");
  lines.push(`- generatedAt: ${report?.generatedAt || "n/a"}`);
  lines.push(`- status: ${report?.status || "unknown"}`);
  lines.push(`- openPositionCount: ${rows.length}`);
  lines.push(`- feedbackReadyCount: ${Number(report?.feedbackReadyCount || 0)}`);
  lines.push("");
  if (!rows.length) {
    lines.push("- No open positions");
    return lines.join("\n");
  }

  lines.push("| Coin | Side | Size | EntryPx | UPNL | Regime | Strategy | Why | Snapshot | Features |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.coin || "n/a"}`
      + ` | ${row.side || "n/a"}`
      + ` | ${fmtMaybeNumber(row.size, 6) || "n/a"}`
      + ` | ${fmtMaybeNumber(row.entryPx, 4) || "n/a"}`
      + ` | ${fmtMaybeNumber(row.unrealizedPnl, 4) || "n/a"}`
      + ` | ${row.regime || "n/a"}`
      + ` | ${row.strategy || "n/a"}`
      + ` | ${row.why || "n/a"}`
      + ` | ${row.feedbackReady ? "ready" : "missing"}`
      + ` | ${row.featureSummary || "-"} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const appDir = path.resolve(String(opts.appDir || process.cwd()));
  const streamDir = path.resolve(String(opts.streamDir || path.join(appDir, "data", "streams")));
  const stateFile = path.resolve(String(opts.stateFile || path.join(appDir, "data", "state", "runtime-state.json")));
  const nowTs = Date.now();
  const sinceTs = nowTs - (Math.max(1, Number(opts.lookbackHours || DEFAULT_LOOKBACK_HOURS)) * 3600 * 1000);

  const runtimeState = readJson(stateFile, {});
  const rows = readStreamRows(streamDir, {
    sinceTs,
    includeStreams: ["execution", "orders", "metrics"],
  });
  const executionRows = rows.filter((row) => row.__stream === "execution");
  const orderRows = rows.filter((row) => row.__stream === "orders");
  const metricsRows = rows.filter((row) => row.__stream === "metrics");

  const report = buildPositionWhyReport({
    runtimeState,
    executionRows,
    orderRows,
    metricsRows,
    coin: opts.coin,
    maxFeatures: opts.maxFeatures,
    nowTs,
  });

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (opts.format === "md") {
    console.log(renderPositionWhyMarkdown(report));
    return;
  }
  console.log(renderPositionWhyTable(report));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  main().catch((error) => {
    console.error(`[position-why] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
