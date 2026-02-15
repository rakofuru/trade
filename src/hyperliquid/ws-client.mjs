import crypto from "node:crypto";
import WsWebSocket from "ws";

const WebSocketCtor = typeof globalThis.WebSocket === "function"
  ? globalThis.WebSocket
  : WsWebSocket;

const wsImpl = typeof globalThis.WebSocket === "function" ? "global" : "ws";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HyperliquidWsClient {
  constructor({
    config,
    logger,
    budgetManager,
    storage = null,
    subscriptions,
    onMessage,
    onLifecycle,
  }) {
    this.config = config;
    this.logger = logger;
    this.budgetManager = budgetManager;
    this.storage = storage;
    this.subscriptions = subscriptions;
    this.onMessage = onMessage;
    this.onLifecycle = onLifecycle;

    this.ws = null;
    this.running = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.wsImplLogged = false;

    this.seenHashes = new Map();
    this.maxSeen = 5000;
  }

  start() {
    this.running = true;
    this.#connect();
  }

  async stop(reason = "manual") {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // no-op
      }
      this.ws = null;
    }
    if (this.onLifecycle) {
      await this.onLifecycle({ type: "stopped", reason });
    }
  }

  #hashRaw(raw) {
    return crypto.createHash("sha1").update(raw).digest("hex");
  }

  #isDuplicate(raw) {
    const key = this.#hashRaw(raw);
    const now = Date.now();
    const prev = this.seenHashes.get(key);
    this.seenHashes.set(key, now);

    if (this.seenHashes.size > this.maxSeen) {
      const entries = Array.from(this.seenHashes.entries()).sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - this.maxSeen; i += 1) {
        this.seenHashes.delete(entries[i][0]);
      }
    }

    return prev !== undefined && now - prev < 5000;
  }

  async #connect() {
    if (!this.running) {
      return;
    }

    if (!this.wsImplLogged) {
      this.logger.info("Resolved websocket implementation", { ws_impl: wsImpl });
      this.wsImplLogged = true;
    }

    this.logger.info("Connecting websocket", { url: this.config.wsUrl, attempts: this.reconnectAttempts });
    const ws = new WebSocketCtor(this.config.wsUrl);
    this.ws = ws;

    this.#bindEvent(ws, "open", async () => {
      this.reconnectAttempts = 0;
      this.logger.info("Websocket connected");
      for (const sub of this.subscriptions) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: sub }));
        await wait(5);
      }
      if (this.onLifecycle) {
        await this.onLifecycle({ type: "connected" });
      }
    });

    this.#bindEvent(ws, "message", async (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      if (this.#isDuplicate(raw)) {
        return;
      }

      this.storage?.appendRawWs({ raw });

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.warn("Failed to parse WS message");
        return;
      }

      if (this.onMessage) {
        await this.onMessage(parsed, raw);
      }
    });

    this.#bindEvent(ws, "error", (event) => {
      this.logger.warn("Websocket error", { message: event?.message || "unknown" });
    });

    this.#bindEvent(ws, "close", async (event) => {
      this.logger.warn("Websocket closed", { code: event.code, reason: event.reason || "" });
      if (this.onLifecycle) {
        await this.onLifecycle({ type: "disconnected", code: event.code, reason: event.reason || "" });
      }
      if (!this.running) {
        return;
      }

      try {
        await this.budgetManager.noteWsReconnect();
      } catch (error) {
        this.logger.error("Reconnect budget exhausted", { error: error.message });
        return;
      }

      this.reconnectAttempts += 1;
      const base = Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempts, 6)));
      const jitter = Math.floor(Math.random() * 800);
      const delayMs = base + jitter;
      this.reconnectTimer = setTimeout(() => {
        this.#connect();
      }, delayMs);
    });
  }

  #bindEvent(ws, eventName, handler) {
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener(eventName, handler);
      return;
    }
    if (typeof ws.on !== "function") {
      throw new Error("Unsupported WebSocket implementation");
    }

    if (eventName === "open") {
      ws.on("open", () => handler({}));
      return;
    }
    if (eventName === "message") {
      ws.on("message", (data) => handler({ data }));
      return;
    }
    if (eventName === "error") {
      ws.on("error", (error) => handler({ message: error?.message || "unknown" }));
      return;
    }
    if (eventName === "close") {
      ws.on("close", (code, reason) => {
        const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        handler({ code, reason: text });
      });
      return;
    }

    ws.on(eventName, handler);
  }
}
