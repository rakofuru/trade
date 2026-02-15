function pushUInt(out, value, bytes) {
  let v = BigInt(value);
  const chunk = new Array(bytes).fill(0);
  for (let i = bytes - 1; i >= 0; i -= 1) {
    chunk[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out.push(...chunk);
}

function pushInt(out, value, bytes) {
  const bits = BigInt(bytes * 8);
  const max = 1n << bits;
  const normalized = value < 0 ? max + value : value;
  pushUInt(out, normalized, bytes);
}

function encodeInteger(out, input) {
  const value = typeof input === "bigint" ? input : BigInt(input);

  if (value >= 0n) {
    if (value <= 0x7fn) {
      out.push(Number(value));
      return;
    }
    if (value <= 0xffn) {
      out.push(0xcc);
      pushUInt(out, value, 1);
      return;
    }
    if (value <= 0xffffn) {
      out.push(0xcd);
      pushUInt(out, value, 2);
      return;
    }
    if (value <= 0xffffffffn) {
      out.push(0xce);
      pushUInt(out, value, 4);
      return;
    }
    out.push(0xcf);
    pushUInt(out, value, 8);
    return;
  }

  if (value >= -32n) {
    out.push(Number(0x100n + value));
    return;
  }
  if (value >= -128n) {
    out.push(0xd0);
    pushInt(out, value, 1);
    return;
  }
  if (value >= -32768n) {
    out.push(0xd1);
    pushInt(out, value, 2);
    return;
  }
  if (value >= -2147483648n) {
    out.push(0xd2);
    pushInt(out, value, 4);
    return;
  }
  out.push(0xd3);
  pushInt(out, value, 8);
}

function encodeBinary(out, bytes) {
  const len = bytes.length;
  if (len <= 0xff) {
    out.push(0xc4, len);
  } else if (len <= 0xffff) {
    out.push(0xc5);
    pushUInt(out, len, 2);
  } else {
    out.push(0xc6);
    pushUInt(out, len, 4);
  }
  out.push(...bytes);
}

function encodeString(out, text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  if (len <= 31) {
    out.push(0xa0 | len);
  } else if (len <= 0xff) {
    out.push(0xd9, len);
  } else if (len <= 0xffff) {
    out.push(0xda);
    pushUInt(out, len, 2);
  } else {
    out.push(0xdb);
    pushUInt(out, len, 4);
  }
  out.push(...bytes);
}

function encodeArray(out, arr) {
  const len = arr.length;
  if (len <= 15) {
    out.push(0x90 | len);
  } else if (len <= 0xffff) {
    out.push(0xdc);
    pushUInt(out, len, 2);
  } else {
    out.push(0xdd);
    pushUInt(out, len, 4);
  }
  for (const item of arr) {
    encodeValue(out, item);
  }
}

function encodeMap(out, obj) {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined);
  const len = entries.length;
  if (len <= 15) {
    out.push(0x80 | len);
  } else if (len <= 0xffff) {
    out.push(0xde);
    pushUInt(out, len, 2);
  } else {
    out.push(0xdf);
    pushUInt(out, len, 4);
  }
  for (const [key, value] of entries) {
    encodeString(out, key);
    encodeValue(out, value);
  }
}

function encodeValue(out, value) {
  if (value === null) {
    out.push(0xc0);
    return;
  }

  if (typeof value === "boolean") {
    out.push(value ? 0xc3 : 0xc2);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError("msgpack encoder only supports finite integers in this implementation");
    }
    encodeInteger(out, BigInt(value));
    return;
  }

  if (typeof value === "bigint") {
    encodeInteger(out, value);
    return;
  }

  if (typeof value === "string") {
    encodeString(out, value);
    return;
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    encodeBinary(out, value);
    return;
  }

  if (Array.isArray(value)) {
    encodeArray(out, value);
    return;
  }

  if (typeof value === "object") {
    encodeMap(out, value);
    return;
  }

  throw new TypeError(`Unsupported msgpack type: ${typeof value}`);
}

export function encodeMsgPack(value) {
  const out = [];
  encodeValue(out, value);
  return Uint8Array.from(out);
}