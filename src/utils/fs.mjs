import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl(filePath, { maxLines = null } = {}) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const selected = maxLines && maxLines > 0 ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const line of selected) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed rows
    }
  }
  return out;
}

export function readJsonlGzip(filePath, { maxLines = null } = {}) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let text = "";
  try {
    const gz = fs.readFileSync(filePath);
    text = zlib.gunzipSync(gz).toString("utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const selected = maxLines && maxLines > 0 ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const line of selected) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed rows
    }
  }
  return out;
}

export function listJsonlFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dirPath, name));
}

export function listFilesRecursive(dirPath, { include = null } = {}) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const out = [];
  const stack = [dirPath];

  while (stack.length) {
    const next = stack.pop();
    const entries = fs.readdirSync(next, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!include || include(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

export function fileExists(filePath) {
  return fs.existsSync(filePath);
}

export function fileSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

export function gzipFile(srcPath, dstPath = `${srcPath}.gz`) {
  if (!fs.existsSync(srcPath)) {
    return false;
  }
  try {
    ensureDir(path.dirname(dstPath));
    const input = fs.readFileSync(srcPath);
    const output = zlib.gzipSync(input, { level: zlib.constants.Z_BEST_SPEED });
    fs.writeFileSync(dstPath, output);
    return true;
  } catch {
    return false;
  }
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}
