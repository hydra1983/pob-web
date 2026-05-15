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
  pob-headless batch-compare --pob <pob.txt> --slot <slot> --items <file|dir|glob> [more files...] [--full] [--include-code]
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
    if (key === "include-code" || key === "pretty" || key === "full" || key === "help") {
      args[key] = true;
      continue;
    }
    if (key === "items") {
      const values = [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        values.push(argv[i + 1]);
        i += 1;
      }
      if (values.length === 0) {
        throw new PobHeadlessError("CLI_USAGE", "Missing value for --items");
      }
      args.items = [...(args.items || []), ...values];
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new PobHeadlessError("CLI_USAGE", `Missing value for --${key}`);
    }
    if (key === "item") {
      args.item = args.item ? [...(Array.isArray(args.item) ? args.item : [args.item]), value] : value;
    } else {
      args[key] = value;
    }
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

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+.:]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function expandItemInput(input) {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return fs
        .readdirSync(resolved)
        .filter(name => name.endsWith(".txt"))
        .map(name => path.join(resolved, name))
        .sort();
    }
    if (stat.isFile()) {
      return [resolved];
    }
  }

  if (input.includes("*") || input.includes("?")) {
    const dir = path.resolve(path.dirname(input));
    const pattern = path.basename(input);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new PobHeadlessError("FILE_NOT_FOUND", `Item glob directory not found: ${dir}`, { input, dir });
    }
    const matcher = wildcardToRegExp(pattern);
    return fs
      .readdirSync(dir)
      .filter(name => matcher.test(name))
      .map(name => path.join(dir, name))
      .sort();
  }

  throw new PobHeadlessError("FILE_NOT_FOUND", `Item input not found: ${resolved}`, { input, resolved });
}

function readItemBatch(args) {
  const rawInputs = [];
  if (args.items) {
    rawInputs.push(...args.items);
  }
  if (args.item) {
    rawInputs.push(...(Array.isArray(args.item) ? args.item : [args.item]));
  }
  if (rawInputs.length === 0) {
    throw new PobHeadlessError("CLI_USAGE", "Missing --items or --item");
  }

  const seen = new Set();
  const files = [];
  for (const input of rawInputs) {
    for (const file of expandItemInput(input)) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  if (files.length === 0) {
    throw new PobHeadlessError("FILE_NOT_FOUND", "No item text files matched", { inputs: rawInputs });
  }
  return files.map(file => ({ path: file, text: fs.readFileSync(file, "utf8").trim() }));
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

function classifyDelta(delta) {
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

const decisionRank = {
  upgrade_candidate: 0,
  manual_review: 1,
  downgrade_skip: 2,
  error: 3,
};

function compactCompareResult(result, includeCode) {
  const payload = includeCode ? result : omitCodeFromCompare(result);
  return {
    slot: payload.slot,
    equipped: payload.equipped,
    decision: classifyDelta(payload.delta),
    restoredOk: payload.restoredOk,
    delta: payload.delta,
    after: {
      combinedDps: payload.after.combinedDps,
      totalDps: payload.after.totalDps,
      effectiveHitPool: payload.after.effectiveHitPool,
      life: payload.after.life,
      chaosResist: payload.after.chaosResist,
      fireResist: payload.after.fireResist,
      coldResist: payload.after.coldResist,
      lightningResist: payload.after.lightningResist,
    },
    changedCode: payload.changedCode,
  };
}

function resultSortKey(result) {
  if (!result.ok) {
    return [decisionRank.error, 0, 0, result.itemFile];
  }
  return [
    decisionRank[result.decision] ?? decisionRank.error,
    -(result.delta.combinedDps ?? result.delta.totalDps ?? 0),
    -(result.delta.effectiveHitPool ?? 0),
    result.itemFile,
  ];
}

function sortBatchResults(results) {
  return results.sort((a, b) => {
    const ak = resultSortKey(a);
    const bk = resultSortKey(b);
    for (let i = 0; i < ak.length; i += 1) {
      if (ak[i] < bk[i]) return -1;
      if (ak[i] > bk[i]) return 1;
    }
    return 0;
  });
}

function summarizeBatch(results) {
  const summary = {
    total: results.length,
    ok: 0,
    errors: 0,
    upgrade_candidate: 0,
    manual_review: 0,
    downgrade_skip: 0,
  };
  for (const result of results) {
    if (!result.ok) {
      summary.errors += 1;
      continue;
    }
    summary.ok += 1;
    summary[result.decision] += 1;
  }
  return summary;
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

  if (command === "batch-compare") {
    const slot = assertSupportedSlot(args.slot);
    const items = readItemBatch(args);
    const result = await withBuild(pob.text, async (api, handle) => {
      const rows = [];
      for (const item of items) {
        try {
          const compare = await api.compareItem(handle, slot, item.text);
          const compact = compactCompareResult(compare, args["include-code"]);
          rows.push({
            ok: true,
            itemFile: item.path,
            decision: compact.decision,
            ...(args.full
              ? {
                  ...compact,
                  result: args["include-code"] ? compare : omitCodeFromCompare(compare),
                }
              : compact),
          });
        } catch (error) {
          rows.push({
            ok: false,
            itemFile: item.path,
            decision: "error",
            error: errorPayload(error).error,
          });
        }
      }
      const results = sortBatchResults(rows);
      return {
        ...common,
        slot,
        itemCount: items.length,
        summary: summarizeBatch(results),
        results,
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
