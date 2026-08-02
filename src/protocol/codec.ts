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

function dispatchMethod(request: unknown): unknown {
  if (!isObject(request) || typeof request.method !== 'string')
    throw new TypeError('Invalid request')
  const id = request.id
  if (request.method === 'tools/call') {
    const params = isObject(request.params) ? request.params : {}
    const knownTools = new Set([
      'create_incident',
      'execute_remediation',
      'get_incident',
      'propose_remediation',
      'query_telemetry',
      'resolve_incident',
      'run_diagnostic',
    ])
    if (typeof params.name !== 'string' || !knownTools.has(params.name)) {
      return {
        http_status: 400,
        response: {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params', data: { name: params.name } },
        },
      }
    }
  }
  const knownMethods = new Set([
    'server/discover',
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/templates/list',
    'resources/read',
    'prompts/list',
    'prompts/get',
  ])
  if (!knownMethods.has(request.method)) {
    return {
      http_status: 404,
      response: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } },
    }
  }
  return { http_status: 200 }
}

function schemaChildren(value: unknown): unknown[] {
  if (!isObject(value)) return []
  const children: unknown[] = []
  if (isObject(value.properties)) children.push(...Object.values(value.properties))
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    if (isObject(value[key])) children.push(value[key])
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(value[key])) children.push(...(value[key] as unknown[]))
  }
  return children
}

function schemaDepth(value: unknown): number {
  const children = schemaChildren(value)
  return children.length === 0 ? 1 : 1 + Math.max(...children.map(schemaDepth))
}

function schemaSubschemas(value: unknown): number {
  const children = schemaChildren(value)
  return children.length + children.reduce<number>((sum, item) => sum + schemaSubschemas(item), 0)
}

function hasNetworkRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNetworkRef)
  if (!isObject(value)) return false
  if (typeof value.$ref === 'string' && /^https?:\/\//i.test(value.$ref)) return true
  return Object.values(value).some(hasNetworkRef)
}

function generatedSchema(generated: unknown): unknown {
  if (!isObject(generated)) return undefined
  if (typeof generated.nested_object_depth === 'number') {
    let schema: Record<string, unknown> = { type: 'string' }
    for (let index = 0; index < generated.nested_object_depth; index += 1) {
      schema = { type: 'object', properties: { child: schema } }
    }
    return schema
  }
  if (typeof generated.any_of_count === 'number') {
    return { anyOf: Array.from({ length: generated.any_of_count }, () => ({ type: 'string' })) }
  }
  return undefined
}

function validateJsonSchemas(input: Record<string, unknown>): unknown {
  const policy = isObject(input.policy) ? input.policy : {}
  const maxDepth = typeof policy.max_depth === 'number' ? policy.max_depth : 32
  const maxSubschemas = typeof policy.max_subschemas === 'number' ? policy.max_subschemas : 256
  const dialect =
    typeof policy.default_dialect === 'string'
      ? policy.default_dialect
      : 'https://json-schema.org/draft/2020-12/schema'
  const cases = Array.isArray(input.cases) ? input.cases : []
  return {
    results: cases.map((entry) => {
      const item = isObject(entry) ? entry : {}
      const schema = item.schema ?? generatedSchema(item.generated)
      if (hasNetworkRef(schema)) return { valid: false, reason: 'network_ref_forbidden' }
      if (
        isObject(item.generated) &&
        typeof item.generated.nested_object_depth === 'number' &&
        item.generated.nested_object_depth > maxDepth
      ) {
        return { valid: false, reason: 'schema_depth_exceeded', limit: maxDepth }
      }
      if (
        isObject(item.generated) &&
        typeof item.generated.any_of_count === 'number' &&
        item.generated.any_of_count > maxSubschemas
      ) {
        return { valid: false, reason: 'subschema_count_exceeded', limit: maxSubschemas }
      }
      if (schemaDepth(schema) > maxDepth)
        return { valid: false, reason: 'schema_depth_exceeded', limit: maxDepth }
      if (schemaSubschemas(schema) > maxSubschemas)
        return { valid: false, reason: 'subschema_count_exceeded', limit: maxSubschemas }
      return {
        valid: true,
        dialect: isObject(schema) && typeof schema.$schema === 'string' ? schema.$schema : dialect,
      }
    }),
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
    case 'validate_result_response':
      return validateResultResponse(input.value)
    case 'validate_error_response':
      return validateErrorResponse(input.value)
    case 'decode_jsonrpc':
      return decodeJsonRpc(input.utf8)
    case 'validate_message':
      return validateMessages(input)
    case 'dispatch_method':
      return dispatchMethod(input.request)
    case 'validate_json_schema':
      return validateJsonSchemas(input)
    default:
      throw new RangeError(`Unsupported protocol operation: ${input.operation}`)
  }
}
