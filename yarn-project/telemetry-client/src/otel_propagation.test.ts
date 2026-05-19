import { SpanStatusCode } from '@opentelemetry/api';

import { getOtelJsonRpcDiagnosticsHandler, getOtelJsonRpcPropagationMiddleware } from './otel_propagation.js';

type RecordedSpan = {
  attributes: Record<string, unknown>;
  ended: boolean;
  exceptions: unknown[];
  name: string;
  status?: { code: SpanStatusCode; message?: string };
};

function createTelemetryRecorder() {
  const spans: RecordedSpan[] = [];
  const getClient = () => ({
    getTracer: () => ({
      startSpan: () => ({}) as any,
      startActiveSpan: (name: string, ...args: any[]) => {
        const options = args.find(arg => typeof arg === 'object' && typeof arg !== 'function' && !('getValue' in arg));
        const fn = args.find(arg => typeof arg === 'function');
        const recorded: RecordedSpan = {
          attributes: { ...(options?.attributes ?? {}) },
          ended: false,
          exceptions: [],
          name,
        };
        const span = {
          end: () => {
            recorded.ended = true;
          },
          recordException: (err: unknown) => {
            recorded.exceptions.push(err);
          },
          setAttribute: (key: string, value: unknown) => {
            recorded.attributes[key] = value;
            return span;
          },
          setAttributes: (attributes: Record<string, unknown>) => {
            Object.assign(recorded.attributes, attributes);
            return span;
          },
          setStatus: (status: { code: SpanStatusCode; message?: string }) => {
            recorded.status = status;
            return span;
          },
          updateName: (updatedName: string) => {
            recorded.name = updatedName;
            return span;
          },
        };
        spans.push(recorded);
        return fn(span);
      },
    }),
  });

  return { getClient: getClient as any, spans };
}

describe('otel JSON-RPC propagation', () => {
  it('updates the server span after the request body is parsed', async () => {
    const { getClient, spans } = createTelemetryRecorder();
    const middleware = getOtelJsonRpcPropagationMiddleware('test', getClient);
    const ctx: any = { request: { body: undefined, headers: {} }, body: undefined };

    await middleware(ctx, async () => {
      ctx.request.body = [{ jsonrpc: '2.0', id: 7, method: 'getStatus', params: [] }];
      ctx.body = [{ jsonrpc: '2.0', id: 7, result: 'ok' }];
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: {
        'rpc.jsonrpc.batch_size': 1,
        'rpc.jsonrpc.request_id': 7,
        'rpc.jsonrpc.version': '2.0',
        'rpc.method': 'getStatus',
        'rpc.system': 'jsonrpc',
      },
      ended: true,
      name: 'JsonRpcServer.getStatus',
      status: { code: SpanStatusCode.OK },
    });
  });

  it('marks batched server spans as errors when any response fails', async () => {
    const { getClient, spans } = createTelemetryRecorder();
    const middleware = getOtelJsonRpcPropagationMiddleware('test', getClient);
    const ctx: any = { request: { body: undefined, headers: {} }, body: undefined };

    await middleware(ctx, async () => {
      ctx.request.body = [
        { jsonrpc: '2.0', id: 1, method: 'count', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'fail', params: [] },
      ];
      ctx.body = [
        { jsonrpc: '2.0', id: 1, result: 2 },
        { jsonrpc: '2.0', id: 2, error: { code: -32702, message: 'failed' } },
      ];
    });

    expect(spans[0]).toMatchObject({
      attributes: {
        'rpc.jsonrpc.batch_size': 2,
        'rpc.jsonrpc.error_code': -32702,
        'rpc.jsonrpc.error_count': 1,
        'rpc.jsonrpc.error_message': 'failed',
        'rpc.jsonrpc.methods': ['count', 'fail'],
      },
      name: 'JsonRpcServer.batch',
      status: { code: SpanStatusCode.ERROR, message: 'failed' },
    });
  });

  it('creates per-method diagnostics spans around JSON-RPC handlers', async () => {
    const { getClient, spans } = createTelemetryRecorder();
    const middleware = getOtelJsonRpcDiagnosticsHandler('test', getClient);

    const response = await middleware({ headers: {}, id: 'abc', method: 'fail', params: [] }, async () => ({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32702, message: 'failed' },
    }));

    expect(response).toEqual({ jsonrpc: '2.0', id: 'abc', error: { code: -32702, message: 'failed' } });
    expect(spans[0]).toMatchObject({
      attributes: {
        'rpc.jsonrpc.error_code': -32702,
        'rpc.jsonrpc.error_count': 1,
        'rpc.jsonrpc.error_message': 'failed',
        'rpc.jsonrpc.request_id': 'abc',
        'rpc.jsonrpc.version': '2.0',
        'rpc.method': 'fail',
        'rpc.system': 'jsonrpc',
      },
      ended: true,
      name: 'JsonRpcHandler.fail',
      status: { code: SpanStatusCode.ERROR, message: 'failed' },
    });
  });
});
