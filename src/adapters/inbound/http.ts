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
  return response(200, { jsonrpc: '2.0', id: body.id, result: discoveryResult() })
}
