import crypto from "node:crypto";

export function verifyLineSignature({
  channelSecret,
  rawBody,
  signature,
}) {
  const secret = String(channelSecret || "");
  const body = typeof rawBody === "string" ? rawBody : String(rawBody || "");
  const sig = String(signature || "").trim();

  if (!secret || !body || !sig) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");

  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(sig, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
