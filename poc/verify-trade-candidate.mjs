#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  PobHeadlessError,
  assertSupportedSlot,
  createPobHeadlessApi,
  defaultPobCodeFile,
  readPobCodeFile,
} from "./headless-api.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      throw new PobHeadlessError("CLI_USAGE", `Unexpected argument: ${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new PobHeadlessError("CLI_USAGE", `Missing value for ${key}`);
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function readFileArg(filePath, label) {
  if (!filePath) {
    throw new PobHeadlessError("CLI_USAGE", `Missing --${label}`);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new PobHeadlessError("FILE_NOT_FOUND", `${label} file not found: ${resolved}`, { file: resolved });
  }
  return { path: resolved, text: fs.readFileSync(resolved, "utf8").trim() };
}

function classify(delta) {
  const dps = delta.combinedDps ?? delta.totalDps ?? 0;
  const ehp = delta.effectiveHitPool ?? 0;
  const life = delta.life ?? 0;
  const chaosResist = delta.chaosResist ?? 0;

  if (dps > 0 && ehp >= -500 && life >= -50 && chaosResist >= -5) {
    return "upgrade_candidate";
  }
  if (dps < 0 && (ehp < 0 || life < 0 || chaosResist < 0)) {
    return "downgrade_skip";
  }
  return "manual_review";
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error instanceof PobHeadlessError ? error.code : "UNEXPECTED_ERROR",
      message: error.message,
      details: error instanceof PobHeadlessError ? error.details : {},
    },
  };
}

try {
  const args = parseArgs(process.argv);
  const pob = args.pob
    ? readFileArg(args.pob, "pob")
    : { path: defaultPobCodeFile, text: readPobCodeFile(defaultPobCodeFile) };
  const item = readFileArg(args.item, "item");
  const slot = assertSupportedSlot(args.slot);
  const api = await createPobHeadlessApi({ verbose: process.env.POB_HEADLESS_VERBOSE === "1" });
  const handle = await api.loadBuild(pob.text);
  const result = await api.compareItem(handle, slot, item.text);

  console.log(
    JSON.stringify(
      {
        ok: true,
        pobFile: pob.path,
        itemFile: item.path,
        slot,
        version: api.version,
        decision: classify(result.delta),
        result: {
          slot: result.slot,
          equipped: result.equipped,
          before: result.before,
          after: result.after,
          delta: result.delta,
          restoredOk: result.restoredOk,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify(errorPayload(error), null, 2));
  process.exitCode = 1;
}

