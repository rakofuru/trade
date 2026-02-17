#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    input: null,
    require: ["A", "B"],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    const next = i + 1 < argv.length ? argv[i + 1] : null;
    const consume = () => {
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--input" && next !== null) {
      out.input = String(consume());
      continue;
    }
    if (arg === "--require" && next !== null) {
      out.require = String(consume())
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter((x) => x === "A" || x === "B" || x === "C");
      continue;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node ops/assert-invariants.mjs [options]",
    "",
    "Options:",
    "  --input <path>       Input report JSON file (default: stdin)",
    "  --require <A,B,C>    Required invariant set (default: A,B)",
    "  --help               Show this help",
  ].join("\n");
}

async function readInput(inputPath) {
  if (inputPath) {
    return fs.readFileSync(path.resolve(inputPath), "utf8");
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function statusOf(report, key) {
  const invStatus = report?.invariantStatus || {};
  const status = String(invStatus?.[key] || "").toUpperCase();
  if (status === "PASS" || status === "WARN" || status === "FAIL") {
    return status;
  }
  const pass = Boolean(report?.invariants?.[key]?.pass);
  return pass ? "PASS" : "FAIL";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const raw = await readInput(opts.input);
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("empty input");
  }
  const report = JSON.parse(text);
  const required = opts.require.length ? opts.require : ["A", "B"];
  const failed = [];
  for (const key of required) {
    if (statusOf(report, key) !== "PASS") {
      failed.push(key);
    }
  }

  if (failed.length) {
    console.error(`[assert-invariants] FAIL required=${required.join(",")} failed=${failed.join(",")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[assert-invariants] PASS required=${required.join(",")}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && path.resolve(selfPath) === invokedPath) {
  main().catch((error) => {
    console.error(`[assert-invariants] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

