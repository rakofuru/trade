import { keccakHex } from "./utils/crypto/keccak.mjs";
import { privateKeyToAddress, signDigest } from "./utils/crypto/secp256k1.mjs";
import { buildAgentEip712Digest } from "./utils/crypto/eip712.mjs";
import { hashAction, makeOrderAction, toOrderWire } from "./hyperliquid/signing.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testKeccak() {
  const expected = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
  const actual = keccakHex(new Uint8Array());
  assert(actual === expected, `keccak256("") mismatch: ${actual}`);
}

function testPrivateKeyToAddress() {
  const addr = privateKeyToAddress("0x0000000000000000000000000000000000000000000000000000000000000001");
  const expected = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
  assert(addr === expected, `privateKeyToAddress mismatch: ${addr}`);
}

function testSigningShape() {
  const action = makeOrderAction([
    toOrderWire({
      asset: 0,
      isBuy: true,
      limitPx: 30000,
      sz: 0.001,
      reduceOnly: false,
      orderType: { limit: { tif: "Ioc" } },
      cloid: "0x11111111111111111111111111111111",
    }),
  ]);

  const nonce = 1700000000000;
  const connectionId = hashAction(action, "0x0000000000000000000000000000000000000000", nonce);
  const digest = buildAgentEip712Digest({ source: "a", connectionIdHex: `0x${Buffer.from(connectionId).toString("hex")}` });
  const sig = signDigest("0x0000000000000000000000000000000000000000000000000000000000000001", digest);

  assert(/^0x[0-9a-f]{64}$/.test(sig.r), "signature.r invalid");
  assert(/^0x[0-9a-f]{64}$/.test(sig.s), "signature.s invalid");
  assert(sig.v === 27 || sig.v === 28, "signature.v invalid");
}

function run() {
  testKeccak();
  testPrivateKeyToAddress();
  testSigningShape();
  console.log("Selftest passed");
}

run();