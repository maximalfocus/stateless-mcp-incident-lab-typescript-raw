export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

export function isJsonRpcRequest(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    value.jsonrpc === '2.0' &&
    isRequestId(value.id) &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    isObject(value.params)
  )
}

export function isJsonRpcNotification(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    value.jsonrpc === '2.0' &&
    !('id' in value) &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    (!('params' in value) || isObject(value.params))
  )
}
