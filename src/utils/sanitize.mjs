const SECRET_KEY_PATTERNS = [
  /privatekey/i,
  /secret/i,
  /api[-_]?key/i,
  /authorization/i,
  /^nonce$/i,
  /^signature$/i,
  /^sig$/i,
];

const IDENTIFIER_PATTERNS = [
  /^cloid$/i,
  /^hash$/i,
  /^txhash$/i,
  /^oid$/i,
  /^orderid$/i,
  /^address$/i,
  /wallet/i,
  /^user$/i,
];

function maskValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  const str = String(value);
  if (str.length <= 8) {
    return "***";
  }
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

function shouldMaskKey(key) {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function shouldMaskIdentifierKey(key) {
  return IDENTIFIER_PATTERNS.some((p) => p.test(key));
}

function sanitize(obj, { maskIdentifiers = false } = {}) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((x) => sanitize(x, { maskIdentifiers }));
  }
  if (typeof obj !== "object") {
    return obj;
  }

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (shouldMaskKey(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (maskIdentifiers && shouldMaskIdentifierKey(key)) {
      out[key] = maskValue(value);
      continue;
    }
    if (typeof value === "string" && value.startsWith("0x") && value.length > 20 && maskIdentifiers) {
      out[key] = maskValue(value);
      continue;
    }
    out[key] = sanitize(value, { maskIdentifiers });
  }
  return out;
}

export function sanitizeForStorage(payload) {
  return sanitize(payload, { maskIdentifiers: false });
}

export function sanitizeForExternal(payload) {
  return sanitize(payload, { maskIdentifiers: true });
}

