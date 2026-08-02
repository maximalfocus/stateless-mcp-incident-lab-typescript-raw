import { isJsonRpcNotification, isJsonRpcRequest, isObject } from './schema.js'

const invalidRequest = {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'Invalid Request' },
} as const

function validateRequests(input: Record<string, unknown>): unknown {
  if (Array.isArray(input.cases)) {
    const valid = input.cases.map(isJsonRpcRequest)
    return valid.every(Boolean) ? { valid } : { valid, errors: valid.map(() => invalidRequest) }
  }
  const value = input.value
  if (isJsonRpcRequest(value)) return { valid: true }
  return {
    input_id: isObject(value) && 'id' in value ? value.id : undefined,
    valid: false,
    error: invalidRequest,
  }
}

function validateResultResponse(value: unknown): unknown {
  if (
    !isObject(value) ||
    value.jsonrpc !== '2.0' ||
    !('result' in value) ||
    !isObject(value.result)
  ) {
    return { valid: false }
  }
  const resultType = value.result.resultType
  const validType = resultType === 'complete' || resultType === 'input_required'
  const valid = validType && (typeof value.id === 'string' || typeof value.id === 'number')
  return { valid, id: value.id, result_type: resultType }
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
    case 'validate_result_response':
      return validateResultResponse(input.value)
    default:
      throw new RangeError(`Unsupported protocol operation: ${input.operation}`)
  }
}
