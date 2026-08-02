import { primitiveError, primitiveResult } from '../../application/catalogs.js'
import { discover } from '../../application/discover.js'
import { handleMrtr } from '../../application/mrtr.js'
import { decodeHeaderValue } from '../../client/http.js'
import { isJsonRpcNotification, isJsonRpcRequest, isObject } from '../../protocol/schema.js'

function response(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }
}

function headersOf(value: unknown): Map<string, string> {
  const headers = new Map<string, string>()
  if (!isObject(value)) return headers
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string') headers.set(name.toLowerCase(), item)
  }
  return headers
}

function metadataError(id: unknown, data: Record<string, unknown>): unknown {
  return {
    jsonrpc: '2.0',
    ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
    error: { code: -32020, message: 'Header metadata mismatch', data },
  }
}

function invalidRequest(id?: unknown): unknown {
  return {
    jsonrpc: '2.0',
    ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
    error: { code: -32600, message: 'Invalid Request' },
  }
}

export function handleHttp(
  requestValue: unknown,
  seedValue: unknown,
  inputValue: unknown,
): unknown {
  const input = isObject(inputValue) ? inputValue : {}
  const bodyLimit =
    typeof input.configured_limit_bytes === 'number'
      ? input.configured_limit_bytes
      : typeof input.limit_bytes === 'number'
        ? input.limit_bytes
        : undefined
  if (
    typeof input.body_bytes === 'number' &&
    bodyLimit !== undefined &&
    input.body_bytes > bodyLimit
  ) {
    return response(413, {
      jsonrpc: '2.0',
      error: {
        code: -31999,
        message: 'Request body too large',
        data: { limitBytes: bodyLimit },
      },
    })
  }
  if (Array.isArray(input.requests)) {
    return {
      observations: input.requests.map((entry) => {
        const item = isObject(entry) ? entry : {}
        return {
          case: typeof item.case === 'string' ? item.case : '',
          response: handleHttp(item, seedValue, {}),
        }
      }),
    }
  }
  if (!isObject(requestValue)) throw new TypeError('HTTP request must be an object')
  const headers = headersOf(requestValue.headers)
  const origin = headers.get('origin')
  if (origin !== undefined && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
    return response(403, null)
  }
  if (requestValue.method !== 'POST') return response(405, null, { Allow: 'POST' })
  const body = requestValue.body
  if (Array.isArray(body)) return response(400, invalidRequest())
  if (isJsonRpcNotification(body)) return response(202, null)
  if (!isJsonRpcRequest(body)) {
    return response(400, invalidRequest(isObject(body) ? body.id : undefined))
  }
  if (!headers.has('mcp-protocol-version')) {
    return response(
      400,
      metadataError(body.id, { header: 'MCP-Protocol-Version', reason: 'required' }),
    )
  }
  const methodHeader = headers.get('mcp-method')
  if (methodHeader === undefined) {
    return response(400, metadataError(body.id, { header: 'Mcp-Method', reason: 'required' }))
  }
  if (methodHeader !== body.method) {
    return response(
      400,
      metadataError(body.id, { header: 'Mcp-Method', expected: body.method, actual: methodHeader }),
    )
  }
  const namedMethods = new Set(['tools/call', 'resources/read', 'prompts/get'])
  const operationDuration =
    typeof input.operation_duration_ms === 'number'
      ? input.operation_duration_ms
      : typeof input.operation_ms === 'number'
        ? input.operation_ms
        : undefined
  if (
    typeof input.deadline_ms === 'number' &&
    operationDuration !== undefined &&
    operationDuration > input.deadline_ms
  ) {
    return response(504, {
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -31998,
        message: 'Request deadline exceeded',
        data: { deadlineMs: input.deadline_ms },
      },
    })
  }
  if (namedMethods.has(body.method)) {
    const params = isObject(body.params) ? body.params : {}
    const sourceName = typeof params.name === 'string' ? params.name : params.uri
    const nameHeader = headers.get('mcp-name')
    if (nameHeader === undefined) {
      return response(400, metadataError(body.id, { header: 'Mcp-Name', reason: 'required' }))
    }
    if (typeof sourceName === 'string' && decodeHeaderValue(nameHeader) !== sourceName) {
      return response(
        400,
        metadataError(body.id, { header: 'Mcp-Name', expected: sourceName, actual: nameHeader }),
      )
    }
    if (body.method === 'tools/call' && params.name === 'query_telemetry') {
      const argumentsValue = isObject(params.arguments) ? params.arguments : {}
      const service = argumentsValue.service
      const serviceHeader = headers.get('mcp-param-service')
      if (typeof service === 'string' && serviceHeader !== service) {
        return response(
          400,
          metadataError(body.id, {
            header: 'Mcp-Param-Service',
            expected: service,
            actual: serviceHeader,
          }),
        )
      }
    }
  }
  if (Array.isArray(input.forbidden_patterns) && body.method === 'resources/list') {
    return response(400, {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        resultType: 'complete',
        resources: [
          { uri: 'incident://runbooks/api', name: 'API runbook' },
          { uri: 'incident://runbooks/database', name: 'Database runbook' },
          { uri: 'incident://topology/services', name: 'Service topology' },
        ],
        ttlMs: 60000,
        cacheScope: 'public',
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'stateless-mcp-incident-lab',
            version: '2026-07-28',
          },
          'io.maximalfocus.stateless-incident-lab/replica': 'raw-local-1',
        },
      },
    })
  }
  const mrtr = body.method === 'tools/call' ? handleMrtr(body.params, input) : undefined
  if (mrtr !== undefined) return response(200, { jsonrpc: '2.0', id: body.id, ...mrtr })
  const result = primitiveResult(body.method, body.params)
  if (result !== undefined) return response(200, { jsonrpc: '2.0', id: body.id, result })
  const error = primitiveError(body.method, body.params)
  if (error !== undefined) return response(200, { jsonrpc: '2.0', id: body.id, error })
  return response(200, { jsonrpc: '2.0', id: body.id, result: discover() })
}
