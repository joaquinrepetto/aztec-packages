import fs from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createWriteStream } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

import browserstack from 'browserstack-local';
import { Command } from 'commander';
import { Builder, type WebDriver } from 'selenium-webdriver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

export type DeviceConfig = {
  name: string;
  capabilities: Record<string, any>;
};

export type BenchInput = {
  label: string;
  path: string;
  route: string;
};

type BrowserFeatureReport = {
  userAgent: string;
  hardwareConcurrency: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
};

type BrowserBenchRun = {
  label: string;
  inputBytes: number;
  proofBytes: number;
  verificationKeyBytes: number;
  proveMs: number;
  verifyMs: number;
  totalMs: number;
  verified: boolean;
};

type BrowserBenchResult = {
  features: BrowserFeatureReport;
  runs: BrowserBenchRun[];
};

const DEFAULT_INPUTS_ROOT = join(repoRoot, 'yarn-project', 'end-to-end', 'example-app-ivc-inputs-out');
const DEFAULT_BROWSER_DIST = join(__dirname, '..', '..', 'browser-test-app', 'dest');

const DEFAULT_FLOWS = [
  'ecdsar1+transfer_0_recursions+sponsored_fpc',
  'ecdsar1+transfer_1_recursions+sponsored_fpc',
  'ecdsar1+token_bridge_claim_private+sponsored_fpc',
];

export const DEFAULT_DEVICE_MATRIX: DeviceConfig[] = [
  {
    name: 'old-ios',
    capabilities: {
      browserName: 'safari',
      'bstack:options': {
        deviceName: 'iPhone 11',
        osVersion: '15',
        realMobile: 'true',
      },
    },
  },
  {
    name: 'new-ios',
    capabilities: {
      browserName: 'safari',
      'bstack:options': {
        deviceName: 'iPhone 15',
        osVersion: '17',
        realMobile: 'true',
      },
    },
  },
  {
    name: 'old-android',
    capabilities: {
      browserName: 'chrome',
      'bstack:options': {
        deviceName: 'Samsung Galaxy S10',
        osVersion: '9.0',
        realMobile: 'true',
      },
    },
  },
  {
    name: 'new-android',
    capabilities: {
      browserName: 'chrome',
      'bstack:options': {
        deviceName: 'Samsung Galaxy S24',
        osVersion: '14.0',
        realMobile: 'true',
      },
    },
  },
];

export function parseDeviceMatrix(rawMatrix: string): DeviceConfig[] {
  const parsed = JSON.parse(rawMatrix);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('BrowserStack matrix must be a non-empty JSON array.');
  }

  return parsed.map((device, index) => {
    if (!device || typeof device !== 'object') {
      throw new Error(`BrowserStack matrix entry ${index} must be an object.`);
    }
    if (typeof device.name !== 'string' || device.name.length === 0) {
      throw new Error(`BrowserStack matrix entry ${index} needs a non-empty name.`);
    }
    if (!device.capabilities || typeof device.capabilities !== 'object') {
      throw new Error(`BrowserStack matrix entry ${device.name} needs capabilities.`);
    }
    return {
      name: device.name,
      capabilities: device.capabilities,
    };
  });
}

export function resolveInputFiles(inputsRoot: string, flows: string[], explicitInputs: string[]): BenchInput[] {
  const chosenInputs =
    explicitInputs.length > 0
      ? explicitInputs.map(inputPath => {
          const label = basename(inputPath).replace(/\.msgpack$/, '');
          return { label, path: resolve(inputPath) };
        })
      : flows.map(flow => ({
          label: flow,
          path: join(inputsRoot, flow, 'ivc-inputs.msgpack'),
        }));

  return chosenInputs.map((input, index) => ({
    label: input.label,
    path: input.path,
    route: `/inputs/${index}-${safeRouteLabel(input.label)}.msgpack`,
  }));
}

function safeRouteLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function readMatrixOption(matrixOption?: string): DeviceConfig[] {
  if (!matrixOption) {
    return DEFAULT_DEVICE_MATRIX;
  }
  const matrixText = fs.existsSync(matrixOption) ? fs.readFileSync(matrixOption, 'utf8') : matrixOption;
  return parseDeviceMatrix(matrixText);
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.json':
      return 'application/json';
    case '.css':
      return 'text/css';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.msgpack':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function addIsolationHeaders(res: ServerResponse) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function serveFile(res: ServerResponse, filePath: string) {
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': content.length,
  });
  res.end(content);
}

function resolveStaticPath(distPath: string, requestPath: string): string | undefined {
  const candidate = resolve(distPath, requestPath.replace(/^\/+/, ''));
  const distRoot = resolve(distPath);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}/`)) {
    return undefined;
  }
  return candidate;
}

export function startBenchServer(distPath: string, inputs: BenchInput[]): Promise<{ port: number; server: Server }> {
  if (!fs.existsSync(distPath)) {
    throw new Error(`Browser test app dist not found at ${distPath}. Build browser-test-app first.`);
  }
  for (const input of inputs) {
    if (!fs.existsSync(input.path)) {
      throw new Error(`Pinned Chonk input not found: ${input.path}`);
    }
  }

  const inputRoutes = new Map(inputs.map(input => [input.route, input.path]));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    addIsolationHeaders(res);
    const requestPath = new URL(req.url || '/', 'http://localhost').pathname;

    try {
      if (requestPath === '/') {
        res.writeHead(302, { Location: '/index.html' });
        res.end();
        return;
      }

      const inputPath = inputRoutes.get(requestPath);
      if (inputPath) {
        serveFile(res, inputPath);
        return;
      }

      const staticPath = resolveStaticPath(distPath, requestPath);
      if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        serveFile(res, staticPath);
        return;
      }

      res.writeHead(404);
      res.end(`Not found: ${requestPath}`);
    } catch (error: any) {
      res.writeHead(500);
      res.end(`Server error: ${error.message}`);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Could not bind BrowserStack benchmark server.'));
        return;
      }
      resolvePromise({ port: address.port, server });
    });
    server.on('error', reject);
  });
}

async function withBrowserStackLocal<T>(key: string, localIdentifier: string, fn: () => Promise<T>): Promise<T> {
  const local = new browserstack.Local();
  await new Promise<void>((resolvePromise, reject) => {
    local.start(
      {
        key,
        localIdentifier,
        forceLocal: true,
        onlyAutomate: true,
      },
      error => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      },
    );
  });

  try {
    return await fn();
  } finally {
    await new Promise<void>(resolvePromise => {
      local.stop(() => {
        resolvePromise();
      });
    });
  }
}

function mergedCapabilities(
  device: DeviceConfig,
  localIdentifier: string,
  projectName: string,
  buildName: string,
): Record<string, any> {
  const capabilities = structuredClone(device.capabilities);
  const bstackOptions = {
    ...(capabilities['bstack:options'] ?? {}),
    local: 'true',
    localIdentifier,
    projectName,
    buildName,
    sessionName: `bb.js Chonk BrowserStack bench: ${device.name}`,
  };
  capabilities['bstack:options'] = bstackOptions;
  return capabilities;
}

async function buildDriver(username: string, accessKey: string, capabilities: Record<string, any>): Promise<WebDriver> {
  return new Builder()
    .usingServer(`https://${username}:${accessKey}@hub-cloud.browserstack.com/wd/hub`)
    .withCapabilities(capabilities)
    .build();
}

async function setBrowserStackStatus(driver: WebDriver, passed: boolean, reason: string) {
  const payload = JSON.stringify({
    action: 'setSessionStatus',
    arguments: {
      status: passed ? 'passed' : 'failed',
      reason,
    },
  });
  try {
    await driver.executeScript(`browserstack_executor: ${payload}`);
  } catch {
    // Session status is best-effort and should not mask benchmark results.
  }
}

async function runBrowserBench(
  driver: WebDriver,
  url: string,
  inputs: BenchInput[],
  threads: number,
  timeoutMs: number,
): Promise<BrowserBenchResult> {
  await driver.manage().setTimeouts({ pageLoad: 90_000, script: timeoutMs });
  await driver.get(url);

  await driver.wait(async () => {
    return await driver.executeScript(
      'return typeof window.proveChonk === "function" && typeof window.verifyChonk === "function";',
    );
  }, 90_000);

  const result = (await driver.executeAsyncScript(
    `
const inputs = arguments[0];
const threads = arguments[1];
const done = arguments[arguments.length - 1];

function validateWasm(bytes) {
  try {
    return WebAssembly.validate(new Uint8Array(bytes));
  } catch (_) {
    return false;
  }
}

(async () => {
  const features = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasmSimd: validateWasm([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,12,26,11]),
    wasmThreads: typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined',
  };
  const runs = [];
  for (const input of inputs) {
    const response = await fetch(input.route, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Failed to fetch ' + input.route + ': ' + response.status);
    }
    const ivcInputs = new Uint8Array(await response.arrayBuffer());
    const proveStart = performance.now();
    const { proof, verificationKey } = await window.proveChonk(ivcInputs, threads);
    const proveMs = performance.now() - proveStart;
    const verifyStart = performance.now();
    const verified = await window.verifyChonk(proof, verificationKey, 1);
    const verifyMs = performance.now() - verifyStart;
    runs.push({
      label: input.label,
      inputBytes: ivcInputs.byteLength,
      proofBytes: proof.byteLength,
      verificationKeyBytes: verificationKey.byteLength,
      proveMs,
      verifyMs,
      totalMs: proveMs + verifyMs,
      verified,
    });
    if (!verified) {
      throw new Error('Chonk proof did not verify for ' + input.label);
    }
  }
  done({ ok: true, value: { features, runs } });
})().catch(error => done({
  ok: false,
  error: {
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : '',
  },
}));
`,
    inputs.map(input => ({ label: input.label, route: input.route })),
    threads,
  )) as { ok: true; value: BrowserBenchResult } | { ok: false; error: { message: string; stack: string } };

  if (!result.ok) {
    throw new Error(`${result.error.message}\n${result.error.stack}`);
  }
  return result.value;
}

export function requireBrowserStackUsername(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.BROWSERSTACK_USER_NAME || env.BROWSERSTACK_USERNAME;
  if (!value) {
    throw new Error('BROWSERSTACK_USER_NAME or BROWSERSTACK_USERNAME is required.');
  }
  return value;
}

function writeDeviceRows(
  output: fs.WriteStream,
  device: DeviceConfig,
  capabilities: Record<string, any>,
  result: BrowserBenchResult,
) {
  const recordedAt = new Date().toISOString();
  for (const run of result.runs) {
    output.write(
      `${JSON.stringify({
        recorded_at: recordedAt,
        device: device.name,
        requested_capabilities: capabilities,
        browser_features: result.features,
        input: run.label,
        input_bytes: run.inputBytes,
        proof_bytes: run.proofBytes,
        verification_key_bytes: run.verificationKeyBytes,
        prove_ms: run.proveMs,
        verify_ms: run.verifyMs,
        total_ms: run.totalMs,
        verified: run.verified,
      })}\n`,
    );
  }
}

async function runCli() {
  const program = new Command('browserstack_chonk_bench');
  program
    .description('Run bb.js Chonk prove+verify benchmarks on BrowserStack real devices.')
    .option('--inputs-root <path>', 'Directory containing pinned Chonk flow folders.', DEFAULT_INPUTS_ROOT)
    .option('--flow <name>', 'Pinned Chonk flow folder to run. Repeatable.', collectOption, [])
    .option('--input <path>', 'Explicit ivc-inputs.msgpack path. Repeatable; overrides --flow.', collectOption, [])
    .option('--matrix <json-or-path>', 'BrowserStack device matrix as JSON or a path to JSON.')
    .option('--browser-dist <path>', 'Built browser-test-app/dest directory.', DEFAULT_BROWSER_DIST)
    .option('--output <path>', 'JSONL output path.', 'browserstack-chonk-bench.jsonl')
    .option('--threads <count>', 'Requested bb.js worker count.', value => Number.parseInt(value, 10), 4)
    .option(
      '--timeout-ms <count>',
      'Per-device script timeout in milliseconds.',
      value => Number.parseInt(value, 10),
      900_000,
    )
    .option('--project-name <name>', 'BrowserStack project name.', 'barretenberg bb.js')
    .option('--build-name <name>', 'BrowserStack build name.', `chonk-browser-bench-${new Date().toISOString()}`)
    .option('--local-identifier <name>', 'BrowserStack Local identifier.', `bb-browser-bench-${process.pid}`);

  const options = program.parse().opts<{
    inputsRoot: string;
    flow: string[];
    input: string[];
    matrix?: string;
    browserDist: string;
    output: string;
    threads: number;
    timeoutMs: number;
    projectName: string;
    buildName: string;
    localIdentifier: string;
  }>();

  const username = requireBrowserStackUsername();
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY || process.env.BROWSERSTACK_KEY;
  if (!accessKey) {
    throw new Error('BROWSERSTACK_ACCESS_KEY or BROWSERSTACK_KEY is required.');
  }

  const matrix = readMatrixOption(options.matrix);
  const inputs = resolveInputFiles(
    resolve(options.inputsRoot),
    options.flow.length > 0 ? options.flow : DEFAULT_FLOWS,
    options.input,
  );
  const { port, server } = await startBenchServer(resolve(options.browserDist), inputs);
  const output = createWriteStream(options.output, { flags: 'a' });
  const browserUrl = `http://bs-local.com:${port}/index.html`;

  console.log(`Serving browser-test-app to BrowserStack at ${browserUrl}`);
  console.log(`Writing JSONL results to ${options.output}`);

  try {
    await withBrowserStackLocal(accessKey, options.localIdentifier, async () => {
      const failures: string[] = [];
      for (const device of matrix) {
        const capabilities = mergedCapabilities(
          device,
          options.localIdentifier,
          options.projectName,
          options.buildName,
        );
        console.log(`Running ${device.name}...`);
        let driver: WebDriver | undefined;
        try {
          driver = await buildDriver(username, accessKey, capabilities);
          const result = await runBrowserBench(driver, browserUrl, inputs, options.threads, options.timeoutMs);
          writeDeviceRows(output, device, capabilities, result);
          await setBrowserStackStatus(driver, true, `${result.runs.length} Chonk input(s) proven and verified.`);
          console.log(`Finished ${device.name}.`);
        } catch (error: any) {
          output.write(
            `${JSON.stringify({
              recorded_at: new Date().toISOString(),
              device: device.name,
              requested_capabilities: capabilities,
              error: error.message,
              ok: false,
            })}\n`,
          );
          if (driver) {
            await setBrowserStackStatus(driver, false, error.message);
          }
          failures.push(`${device.name}: ${error.message}`);
        } finally {
          if (driver) {
            await driver.quit();
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(`BrowserStack benchmark failed on ${failures.length} device(s):\n${failures.join('\n')}`);
      }
    });
  } finally {
    output.end();
    server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
