import crypto from "node:crypto";
import { encodeMsgPack } from "../utils/crypto/msgpack.mjs";
import { keccak256 } from "../utils/crypto/keccak.mjs";
import { buildAgentEip712Digest } from "../utils/crypto/eip712.mjs";
import { signDigest, normalizeAddress, hexToBytes, bytesToHex } from "../utils/crypto/secp256k1.mjs";

function bigEndianUint64(value) {
  let v = BigInt(value);
  if (v < 0n) {
    throw new Error("uint64 cannot be negative");
  }
  const out = Buffer.alloc(8);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function floatToWire(value) {
  const rounded = Number(value).toFixed(8);
  if (!Number.isFinite(Number(rounded))) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  if (Math.abs(Number(rounded)) === 0) {
    return "0";
  }
  return rounded.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function orderTypeToWire(type) {
  if (type?.limit?.tif) {
    return { limit: { tif: type.limit.tif } };
  }
  if (type?.trigger) {
    const triggerPx = floatToWire(type.trigger.triggerPx);
    const tpslRaw = String(type.trigger.tpsl || "").toLowerCase();
    if (tpslRaw !== "tp" && tpslRaw !== "sl") {
      throw new Error("trigger.tpsl must be 'tp' or 'sl'");
    }
    return {
      trigger: {
        isMarket: Boolean(type.trigger.isMarket),
        triggerPx,
        tpsl: tpslRaw,
      },
    };
  }
  throw new Error("Unsupported order type: expected limit or trigger");
}

export function normalizeCloid(cloid) {
  if (!cloid) {
    return undefined;
  }
  const raw = cloid.toLowerCase();
  if (!/^0x[0-9a-f]{32}$/.test(raw)) {
    throw new Error("cloid must be a 16-byte hex string (0x + 32 hex chars)");
  }
  return raw;
}

export function makeCloid() {
  return `0x${crypto.randomBytes(16).toString("hex")}`;
}

export function toOrderWire(orderRequest) {
  return {
    a: orderRequest.asset,
    b: orderRequest.isBuy,
    p: floatToWire(orderRequest.limitPx),
    s: floatToWire(orderRequest.sz),
    r: Boolean(orderRequest.reduceOnly),
    t: orderTypeToWire(orderRequest.orderType),
    c: orderRequest.cloid ? normalizeCloid(orderRequest.cloid) : undefined,
  };
}

export function makeOrderAction(orderWires, grouping = "na", builder = undefined) {
  const action = {
    type: "order",
    orders: orderWires,
    grouping,
  };
  if (builder) {
    action.builder = {
      b: normalizeAddress(builder.address),
      f: Number(builder.fee),
    };
  }
  return action;
}

export function makeCancelByCloidAction(cancels) {
  return {
    type: "cancelByCloid",
    cancels: cancels.map((c) => ({
      asset: Number(c.asset),
      cloid: normalizeCloid(c.cloid),
    })),
  };
}

export function makeCancelAction(cancels) {
  return {
    type: "cancel",
    cancels: cancels.map((c) => ({
      a: Number(c.asset),
      o: Number(c.oid),
    })),
  };
}

export function actionHash(action, vaultAddress, nonce) {
  const packedAction = Buffer.from(encodeMsgPack(action));
  const nonceBytes = bigEndianUint64(nonce);

  let payload;
  if (!vaultAddress) {
    payload = Buffer.concat([packedAction, nonceBytes, Buffer.from([0x00])]);
  } else {
    const addr = hexToBytes(normalizeAddress(vaultAddress));
    payload = Buffer.concat([packedAction, nonceBytes, Buffer.from([0x01]), addr]);
  }
  return Buffer.from(keccak256(payload));
}

export function hashAction(action, vaultAddress, nonce, expiresAfter = null) {
  let hash = actionHash(action, vaultAddress, nonce);
  if (expiresAfter !== null && expiresAfter !== undefined) {
    hash = Buffer.from(keccak256(Buffer.concat([hash, bigEndianUint64(expiresAfter)])));
  }
  return hash;
}

export function signL1Action({ action, privateKey, vaultAddress, nonce, expiresAfter, source }) {
  const actionDigest = hashAction(action, vaultAddress, nonce, expiresAfter);
  const connectionId = bytesToHex(actionDigest);
  const typedDataDigest = buildAgentEip712Digest({
    source,
    connectionIdHex: connectionId,
    chainId: 1337n,
  });

  return signDigest(privateKey, typedDataDigest);
}
