import { loadConfig } from "./config.mjs";
import { Storage } from "./core/storage.mjs";

function parseHoursArg() {
  const idx = process.argv.indexOf("--hours");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 24;
}

function parseRunIdArg() {
  const idx = process.argv.indexOf("--run-id");
  if (idx >= 0 && process.argv[idx + 1]) {
    return String(process.argv[idx + 1]).trim() || null;
  }
  return null;
}

function rowTs(row) {
  const ts = Number(row?.ts);
  if (Number.isFinite(ts) && ts > 0) {
    return ts;
  }
  const iso = row?.isoTime;
  if (iso) {
    const parsed = Date.parse(String(iso));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function extractExchangeError(row) {
  const response = row?.response || {};
  if (String(response?.status || "").toLowerCase() === "err") {
    if (typeof response?.response === "string" && response.response) {
      return response.response;
    }
    if (typeof response?.error === "string" && response.error) {
      return response.error;
    }
    if (typeof response?.response?.error === "string" && response.response.error) {
      return response.response.error;
    }
  }
  const statuses = response?.response?.data?.statuses || response?.data?.statuses || [];
  for (const status of statuses) {
    if (typeof status?.error === "string" && status.error) {
      return status.error;
    }
  }
  return null;
}

function classifyError(message) {
  const text = String(message || "");
  if (!text) {
    return "none";
  }
  if (/Order has invalid price\./i.test(text)) {
    return "invalid_price";
  }
  if (/Vault not registered/i.test(text)) {
    return "vault_not_registered";
  }
  return "other";
}

function main() {
  const config = loadConfig();
  const storage = new Storage(config);
  const windowHours = parseHoursArg();
  const runId = parseRunIdArg();
  const cutoff = Date.now() - (windowHours * 3600 * 1000);

  let rows = storage.readStream("raw_http", { maxLines: 500000 });
  rows = rows.filter((row) => {
    if (!String(row?.label || "").startsWith("exchange:order")) {
      return false;
    }
    if (rowTs(row) < cutoff) {
      return false;
    }
    if (runId && String(row?.runId || "") !== runId) {
      return false;
    }
    return true;
  });

  let invalidPrice = 0;
  let vaultNotRegistered = 0;
  let otherExchangeErr = 0;

  for (const row of rows) {
    const code = classifyError(extractExchangeError(row));
    if (code === "invalid_price") {
      invalidPrice += 1;
    } else if (code === "vault_not_registered") {
      vaultNotRegistered += 1;
    } else if (code === "other") {
      otherExchangeErr += 1;
    }
  }

  const out = {
    windowHours,
    sample: rows.length,
    invalidPrice,
    vaultNotRegistered,
    otherExchangeErr,
  };
  if (runId) {
    out.runId = runId;
  }

  console.log(out);
}

try {
  main();
} catch (error) {
  console.error(`verify failed: ${error.message}`);
  process.exitCode = 1;
}
