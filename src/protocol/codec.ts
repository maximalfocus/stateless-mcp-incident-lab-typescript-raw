import { isJsonRpcNotification, isJsonRpcRequest, isObject } from './schema.js'

const invalidRequest = {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'Invalid Request' },
} as const

function validateRequests(input: Record<string, unknown>): unknown {
  if (Array.isArray(input.cases)) return { valid: input.cases.map(isJsonRpcRequest) }
  const value = input.value
  if (isJsonRpcRequest(value)) return { valid: true }
  return {
    input_id: isObject(value) && 'id' in value ? value.id : undefined,
    valid: false,
    error: invalidRequest,
  }
}

export function executeFunction(input: unknown): unknown {
  if (!isObject(input) || typeof input.operation !== 'string') {
    throw new TypeError('Protocol operation must be named')
  }
  switch (input.operation) {
    case 'validate_request':
      return validateRequests(input)
    case 'validate_notification':
      return { valid: isJsonRpcNotification(input.value), response_required: false }
    default:
      throw new RangeError(`Unsupported protocol operation: ${input.operation}`)
  }
}
