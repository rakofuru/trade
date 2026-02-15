import path from "node:path";
import crypto from "node:crypto";
import {
  appendJsonl,
  ensureDir,
  fileSizeBytes,
  listFilesRecursive,
  readJson,
  readJsonl,
  readJsonlGzip,
  writeJson,
} from "../utils/fs.mjs";

function nowIso() {
  return new Date().toISOString();
}

export class Storage {
  constructor(config) {
    this.config = config;
    this.dataDir = config.dataDir;
    this.streamDir = config.streamDir;
    this.stateDir = config.stateDir;
    this.rollupDir = config.rollupDir || path.join(config.dataDir, "rollups");
    this.replayDir = path.join(config.dataDir, "replay");
    this.maxRawFileBytes = Math.max(0.1, Number(config.rawMaxFileMb || 200)) * 1024 * 1024;

    ensureDir(this.dataDir);
    ensureDir(this.streamDir);
    ensureDir(this.rollupDir);
    ensureDir(this.stateDir);
    ensureDir(this.replayDir);
  }

  appendStream(name, payload) {
    const ts = Date.now();
    const dayKey = dateKey(ts);
    const file = this.#resolveAppendFile(this.streamDir, dayKey, name);
    appendJsonl(file, {
      ts,
      isoTime: nowIso(),
      ...payload,
    });
  }

  appendRawHttp(payload) {
    this.appendStream("raw_http", payload);
  }

  appendRawWs(payload) {
    this.appendStream("raw_ws", payload);
  }

  appendMarketEvent(type, payload) {
    this.appendStream(`market_${type}`, payload);
  }

  appendUserEvent(type, payload) {
    this.appendStream(`user_${type}`, payload);
  }

  appendOrderEvent(payload) {
    this.appendStream("orders", payload);
  }

  appendExecutionEvent(payload) {
    this.appendStream("execution", payload);
  }

  appendFill(payload) {
    this.appendStream("fills", payload);
  }

  appendFunding(payload) {
    this.appendStream("funding", payload);
  }

  appendCandle(payload) {
    this.appendStream("candles", payload);
  }

  appendMetric(payload) {
    this.appendStream("metrics", payload);
  }

  appendReport(payload) {
    this.appendStream("reports", payload);
  }

  appendImprovement(payload) {
    this.appendStream("improvements", payload);
  }

  appendRollup(name, payload) {
    const ts = Number(payload?.ts || Date.now());
    const dayKey = dateKey(ts);
    const file = this.#resolveAppendFile(this.rollupDir, dayKey, name);
    appendJsonl(file, {
      ts,
      isoTime: nowIso(),
      ...payload,
    });
  }

  appendReplayEvent(payload) {
    this.appendStream("replay", payload);
  }

  appendError(payload) {
    this.appendStream("errors", payload);
  }

  saveState(name, data) {
    const file = path.join(this.stateDir, `${name}.json`);
    writeJson(file, data);
  }

  loadState(name, fallback = null) {
    const file = path.join(this.stateDir, `${name}.json`);
    return readJson(file, fallback);
  }

  readStream(name, opts = {}) {
    const rows = this.#readByName(this.streamDir, name, opts);
    rows.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    if (opts?.sinceTs) {
      return rows.filter((x) => Number(x?.ts || 0) >= Number(opts.sinceTs));
    }
    return rows;
  }

  readRollup(name, opts = {}) {
    const rows = this.#readByName(this.rollupDir, name, opts);
    rows.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    if (opts?.sinceTs) {
      return rows.filter((x) => Number(x?.ts || 0) >= Number(opts.sinceTs));
    }
    return rows;
  }

  listStreams() {
    const files = listFilesRecursive(this.streamDir, {
      include: (full) => full.endsWith(".jsonl") || full.endsWith(".jsonl.gz"),
    });
    const names = new Set();
    for (const file of files) {
      const base = path.basename(file);
      const streamName = parseStreamName(base);
      if (streamName) {
        names.add(streamName);
      }
    }
    return Array.from(names).sort();
  }

  listRollups() {
    const files = listFilesRecursive(this.rollupDir, {
      include: (full) => full.endsWith(".jsonl") || full.endsWith(".jsonl.gz"),
    });
    const names = new Set();
    for (const file of files) {
      const base = path.basename(file);
      const streamName = parseStreamName(base);
      if (streamName) {
        names.add(streamName);
      }
    }
    return Array.from(names).sort();
  }

  createReplaySnapshot(meta = {}) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const outPath = path.join(this.replayDir, `${id}.json`);
    writeJson(outPath, {
      id,
      createdAt: nowIso(),
      meta,
      streams: this.listStreams(),
    });
    return outPath;
  }

  #resolveAppendFile(baseDir, dayKey, name) {
    const dayDir = path.join(baseDir, dayKey);
    ensureDir(dayDir);

    const base = path.join(dayDir, `${name}.jsonl`);
    if (fileSizeBytes(base) < this.maxRawFileBytes) {
      return base;
    }

    let part = 1;
    while (part < 10000) {
      const candidate = path.join(dayDir, `${name}.part${part}.jsonl`);
      if (fileSizeBytes(candidate) < this.maxRawFileBytes) {
        return candidate;
      }
      part += 1;
    }
    return path.join(dayDir, `${name}.part-overflow.jsonl`);
  }

  #readByName(baseDir, name, opts = {}) {
    const files = this.#collectFilesForName(baseDir, name);
    const rows = [];
    for (const file of files) {
      const extension = file.endsWith(".jsonl.gz") ? "gz" : "jsonl";
      const partRows = extension === "gz"
        ? readJsonlGzip(file, opts)
        : readJsonl(file, opts);
      if (partRows.length) {
        rows.push(...partRows);
      }
    }
    if (opts?.maxLines && opts.maxLines > 0 && rows.length > opts.maxLines) {
      return rows.slice(-opts.maxLines);
    }
    return rows;
  }

  #collectFilesForName(baseDir, name) {
    if (!baseDir) {
      return [];
    }

    const legacy = [
      path.join(baseDir, `${name}.jsonl`),
      path.join(baseDir, `${name}.jsonl.gz`),
    ];

    const recursive = listFilesRecursive(baseDir, {
      include: (full) => {
        const base = path.basename(full);
        if (!(base.endsWith(".jsonl") || base.endsWith(".jsonl.gz"))) {
          return false;
        }
        return parseStreamName(base) === name;
      },
    });

    const uniq = new Set([...legacy, ...recursive]);
    const files = Array.from(uniq).filter(Boolean).filter((file) => {
      try {
        return fileSizeBytes(file) > 0;
      } catch {
        return false;
      }
    });

    files.sort();
    return files;
  }
}

function parseStreamName(baseName) {
  let name = baseName;
  if (name.endsWith(".jsonl.gz")) {
    name = name.slice(0, -9);
  } else if (name.endsWith(".jsonl")) {
    name = name.slice(0, -6);
  } else {
    return null;
  }
  return name.replace(/\.part\d+$/, "");
}

function dateKey(ts) {
  const d = new Date(Number(ts || Date.now()));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
