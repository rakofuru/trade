function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function fmtNumber(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function fmtPct01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

function compact(value, maxLen = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "n/a";
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function normalize(payload = {}) {
  return {
    dateUtc: String(payload.dateUtc || new Date(Date.now() - (24 * 3600 * 1000)).toISOString().slice(0, 10)),
    dailyRealizedPnlUsd: fmtMoney(payload.dailyRealizedPnlUsd),
    maxDdBps: fmtNumber(payload.maxDdBps, 2),
    entryCount: Math.max(0, Number(payload.entryCount || 0)),
    exitCount: Math.max(0, Number(payload.exitCount || 0)),
    winRate: fmtPct01(payload.winRate),
    slippageEstimate: compact(payload.slippageEstimate || "n/a", 80),
    rejectCount: Math.max(0, Number(payload.rejectCount || 0)),
    regimeTop: compact(payload.regimeTop || "n/a", 80),
    regimeBottom: compact(payload.regimeBottom || "n/a", 80),
    watchdogCount: Math.max(0, Number(payload.watchdogCount || 0)),
    reconcileFailCount: Math.max(0, Number(payload.reconcileFailCount || 0)),
    cleanupFailCount: Math.max(0, Number(payload.cleanupFailCount || 0)),
    askQuestionCount: Math.max(0, Number(payload.askQuestionCount || 0)),
    stopReasonTop: compact(payload.stopReasonTop || "n/a", 80),
    extraSummaryLines: Array.isArray(payload.extraSummaryLines)
      ? payload.extraSummaryLines.slice(0, 20).map((x) => compact(x, 120))
      : [],
  };
}

export function buildDailyEvaluationHumanMessage(payload = {}) {
  const p = normalize(payload);
  return [
    "【HL Trade Ops / Daily Summary】",
    `- 日付(UTC): ${p.dateUtc}`,
    `- 実現損益: ${p.dailyRealizedPnlUsd} / 最大DD: ${p.maxDdBps}bps`,
    `- 取引回数: entry=${p.entryCount} exit=${p.exitCount} / 勝率: ${p.winRate}`,
    `- 主要コスト: slippage推定=${p.slippageEstimate} / reject=${p.rejectCount}`,
    `- レジーム成績: 上位=${p.regimeTop} / 下位=${p.regimeBottom}`,
    `- 異常: watchdog=${p.watchdogCount} reconcile_fail=${p.reconcileFailCount} cleanup_fail=${p.cleanupFailCount}`,
    `- 運用: AskQuestion=${p.askQuestionCount} / 停止理由Top=${p.stopReasonTop}`,
  ].join("\n");
}

export function buildDailyEvaluationPromptMessage(payload = {}) {
  const p = normalize(payload);
  const lines = [
    "【あなたへの依頼】",
    "あなたは自動売買botの「日次レビュアー」です。目的は改善です。",
    "以下のログ要約を読み、次の順で出力してください。",
    "",
    "(1) 私（人間）向け日次評価（日本語、最大12行）",
    "- 今日の成績の解釈（運か実力か）",
    "- 悪化要因トップ3（根拠つき）",
    "- 明日やるべき改善トップ3（低コスト順）",
    "",
    "(2) bot設定に反映できる提案がある場合だけ、機械可読ブロックを付ける（任意）",
    "```txt",
    "BOT_TUNING_V1",
    `suggestionId=daily_${p.dateUtc.replace(/-/g, "")}`,
    "change=<提案内容を1行>",
    "reason=<なぜ必要か1行>",
    "```",
    "",
    "【日次ログ要約】",
    `dateUtc=${p.dateUtc}`,
    `dailyRealizedPnlUsd=${p.dailyRealizedPnlUsd}`,
    `maxDdBps=${p.maxDdBps}`,
    `entryCount=${p.entryCount}`,
    `exitCount=${p.exitCount}`,
    `winRate=${p.winRate}`,
    `slippageEstimate=${p.slippageEstimate}`,
    `rejectCount=${p.rejectCount}`,
    `regimeTop=${p.regimeTop}`,
    `regimeBottom=${p.regimeBottom}`,
    `watchdogCount=${p.watchdogCount}`,
    `reconcileFailCount=${p.reconcileFailCount}`,
    `cleanupFailCount=${p.cleanupFailCount}`,
    `askQuestionCount=${p.askQuestionCount}`,
    `stopReasonTop=${p.stopReasonTop}`,
  ];
  for (const line of p.extraSummaryLines) {
    lines.push(`extra=${line}`);
  }
  return lines.join("\n");
}

export function buildDailyEvaluationMessages(payload = {}) {
  return [
    buildDailyEvaluationHumanMessage(payload),
    buildDailyEvaluationPromptMessage(payload),
  ];
}
