# PoB Headless API PoC

This directory contains an internal proof of concept for using `pob-web` as a headless Path of Building calculation engine.

It is not intended to be submitted upstream as one large PR. Upstream-sized changes should be split into small, generic patches such as `getBuildCode()` or Node embedding fixes.

## Scope

- Load a PoB share code from `pob.txt`.
- Read stable panel stats as JSON.
- Export the current in-memory build back to a PoB share code.
- Temporarily equip item text into a supported slot.
- Compare before/after stats and restore the original build.
- Provide a JSON CLI for downstream trade-candidate verification.

## Runtime

The API expects a packed PoB runtime under:

```text
packages/packer/build/poe1/<version>/root-zipfs
```

The local test baseline currently supports:

- `v2.63.0`: latest available local tag.
- `dev-aeccaca6`: local PathOfBuilding HEAD at `aeccaca6`.

Set `POB_WEB_VERSION` to choose a runtime:

```bash
POB_WEB_VERSION=dev-aeccaca6 node poc/test-headless-api.mjs
```

## CLI

```bash
node poc/pob-headless-cli.mjs list-slots --pretty
node poc/pob-headless-cli.mjs stats --pob /absolute/path/to/pob.txt --pretty
node poc/pob-headless-cli.mjs export-code --pob /absolute/path/to/pob.txt --pretty
node poc/pob-headless-cli.mjs compare-item --pob /absolute/path/to/pob.txt --slot "Weapon 2" --item /absolute/path/to/item.txt --pretty
node poc/pob-headless-cli.mjs batch-compare --pob /absolute/path/to/pob.txt --slot "Weapon 2" --items /absolute/path/to/candidates --pretty
```

`batch-compare` accepts item text files, directories containing `.txt` files, or simple glob patterns. It loads the PoB once, compares every candidate, restores after each item, and returns sorted JSON with a summary and per-item decision.

## Tests

```bash
node poc/test-headless-api.mjs
POB_WEB_VERSION=dev-aeccaca6 node poc/test-headless-api.mjs
```

The test suite covers baseline stats, `getBuildCode()` round-trip, item compare/restore for both weapon slots, invalid slot errors, and invalid item text errors.
It also smoke-tests the `batch-compare` CLI against the sample item directory.

## Bundle

Build a self-contained directory bundle:

```bash
POB_WEB_VERSION=dev-aeccaca6 node poc/build-bundle.mjs
```

This creates:

```text
poc/dist/pob-headless-dev-aeccaca6/
```

The bundle includes the CLI, driver wasm files, and packed PoB runtime. It still requires a modern Node.js runtime.

## Trade Candidate Verification

```bash
POB_WEB_VERSION=dev-aeccaca6 node poc/verify-trade-candidate.mjs \
  --pob /absolute/path/to/pob.txt \
  --slot "Weapon 2" \
  --item /absolute/path/to/item.txt
```

The result includes a coarse decision:

- `upgrade_candidate`
- `manual_review`
- `downgrade_skip`
