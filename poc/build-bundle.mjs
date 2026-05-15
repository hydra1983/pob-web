import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pobWebRoot = path.resolve(scriptDir, "..");
const version = process.env.POB_WEB_VERSION || process.argv[2] || "dev-aeccaca6";
const build = process.env.POB_WEB_BUILD || "release";
const packageVersion = `0.0.0-${version.replace(/[^0-9A-Za-z-]/g, "-")}`;
const packageName = process.env.POB_HEADLESS_PACKAGE_NAME || "@hydra1983/pob-headless";
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
copyFile(path.join(pobWebRoot, "LICENSE"), path.join(outDir, "LICENSE"));
copyFile(path.join(pobWebRoot, "NOTICE.md"), path.join(outDir, "NOTICE.md"));

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
SCRIPT="\${BASH_SOURCE[0]}"
while [ -L "$SCRIPT" ]; do
  DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
  TARGET="$(readlink "$SCRIPT")"
  if [[ "$TARGET" == /* ]]; then
    SCRIPT="$TARGET"
  else
    SCRIPT="$DIR/$TARGET"
  fi
done
ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "${name} requires Node.js 24+. Run: source ~/.zshrc >/dev/null 2>&1; nvm use v24.13.0 >/dev/null" >&2
  exit 1
fi
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
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: packageName,
      version: packageVersion,
      private: true,
      description: "Self-contained headless Path of Building CLI bundle generated from pob-web.",
      license: "MIT",
      type: "module",
      bin: {
        "pob-headless": "bin/pob-headless",
        "verify-trade-candidate": "bin/verify-trade-candidate",
      },
      files: [
        "bin",
        "poc/headless-api.mjs",
        "poc/pob-headless-cli.mjs",
        "poc/verify-trade-candidate.mjs",
        "poc/items",
        "packages",
        "LICENSE",
        "NOTICE.md",
        "README.md",
      ],
      pobHeadless: {
        runtimeVersion: version,
        driverBuild: build,
      },
      engines: {
        node: ">=24",
      },
    },
    null,
    2,
  )}\n`,
);

fs.writeFileSync(
  path.join(outDir, "README.md"),
  `# pob-headless bundle

Self-contained PoB headless CLI bundle generated from temp/pob-web.

- Package name: ${packageName}
- Package version: ${packageVersion}
- Runtime version: ${version}
- Driver build: ${build}
- Requires: Node.js 24+ or compatible modern Node runtime

Examples:

\`\`\`bash
bin/pob-headless stats --pob /absolute/path/to/pob.txt --pretty
bin/pob-headless compare-item --pob /absolute/path/to/pob.txt --slot "Weapon 2" --item poc/items/loath-barb-kinetic-wand.txt --pretty
bin/pob-headless batch-compare --pob /absolute/path/to/pob.txt --slot "Weapon 2" --items /absolute/path/to/candidates --pretty
bin/verify-trade-candidate --pob /absolute/path/to/pob.txt --slot "Weapon 2" --item poc/items/loath-barb-kinetic-wand.txt
\`\`\`

Install from this directory with \`npm install <bundle-dir>\`, or copy the bundle directory to a stable local tool path.
`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      outDir,
      packageName,
      packageVersion,
      version,
      build,
    },
    null,
    2,
  ),
);
