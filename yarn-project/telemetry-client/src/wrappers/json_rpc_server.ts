import { type SafeJsonRpcServerOptions, createSafeJsonRpcServer } from '@aztec/foundation/json-rpc/server';
import type { ApiSchemaFor } from '@aztec/stdlib/schemas';

import { getOtelJsonRpcDiagnosticsHandler, getOtelJsonRpcPropagationMiddleware } from '../otel_propagation.js';
import { getTelemetryClient } from '../start.js';

export function createTracedJsonRpcServer<T extends object = any>(
  handler: T,
  schema: ApiSchemaFor<T>,
  options: SafeJsonRpcServerOptions = {},
) {
  return createSafeJsonRpcServer(handler, schema, {
    ...options,
    diagnosticsHandler: getOtelJsonRpcDiagnosticsHandler(
      'JsonRpcServer',
      getTelemetryClient,
      options.diagnosticsHandler,
    ),
    middlewares: [...(options.middlewares ?? []), getOtelJsonRpcPropagationMiddleware()],
  });
}
