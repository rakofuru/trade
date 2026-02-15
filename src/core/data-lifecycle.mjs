import {
  fileExists,
  fileMtimeMs,
  gzipFile,
  listFilesRecursive,
  removeFile,
} from "../utils/fs.mjs";

function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

function parseDayKeyFromPath(fullPath) {
  const segments = String(fullPath).split(/[\\/]/g);
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const seg = segments[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) {
      return seg;
    }
  }
  return null;
}

function daysDiff(fromDay, toDay = todayUtcKey()) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return 0;
  }
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

function inferAgeDays(fullPath) {
  const dayKey = parseDayKeyFromPath(fullPath);
  if (dayKey) {
    return daysDiff(dayKey);
  }
  const mtime = fileMtimeMs(fullPath);
  if (!mtime) {
    return 0;
  }
  return Math.floor((Date.now() - mtime) / (24 * 3600 * 1000));
}

export class DataLifecycleManager {
  constructor({ config, logger, storage }) {
    this.config = config;
    this.logger = logger;
    this.storage = storage;
    this.running = false;
  }

  async runOnce() {
    if (this.running) {
      return { skipped: true };
    }
    this.running = true;
    try {
      const stats = {
        compressedRaw: 0,
        removedRaw: 0,
        removedCompressed: 0,
        removedRollup: 0,
      };

      this.#handleRawFiles(stats);
      this.#handleRollupFiles(stats);

      if (Object.values(stats).some((x) => x > 0)) {
        this.logger.info("Data lifecycle maintenance complete", stats);
        this.storage.appendMetric({
          type: "data_lifecycle",
          ...stats,
        });
      }
      return stats;
    } finally {
      this.running = false;
    }
  }

  #handleRawFiles(stats) {
    const rawFiles = listFilesRecursive(this.config.streamDir, {
      include: (full) => full.endsWith(".jsonl") || full.endsWith(".jsonl.gz"),
    });
    for (const file of rawFiles) {
      const ageDays = inferAgeDays(file);

      if (file.endsWith(".jsonl")) {
        const gz = `${file}.gz`;
        if (ageDays >= 1 && !fileExists(gz)) {
          const ok = gzipFile(file, gz);
          if (ok) {
            stats.compressedRaw += 1;
          }
        }

        if (ageDays > this.config.rawKeepDays && fileExists(gz)) {
          removeFile(file);
          stats.removedRaw += 1;
        }
      }

      if (file.endsWith(".jsonl.gz") && ageDays > this.config.compressedKeepDays) {
        removeFile(file);
        stats.removedCompressed += 1;
      }
    }
  }

  #handleRollupFiles(stats) {
    const rollupFiles = listFilesRecursive(this.config.rollupDir, {
      include: (full) => full.endsWith(".jsonl") || full.endsWith(".jsonl.gz"),
    });
    for (const file of rollupFiles) {
      const ageDays = inferAgeDays(file);
      if (ageDays > this.config.rollupKeepDays) {
        removeFile(file);
        stats.removedRollup += 1;
      }
    }
  }
}
