import crypto from "node:crypto";

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

    this.logger.info("Connecting websocket", { url: this.config.wsUrl, attempts: this.reconnectAttempts });
    const ws = new WebSocket(this.config.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", async () => {
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

    ws.addEventListener("message", async (event) => {
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

    ws.addEventListener("error", (event) => {
      this.logger.warn("Websocket error", { message: event?.message || "unknown" });
    });

    ws.addEventListener("close", async (event) => {
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
}