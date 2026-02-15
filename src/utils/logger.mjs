import { sanitizeForExternal } from "./sanitize.mjs";

const LEVELS = ["debug", "info", "warn", "error"];

export class Logger {
  constructor(level = "info") {
    this.level = level;
  }

  shouldLog(level) {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.level);
  }

  log(level, msg, meta = undefined) {
    if (!this.shouldLog(level)) {
      return;
    }
    const ts = new Date().toISOString();
    const safeMeta = meta === undefined ? undefined : sanitizeForExternal(meta);
    const payload = safeMeta === undefined ? "" : ` ${JSON.stringify(safeMeta)}`;
    const line = `${ts} [${level.toUpperCase()}] ${msg}${payload}`;
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  debug(msg, meta) { this.log("debug", msg, meta); }
  info(msg, meta) { this.log("info", msg, meta); }
  warn(msg, meta) { this.log("warn", msg, meta); }
  error(msg, meta) { this.log("error", msg, meta); }
}
