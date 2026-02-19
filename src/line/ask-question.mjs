import { buildDecisionTemplate } from "./decision-parser.mjs";

function fmtNumber(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function fmtInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : "n/a";
}

function compactText(value, maxLen = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "n/a";
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildPromptBlock({
  questionId,
  summary,
  dilemmas,
  options,
  runtime,
}) {
  const lines = [
    "あなたは Hyperliquid の運用アシスタントです。以下の状況に対して、実行すべき判断を1つ選んでください。",
    "",
    `questionId=${questionId}`,
    `timestamp=${new Date(Number(runtime?.ts || Date.now())).toISOString()}`,
    "",
    "[状況]",
    `- coin=${summary.coin}`,
    `- midPx=${summary.midPx}`,
    `- positionSize=${summary.positionSize}`,
    `- positionSide=${summary.positionSide}`,
    `- openOrders=${summary.openOrders}`,
    `- dailyPnlUsd=${summary.dailyPnlUsd}`,
    `- drawdownBps=${summary.drawdownBps}`,
    `- regime=${summary.regime}`,
    `- signal=${summary.signal}`,
    "",
    "[論点]",
    ...dilemmas.map((x, idx) => `- ${idx + 1}. ${x}`),
    "",
    "[選択肢]",
    ...options.map((x, idx) => `- ${idx + 1}. ${x}`),
    "",
    "出力フォーマット: 1行目に最終判断、2行目以降に理由を3点以内で簡潔に。",
  ];
  return lines.join("\n");
}

export function buildAskQuestionMessage(payload = {}) {
  const questionId = String(payload.questionId || `ask_${Date.now()}`);
  const summary = {
    coin: String(payload.coin || "ALL"),
    midPx: fmtNumber(payload.midPx, 2),
    positionSize: fmtNumber(payload.positionSize, 6),
    positionSide: String(payload.positionSide || "flat"),
    openOrders: fmtInt(payload.openOrders),
    dailyPnlUsd: fmtMoney(payload.dailyPnlUsd),
    drawdownBps: fmtNumber(payload.drawdownBps, 2),
    regime: String(payload.regime || "unknown"),
    signal: compactText(payload.signalSummary || payload.signalReason || "unknown", 120),
  };

  const dilemmas = Array.isArray(payload.dilemmas) && payload.dilemmas.length
    ? payload.dilemmas.slice(0, 3).map((x) => compactText(x, 120))
    : ["エントリー判断の期待値が十分か", "直近リスク指標に対して追加行動が必要か", "現状維持が最適か"];

  const options = Array.isArray(payload.options) && payload.options.length
    ? payload.options.slice(0, 6).map((x) => compactText(x, 80))
    : ["HOLD", "ENTER", "EXIT", "REDUCE", "FLIP"];

  const promptBlock = buildPromptBlock({
    questionId,
    summary,
    dilemmas,
    options,
    runtime: {
      ts: payload.ts || Date.now(),
    },
  });

  const replyTemplate = buildDecisionTemplate({
    action: "APPROVE",
    coin: summary.coin === "ALL" ? "ALL" : summary.coin,
    reason: `question:${questionId}`,
    ttlSec: 300,
  });

  const lines = [
    "【HL Trade Ops / AskQuestion】",
    `questionId=${questionId}`,
    "",
    "A) 状況サマリ",
    `- 銘柄: ${summary.coin}`,
    `- 価格(mid): ${summary.midPx}`,
    `- ポジション: side=${summary.positionSide}, size=${summary.positionSize}`,
    `- 未約定数: ${summary.openOrders}`,
    `- リスク: dailyPnlUsd=${summary.dailyPnlUsd}, drawdownBps=${summary.drawdownBps}`,
    `- レジーム: ${summary.regime}`,
    `- シグナル要点: ${summary.signal}`,
    "",
    "B) Botが迷っている論点",
    ...dilemmas.map((x, idx) => `- ${idx + 1}. ${x}`),
    "",
    "C) Botが取り得る選択肢",
    ...options.map((x, idx) => `- ${idx + 1}. ${x}`),
    "",
    "D) ChatGPT貼り付け用プロンプト",
    "```",
    promptBlock,
    "```",
    "",
    "E) LINE返信テンプレ",
    "```",
    replyTemplate,
    "```",
  ];

  const text = lines.join("\n");
  if (text.length <= 4800) {
    return text;
  }
  return `${text.slice(0, 4700)}\n...(truncated)`;
}
