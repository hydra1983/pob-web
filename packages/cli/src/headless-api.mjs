import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const repoRoot = path.resolve(workspaceRoot, "..", "..");
const bundledPackagesRoot = path.join(packageRoot, "packages");
const workspacePackagesRoot = path.join(workspaceRoot, "packages");

function resolvePackagesRoot() {
  if (fs.existsSync(bundledPackagesRoot)) {
    return bundledPackagesRoot;
  }
  return workspacePackagesRoot;
}

export const defaultPobCodeFile = path.join(
  repoRoot,
  "analysis/kinetic-fusillade-lightning-warp-deadeye/endgame-variants/pob/snapshots/v37/pob.txt",
);

export const supportedSlots = Object.freeze([
  "Weapon 1",
  "Weapon 2",
  "Weapon 1 Swap",
  "Weapon 2 Swap",
  "Helmet",
  "Body Armour",
  "Gloves",
  "Boots",
  "Amulet",
  "Ring 1",
  "Ring 2",
  "Ring 3",
  "Belt",
  "Flask 1",
  "Flask 2",
  "Flask 3",
  "Flask 4",
  "Flask 5",
  "Graft 1",
  "Graft 2",
]);

const slotAliases = new Map([
  ["Main Hand", "Weapon 1"],
  ["Off Hand", "Weapon 2"],
  ["Weapon1", "Weapon 1"],
  ["Weapon2", "Weapon 2"],
  ["Body", "Body Armour"],
  ["Chest", "Body Armour"],
  ["Ring", "Ring 1"],
]);

export class PobHeadlessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PobHeadlessError";
    this.code = code;
    this.details = details;
  }
}

export function normaliseSlotName(slotName) {
  return slotAliases.get(String(slotName)) || String(slotName);
}

export function assertSupportedSlot(slotName) {
  const normalised = normaliseSlotName(slotName);
  if (!supportedSlots.includes(normalised)) {
    throw new PobHeadlessError("INVALID_SLOT", `Unsupported slot: ${slotName}`, {
      slot: String(slotName),
      normalisedSlot: normalised,
      supportedSlots,
    });
  }
  return normalised;
}

export function readPobCodeFile(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

function ensureRuntime({ version, build }) {
  const packagesRoot = resolvePackagesRoot();
  const runtimeDir = path.join(packageRoot, "runtime", version);
  const rootZipFs = path.join(packagesRoot, "packer/build/poe1", version, "root-zipfs");
  const rootMount = path.join(runtimeDir, "root");
  const userMount = path.join(runtimeDir, "user");
  const libLuaDir = path.join(runtimeDir, "lib", "lua");
  const driverDist = path.join(packagesRoot, "driver/dist", build);
  const luaUtf8Source = path.join(driverDist, "lua-utf8.wasm");
  const luaUtf8Mount = path.join(libLuaDir, "lua-utf8.wasm");

  if (!fs.existsSync(rootZipFs)) {
    throw new PobHeadlessError("RUNTIME_NOT_FOUND", `Packed root-zipfs not found: ${rootZipFs}`, { rootZipFs });
  }
  if (!fs.existsSync(luaUtf8Source)) {
    throw new PobHeadlessError("RUNTIME_NOT_FOUND", `lua-utf8.wasm not found: ${luaUtf8Source}`, { luaUtf8Source });
  }

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(userMount, { recursive: true });
  fs.mkdirSync(libLuaDir, { recursive: true });

  if (fs.existsSync(rootMount) && fs.lstatSync(rootMount).isSymbolicLink()) {
    fs.unlinkSync(rootMount);
  }
  if (!fs.existsSync(rootMount)) {
    fs.cpSync(rootZipFs, rootMount, { recursive: true });
  }
  if (fs.existsSync(luaUtf8Mount) && fs.lstatSync(luaUtf8Mount).isSymbolicLink()) {
    fs.unlinkSync(luaUtf8Mount);
  }
  if (!fs.existsSync(luaUtf8Mount)) {
    fs.copyFileSync(luaUtf8Source, luaUtf8Mount);
  }

  return { runtimeDir, driverDist };
}

function luaString(value) {
  return JSON.stringify(String(value));
}

function numericDelta(before, after) {
  const delta = {};
  for (const [key, beforeValue] of Object.entries(before)) {
    const afterValue = after[key];
    if (typeof beforeValue === "number" && typeof afterValue === "number") {
      delta[key] = afterValue - beforeValue;
    }
  }
  return delta;
}

const helperLua = String.raw`
local function headlessJsonEscape(v)
  v = tostring(v):gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r")
  return '"' .. v .. '"'
end

local function headlessJsonValue(v)
  if v == nil then
    return "null"
  end
  if type(v) == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      return "null"
    end
    return tostring(v)
  end
  if type(v) == "boolean" then
    return v and "true" or "false"
  end
  return headlessJsonEscape(v)
end

local function headlessJsonObject(fields)
  local out = { "{" }
  for index, field in ipairs(fields) do
    if index > 1 then
      table.insert(out, ",")
    end
    table.insert(out, headlessJsonEscape(field[1]))
    table.insert(out, ":")
    table.insert(out, headlessJsonValue(field[2]))
  end
  table.insert(out, "}")
  return table.concat(out)
end

local function headlessBuild()
  local main = GetMainObject()
  local build = main and main.main and main.main.modes and main.main.modes.BUILD
  if not build then
    error("headless: BUILD mode is not available")
  end
  return build
end

function headlessGetStatsJson()
  local build = headlessBuild()
  local calcs = build.calcsTab or {}
  local out = calcs.mainOutput or {}
  local env = calcs.mainEnv or {}
  local skill = env.player and env.player.mainSkill or {}
  local granted = skill.activeEffect and skill.activeEffect.grantedEffect or {}

  return headlessJsonObject({
    { "buildName", build.buildName },
    { "className", build.spec and build.spec.curClassName },
    { "ascendancy", build.spec and build.spec.curAscendClassName },
    { "mainSkill", granted.name or skill.skillName },
    { "combinedDps", out.CombinedDPS },
    { "fullDps", out.FullDPS },
    { "totalDps", out.TotalDPS },
    { "totalDot", out.TotalDot },
    { "igniteDps", out.IgniteDPS },
    { "averageDamage", out.AverageDamage },
    { "attackRate", out.Speed },
    { "critChance", out.CritChance },
    { "critMultiplier", out.CritMultiplier },
    { "life", out.Life },
    { "energyShield", out.EnergyShield },
    { "mana", out.Mana },
    { "evasion", out.Evasion },
    { "armour", out.Armour },
    { "ward", out.Ward },
    { "fireResist", out.FireResist },
    { "coldResist", out.ColdResist },
    { "lightningResist", out.LightningResist },
    { "chaosResist", out.ChaosResist },
    { "blockChance", out.BlockChance },
    { "spellBlockChance", out.SpellBlockChance },
    { "spellSuppressionChance", out.SpellSuppressionChance },
    { "effectiveHitPool", out.TotalEHP or out.EHP },
    { "physicalMaxHit", out.PhysicalMaximumHitTaken },
    { "elementalMaxHit", out.ElementalMaximumHitTaken },
    { "chaosMaxHit", out.ChaosMaximumHitTaken },
    { "lifeLeechOnHitRate", out.LifeLeechGainRate },
    { "manaLeechOnHitRate", out.ManaLeechGainRate },
  })
end

local function headlessNormaliseSlot(slotName)
  local aliases = {
    ["Main Hand"] = "Weapon 1",
    ["Off Hand"] = "Weapon 2",
    ["Weapon1"] = "Weapon 1",
    ["Weapon2"] = "Weapon 2",
    ["Body"] = "Body Armour",
    ["Chest"] = "Body Armour",
    ["Ring"] = "Ring 1",
  }
  return aliases[slotName] or slotName
end

function headlessSetItem(slotName, itemRaw)
  local build = headlessBuild()
  local itemsTab = build.itemsTab
  if not itemsTab then
    error("headlessSetItem: itemsTab is not available")
  end

  slotName = headlessNormaliseSlot(slotName)
  local slot = itemsTab.slots[slotName]
  if not slot then
    error("headlessSetItem: unknown slot '" .. tostring(slotName) .. "'")
  end

  local item = new("Item", itemRaw)
  if not item or not item.base then
    error("headlessSetItem: failed to parse item text")
  end
  item:NormaliseQuality()
  item:BuildModList()

  if not itemsTab:IsItemValidForSlot(item, slotName) then
    error("headlessSetItem: item '" .. tostring(item.name) .. "' is not valid for slot '" .. slotName .. "'")
  end

  itemsTab:AddItem(item, true)
  slot:SetSelItemId(item.id)
  itemsTab:PopulateSlots()
  itemsTab.modFlag = true
  build.buildFlag = true

  return headlessJsonObject({
    { "slot", slotName },
    { "itemId", item.id },
    { "name", item.name },
    { "baseName", item.baseName },
    { "type", item.type },
    { "rarity", item.rarity },
  })
end
`;

export async function createPobHeadlessApi(options = {}) {
  const build = options.build || process.env.POB_WEB_BUILD || "release";
  const version = options.version || process.env.POB_WEB_VERSION || "v2.63.0";
  const logs = [];
  const errors = [];
  const titles = [];
  const { runtimeDir, driverDist } = ensureRuntime({ version, build });

  process.chdir(runtimeDir);

  const driverPath = path.join(driverDist, "driver.mjs");
  const wasmBinary = fs.readFileSync(path.join(driverDist, "driver.wasm"));
  const driverModule = await import(pathToFileURL(driverPath));
  const module = await driverModule.default({
    wasmBinary,
    print: (...args) => {
      const line = args.map(String).join(" ");
      logs.push(line);
      if (options.verbose) {
        console.log("[lua]", line);
      }
    },
    printErr: (...args) => {
      const line = args.map(String).join(" ");
      logs.push(`[stderr] ${line}`);
      if (options.verbose) {
        console.warn("[lua:stderr]", line);
      }
    },
    fs,
    onError: message => {
      errors.push(String(message));
      if (options.verbose) {
        console.error("[lua:error]", message);
      }
    },
    setWindowTitle: title => titles.push(String(title)),
    getScreenWidth: () => options.width || 1550,
    getScreenHeight: () => options.height || 800,
    getCursorPosX: () => 0,
    getCursorPosY: () => 0,
    isKeyDown: () => 0,
    copy: () => {},
    paste: async () => "",
    openUrl: () => {},
    fetch: () => {},
    imageLoad: () => {},
    drawCommit: () => {},
    getStringWidth: (size, _font, text) => Math.ceil(String(text).length * size * 0.55),
    getStringCursorIndex: () => 0,
    launchSubScript: async () => 0,
    abortSubScript: async () => 0,
    isSubScriptRunning: () => 0,
    bridge: {
      fetch: async () => ({ body: "", status: 0, headers: {}, error: "fetch disabled in headless poc" }),
      onSubScriptFinished: () => {},
      onSubScriptError: message => errors.push(String(message)),
    },
  });

  const init = module.cwrap("init", "number", [], { async: true });
  const start = module.cwrap("start", "number", [], { async: true });
  const onFrame = module.cwrap("on_frame", "number", [], { async: true });
  const loadBuildFromCode = module.cwrap("load_build_from_code", "number", ["string"], { async: true });
  const getBuildCodeC = module.cwrap("get_build_code", "string", [], { async: true });
  const evalLua = module.cwrap("eval_lua_string", "string", ["string"]);

  let started = false;
  let loaded = false;
  const handle = { id: "active" };

  function assertHandle(candidate) {
    if (!candidate || candidate.id !== handle.id || !loaded) {
      throw new PobHeadlessError("INVALID_HANDLE", `Unknown or unloaded build handle: ${JSON.stringify(candidate)}`, {
        handle: candidate,
      });
    }
  }

  function rawLua(code) {
    return evalLua(code);
  }

  function callLua(functionName, ...args) {
    const source = `
local ok, result = pcall(function()
  local fn = _G[${luaString(functionName)}]
  if type(fn) ~= "function" then
    error("missing lua function: " .. ${luaString(functionName)})
  end
  return fn(${args.map(luaString).join(", ")})
end)
if ok then
  return "OK\\n" .. tostring(result or "")
end
return "ERR\\n" .. tostring(result)
`;
    const output = rawLua(source);
    if (output.startsWith("OK\n")) {
      return output.slice(3);
    }
    if (output.startsWith("ERR\n")) {
      throw new PobHeadlessError("LUA_ERROR", output.slice(4), { functionName });
    }
    throw new PobHeadlessError("LUA_ERROR", output || "Lua evaluation failed", { functionName });
  }

  async function flushFrames(count = 3) {
    for (let i = 0; i < count; i += 1) {
      await onFrame();
    }
  }

  async function ensureStarted() {
    if (started) {
      return;
    }
    const initStatus = await init();
    if (initStatus !== 0) {
      throw new PobHeadlessError("RUNTIME_INIT_FAILED", `init failed with status ${initStatus}`, { initStatus });
    }
    const startStatus = await start();
    if (startStatus !== 0) {
      throw new PobHeadlessError("RUNTIME_START_FAILED", `start failed with status ${startStatus}`, { startStatus });
    }
    const helperStatus = rawLua(`${helperLua}\nreturn "OK"`);
    if (helperStatus !== "OK") {
      throw new PobHeadlessError("LUA_HELPER_INIT_FAILED", helperStatus || "failed to install helper lua functions");
    }
    started = true;
  }

  return {
    version,
    build,
    runtimeDir,
    logs,
    errors,
    titles,

    async loadBuild(code) {
      await ensureStarted();
      const loadStatus = await loadBuildFromCode(String(code).trim());
      if (loadStatus !== 0) {
        throw new PobHeadlessError("LOAD_BUILD_FAILED", `loadBuild failed with status ${loadStatus}`, {
          loadStatus,
          errors: errors.slice(-5),
        });
      }
      loaded = true;
      await flushFrames();
      return handle;
    },

    async getStats(candidate) {
      assertHandle(candidate);
      await flushFrames(1);
      return JSON.parse(callLua("headlessGetStatsJson"));
    },

    async setItem(candidate, slot, itemText) {
      assertHandle(candidate);
      const normalisedSlot = assertSupportedSlot(slot);
      const result = JSON.parse(callLua("headlessSetItem", normalisedSlot, itemText));
      await flushFrames();
      return result;
    },

    async compareItem(candidate, slot, itemText) {
      assertHandle(candidate);
      const restoreCode = await this.getBuildCode(candidate);
      const before = await this.getStats(candidate);
      const equipped = await this.setItem(candidate, slot, itemText);
      const after = await this.getStats(candidate);
      const changedCode = await this.getBuildCode(candidate);

      await this.loadBuild(restoreCode);
      const restored = await this.getStats(candidate);
      const restoredOk = JSON.stringify(before) === JSON.stringify(restored);

      return {
        slot: equipped.slot,
        equipped,
        before,
        after,
        delta: numericDelta(before, after),
        changedCode,
        restoredOk,
      };
    },

    async getBuildCode(candidate) {
      assertHandle(candidate);
      const code = await getBuildCodeC();
      if (!code) {
        throw new PobHeadlessError("GET_BUILD_CODE_FAILED", "getBuildCode failed");
      }
      return code;
    },

    getDiagnostics() {
      return {
        version,
        build,
        runtimeDir,
        titles: titles.slice(),
        errors: errors.slice(),
        logs: logs.slice(),
      };
    },

    async flushFrames(count = 3) {
      await flushFrames(count);
    },
  };
}
