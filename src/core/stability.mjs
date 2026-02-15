function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeDiv(numerator, denominator, fallback = 0) {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) {
    return fallback;
  }
  return Number(numerator) / d;
}

function metricStatusMax(value, threshold) {
  if (!(threshold > 0)) {
    return "pass";
  }
  if (value > threshold) {
    return "fail";
  }
  if (value > threshold * 0.8) {
    return "warn";
  }
  return "pass";
}

function metricStatusMin(value, threshold) {
  if (!(threshold > 0)) {
    return "pass";
  }
  if (value < threshold) {
    return "fail";
  }
  if (value < threshold * 1.2) {
    return "warn";
  }
  return "pass";
}

function toPct(value) {
  return `${(safeNumber(value) * 100).toFixed(2)}%`;
}

export function evaluateStability(report, config, budgetSnapshot = null) {
  const summary = report?.summary || {};
  const orderCount = safeNumber(summary.orderAttemptCount ?? summary.orderCount);
  const cancelCount = safeNumber(summary.cancelAttemptCount);
  const executionCount = safeNumber(summary.executionCount);
  const exchangeErrCount = safeNumber(summary.orderRejectCount ?? summary.exchangeErrCount);
  const errorCount = safeNumber(summary.errorCount);
  const cancelErrorRate = safeNumber(summary.cancelErrorRate);
  const totalNotional = safeNumber(summary.totalNotional);
  const totalSlippageUsd = safeNumber(summary.totalSlippageUsd);
  const drawdownBps = safeNumber(summary.currentDrawdownBps ?? summary.maxDrawdownBps);

  const fillRate = safeNumber(summary.fillRate, safeDiv(executionCount, orderCount, 0));
  const rejectRate = safeNumber(summary.orderRejectRate, safeDiv(exchangeErrCount, orderCount, 0));
  const exceptionRate = safeNumber(
    summary.operationalExceptionRate,
    safeDiv(errorCount, Math.max(orderCount, 1), 0),
  );
  const slippageBps = totalNotional > 0 ? (totalSlippageUsd / totalNotional) * 10000 : 0;
  const wsReconnectRatio = safeDiv(
    budgetSnapshot?.wsReconnects,
    Math.max(1, budgetSnapshot?.reconnectLimit || config?.budgetMaxWsReconnects || 1),
    0,
  );

  const minOrders = Math.max(0, safeNumber(config?.stabilityMinOrders, 10));
  const minCancels = Math.max(0, safeNumber(config?.stabilityMinCancelAttempts, 3));
  const warmup = orderCount < minOrders;

  const metrics = [
    {
      key: "fill_rate",
      label: "fill rate",
      value: fillRate,
      threshold: safeNumber(config?.stabilityMinFillRate, 0.02),
      thresholdType: "min",
      format: toPct,
    },
    {
      key: "reject_rate",
      label: "exchange reject rate",
      value: rejectRate,
      threshold: safeNumber(config?.stabilityMaxRejectRate, 0.35),
      thresholdType: "max",
      format: toPct,
    },
    {
      key: "slippage_bps",
      label: "slippage bps",
      value: slippageBps,
      threshold: safeNumber(config?.stabilityMaxSlippageBps, 18),
      thresholdType: "max",
      format: (v) => `${safeNumber(v).toFixed(2)}bps`,
    },
    {
      key: "exception_rate",
      label: "exception rate",
      value: exceptionRate,
      threshold: safeNumber(config?.stabilityMaxExceptionRate, 0.2),
      thresholdType: "max",
      format: toPct,
    },
    {
      key: "cancel_error_rate",
      label: "cancel error rate",
      value: cancelErrorRate,
      threshold: safeNumber(config?.stabilityMaxCancelErrorRate, 0.8),
      thresholdType: "max",
      format: toPct,
    },
    {
      key: "ws_reconnect_ratio",
      label: "ws reconnect usage",
      value: wsReconnectRatio,
      threshold: safeNumber(config?.stabilityMaxWsReconnectRatio, 0.8),
      thresholdType: "max",
      format: toPct,
    },
    {
      key: "drawdown_bps",
      label: "drawdown",
      value: drawdownBps,
      threshold: safeNumber(config?.stabilityMaxDrawdownBps, safeNumber(config?.riskMaxDrawdownBps, 450)),
      thresholdType: "max",
      format: (v) => `${safeNumber(v).toFixed(2)}bps`,
    },
  ];

  for (const metric of metrics) {
    const derive = metric.thresholdType === "max" ? metricStatusMax : metricStatusMin;
    metric.status = derive(metric.value, metric.threshold);
    if (warmup && ["fill_rate", "reject_rate", "exception_rate"].includes(metric.key)) {
      metric.status = "warmup";
    }
    if (metric.key === "cancel_error_rate" && cancelCount < minCancels) {
      metric.status = "warmup";
    }
  }

  const statuses = metrics.map((m) => m.status).filter((x) => x !== "warmup");
  let overall = "pass";
  if (warmup && statuses.every((x) => x === "pass")) {
    overall = "warmup";
  } else if (statuses.includes("fail")) {
    overall = "fail";
  } else if (statuses.includes("warn")) {
    overall = "warn";
  }

  const violations = metrics
    .filter((m) => m.status === "fail")
    .map((m) => `${m.key}=${m.format(m.value)} threshold=${m.format(m.threshold)}`);

  return {
    overall,
    warmup,
    minOrders,
    minCancels,
    sampleOrders: orderCount,
    sampleCancels: cancelCount,
    metrics,
    violations,
  };
}
