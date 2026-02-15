import { mergeRollupRows } from "./rollup-manager.mjs";
import { evaluateStability } from "./stability.mjs";

function withinWindow(row, cutoff) {
  const ts = Number(row?.ts ?? 0);
  return ts >= cutoff;
}

function summarizeGroup(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    if (!out[key]) {
      out[key] = {
        count: 0,
        notional: 0,
        pnl: 0,
        fees: 0,
        slippageUsd: 0,
        maker: 0,
        taker: 0,
        wins: 0,
        losses: 0,
        avgLatencyMs: 0,
        _latencySum: 0,
        _latencyN: 0,
      };
    }
    const g = out[key];
    g.count += 1;
    g.notional += Number(row.notional || 0);
    g.pnl += Number(row.realizedPnl || 0);
    g.fees += Number(row.feeUsd || row.fees || 0);
    g.slippageUsd += Number(row.slippageUsd || 0);
    g.maker += row.maker ? 1 : 0;
    g.taker += row.taker ? 1 : 0;
    g.wins += Number(row.realizedPnl || 0) > 0 ? 1 : 0;
    g.losses += Number(row.realizedPnl || 0) < 0 ? 1 : 0;

    if (row.latencyMs !== null && row.latencyMs !== undefined) {
      g._latencySum += Number(row.latencyMs || 0);
      g._latencyN += 1;
      g.avgLatencyMs = g._latencyN > 0 ? g._latencySum / g._latencyN : 0;
    }
  }

  for (const value of Object.values(out)) {
    const total = value.wins + value.losses;
    value.winRate = total > 0 ? value.wins / total : 0;
    value.rewardProxyBps = value.notional > 0
      ? ((value.pnl - value.fees - value.slippageUsd) / value.notional) * 10000
      : 0;
    delete value._latencySum;
    delete value._latencyN;
  }

  return out;
}

export function generateReport({ storage, budgetSnapshot = null, windowMs = 24 * 3600 * 1000 }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const rawLookbackHours = Number(storage?.config?.reportRawLookbackHours || 24);
  const rawCutoff = Math.max(cutoff, now - rawLookbackHours * 3600 * 1000);

  const executionRows = storage.readStream("execution", { maxLines: 100000 }).filter((x) => withinWindow(x, rawCutoff));
  const fillRows = storage.readStream("fills", { maxLines: 100000 }).filter((x) => withinWindow(x, rawCutoff));
  const errors = storage.readStream("errors", { maxLines: 50000 }).filter((x) => withinWindow(x, rawCutoff));
  const orderRows = storage.readStream("orders", { maxLines: 50000 }).filter((x) => withinWindow(x, rawCutoff));
  const exchangeRows = storage.readStream("raw_http", { maxLines: 100000 })
    .filter((x) => withinWindow(x, rawCutoff))
    .filter((x) => String(x.label || "").startsWith("exchange:"));
  const rollupRows = storage.readRollup("coin_rollup", { maxLines: 200000 })
    .filter((x) => withinWindow(x, cutoff))
    .filter((x) => Number(x.ts || 0) < rawCutoff);

  const arm = summarizeGroup(executionRows, (x) => x.armId);
  const coin = summarizeGroup(executionRows, (x) => x.coin);
  const regime = summarizeGroup(executionRows, (x) => x.regime);
  const type = summarizeGroup(executionRows, (x) => (x.maker ? "maker" : "taker"));
  const rollupMerged = mergeRollupRows(rollupRows);
  const mergedCoin = mergeGroupMaps(coin, rollupMerged.byCoin || {});
  const exchangeParsed = exchangeRows.map((row) => parseExchangeRow(row));
  const exchangeOrders = exchangeParsed.filter((x) => x.actionType === "order");
  const exchangeCancels = exchangeParsed.filter((x) => x.actionType === "cancel" || x.actionType === "cancelByCloid");
  const orderRejectRaw = exchangeOrders.filter((x) => Boolean(x.error));
  const cancelErrorRaw = exchangeCancels.filter((x) => Boolean(x.error) && !x.benignCancelNoop);
  const cancelNoopRaw = exchangeCancels.filter((x) => Boolean(x.error) && x.benignCancelNoop);
  const orderSubmitErrors = errors.filter((x) => String(x.where || "") === "order_submit");
  const suppressedErrors = errors.filter((x) => isSuppressedOperationalError(x));
  const operationalErrors = errors.filter((x) => {
    const where = String(x.where || "");
    if (where === "order_submit") {
      return false;
    }
    if (isSuppressedOperationalError(x)) {
      return false;
    }
    return true;
  });

  const feedbackState = storage.loadState("feedback-state", null);
  const currentDrawdownBps = Number(feedbackState?.metrics?.drawdownBps || 0);
  const maxDrawdownBps = Math.max(
    currentDrawdownBps,
    Number(feedbackState?.metrics?.global?.maxDrawdownBps || 0),
  );

  const summary = {
    windowMs,
    generatedAt: new Date().toISOString(),
    executionCount: executionRows.length + Number(rollupMerged.summary?.executionCount || 0),
    errorCount: operationalErrors.length + Number(rollupMerged.summary?.errorCount || 0),
    suppressedErrorCount: suppressedErrors.length,
    orderSubmitErrorCount: orderSubmitErrors.length,
    rawErrorCountAll: errors.length + Number(rollupMerged.summary?.errorCount || 0),
    orderCount: orderRows.length + Number(rollupMerged.summary?.orderCount || 0),
    orderAttemptCount: exchangeOrders.length + Number(rollupMerged.summary?.orderCount || 0),
    cancelAttemptCount: exchangeCancels.length,
    orderRejectCount: orderRejectRaw.length + Number(rollupMerged.summary?.exchangeErrCount || 0),
    cancelErrorCount: cancelErrorRaw.length,
    cancelNoopCount: cancelNoopRaw.length,
    totalNotional: executionRows.reduce((a, b) => a + Number(b.notional || 0), 0) + Number(rollupMerged.summary?.totalNotional || 0),
    totalPnl: executionRows.reduce((a, b) => a + Number(b.realizedPnl || 0), 0) + Number(rollupMerged.summary?.totalPnl || 0),
    totalFees: executionRows.reduce((a, b) => a + Number(b.feeUsd || b.fees || 0), 0) + Number(rollupMerged.summary?.totalFees || 0),
    totalSlippageUsd: executionRows.reduce((a, b) => a + Number(b.slippageUsd || 0), 0) + Number(rollupMerged.summary?.totalSlippageUsd || 0),
    makerRatio: executionRows.length
      ? executionRows.filter((x) => x.maker).length / executionRows.length
      : 0,
    exchangeErrCount: (
      orderRejectRaw.length
      + cancelErrorRaw.length
      + Number(rollupMerged.summary?.exchangeErrCount || 0)
    ),
    filledOrderCount: countFilledOrders(fillRows),
    rawCutoff,
    rawLookbackHours,
    rollupRows: rollupRows.length,
    currentDrawdownBps,
    maxDrawdownBps,
  };

  summary.filledOrderRate = summary.orderAttemptCount > 0
    ? summary.filledOrderCount / summary.orderAttemptCount
    : 0;
  summary.fillRate = summary.filledOrderRate;
  summary.orderRejectRate = summary.orderAttemptCount > 0
    ? summary.orderRejectCount / summary.orderAttemptCount
    : 0;
  summary.cancelErrorRate = summary.cancelAttemptCount > 0
    ? summary.cancelErrorCount / summary.cancelAttemptCount
    : 0;
  summary.rejectRate = summary.orderRejectRate;
  summary.operationalExceptionRate = (summary.orderAttemptCount + summary.cancelAttemptCount) > 0
    ? summary.errorCount / (summary.orderAttemptCount + summary.cancelAttemptCount)
    : 0;
  summary.exceptionRate = summary.operationalExceptionRate;
  summary.slippageBps = summary.totalNotional > 0
    ? (summary.totalSlippageUsd / summary.totalNotional) * 10000
    : 0;

  const exchangeErrorCounts = {};
  for (const row of exchangeParsed) {
    const message = redactSensitiveText(row.error);
    if (!message) {
      continue;
    }
    exchangeErrorCounts[String(message)] = (exchangeErrorCounts[String(message)] || 0) + 1;
  }

  const stability = evaluateStability({ summary }, storage?.config || {}, budgetSnapshot);

  return {
    summary,
    stability,
    byArm: arm,
    byCoin: mergedCoin,
    byRegime: regime,
    byType: type,
    exchangeErrors: exchangeErrorCounts,
    errors: errors.slice(-50),
    recentTrades: executionRows.slice(-50),
    budget: budgetSnapshot,
  };
}

export function saveReport(storage, report, tag = "manual") {
  storage.appendReport({
    tag,
    report,
  });
}

export function formatReport(report) {
  const lines = [];
  lines.push("=== Bot Performance Report ===");
  lines.push(`generatedAt: ${report.summary.generatedAt}`);
  lines.push(`windowMs: ${report.summary.windowMs}`);
  lines.push(`executionCount: ${report.summary.executionCount}`);
  lines.push(`orderCount: ${report.summary.orderCount}`);
  lines.push(`orderAttemptCount: ${report.summary.orderAttemptCount}`);
  lines.push(`cancelAttemptCount: ${report.summary.cancelAttemptCount}`);
  lines.push(`errorCount: ${report.summary.errorCount}`);
  lines.push(`suppressedErrorCount: ${report.summary.suppressedErrorCount}`);
  lines.push(`orderSubmitErrorCount: ${report.summary.orderSubmitErrorCount}`);
  lines.push(`totalNotional: ${report.summary.totalNotional.toFixed(4)}`);
  lines.push(`totalPnl: ${report.summary.totalPnl.toFixed(6)}`);
  lines.push(`totalFees: ${report.summary.totalFees.toFixed(6)}`);
  lines.push(`totalSlippageUsd: ${report.summary.totalSlippageUsd.toFixed(6)}`);
  lines.push(`makerRatio: ${(report.summary.makerRatio * 100).toFixed(2)}%`);
  lines.push(`exchangeErrCount: ${report.summary.exchangeErrCount}`);
  lines.push(`orderRejectCount: ${report.summary.orderRejectCount}`);
  lines.push(`cancelErrorCount: ${report.summary.cancelErrorCount}`);
  lines.push(`cancelNoopCount: ${report.summary.cancelNoopCount}`);
  lines.push(`filledOrderCount: ${report.summary.filledOrderCount}`);
  lines.push(`filledOrderRate: ${(Number(report.summary.filledOrderRate || 0) * 100).toFixed(2)}%`);
  lines.push(`fillRate: ${(Number(report.summary.fillRate || 0) * 100).toFixed(2)}%`);
  lines.push(`orderRejectRate: ${(Number(report.summary.orderRejectRate || 0) * 100).toFixed(2)}%`);
  lines.push(`cancelErrorRate: ${(Number(report.summary.cancelErrorRate || 0) * 100).toFixed(2)}%`);
  lines.push(`rejectRate: ${(Number(report.summary.rejectRate || 0) * 100).toFixed(2)}%`);
  lines.push(`exceptionRate: ${(Number(report.summary.exceptionRate || 0) * 100).toFixed(2)}%`);
  lines.push(`slippageBps: ${Number(report.summary.slippageBps || 0).toFixed(2)}`);
  lines.push(`currentDrawdownBps: ${Number(report.summary.currentDrawdownBps || 0).toFixed(2)}`);
  lines.push(`rawLookbackHours: ${report.summary.rawLookbackHours}`);
  lines.push(`rollupRowsUsed: ${report.summary.rollupRows}`);

  lines.push("-- stability --");
  lines.push(`overall: ${String(report?.stability?.overall || "unknown").toUpperCase()}`);
  if (report?.stability?.warmup) {
    lines.push(`warmup: order samples ${report.stability.sampleOrders}/${report.stability.minOrders}`);
  }
  for (const metric of report?.stability?.metrics || []) {
    const status = String(metric.status || "unknown").toUpperCase();
    const value = formatStabilityMetric(metric, metric.value);
    const threshold = formatStabilityMetric(metric, metric.threshold);
    const compare = metric.thresholdType === "min" ? ">=" : "<=";
    lines.push(`${metric.key}: ${value} (target ${compare} ${threshold}) [${status}]`);
  }

  lines.push("-- byArm --");
  lines.push(...formatGroupTable(report.byArm || {}, { includeLatency: false }));

  lines.push("-- byCoin --");
  lines.push(...formatGroupTable(report.byCoin || {}, { includeLatency: false }));

  lines.push("-- byType --");
  lines.push(...formatGroupTable(report.byType || {}, { includeLatency: true }));

  lines.push("-- exchangeErrors --");
  for (const [k, v] of Object.entries(report.exchangeErrors || {})) {
    lines.push(`${v}x ${k}`);
  }

  const improvements = generateTopImprovements(report);
  lines.push("-- topImprovements --");
  for (let i = 0; i < improvements.length; i += 1) {
    const x = improvements[i];
    lines.push(`${i + 1}. [${x.category}] ${x.title} :: ${x.why}`);
  }

  return lines.join("\n");
}

export function loadLastReport(storage) {
  const rows = storage.readStream("reports", { maxLines: 1 });
  return rows.length ? rows[0] : null;
}

export function generateTopImprovements(report) {
  const out = [];
  const slip = Number(report?.summary?.totalSlippageUsd || 0);
  const notional = Number(report?.summary?.totalNotional || 0);
  const slipBps = notional > 0 ? (slip / notional) * 10000 : 0;
  const rejectCount = Number(report?.summary?.exchangeErrCount || 0);

  out.push({
    category: "execution",
    title: "Dynamic IOC/Alo routing by expected_fill_prob",
    why: `slippage~${slipBps.toFixed(2)}bps, reduce taker bleed when fill probability is low`,
  });
  out.push({
    category: "learning",
    title: "Regime-wise adaptive exploration",
    why: "decrease exploration in high-variance regimes to reduce noisy losses",
  });
  out.push({
    category: "operations",
    title: "Agent wallet isolation + stricter budget headroom",
    why: `recent exchange rejects=${rejectCount}, keep survivability and reduce failure loops`,
  });
  out.push({
    category: "debugging",
    title: "Auto index exchange rejects into searchable codes",
    why: "faster root-cause from raw_http without manual grep",
  });
  out.push({
    category: "allocation",
    title: "Concentrate notional on top-2 coin selectors",
    why: "avoid thin-liquidity tails and cut unproductive order attempts",
  });
  return out.slice(0, 5);
}

function extractExchangeError(rawRow) {
  const response = rawRow?.response || {};
  if (String(response?.status || "").toLowerCase() === "err") {
    if (typeof response?.response === "string" && response.response) {
      return response.response;
    }
    if (typeof response?.error === "string" && response.error) {
      return response.error;
    }
    if (typeof response?.response?.error === "string" && response.response.error) {
      return response.response.error;
    }
  }

  const statuses = response?.response?.data?.statuses || response?.data?.statuses || [];
  for (const status of statuses) {
    if (typeof status?.error === "string" && status.error) {
      return status.error;
    }
  }
  return null;
}

function parseExchangeRow(rawRow) {
  const label = String(rawRow?.label || "");
  const requestAction = String(rawRow?.request?.action?.type || "");
  const parts = label.split(":");
  const actionFromLabel = parts.length > 1 ? parts[1] : "";
  const actionType = requestAction || actionFromLabel || "unknown";
  const error = extractExchangeError(rawRow);
  const errorCode = classifyExchangeError(error);
  return {
    label,
    actionType,
    error,
    errorCode,
    benignCancelNoop: isBenignCancelNoop(actionType, errorCode),
    row: rawRow,
  };
}

function classifyExchangeError(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return "none";
  if (m.includes("vault not registered")) return "vault_not_registered";
  if (m.includes("badalopx") || (m.includes("alo") && m.includes("bad"))) return "bad_alo_px";
  if (m.includes("mintraden") || m.includes("min trade") || m.includes("min notional")) return "min_notional";
  if (m.includes("invalid price")) return "invalid_price";
  if (m.includes("invalid size")) return "invalid_size";
  if (m.includes("tick") || m.includes("lot")) return "tick_or_lot_size";
  if (m.includes("insufficient") && m.includes("margin")) return "insufficient_margin";
  if (m.includes("not approved") || m.includes("notapproved")) return "not_approved";
  if (
    m.includes("never placed")
    || m.includes("already canceled")
    || m.includes("already cancelled")
    || m.includes("or filled")
  ) {
    return "order_already_terminal";
  }
  return "other";
}

function isBenignCancelNoop(actionType, errorCode) {
  const a = String(actionType || "");
  if (a !== "cancel" && a !== "cancelByCloid") {
    return false;
  }
  return errorCode === "order_already_terminal";
}

function redactSensitiveText(value) {
  if (!value) {
    return value;
  }
  return String(value).replace(/0x[a-fA-F0-9]{8,}/g, (m) => `${m.slice(0, 6)}***${m.slice(-4)}`);
}

function mergeGroupMaps(primary, secondary) {
  const out = { ...(primary || {}) };
  for (const [key, value] of Object.entries(secondary || {})) {
    if (!out[key]) {
      out[key] = { ...value };
      continue;
    }
    const target = out[key];
    target.count = Number(target.count || 0) + Number(value.count || 0);
    target.notional = Number(target.notional || 0) + Number(value.notional || 0);
    target.pnl = Number(target.pnl || 0) + Number(value.pnl || 0);
    target.fees = Number(target.fees || 0) + Number(value.fees || 0);
    target.slippageUsd = Number(target.slippageUsd || 0) + Number(value.slippageUsd || 0);
    target.maker = Number(target.maker || 0) + Number(value.maker || 0);
    target.taker = Number(target.taker || 0) + Number(value.taker || 0);
    target.wins = Number(target.wins || 0) + Number(value.wins || 0);
    target.losses = Number(target.losses || 0) + Number(value.losses || 0);
    const total = target.wins + target.losses;
    target.winRate = total > 0 ? target.wins / total : 0;
    target.rewardProxyBps = target.notional > 0
      ? ((target.pnl - target.fees - target.slippageUsd) / target.notional) * 10000
      : 0;
  }
  return out;
}

function formatGroupTable(group, { includeLatency = false } = {}) {
  const rows = Object.entries(group || {}).map(([key, value]) => ({
    key,
    n: Number(value.count || 0),
    winRate: (Number(value.winRate || 0) * 100).toFixed(1),
    reward: Number(value.rewardProxyBps || 0).toFixed(2),
    latency: Number(value.avgLatencyMs || 0).toFixed(1),
  }));
  if (!rows.length) {
    return ["(no data)"];
  }
  rows.sort((a, b) => b.n - a.n);

  const keyWidth = Math.min(24, Math.max(...rows.map((r) => r.key.length), 4));
  const lines = [];
  const header = includeLatency
    ? `${padRight("key", keyWidth)} | n | win% | rewardBps | latencyMs`
    : `${padRight("key", keyWidth)} | n | win% | rewardBps`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const row of rows) {
    if (includeLatency) {
      lines.push(`${padRight(row.key, keyWidth)} | ${row.n} | ${row.winRate} | ${row.reward} | ${row.latency}`);
    } else {
      lines.push(`${padRight(row.key, keyWidth)} | ${row.n} | ${row.winRate} | ${row.reward}`);
    }
  }
  return lines;
}

function padRight(text, width) {
  const str = String(text);
  if (str.length >= width) {
    return str;
  }
  return str + " ".repeat(width - str.length);
}

function formatStabilityMetric(metric, value) {
  if (typeof metric?.format === "function") {
    return metric.format(value);
  }
  const key = String(metric?.key || "");
  if (key.includes("rate") || key.includes("ratio")) {
    return `${(Number(value || 0) * 100).toFixed(2)}%`;
  }
  if (key.includes("bps")) {
    return `${Number(value || 0).toFixed(2)}bps`;
  }
  return Number(value || 0).toFixed(4);
}

function countFilledOrders(fillRows) {
  const keys = new Set();
  for (const row of fillRows || []) {
    const fill = row?.fill || row;
    const cloid = fill?.cloid || fill?.clientOrderId;
    if (cloid) {
      keys.add(`c:${cloid}`);
      continue;
    }
    const oid = fill?.oid || fill?.orderId;
    if (oid !== undefined && oid !== null) {
      keys.add(`o:${oid}`);
    }
  }
  return keys.size;
}

function isSuppressedOperationalError(row) {
  const where = String(row?.where || "");
  const error = String(row?.error || "").toLowerCase();
  // Historic noise from trigger acceptance (waitingForTrigger) was recorded as unknown.
  if (where === "tpsl_submit" && error === "unknown") {
    return true;
  }
  return false;
}
