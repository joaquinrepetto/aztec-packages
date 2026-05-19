import { type AttributeValue, type Span, SpanStatusCode } from '@opentelemetry/api';

import {
  ATTR_JSONRPC_BATCH_SIZE,
  ATTR_JSONRPC_ERROR_CODE,
  ATTR_JSONRPC_ERROR_COUNT,
  ATTR_JSONRPC_ERROR_MSG,
  ATTR_JSONRPC_METHOD,
  ATTR_JSONRPC_METHODS,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_JSONRPC_VERSION,
  ATTR_RPC_SYSTEM,
} from './vendor/attributes.js';

type JsonRpcRequestSpanMetadata = {
  name: string;
  attributes: Record<string, AttributeValue>;
};

const JSONRPC_SYSTEM = 'jsonrpc';
const JSONRPC_VERSION = '2.0';

export function getJsonRpcRequestSpanMetadata(spanPrefix: string, requestOrBatch: unknown): JsonRpcRequestSpanMetadata {
  const attributes: Record<string, AttributeValue> = {
    [ATTR_RPC_SYSTEM]: JSONRPC_SYSTEM,
    [ATTR_JSONRPC_VERSION]: JSONRPC_VERSION,
  };

  const requests = Array.isArray(requestOrBatch) ? requestOrBatch : [requestOrBatch];
  if (Array.isArray(requestOrBatch)) {
    attributes[ATTR_JSONRPC_BATCH_SIZE] = requestOrBatch.length;
    const methods = requests.map(getJsonRpcMethod).filter(method => method !== undefined);
    if (methods.length > 0) {
      attributes[ATTR_JSONRPC_METHODS] = methods;
    }
  }

  const request = requests.length === 1 ? requests[0] : undefined;
  const method = getJsonRpcMethod(request);
  const requestId = getJsonRpcRequestId(request);

  if (method) {
    attributes[ATTR_JSONRPC_METHOD] = method;
  }
  if (requestId !== undefined) {
    attributes[ATTR_JSONRPC_REQUEST_ID] = requestId;
  }

  return {
    name: `${spanPrefix}.${method ?? (Array.isArray(requestOrBatch) ? 'batch' : 'unknown')}`,
    attributes,
  };
}

export function applyJsonRpcResponseSpanStatus(span: Span, response: unknown): void {
  const error = getJsonRpcResponseError(response);
  if (!error) {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }

  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  if (error.code !== undefined) {
    span.setAttribute(ATTR_JSONRPC_ERROR_CODE, error.code);
  }
  span.setAttribute(ATTR_JSONRPC_ERROR_MSG, error.message);
  span.setAttribute(ATTR_JSONRPC_ERROR_COUNT, error.count);
}

export function applyJsonRpcExceptionSpanStatus(span: Span, err: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
  if (typeof err === 'string' || err instanceof Error) {
    span.recordException(err);
  }
}

function getJsonRpcResponseError(
  responseOrBatch: unknown,
): { code?: number; count: number; message: string } | undefined {
  const responses = Array.isArray(responseOrBatch) ? responseOrBatch : [responseOrBatch];
  const errors = responses.map(getSingleJsonRpcResponseError).filter(error => error !== undefined);
  const firstError = errors[0];
  return firstError ? { ...firstError, count: errors.length } : undefined;
}

function getSingleJsonRpcResponseError(response: unknown): { code?: number; message: string } | undefined {
  if (!isRecord(response) || !isRecord(response.error)) {
    return undefined;
  }

  const { code, message } = response.error;
  return {
    code: typeof code === 'number' ? code : undefined,
    message: typeof message === 'string' && message.length > 0 ? message : 'JSON-RPC error',
  };
}

function getJsonRpcMethod(request: unknown): string | undefined {
  return isRecord(request) && typeof request.method === 'string' && request.method.length > 0
    ? request.method
    : undefined;
}

function getJsonRpcRequestId(request: unknown): number | string | undefined {
  if (!isRecord(request)) {
    return undefined;
  }

  return typeof request.id === 'number' || typeof request.id === 'string' ? request.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
