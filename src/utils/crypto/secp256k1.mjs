import crypto from "node:crypto";
import { keccak256 } from "./keccak.mjs";

const CURVE = {
  P: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  N: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  GX: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
  GY: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
};

const HALF_N = CURVE.N / 2n;

function mod(a, m) {
  const v = a % m;
  return v >= 0n ? v : v + m;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = mod(result * b, modulus);
    }
    b = mod(b * b, modulus);
    e >>= 1n;
  }
  return result;
}

function modInv(a, m) {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) {
    throw new Error("Value is not invertible");
  }
  return mod(t, m);
}

class Point {
  constructor(x, y, infinity = false) {
    this.x = x;
    this.y = y;
    this.infinity = infinity;
  }

  static infinity() {
    return new Point(0n, 0n, true);
  }
}

const G = new Point(CURVE.GX, CURVE.GY, false);

function pointAdd(a, b) {
  if (a.infinity) return b;
  if (b.infinity) return a;

  if (a.x === b.x) {
    if (mod(a.y + b.y, CURVE.P) === 0n) {
      return Point.infinity();
    }
    return pointDouble(a);
  }

  const m = mod((b.y - a.y) * modInv(b.x - a.x, CURVE.P), CURVE.P);
  const x = mod(m * m - a.x - b.x, CURVE.P);
  const y = mod(m * (a.x - x) - a.y, CURVE.P);
  return new Point(x, y, false);
}

function pointDouble(a) {
  if (a.infinity) return a;
  if (a.y === 0n) return Point.infinity();

  const m = mod((3n * a.x * a.x) * modInv(2n * a.y, CURVE.P), CURVE.P);
  const x = mod(m * m - 2n * a.x, CURVE.P);
  const y = mod(m * (a.x - x) - a.y, CURVE.P);
  return new Point(x, y, false);
}

function pointMultiply(point, scalar) {
  let n = mod(scalar, CURVE.N);
  let result = Point.infinity();
  let addend = point;

  while (n > 0n) {
    if (n & 1n) {
      result = pointAdd(result, addend);
    }
    addend = pointDouble(addend);
    n >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
}

function bigIntToBytes(value, length = 32) {
  let hex = value.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  const raw = Buffer.from(hex, "hex");
  if (raw.length > length) {
    throw new Error("Integer overflow");
  }
  if (raw.length === length) {
    return raw;
  }
  return Buffer.concat([Buffer.alloc(length - raw.length), raw]);
}

function normalizePrivateKey(privateKeyHex) {
  const raw = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("HYPERLIQUID_API_WALLET_PRIVATE_KEY must be a 32-byte hex key (0x...)");
  }
  const out = Buffer.from(raw, "hex");
  const d = bytesToBigInt(out);
  if (d <= 0n || d >= CURVE.N) {
    throw new Error("Private key out of secp256k1 range");
  }
  return out;
}

function hmacSha256(key, ...parts) {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) {
    h.update(p);
  }
  return h.digest();
}

function* deterministicKGenerator(privateKeyBytes, msgHashBytes) {
  let k = Buffer.alloc(32, 0x00);
  let v = Buffer.alloc(32, 0x01);
  const x = Buffer.from(privateKeyBytes);
  const h1 = Buffer.from(msgHashBytes);

  k = hmacSha256(k, v, Buffer.from([0x00]), x, h1);
  v = hmacSha256(k, v);
  k = hmacSha256(k, v, Buffer.from([0x01]), x, h1);
  v = hmacSha256(k, v);

  for (;;) {
    v = hmacSha256(k, v);
    const candidate = bytesToBigInt(v);
    if (candidate > 0n && candidate < CURVE.N) {
      yield candidate;
    }
    k = hmacSha256(k, v, Buffer.from([0x00]));
    v = hmacSha256(k, v);
  }
}

function toHexPrefixed(buffer) {
  return `0x${Buffer.from(buffer).toString("hex")}`;
}

export function signDigest(privateKeyHex, digestInput) {
  const msgHash = Buffer.from(digestInput);
  if (msgHash.length !== 32) {
    throw new Error("Digest must be exactly 32 bytes");
  }

  const privateKey = normalizePrivateKey(privateKeyHex);
  const d = bytesToBigInt(privateKey);
  const z = mod(bytesToBigInt(msgHash), CURVE.N);

  const kGen = deterministicKGenerator(privateKey, msgHash);
  for (let guard = 0; guard < 1000; guard += 1) {
    const next = kGen.next();
    if (next.done) {
      break;
    }
    const k = next.value;
    const rPoint = pointMultiply(G, k);
    if (rPoint.infinity) {
      continue;
    }

    const r = mod(rPoint.x, CURVE.N);
    if (r === 0n) {
      continue;
    }

    const kInv = modInv(k, CURVE.N);
    let s = mod(kInv * mod(z + r * d, CURVE.N), CURVE.N);
    if (s === 0n) {
      continue;
    }

    let recovery = Number(rPoint.y & 1n);
    if (rPoint.x >= CURVE.N) {
      recovery |= 2;
    }

    if (s > HALF_N) {
      s = CURVE.N - s;
      recovery ^= 1;
    }

    const v = 27 + (recovery & 1);
    return {
      r: toHexPrefixed(bigIntToBytes(r, 32)),
      s: toHexPrefixed(bigIntToBytes(s, 32)),
      v,
    };
  }

  throw new Error("Failed to generate secp256k1 signature");
}

export function normalizeAddress(address) {
  if (!address) {
    return null;
  }
  const raw = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`Invalid address: ${address}`);
  }
  return raw;
}

export function hexToBytes(hex) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  return Buffer.from(normalized, "hex");
}

export function bytesToHex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function publicKeyToAddress(uncompressedPublicKey) {
  const raw = Buffer.from(uncompressedPublicKey);
  const body = raw[0] === 0x04 ? raw.subarray(1) : raw;
  const hash = keccak256(body);
  return `0x${Buffer.from(hash).subarray(12).toString("hex")}`;
}

export function privateKeyToAddress(privateKeyHex) {
  const privateKey = normalizePrivateKey(privateKeyHex);
  const d = bytesToBigInt(privateKey);
  const q = pointMultiply(G, d);
  const uncompressed = Buffer.concat([
    Buffer.from([0x04]),
    bigIntToBytes(q.x, 32),
    bigIntToBytes(q.y, 32),
  ]);
  return publicKeyToAddress(uncompressed);
}
