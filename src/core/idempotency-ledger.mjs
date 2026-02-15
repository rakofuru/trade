import crypto from "node:crypto";

export class IdempotencyLedger {
  constructor({ storage, initialState = null }) {
    this.storage = storage;
    this.records = new Map();
    this.maxAgeMs = 6 * 60 * 60 * 1000;

    if (initialState && Array.isArray(initialState.records)) {
      for (const r of initialState.records) {
        this.records.set(r.key, r);
      }
    }
  }

  makeKey(payload) {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  seen(payload) {
    this.gc();
    const key = this.makeKey(payload);
    return this.records.get(key) || null;
  }

  markSubmitted(payload, meta = {}) {
    this.gc();
    const key = this.makeKey(payload);
    const record = {
      key,
      payload,
      submittedAt: Date.now(),
      status: "submitted",
      ...meta,
    };
    this.records.set(key, record);
    this.storage?.appendMetric({
      type: "idempotency_submit",
      key,
      payload,
      meta,
    });
    return key;
  }

  markResultByKey(key, result) {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }
    existing.status = result?.error ? "error" : "ok";
    existing.result = result;
    existing.updatedAt = Date.now();
  }

  snapshot() {
    this.gc();
    return {
      savedAt: new Date().toISOString(),
      records: Array.from(this.records.values()).slice(-5000),
    };
  }

  gc() {
    const threshold = Date.now() - this.maxAgeMs;
    for (const [key, value] of this.records.entries()) {
      if ((value.updatedAt || value.submittedAt || 0) < threshold) {
        this.records.delete(key);
      }
    }
  }
}