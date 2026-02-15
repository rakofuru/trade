const MASK_64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(x, n) {
  const shift = BigInt(n);
  return ((x << shift) | (x >> (64n - shift))) & MASK_64;
}

function readLaneLE(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  }
  return value;
}

function writeLaneLE(value, out, offset) {
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function keccakF1600(state) {
  const b = new Array(25).fill(0n);
  const c = new Array(5).fill(0n);
  const d = new Array(5).fill(0n);

  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }

    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const idx = x + 5 * y;
        const dst = y + 5 * ((2 * x + 3 * y) % 5);
        b[dst] = rotl64(state[idx], ROTATION[idx]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const idx = x + 5 * y;
        state[idx] = (b[idx] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK_64;
      }
    }

    state[0] = (state[0] ^ ROUND_CONSTANTS[round]) & MASK_64;
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  if (typeof input === "string") {
    if (input.startsWith("0x") && input.length % 2 === 0) {
      const bytes = new Uint8Array((input.length - 2) / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(input.slice(2 + i * 2, 4 + i * 2), 16);
      }
      return bytes;
    }
    return new TextEncoder().encode(input);
  }
  throw new TypeError("Unsupported input type for keccak256");
}

export function keccak256(input) {
  const bytes = toBytes(input);
  const rateBytes = 136;
  const state = new Array(25).fill(0n);

  const q = rateBytes - (bytes.length % rateBytes);
  const padded = new Uint8Array(bytes.length + q);
  padded.set(bytes, 0);
  if (q === 1) {
    padded[bytes.length] = 0x81;
  } else {
    padded[bytes.length] = 0x01;
    padded[padded.length - 1] = 0x80;
  }

  for (let offset = 0; offset < padded.length; offset += rateBytes) {
    for (let i = 0; i < rateBytes / 8; i += 1) {
      state[i] ^= readLaneLE(padded, offset + i * 8);
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    writeLaneLE(state[i], out, i * 8);
  }
  return out;
}

export function keccakHex(input) {
  return `0x${Buffer.from(keccak256(input)).toString("hex")}`;
}
