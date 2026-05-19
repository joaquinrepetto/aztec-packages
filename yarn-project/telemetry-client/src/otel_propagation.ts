import type { DiagnosticsHandler } from '@aztec/foundation/json-rpc/server';

import { ROOT_CONTEXT, type Span, SpanKind, propagation } from '@opentelemetry/api';
import type Koa from 'koa';

import {
  applyJsonRpcExceptionSpanStatus,
  applyJsonRpcResponseSpanStatus,
  getJsonRpcRequestSpanMetadata,
} from './json_rpc_tracing.js';
import { getTelemetryClient } from './start.js';
import type { TelemetryClient } from './telemetry.js';

type GetTelemetryClient = () => Pick<TelemetryClient, 'getTracer'>;

export function getOtelJsonRpcPropagationMiddleware(
  scope = 'JsonRpcServer',
  getClient: GetTelemetryClient = getTelemetryClient,
): (ctx: Koa.Context, next: () => Promise<void>) => Promise<void> {
  return function otelJsonRpcPropagation(ctx: Koa.Context, next: () => Promise<void>) {
    const tracer = getClient().getTracer(scope);
    const extractedContext = propagation.extract(ROOT_CONTEXT, ctx.request.headers);
    return tracer.startActiveSpan(
      'JsonRpcServer',
      { kind: SpanKind.SERVER, attributes: getJsonRpcRequestSpanMetadata('JsonRpcServer', undefined).attributes },
      extractedContext,
      async (span: Span): Promise<void> => {
        try {
          await next();
          applyJsonRpcRequestSpanMetadata(span, 'JsonRpcServer', ctx.request.body);
          applyJsonRpcResponseSpanStatus(span, ctx.body);
        } catch (err) {
          applyJsonRpcRequestSpanMetadata(span, 'JsonRpcServer', ctx.request.body);
          applyJsonRpcExceptionSpanStatus(span, err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };
}

export function getOtelJsonRpcDiagnosticsHandler(
  scope = 'JsonRpcServer',
  getClient: GetTelemetryClient = getTelemetryClient,
  delegate?: DiagnosticsHandler,
): DiagnosticsHandler {
  return function otelJsonRpcDiagnostics(ctx, processRequest) {
    const tracer = getClient().getTracer(scope);
    const metadata = getJsonRpcRequestSpanMetadata('JsonRpcHandler', { id: ctx.id, method: ctx.method });
    return tracer.startActiveSpan(
      metadata.name,
      { kind: SpanKind.INTERNAL, attributes: metadata.attributes },
      async (span: Span): Promise<unknown> => {
        try {
          const response = await (delegate ? delegate(ctx, processRequest) : processRequest());
          applyJsonRpcResponseSpanStatus(span, response);
          return response;
        } catch (err) {
          applyJsonRpcExceptionSpanStatus(span, err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };
}

function applyJsonRpcRequestSpanMetadata(span: Span, spanPrefix: string, requestOrBatch: unknown): void {
  const metadata = getJsonRpcRequestSpanMetadata(spanPrefix, requestOrBatch);
  span.updateName(metadata.name);
  span.setAttributes(metadata.attributes);
}
