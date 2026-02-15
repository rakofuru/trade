import { keccak256 } from "./keccak.mjs";
import { hexToBytes } from "./secp256k1.mjs";

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const AGENT_TYPE = "Agent(string source,bytes32 connectionId)";
const EXCHANGE_NAME = "Exchange";
const EXCHANGE_VERSION = "1";

function leftPad32(bytes) {
  const data = Buffer.from(bytes);
  if (data.length > 32) {
    throw new Error("leftPad32 overflow");
  }
  return Buffer.concat([Buffer.alloc(32 - data.length), data]);
}

function uint256Bytes(value) {
  let n = BigInt(value);
  if (n < 0n) {
    throw new Error("uint256 cannot be negative");
  }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function addressBytes(addressHex) {
  const raw = hexToBytes(addressHex);
  if (raw.length !== 20) {
    throw new Error("Address must be 20 bytes");
  }
  return leftPad32(raw);
}

function bytes32(hexOrBytes) {
  const raw = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : Buffer.from(hexOrBytes);
  if (raw.length !== 32) {
    throw new Error("bytes32 value must be 32 bytes");
  }
  return raw;
}

const DOMAIN_TYPE_HASH = Buffer.from(keccak256(DOMAIN_TYPE));
const AGENT_TYPE_HASH = Buffer.from(keccak256(AGENT_TYPE));
const NAME_HASH = Buffer.from(keccak256(EXCHANGE_NAME));
const VERSION_HASH = Buffer.from(keccak256(EXCHANGE_VERSION));
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function buildAgentEip712Digest({ source, connectionIdHex, chainId = 1337n }) {
  const domainEncoded = Buffer.concat([
    DOMAIN_TYPE_HASH,
    NAME_HASH,
    VERSION_HASH,
    uint256Bytes(chainId),
    addressBytes(ZERO_ADDRESS),
  ]);
  const domainSeparator = Buffer.from(keccak256(domainEncoded));

  const sourceHash = Buffer.from(keccak256(source));
  const structEncoded = Buffer.concat([
    AGENT_TYPE_HASH,
    sourceHash,
    bytes32(connectionIdHex),
  ]);
  const structHash = Buffer.from(keccak256(structEncoded));

  const digestInput = Buffer.concat([
    Buffer.from([0x19, 0x01]),
    domainSeparator,
    structHash,
  ]);
  return Buffer.from(keccak256(digestInput));
}