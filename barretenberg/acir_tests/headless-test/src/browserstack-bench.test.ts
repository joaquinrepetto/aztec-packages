import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_DEVICE_MATRIX,
  parseDeviceMatrix,
  requireBrowserStackUsername,
  resolveInputFiles,
  startBenchServer,
} from './browserstack-bench.js';

const customMatrix = parseDeviceMatrix(
  JSON.stringify([
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
  ]),
);

assert.equal(customMatrix.length, 1);
assert.equal(customMatrix[0].name, 'old-ios');
assert.equal(customMatrix[0].capabilities.browserName, 'safari');
assert.equal(customMatrix[0].capabilities['bstack:options'].deviceName, 'iPhone 11');

const resolvedFlows = resolveInputFiles(
  '/repo/yarn-project/end-to-end/example-app-ivc-inputs-out',
  ['flow-a', 'flow-b'],
  [],
);
assert.deepEqual(resolvedFlows, [
  {
    label: 'flow-a',
    path: '/repo/yarn-project/end-to-end/example-app-ivc-inputs-out/flow-a/ivc-inputs.msgpack',
    route: '/inputs/0-flow-a.msgpack',
  },
  {
    label: 'flow-b',
    path: '/repo/yarn-project/end-to-end/example-app-ivc-inputs-out/flow-b/ivc-inputs.msgpack',
    route: '/inputs/1-flow-b.msgpack',
  },
]);

const resolvedExplicitInputs = resolveInputFiles('/ignored', [], ['/tmp/a.msgpack', '/tmp/b.msgpack']);
assert.deepEqual(
  resolvedExplicitInputs.map(input => ({ label: input.label, route: input.route })),
  [
    { label: 'a', route: '/inputs/0-a.msgpack' },
    { label: 'b', route: '/inputs/1-b.msgpack' },
  ],
);

assert.equal(DEFAULT_DEVICE_MATRIX.length, 4);
assert.deepEqual(
  DEFAULT_DEVICE_MATRIX.map(device => device.name),
  ['old-ios', 'new-ios', 'old-android', 'new-android'],
);

assert.equal(requireBrowserStackUsername({ BROWSERSTACK_USER_NAME: 'preferred-name' }), 'preferred-name');
assert.equal(requireBrowserStackUsername({ BROWSERSTACK_USERNAME: 'legacy-name' }), 'legacy-name');
assert.throws(() => requireBrowserStackUsername({}), /BROWSERSTACK_USER_NAME or BROWSERSTACK_USERNAME/);

const tempRoot = mkdtempSync(join(tmpdir(), 'browserstack-bench-test-'));
const distPath = join(tempRoot, 'dist');
const inputPath = join(tempRoot, 'ivc-inputs.msgpack');
mkdirSync(distPath, { recursive: true });
writeFileSync(join(distPath, 'index.html'), '<html>ok</html>');
writeFileSync(inputPath, Buffer.from([1, 2, 3, 4]));

const { port, server } = await startBenchServer(distPath, [
  { label: 'flow-a', path: inputPath, route: '/inputs/0-flow-a.msgpack' },
]);
try {
  const indexResponse = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(indexResponse.status, 200);
  assert.equal(indexResponse.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(indexResponse.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(await indexResponse.text(), '<html>ok</html>');

  const inputResponse = await fetch(`http://127.0.0.1:${port}/inputs/0-flow-a.msgpack`);
  assert.equal(inputResponse.status, 200);
  assert.deepEqual([...new Uint8Array(await inputResponse.arrayBuffer())], [1, 2, 3, 4]);

  const traversalResponse = await fetch(`http://127.0.0.1:${port}/../package.json`);
  assert.equal(traversalResponse.status, 404);
} finally {
  server.close();
}
