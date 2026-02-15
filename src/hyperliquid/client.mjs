import { NonceManager } from "./nonce-manager.mjs";
import { signL1Action } from "./signing.mjs";
import { privateKeyToAddress, normalizeAddress } from "../utils/crypto/secp256k1.mjs";
import { sanitizeForStorage } from "../utils/sanitize.mjs";

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

export class HyperliquidHttpClient {
  constructor(config, logger, budgetManager, storage = null) {
    this.config = config;
    this.logger = logger;
    this.budgetManager = budgetManager;
    this.storage = storage;
    this.nonceManager = new NonceManager();

    this.signerAddress = privateKeyToAddress(config.apiWalletPrivateKey);
    this.accountAddress = normalizeAddress(config.accountAddress);
    this.vaultAddress = config.vaultAddress ? normalizeAddress(config.vaultAddress) : null;
    if (this.vaultAddress && this.vaultAddress === this.accountAddress) {
      logger.warn("vaultAddress equals accountAddress; ignoring vaultAddress to avoid vault mode rejection", {
        vaultAddress: this.vaultAddress,
      });
      this.vaultAddress = null;
    }
    if (this.vaultAddress && !this.config.vaultModeEnabled) {
      throw new Error(
        "Vault mode guard: HYPERLIQUID_VAULT_ADDRESS is set but HYPERLIQUID_VAULT_MODE_ENABLED is false.",
      );
    }
    this.isSignerSameAsAccount = this.signerAddress === this.accountAddress;

    this.logger.info("Initialized signer", {
      signerAddress: this.signerAddress,
      accountAddress: this.accountAddress,
      vaultAddress: this.vaultAddress,
      signerEqualsAccount: this.isSignerSameAsAccount,
    });
  }

  signerInfo() {
    return {
      signerAddress: this.signerAddress,
      accountAddress: this.accountAddress,
      vaultAddress: this.vaultAddress,
      signerEqualsAccount: this.isSignerSameAsAccount,
    };
  }

  nextNonce() {
    return this.nonceManager.next();
  }

  async postInfo(payload, label = payload.type || "info") {
    return this.#postJson(`${this.config.httpUrl}/info`, payload, `info:${label}`);
  }

  async postExchangeAction(action, { nonce = null, expiresAfter = null, tag = "exchange" } = {}) {
    if (this.vaultAddress && !this.config.vaultModeEnabled) {
      throw new Error("Vault mode guard: refusing to send exchange action with vaultAddress");
    }
    const useNonce = nonce ?? this.nonceManager.next();
    const signature = signL1Action({
      action,
      privateKey: this.config.apiWalletPrivateKey,
      vaultAddress: this.vaultAddress,
      nonce: useNonce,
      expiresAfter,
      source: this.config.source,
    });

    const body = {
      action,
      nonce: useNonce,
      signature,
    };

    if (this.vaultAddress) {
      body.vaultAddress = this.vaultAddress;
    }
    if (expiresAfter !== null && expiresAfter !== undefined) {
      body.expiresAfter = expiresAfter;
    }

    const response = await this.#postJson(`${this.config.httpUrl}/exchange`, body, `exchange:${action.type}:${tag}`);
    return {
      nonce: useNonce,
      signature,
      response,
    };
  }

  async fetchUserState() {
    try {
      return await this.postInfo({
        type: "userState",
        user: this.accountAddress,
      }, "userState");
    } catch (error) {
      if (error.status !== 422 && error.status !== 400) {
        throw error;
      }
      this.logger.debug("userState failed, retrying with clearinghouseState", {
        status: error.status,
      });
      return this.postInfo({
        type: "clearinghouseState",
        user: this.accountAddress,
      }, "clearinghouseState");
    }
  }

  async fetchSpotState() {
    try {
      return await this.postInfo({
        type: "spotClearinghouseState",
        user: this.accountAddress,
      }, "spotClearinghouseState");
    } catch (error) {
      if (error.status === 422 || error.status === 400) {
        return null;
      }
      throw error;
    }
  }

  async fetchOpenOrders() {
    const out = await this.postInfo({
      type: "openOrders",
      user: this.accountAddress,
    }, "openOrders");
    return Array.isArray(out) ? out : (out?.orders || []);
  }

  async fetchFillsByTime(startTime, endTime) {
    const out = await this.postInfo({
      type: "userFillsByTime",
      user: this.accountAddress,
      startTime,
      endTime,
      aggregateByTime: false,
    }, "userFillsByTime");
    return Array.isArray(out) ? out : (out?.fills || []);
  }

  async fetchBudgetStatus() {
    if (this.config.budgetStatusEndpoint) {
      return this.#postOrGetStatusEndpoint(this.config.budgetStatusEndpoint);
    }

    const response = await this.postInfo({
      type: "userRateLimit",
      user: this.accountAddress,
    }, "userRateLimit");

    if (response && typeof response === "object" && "nRequestsUsed" in response && "nRequestsCap" in response) {
      const used = Number(response.nRequestsUsed);
      const cap = Number(response.nRequestsCap);
      return {
        used,
        cap,
        remaining: Math.max(0, cap - used),
        remainingRatio: cap > 0 ? Math.max(0, cap - used) / cap : 0,
        source: "userRateLimit",
      };
    }

    return null;
  }

  async #postOrGetStatusEndpoint(url) {
    const timeout = withTimeout(10000);
    try {
      await this.budgetManager.noteHttpCall("quota:endpoint");
      let response = await fetch(url, { method: "GET", signal: timeout.signal });
      if (response.status === 405 || response.status === 404) {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: this.accountAddress }),
          signal: timeout.signal,
        });
      }
      const json = await response.json();
      return parseQuotaPayload(json);
    } finally {
      timeout.clear();
    }
  }

  async #postJson(url, payload, label = "http") {
    const timeout = withTimeout(15000);
    const startTs = Date.now();
    try {
      await this.budgetManager.noteHttpCall(label);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }

      this.storage?.appendRawHttp({
        label,
        method: "POST",
        url,
        request: sanitizeForStorage(payload),
        status: response.status,
        durationMs: Date.now() - startTs,
        response: sanitizeForStorage(json),
      });

      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} for ${label}`);
        err.status = response.status;
        err.response = json;
        throw err;
      }
      return json;
    } finally {
      timeout.clear();
    }
  }
}

function parseQuotaPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [payload, payload.data, payload.result].filter((x) => x && typeof x === "object");
  for (const c of candidates) {
    const remaining = firstNumber(c, ["remaining", "remainingCalls", "quotaRemaining", "requestsRemaining"]);
    const cap = firstNumber(c, ["cap", "limit", "quotaCap", "max", "requestsCap"]);
    const used = firstNumber(c, ["used", "nRequestsUsed", "requestsUsed"]);

    if (remaining !== null && cap !== null) {
      return {
        remaining,
        cap,
        used: used === null ? cap - remaining : used,
        remainingRatio: cap > 0 ? remaining / cap : 0,
        source: "custom",
      };
    }
    if (used !== null && cap !== null) {
      const rem = Math.max(0, cap - used);
      return {
        remaining: rem,
        cap,
        used,
        remainingRatio: cap > 0 ? rem / cap : 0,
        source: "custom",
      };
    }
  }
  return null;
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined) {
      const n = Number(obj[key]);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return null;
}
