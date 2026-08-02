import { isJsonRpcNotification, isJsonRpcRequest, isObject } from '../../protocol/schema.js'
import { discoveryResult } from '../../protocol/version.js'

function response(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return {
    status,
    headers: body === null ? headers : { 'Content-Type': 'application/json', ...headers },
    body,
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
  if (requestValue.method !== 'POST') return response(405, null, { Allow: 'POST' })
  const body = requestValue.body
  if (Array.isArray(body)) return response(400, invalidRequest())
  if (isJsonRpcNotification(body)) return response(202, null)
  if (!isJsonRpcRequest(body)) {
    return response(400, invalidRequest(isObject(body) ? body.id : undefined))
  }
  return response(200, { jsonrpc: '2.0', id: body.id, result: discoveryResult() })
}
