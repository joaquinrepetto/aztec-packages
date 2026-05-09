---
name: wasm-bench-browserstack
description: Run on-demand bb.js Chonk prove+verify benchmarks on BrowserStack real mobile devices using pinned IVC inputs.
---

# BrowserStack bb.js Chonk Benchmark

Use this skill when asked to benchmark bb.js Chonk proving on real browsers or
mobile devices. This is an on-demand benchmark, not a per-PR CI gate.

## Scope

- Benchmark full Chonk prove plus verify through `window.proveChonk` and
  `window.verifyChonk`.
- Use the pinned Chonk IVC input archive from
  `barretenberg/cpp/scripts/test_chonk_standalone_vks_havent_changed.sh`.
- Default device coverage is old iOS, new iOS, old Android, and new Android.
  Override the matrix for focused device work.
- Results are JSONL rows, one row per input per device, including BrowserStack
  requested capabilities and browser feature probes for SAB, threads, SIMD, and
  hardware concurrency.

## Prerequisites

From the repository root:

```bash
cd barretenberg/cpp
./scripts/test_chonk_standalone_vks_havent_changed.sh --download_pinned_inputs

cd ../ts
yarn build:wasm
yarn build:browser

cd ../acir_tests
yarn install
yarn workspace browser-test-app build
```

Set BrowserStack credentials:

```bash
export BROWSERSTACK_USER_NAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

`BROWSERSTACK_USERNAME` is also accepted for the username, and
`BROWSERSTACK_KEY` is also accepted for the access key.

## Run

```bash
cd barretenberg/acir_tests
yarn workspace headless-test browserstack:chonk-bench \
  --output browserstack-chonk-bench.jsonl
```

The default flow set is:

- `ecdsar1+transfer_0_recursions+sponsored_fpc`
- `ecdsar1+transfer_1_recursions+sponsored_fpc`
- `ecdsar1+token_bridge_claim_private+sponsored_fpc`

Override flows:

```bash
yarn workspace headless-test browserstack:chonk-bench \
  --flow ecdsar1+transfer_1_recursions+sponsored_fpc \
  --flow ecdsar1+transfer_0_recursions+sponsored_fpc
```

Use explicit input files:

```bash
yarn workspace headless-test browserstack:chonk-bench \
  --input /path/to/ivc-inputs-a.msgpack \
  --input /path/to/ivc-inputs-b.msgpack
```

Override the device matrix with JSON or a JSON file:

```json
[
  {
    "name": "ios-17",
    "capabilities": {
      "browserName": "safari",
      "bstack:options": {
        "deviceName": "iPhone 15",
        "osVersion": "17",
        "realMobile": "true"
      }
    }
  }
]
```

Then:

```bash
yarn workspace headless-test browserstack:chonk-bench --matrix ./matrix.json
```

## Output

Each JSONL row contains:

- `device`
- `requested_capabilities`
- `browser_features`
- `input`
- `input_bytes`
- `proof_bytes`
- `verification_key_bytes`
- `prove_ms`
- `verify_ms`
- `total_ms`
- `verified`

Keep the raw JSONL with the PR or gist so later benchmark comparisons can reuse
the same flow/device inputs.
