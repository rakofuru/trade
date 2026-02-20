import http from "node:http";
import { URL } from "node:url";
import { parseBotDecisionMessage, decisionTemplateHeader } from "./decision-parser.mjs";
import { verifyLineSignature } from "./signature.mjs";
import {
  buildAskQuestionMessages,
  buildAskQuestionQuickReply,
  buildAskQuestionPromptMessage,
  buildAskQuestionDetailMessage,
} from "./ask-question.mjs";
import { buildDailyEvaluationMessages } from "./daily-eval.mjs";

const LINE_API_BASE = "https://api.line.me/v2/bot/message";
const MAX_LINE_TEXT_LEN = 4800;
const MAX_LINE_MESSAGES_PER_REQUEST = 5;
const ASKQUESTION_CACHE_MAX = 300;

function splitTextToLineMessages(text) {
  const source = String(text || "");
  if (!source) {
    return [""];
  }
  const out = [];
  let offset = 0;
  while (offset < source.length) {
    out.push(source.slice(offset, offset + MAX_LINE_TEXT_LEN));
    offset += MAX_LINE_TEXT_LEN;
  }
  return out;
}

function normalizeUserIdSet(ids) {
  const set = new Set();
  for (const id of ids || []) {
    const value = String(id || "").trim();
    if (value) {
      set.add(value);
    }
  }
  return set;
}

function joinPublicWebhookUrl(baseUrl, webhookPath) {
  const base = String(baseUrl || "").trim();
  const path = String(webhookPath || "").trim();
  if (!base || !path) {
    return "";
  }
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function isLineUserAllowed(userId, allowedUserIds) {
  const user = String(userId || "").trim();
  if (!user) {
    return false;
  }
  const allowedSet = allowedUserIds instanceof Set
    ? allowedUserIds
    : normalizeUserIdSet(allowedUserIds);
  if (!allowedSet.size) {
    return false;
  }
  return allowedSet.has(user);
}

async function readRawBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) {
      throw new Error("payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class LineOpsBridge {
  constructor({
    config,
    logger,
    storage,
    onDecision = null,
  }) {
    this.config = config;
    this.logger = logger;
    this.storage = storage;
    this.onDecision = typeof onDecision === "function" ? onDecision : null;
    this.server = null;
    this.listening = false;
    this.allowedUserIds = normalizeUserIdSet(config.lineAllowedUserIds || []);
    this.askQuestionPayloadById = new Map();
    this.askQuestionPayloadOrder = [];
  }

  isWebhookEnabled() {
    return Boolean(
      this.config.lineChannelSecret
      && this.config.lineWebhookPath,
    );
  }

  isMessagingEnabled() {
    return Boolean(
      this.config.lineChannelAccessToken
      && this.allowedUserIds.size > 0,
    );
  }

  async start() {
    if (!this.isWebhookEnabled()) {
      this.logger.warn("LINE webhook disabled due to missing config", {
        hasSecret: Boolean(this.config.lineChannelSecret),
        webhookPath: this.config.lineWebhookPath || "",
      });
      return false;
    }
    if (!this.config.lineChannelAccessToken) {
      this.logger.warn("LINE messaging token missing; webhook accepts commands but cannot reply/push");
    }
    if (this.server || this.listening) {
      return true;
    }

    this.server = http.createServer((req, res) => {
      this.#handleHttpRequest(req, res).catch((error) => {
        this.storage.appendError({
          where: "line_webhook_http",
          error: error.message,
        });
        this.logger.error("LINE webhook handler failed", { error: error.message });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("internal_error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(
        Number(this.config.lineWebhookPort || 8787),
        String(this.config.lineWebhookHost || "0.0.0.0"),
      );
    });

    this.listening = true;
    this.logger.info("LINE webhook server started", {
      host: this.config.lineWebhookHost || "0.0.0.0",
      port: Number(this.config.lineWebhookPort || 8787),
      path: this.config.lineWebhookPath,
      publicWebhookUrl: joinPublicWebhookUrl(this.config.publicBaseUrl, this.config.lineWebhookPath) || undefined,
    });
    return true;
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.listening = false;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  async sendAskQuestion(payload = {}) {
    if (!this.isMessagingEnabled()) {
      this.storage.appendMetric({
        type: "line_askquestion_skipped",
        reason: "messaging_disabled",
        allowedUserCount: this.allowedUserIds.size,
      });
      return {
        sent: false,
        reason: "messaging_disabled",
      };
    }

    const messages = buildAskQuestionMessages(payload);
    const quickReply = buildAskQuestionQuickReply(payload);
    this.#rememberAskQuestionPayload(payload);
    const lineMessages = [];
    for (const text of messages) {
      lineMessages.push({
        type: "text",
        text: String(text),
      });
    }
    if (lineMessages.length > 0 && payload?.requiresHuman === true) {
      // Quick reply should be attached to the last delivered message.
      lineMessages[lineMessages.length - 1].quickReply = quickReply;
    }
    return this.#broadcastLineMessages({
      metricType: "line_askquestion_sent",
      metricPayload: {
        questionId: payload.questionId || null,
      },
      messages: lineMessages,
    });
  }

  async sendDailyEvaluation(payload = {}) {
    if (!this.isMessagingEnabled()) {
      this.storage.appendMetric({
        type: "line_daily_eval_skipped",
        reason: "messaging_disabled",
        allowedUserCount: this.allowedUserIds.size,
        dateUtc: payload?.dateUtc || null,
      });
      return {
        sent: false,
        reason: "messaging_disabled",
      };
    }

    const messages = buildDailyEvaluationMessages(payload);
    return this.#broadcastTextMessages({
      metricType: "line_daily_eval_sent",
      metricPayload: {
        dateUtc: payload?.dateUtc || null,
      },
      messages,
    });
  }

  async #broadcastTextMessages({
    metricType,
    metricPayload = {},
    messages = [],
  }) {
    const failures = [];
    let sentCount = 0;
    for (const userId of this.allowedUserIds) {
      try {
        await this.#pushTexts(userId, messages);
        sentCount += 1;
      } catch (error) {
        failures.push({
          userId,
          error: error.message,
        });
      }
    }

    this.storage.appendMetric({
      type: metricType,
      sentCount,
      failedCount: failures.length,
      messageCount: messages.length,
      ...metricPayload,
    });
    if (failures.length) {
      this.logger.warn("LINE push failed for some users", {
        metricType,
        failedCount: failures.length,
      });
    }
    return {
      sent: sentCount > 0,
      sentCount,
      failedCount: failures.length,
    };
  }

  async #broadcastLineMessages({
    metricType,
    metricPayload = {},
    messages = [],
  }) {
    const failures = [];
    let sentCount = 0;
    for (const userId of this.allowedUserIds) {
      try {
        await this.#pushLineMessages(userId, messages);
        sentCount += 1;
      } catch (error) {
        failures.push({
          userId,
          error: error.message,
        });
      }
    }

    this.storage.appendMetric({
      type: metricType,
      sentCount,
      failedCount: failures.length,
      messageCount: messages.length,
      ...metricPayload,
    });
    if (failures.length) {
      this.logger.warn("LINE push failed for some users", {
        metricType,
        failedCount: failures.length,
      });
    }
    return {
      sent: sentCount > 0,
      sentCount,
      failedCount: failures.length,
    };
  }

  #rememberAskQuestionPayload(payload = {}) {
    const questionId = String(payload?.questionId || "").trim();
    if (!questionId) {
      return;
    }
    this.askQuestionPayloadById.set(questionId, {
      ...payload,
      _cachedAt: Date.now(),
    });
    this.askQuestionPayloadOrder.push(questionId);
    if (this.askQuestionPayloadOrder.length <= ASKQUESTION_CACHE_MAX) {
      return;
    }
    while (this.askQuestionPayloadOrder.length > ASKQUESTION_CACHE_MAX) {
      const oldest = this.askQuestionPayloadOrder.shift();
      if (!oldest) {
        continue;
      }
      if (this.askQuestionPayloadOrder.includes(oldest)) {
        continue;
      }
      this.askQuestionPayloadById.delete(oldest);
    }
  }

  async #handleAskQuestionAssistCommand({ command, replyToken }) {
    const reason = String(command?.reason || "").trim().toLowerCase();
    if (reason !== "askq_prompt_resend" && reason !== "askq_detail") {
      return false;
    }
    const questionId = String(command?.questionId || "").trim();
    const payload = this.askQuestionPayloadById.get(questionId);
    if (!payload) {
      await this.#replyText(replyToken, `NG: AskQuestion payload not found (questionId=${questionId || "n/a"})`);
      this.storage.appendMetric({
        type: "line_askq_assist_missing",
        reason,
        questionId: questionId || null,
      });
      return true;
    }

    const text = reason === "askq_prompt_resend"
      ? buildAskQuestionPromptMessage(payload)
      : buildAskQuestionDetailMessage(payload);
    await this.#replyText(replyToken, text);
    this.storage.appendMetric({
      type: "line_askq_assist_sent",
      reason,
      questionId,
    });
    return true;
  }

  async #handleHttpRequest(req, res) {
    const method = String(req.method || "").toUpperCase();
    const url = new URL(String(req.url || "/"), "http://localhost");
    if (method !== "POST" || url.pathname !== this.config.lineWebhookPath) {
      res.statusCode = 404;
      res.end("not_found");
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = String(req.headers["x-line-signature"] || "");
    const signatureOk = verifyLineSignature({
      channelSecret: this.config.lineChannelSecret,
      rawBody,
      signature,
    });
    if (!signatureOk) {
      this.storage.appendMetric({
        type: "line_webhook_rejected",
        reason: "signature_invalid",
      });
      res.statusCode = 401;
      res.end("invalid_signature");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.storage.appendMetric({
        type: "line_webhook_rejected",
        reason: "invalid_json",
      });
      res.statusCode = 400;
      res.end("invalid_json");
      return;
    }

    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const event of events) {
      await this.#handleLineEvent(event);
    }

    res.statusCode = 200;
    res.end("ok");
  }

  async #handleLineEvent(event) {
    const userId = String(event?.source?.userId || "").trim();
    const replyToken = String(event?.replyToken || "").trim();
    const text = String(event?.message?.text || "");
    const eventType = String(event?.type || "");

    this.storage.appendMetric({
      type: "line_webhook_event",
      eventType,
      hasReplyToken: Boolean(replyToken),
      hasUserId: Boolean(userId),
    });

    if (eventType !== "message" || String(event?.message?.type || "") !== "text") {
      return;
    }
    if (!replyToken) {
      return;
    }

    if (!isLineUserAllowed(userId, this.allowedUserIds)) {
      this.storage.appendMetric({
        type: "line_webhook_rejected",
        reason: "allowlist_denied",
        userId,
      });
      await this.#replyText(replyToken, "許可されていない userId です。LINE_ALLOWED_USER_IDS を確認してください。");
      return;
    }

    const parsed = parseBotDecisionMessage(text);
    if (!parsed.ok) {
      this.storage.appendMetric({
        type: "line_command_invalid",
        reason: parsed.error,
      });
      await this.#replyText(
        replyToken,
        `コマンド形式エラー: ${parsed.message}\n${decisionTemplateHeader(2)} ブロックで返信してください。`,
      );
      return;
    }

    const command = parsed.command;
    this.storage.appendMetric({
      type: "line_command_received",
      action: command.action,
      coin: command.coin,
      userId,
      questionId: command.questionId || null,
      version: command.version || null,
    });

    if (command.action === "CUSTOM") {
      const handledAssist = await this.#handleAskQuestionAssistCommand({
        command,
        replyToken,
      });
      if (handledAssist) {
        return;
      }
    }

    if (!this.onDecision) {
      await this.#replyText(replyToken, "コマンド受信: handler 未設定のため処理できませんでした。");
      return;
    }

    let result;
    try {
      result = await this.onDecision(command, {
        userId,
        eventType,
        timestamp: Number(event?.timestamp || Date.now()),
        replyToken,
      });
    } catch (error) {
      this.storage.appendError({
        where: "line_command_execute",
        action: command.action,
        error: error.message,
      });
      await this.#replyText(replyToken, `実行失敗: ${error.message}`);
      return;
    }

    const ok = Boolean(result?.ok);
    const message = String(result?.message || (ok ? "実行しました" : "実行できませんでした"));
    await this.#replyText(replyToken, `${ok ? "OK" : "NG"}: ${message}`);
  }

  async #replyText(replyToken, text) {
    if (!this.config.lineChannelAccessToken) {
      return;
    }
    const chunks = splitTextToLineMessages(text).slice(0, MAX_LINE_MESSAGES_PER_REQUEST);
    const body = {
      replyToken,
      messages: chunks.map((chunk) => ({ type: "text", text: chunk })),
    };
    await this.#postLineApi("/reply", body);
  }

  async #pushTexts(to, texts) {
    const chunks = [];
    for (const text of texts || []) {
      chunks.push(...splitTextToLineMessages(text));
    }
    for (let i = 0; i < chunks.length; i += MAX_LINE_MESSAGES_PER_REQUEST) {
      const slice = chunks.slice(i, i + MAX_LINE_MESSAGES_PER_REQUEST);
      const body = {
        to,
        messages: slice.map((chunk) => ({ type: "text", text: chunk })),
      };
      await this.#postLineApi("/push", body);
    }
  }

  async #pushLineMessages(to, lineMessages) {
    const messages = [];
    for (const item of lineMessages || []) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (String(item.type || "") !== "text") {
        continue;
      }
      const chunks = splitTextToLineMessages(String(item.text || ""));
      for (let i = 0; i < chunks.length; i += 1) {
        const msg = {
          type: "text",
          text: chunks[i],
        };
        // Keep quick reply only on the first chunk.
        if (i === 0 && item.quickReply && Array.isArray(item.quickReply.items) && item.quickReply.items.length) {
          msg.quickReply = {
            items: item.quickReply.items.slice(0, 13),
          };
        }
        messages.push(msg);
      }
    }
    for (let i = 0; i < messages.length; i += MAX_LINE_MESSAGES_PER_REQUEST) {
      const slice = messages.slice(i, i + MAX_LINE_MESSAGES_PER_REQUEST);
      const body = {
        to,
        messages: slice,
      };
      await this.#postLineApi("/push", body);
    }
  }

  async #postLineApi(path, body) {
    if (!this.config.lineChannelAccessToken) {
      throw new Error("line_access_token_missing");
    }
    const res = await fetch(`${LINE_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.lineChannelAccessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return;
    }
    const text = await res.text();
    throw new Error(`line_api_${path}_failed(${res.status}): ${String(text || "").slice(0, 200)}`);
  }
}
