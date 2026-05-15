import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pobWebRoot = path.resolve(scriptDir, "..");
const version = process.env.POB_WEB_VERSION || process.argv[2] || "dev-aeccaca6";
const build = process.env.POB_WEB_BUILD || "release";
const outDir = path.join(scriptDir, "dist", `pob-headless-${version}`);

const driverDist = path.join(pobWebRoot, "packages", "driver", "dist", build);
const runtimeRoot = path.join(pobWebRoot, "packages", "packer", "build", "poe1", version, "root-zipfs");

function assertExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required bundle input does not exist: ${filePath}`);
  }
}

function copyFile(src, dest) {
  assertExists(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  assertExists(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

assertExists(driverDist);
assertExists(runtimeRoot);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyFile(path.join(scriptDir, "headless-api.mjs"), path.join(outDir, "poc", "headless-api.mjs"));
copyFile(path.join(scriptDir, "pob-headless-cli.mjs"), path.join(outDir, "poc", "pob-headless-cli.mjs"));
copyFile(path.join(scriptDir, "verify-trade-candidate.mjs"), path.join(outDir, "poc", "verify-trade-candidate.mjs"));
copyDir(path.join(scriptDir, "items"), path.join(outDir, "poc", "items"));

for (const file of ["driver.mjs", "driver.wasm", "lua-utf8.wasm"]) {
  copyFile(path.join(driverDist, file), path.join(outDir, "packages", "driver", "dist", build, file));
}
copyDir(
  runtimeRoot,
  path.join(outDir, "packages", "packer", "build", "poe1", version, "root-zipfs"),
);

function writeWrapper(name, target) {
  const wrapper = `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
export POB_WEB_VERSION="\${POB_WEB_VERSION:-${version}}"
export POB_WEB_BUILD="\${POB_WEB_BUILD:-${build}}"
exec node "$ROOT/${target}" "$@"
`;
  const wrapperPath = path.join(outDir, "bin", name);
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, wrapper);
  fs.chmodSync(wrapperPath, 0o755);
}

writeWrapper("pob-headless", "poc/pob-headless-cli.mjs");
writeWrapper("verify-trade-candidate", "poc/verify-trade-candidate.mjs");

fs.writeFileSync(
  path.join(outDir, "README.md"),
  `# pob-headless bundle

Self-contained PoB headless CLI bundle generated from temp/pob-web.

- Runtime version: ${version}
- Driver build: ${build}
- Requires: Node.js 24+ or compatible modern Node runtime

Examples:

\`\`\`bash
bin/pob-headless stats --pob /absolute/path/to/pob.txt --pretty
bin/pob-headless compare-item --pob /absolute/path/to/pob.txt --slot "Weapon 2" --item poc/items/loath-barb-kinetic-wand.txt --pretty
bin/verify-trade-candidate --pob /absolute/path/to/pob.txt --slot "Weapon 2" --item poc/items/loath-barb-kinetic-wand.txt
\`\`\`
`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      outDir,
      version,
      build,
    },
    null,
    2,
  ),
);
