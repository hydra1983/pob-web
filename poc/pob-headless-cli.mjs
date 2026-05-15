#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PobHeadlessError,
  assertSupportedSlot,
  createPobHeadlessApi,
  defaultPobCodeFile,
  readPobCodeFile,
  supportedSlots,
} from "./headless-api.mjs";

function usage() {
  return `Usage:
  pob-headless stats --pob <pob.txt>
  pob-headless export-code --pob <pob.txt>
  pob-headless set-item --pob <pob.txt> --slot <slot> --item <item.txt> [--include-code]
  pob-headless compare-item --pob <pob.txt> --slot <slot> --item <item.txt> [--include-code]
  pob-headless list-slots

Environment:
  POB_WEB_VERSION   PoB runtime version, default v2.63.0
  POB_WEB_BUILD     driver build, default release
  POB_HEADLESS_VERBOSE=1 prints Lua runtime logs
`;
}

function parseArgs(argv) {
  const command = argv[2];
  const args = {};
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new PobHeadlessError("CLI_USAGE", `Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (key === "include-code" || key === "pretty" || key === "help") {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new PobHeadlessError("CLI_USAGE", `Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return { command, args };
}

function readRequiredFile(filePath, label) {
  if (!filePath) {
    throw new PobHeadlessError("CLI_USAGE", `Missing --${label}`);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new PobHeadlessError("FILE_NOT_FOUND", `${label} file not found: ${resolved}`, { file: resolved });
  }
  return { path: resolved, text: fs.readFileSync(resolved, "utf8").trim() };
}

function readPobArg(filePath) {
  if (filePath) {
    return readRequiredFile(filePath, "pob");
  }
  if (fs.existsSync(defaultPobCodeFile)) {
    return { path: defaultPobCodeFile, text: readPobCodeFile(defaultPobCodeFile) };
  }
  throw new PobHeadlessError("CLI_USAGE", "Missing --pob");
}

function codeInfo(code) {
  return {
    length: code.length,
    sha256: crypto.createHash("sha256").update(code).digest("hex"),
  };
}

function omitCodeFromCompare(result) {
  const { changedCode, ...rest } = result;
  return {
    ...rest,
    changedCode: codeInfo(changedCode),
  };
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error instanceof PobHeadlessError ? error.code : "UNEXPECTED_ERROR",
      message: error.message,
      details: error instanceof PobHeadlessError ? error.details : {},
      stack: process.env.POB_HEADLESS_DEBUG === "1" ? error.stack : undefined,
    },
  };
}

function printJson(payload, pretty) {
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
}

async function withBuild(pobText, callback) {
  const api = await createPobHeadlessApi({ verbose: process.env.POB_HEADLESS_VERBOSE === "1" });
  const handle = await api.loadBuild(pobText);
  return callback(api, handle);
}

async function main() {
  const { command, args } = parseArgs(process.argv);
  if (!command || command === "help" || command === "--help" || args.help) {
    console.log(usage());
    return;
  }

  if (command === "list-slots") {
    printJson({ ok: true, slots: supportedSlots }, args.pretty);
    return;
  }

  const pob = readPobArg(args.pob);
  const common = {
    ok: true,
    pobFile: pob.path,
    version: process.env.POB_WEB_VERSION || "v2.63.0",
    build: process.env.POB_WEB_BUILD || "release",
  };

  if (command === "stats") {
    const result = await withBuild(pob.text, async (api, handle) => ({
      ...common,
      stats: await api.getStats(handle),
    }));
    printJson(result, args.pretty);
    return;
  }

  if (command === "export-code") {
    const result = await withBuild(pob.text, async (api, handle) => {
      const code = await api.getBuildCode(handle);
      return {
        ...common,
        code,
        codeInfo: codeInfo(code),
      };
    });
    printJson(result, args.pretty);
    return;
  }

  if (command === "set-item" || command === "compare-item") {
    const slot = assertSupportedSlot(args.slot);
    const item = readRequiredFile(args.item, "item");
    const result = await withBuild(pob.text, async (api, handle) => {
      if (command === "set-item") {
        const equipped = await api.setItem(handle, slot, item.text);
        const stats = await api.getStats(handle);
        const changedCode = await api.getBuildCode(handle);
        return {
          ...common,
          itemFile: item.path,
          slot,
          equipped,
          stats,
          changedCode: args["include-code"] ? changedCode : codeInfo(changedCode),
        };
      }
      const compare = await api.compareItem(handle, slot, item.text);
      return {
        ...common,
        itemFile: item.path,
        result: args["include-code"] ? compare : omitCodeFromCompare(compare),
      };
    });
    printJson(result, args.pretty);
    return;
  }

  throw new PobHeadlessError("CLI_USAGE", `Unknown command: ${command}`);
}

main().catch(error => {
  printJson(errorPayload(error), true);
  process.exitCode = 1;
});

