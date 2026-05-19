import { defaultFetch } from '@aztec/foundation/json-rpc/client';
import type { Logger } from '@aztec/foundation/log';
import { makeBackoff, retry } from '@aztec/foundation/retry';

import { SpanKind, context, propagation } from '@opentelemetry/api';

import {
  applyJsonRpcExceptionSpanStatus,
  applyJsonRpcResponseSpanStatus,
  getJsonRpcRequestSpanMetadata,
} from '../json_rpc_tracing.js';
import { getTelemetryClient } from '../start.js';

/**
 * Makes a fetch function that retries based on the given attempts and propagates trace information.
 * @param retries - Sequence of intervals (in seconds) to retry, or a factory function returning an iterator for custom/indefinite backoff.
 * @param noRetry - Whether to stop retries on server errors.
 * @param log - Optional logger for logging attempts.
 * @returns A fetch function.
 */
export function makeTracedFetch(
  retries: number[] | (() => Generator<number>),
  defaultNoRetry: boolean,
  fetch = defaultFetch,
  log?: Logger,
) {
  return (host: string, body: unknown, extraHeaders: Record<string, string> = {}, noRetry?: boolean) => {
    const telemetry = getTelemetryClient();
    const metadata = getJsonRpcRequestSpanMetadata('JsonRpcClient', body);
    return telemetry
      .getTracer('fetch')
      .startActiveSpan(metadata.name, { kind: SpanKind.CLIENT, attributes: metadata.attributes }, async span => {
        try {
          const headers = { ...extraHeaders };
          propagation.inject(context.active(), headers);
          const backoff = typeof retries === 'function' ? retries() : makeBackoff(retries);
          const result = await retry(
            () => fetch(host, body, headers, noRetry ?? defaultNoRetry),
            `JsonRpcClient request to ${host}`,
            backoff,
            log,
            false,
          );
          applyJsonRpcResponseSpanStatus(span, result.response);
          return result;
        } catch (err) {
          applyJsonRpcExceptionSpanStatus(span, err);
          throw err;
        } finally {
          span.end();
        }
      });
  };
}
