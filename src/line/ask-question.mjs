import { buildDecisionTemplate } from "./decision-parser.mjs";

function fmtNumber(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function fmtInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : "n/a";
}

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function compact(value, maxLen = 120) {
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
  const ttlSecRaw = Number(payload.ttlSec);
  const ttlSec = Number.isFinite(ttlSecRaw) && ttlSecRaw > 0
    ? Math.min(86400, Math.floor(ttlSecRaw))
    : 300;
  const ts = Number(payload.ts || Date.now());
  return {
    questionId: String(payload.questionId || `ask_${ts}`),
    timestampIso: new Date(ts).toISOString(),
    coin: String(payload.coin || "ALL").toUpperCase(),
    midPx: fmtNumber(payload.midPx, 2),
    positionSide: String(payload.positionSide || "flat"),
    positionSize: fmtNumber(payload.positionSize, 6),
    openOrders: fmtInt(payload.openOrders),
    dailyPnlUsd: fmtMoney(payload.dailyPnlUsd),
    drawdownBps: fmtNumber(payload.drawdownBps, 2),
    regime: compact(payload.regime || "unknown", 40),
    signal: compact(payload.signalSummary || payload.signalReason || "unknown", 80),
    reasonCode: compact(payload.reasonCode || payload.reason || "unknown", 60),
    phase: compact(payload.phase || "unknown", 40),
    ttlSec,
    ttlDefaultActionFlat: String(payload.ttlDefaultActionFlat || "HOLD").toUpperCase(),
    ttlDefaultActionInPosition: String(payload.ttlDefaultActionInPosition || "FLATTEN").toUpperCase(),
    dilemmas: Array.isArray(payload.dilemmas)
      ? payload.dilemmas.slice(0, 3).map((x) => compact(x, 100))
      : [],
    options: Array.isArray(payload.options)
      ? payload.options.slice(0, 6).map((x) => compact(x, 40))
      : [],
  };
}

export function buildAskQuestionHumanMessage(payload = {}) {
  const p = normalize(payload);
  return [
    "【HL Trade Ops / AskQuestion】",
    `- id: ${p.questionId}`,
    `- 時刻(UTC): ${p.timestampIso}`,
    `- 銘柄: ${p.coin} / 価格(mid): ${p.midPx}`,
    `- ポジ: ${p.positionSide} size=${p.positionSize} / 未約定: ${p.openOrders}`,
    `- リスク: dailyPnl=${p.dailyPnlUsd} / dd=${p.drawdownBps}bps`,
    `- 状態: regime=${p.regime} / signal=${p.signal}`,
    `- 詰まり理由: ${p.reasonCode}（${p.phase}）`,
    `- 期限: ${p.ttlSec} 秒（期限切れ時: flat→${p.ttlDefaultActionFlat} / pos→${p.ttlDefaultActionInPosition}）`,
  ].join("\n");
}

export function buildAskQuestionPromptMessage(payload = {}) {
  const p = normalize(payload);
  const replyTemplate = buildDecisionTemplate({
    version: 2,
    questionId: p.questionId,
    action: "HOLD",
    ttlSec: p.ttlSec,
    reason: "risk_first_hold",
  });
  const lines = [
    "【あなたへの依頼】",
    "あなたは「暗号資産デリバティブ自動売買 bot の運用判断者」です。",
    "目的は “破滅回避を最優先しつつ、期待値がある時だけ稼働させる” ことです。",
    "以下のAskQuestionに対し、必ず次の2部構成で回答してください。",
    "",
    "(1) 私（人間）向け要約（日本語、自由形式、最大8行）",
    "- いま何が起きていて、どのリスクが支配的か",
    "- 判断（HOLD/RESUME/PAUSE/FLATTEN）と理由（3点以内）",
    "- 追加で確認すべきこと（あれば1〜2点）",
    "",
    "(2) bot用返信（機械可読、必ずこのブロックのみ）",
    "```txt",
    replyTemplate,
    "```",
    "",
    "【重要】",
    "- botは(2)のブロックだけを読みます。余計なテキストをブロック内に入れないでください。",
    "- 時事ネタ/ニュースが必要なら、あなたは自分で検索して良い前提です。",
    "- ただし短期売買の期待値に直結しない場合は、無理に使わず “不確実” と明言してください。",
    "",
    "【AskQuestionデータ】",
    `questionId=${p.questionId}`,
    `timestamp=${p.timestampIso}`,
    "",
    `coin=${p.coin}`,
    `midPx=${p.midPx}`,
    `positionSide=${p.positionSide}`,
    `positionSize=${p.positionSize}`,
    `openOrders=${p.openOrders}`,
    `dailyPnlUsd=${p.dailyPnlUsd}`,
    `drawdownBps=${p.drawdownBps}`,
    `regime=${p.regime}`,
    `signal=${p.signal}`,
    `reasonCode=${p.reasonCode}`,
    `phase=${p.phase}`,
  ];
  if (p.dilemmas.length) {
    lines.push("dilemmas=");
    for (const item of p.dilemmas) {
      lines.push(`- ${item}`);
    }
  }
  if (p.options.length) {
    lines.push("options=");
    for (const item of p.options) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export function buildAskQuestionMessages(payload = {}) {
  return [
    buildAskQuestionHumanMessage(payload),
    buildAskQuestionPromptMessage(payload),
  ];
}

export function buildAskQuestionMessage(payload = {}) {
  return buildAskQuestionMessages(payload).join("\n\n");
}
