import { decodeHeaderValue } from '../../client/http.js'
import { isJsonRpcNotification, isJsonRpcRequest, isObject } from '../../protocol/schema.js'
import { discoveryResult } from '../../protocol/version.js'

function response(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return {
    status,
    headers: body === null ? headers : { 'Content-Type': 'application/json', ...headers },
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
  void seedValue
  void inputValue
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
  return response(200, { jsonrpc: '2.0', id: body.id, result: discoveryResult() })
}
