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

function validateErrorResponse(value: unknown): unknown {
  const valid =
    isObject(value) &&
    value.jsonrpc === '2.0' &&
    isObject(value.error) &&
    typeof value.error.code === 'number' &&
    typeof value.error.message === 'string' &&
    !('result' in value)
  const result = isObject(value) && isObject(value.result) ? value.result : undefined
  return {
    valid,
    id: isObject(value) ? value.id : undefined,
    code: isObject(value) && isObject(value.error) ? value.error.code : undefined,
    has_result: isObject(value) && 'result' in value,
    has_result_meta: result !== undefined && '_meta' in result,
  }
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(allFinite)
  if (isObject(value)) return Object.values(value).every(allFinite)
  return true
}

function decodeJsonRpc(utf8: unknown): unknown {
  if (typeof utf8 !== 'string') throw new TypeError('JSON-RPC input must be UTF-8 text')
  try {
    const value: unknown = JSON.parse(utf8)
    if (!allFinite(value)) throw new SyntaxError('Non-finite JSON number')
    return { ok: true, value }
  } catch {
    return { ok: false, error: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } } }
  }
}

function validateMessages(input: Record<string, unknown>): unknown {
  const cases = Array.isArray(input.cases) ? input.cases : [input.value]
  const valid = cases.map((value) => isJsonRpcRequest(value) || isJsonRpcNotification(value))
  return { valid, errors: valid.map(() => invalidRequest) }
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
    case 'validate_error_response':
      return validateErrorResponse(input.value)
    case 'decode_jsonrpc':
      return decodeJsonRpc(input.utf8)
    case 'validate_message':
      return validateMessages(input)
    default:
      throw new RangeError(`Unsupported protocol operation: ${input.operation}`)
  }
}
