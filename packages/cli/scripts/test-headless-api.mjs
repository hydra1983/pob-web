import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PobHeadlessError,
  createPobHeadlessApi,
  defaultPobCodeFile,
  readPobCodeFile,
} from "../src/headless-api.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const itemFile = path.join(packageRoot, "fixtures", "items", "loath-barb-kinetic-wand.txt");
const pobCode = readPobCodeFile(defaultPobCodeFile);
const wandText = fs.readFileSync(itemFile, "utf8").trim();
const api = await createPobHeadlessApi({ verbose: process.env.POB_HEADLESS_VERBOSE === "1" });
const handle = await api.loadBuild(pobCode);
const checks = [];

function record(name, fn) {
  checks.push({ name, fn });
}

async function expectRejectsPobError(name, fn, code) {
  let caught;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${name} should reject`);
  assert(caught instanceof PobHeadlessError, `${name} should throw PobHeadlessError`);
  assert.equal(caught.code, code, `${name} error code`);
}

record("stats: v37 baseline", async () => {
  const stats = await api.getStats(handle);
  assert.equal(stats.className, "Ranger");
  assert.equal(stats.ascendancy, "Deadeye");
  assert.equal(stats.mainSkill, "Kinetic Fusillade");
  assert.equal(stats.life, 2786);
  assert(stats.combinedDps > 900000);
  assert.equal(stats.fireResist, 75);
  assert.equal(stats.coldResist, 75);
  assert.equal(stats.lightningResist, 75);
});

record("round-trip: getBuildCode reload preserves stats", async () => {
  const before = await api.getStats(handle);
  const code = await api.getBuildCode(handle);
  await api.loadBuild(code);
  const after = await api.getStats(handle);
  assert.deepEqual(after, before);
});

record("compareItem: Weapon 1 decreases DPS and restores build", async () => {
  await api.loadBuild(pobCode);
  const result = await api.compareItem(handle, "Weapon 1", wandText);
  assert.equal(result.restoredOk, true);
  assert(result.delta.combinedDps < 0);
  assert(result.delta.totalDps < 0);
  assert(result.delta.attackRate < 0);
  assert(result.delta.critChance < 0);
});

record("compareItem: Weapon 2 decreases DPS/EHP/life and restores build", async () => {
  await api.loadBuild(pobCode);
  const result = await api.compareItem(handle, "Weapon 2", wandText);
  assert.equal(result.restoredOk, true);
  assert(result.delta.combinedDps < 0);
  assert(result.delta.effectiveHitPool < 0);
  assert.equal(result.delta.life, -201);
  assert.equal(result.delta.chaosResist, -27);
});

record("invalid slot returns explicit error", async () => {
  await expectRejectsPobError(
    "invalid slot",
    () => api.setItem(handle, "Not A Slot", wandText),
    "INVALID_SLOT",
  );
});

record("invalid item text returns explicit lua error", async () => {
  await expectRejectsPobError(
    "invalid item",
    () => api.setItem(handle, "Weapon 1", "not an item"),
    "LUA_ERROR",
  );
});

record("batch-compare CLI returns downgrade_skip", async () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(packageRoot, "src", "pob-headless-cli.mjs"),
      "batch-compare",
      "--pob",
      defaultPobCodeFile,
      "--slot",
      "Weapon 2",
      "--items",
      path.join(packageRoot, "fixtures", "items"),
    ],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  const payload = JSON.parse(output);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.summary.downgrade_skip, 1);
  assert.equal(payload.results[0].decision, "downgrade_skip");
  assert.equal(payload.results[0].restoredOk, true);
});

record("verify-candidate CLI returns downgrade_skip", async () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(packageRoot, "src", "pob-headless-cli.mjs"),
      "verify-candidate",
      "--pob",
      defaultPobCodeFile,
      "--slot",
      "Weapon 2",
      "--item",
      itemFile,
    ],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  const payload = JSON.parse(output);
  assert.equal(payload.ok, true);
  assert.equal(payload.decision, "downgrade_skip");
  assert.equal(payload.result.restoredOk, true);
});

const results = [];
for (const check of checks) {
  await check.fn();
  results.push({ name: check.name, ok: true });
}
console.log(
  JSON.stringify(
    {
      ok: true,
      version: api.version,
      build: api.build,
      checks: results,
    },
    null,
    2,
  ),
);
