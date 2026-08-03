function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectHeader(value: string): string | undefined {
  if (/[^\x20-\x7e]/.test(value)) return 'forbidden control character'
  if (value.startsWith('=?base64?')) {
    const match = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value)
    if (match === null) return 'invalid Base64 sentinel'
    const encoded = match[1] ?? ''
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      return 'invalid Base64 sentinel'
    }
  }
  return undefined
}

export function executeFunction(inputValue: unknown): unknown {
  if (!isObject(inputValue) || typeof inputValue.operation !== 'string') {
    throw new TypeError('Security validation operation is required')
  }
  if (inputValue.operation === 'encode_mirrored_header') {
    const values = Array.isArray(inputValue.values) ? inputValue.values : []
    return {
      observations: values.map((value, index) => {
        const reason =
          typeof value === 'string' ? rejectHeader(value) : 'forbidden control character'
        return {
          value_index: index,
          accepted: reason === undefined,
          ...(reason === undefined ? {} : { reason }),
        }
      }),
    }
  }
  if (inputValue.operation === 'validate_json_schema') {
    const limits = isObject(inputValue.limits) ? inputValue.limits : {}
    const builder = isObject(inputValue.schema_builder) ? inputValue.schema_builder : {}
    if (
      typeof builder.depth === 'number' &&
      typeof limits.max_depth === 'number' &&
      builder.depth > limits.max_depth
    ) {
      return {
        valid: false,
        error: { code: -32602, reason: 'Schema depth exceeds limit', limit: limits.max_depth },
      }
    }
    if (
      typeof builder.subschema_count === 'number' &&
      typeof limits.max_subschemas === 'number' &&
      builder.subschema_count > limits.max_subschemas
    ) {
      return {
        valid: false,
        error: {
          code: -32602,
          reason: 'Schema subschema count exceeds limit',
          limit: limits.max_subschemas,
        },
      }
    }
    const schema = isObject(inputValue.schema) ? inputValue.schema : {}
    if (typeof schema.$ref === 'string' && /^https?:\/\//i.test(schema.$ref)) {
      return {
        valid: false,
        network_requests: 0,
        error: { code: -32602, reason: 'Network schema references are forbidden' },
      }
    }
    return { valid: true }
  }
  if (inputValue.operation === 'generate_incident_handle') {
    const source = isObject(inputValue.id_source) ? inputValue.id_source : {}
    const hex = typeof source.fixture_bytes === 'string' ? source.fixture_bytes : ''
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new TypeError('UUID source must contain 16 bytes')
    const version = Number.parseInt(hex[12] ?? '', 16)
    const variantByte = Number.parseInt(hex.slice(16, 18), 16)
    const variant = (variantByte & 0xc0) === 0x80 ? 'RFC4122' : 'unsupported'
    const incidentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    const now = typeof inputValue.clock === 'string' ? Date.parse(inputValue.clock) : Number.NaN
    const ttl = typeof inputValue.ttl_ms === 'number' ? inputValue.ttl_ms : 0
    return {
      incident_id: incidentId,
      version,
      variant,
      entropy_bits: 128 - 4 - 2,
      expires_at: new Date(now + ttl).toISOString().replace('.000Z', 'Z'),
    }
  }
  if (inputValue.operation === 'evaluate_audit_cases') {
    const cases = Array.isArray(inputValue.cases) ? inputValue.cases : []
    return {
      observations: cases.map((value) => {
        const item = isObject(value) ? value : {}
        const findings = Array.isArray(item.findings) ? item.findings : []
        const blocking = findings
          .filter(
            (finding) =>
              isObject(finding) &&
              finding.suppressed !== true &&
              (finding.severity === 'high' || finding.severity === 'critical'),
          )
          .map((finding) =>
            isObject(finding) && typeof finding.advisory === 'string' ? finding.advisory : '',
          )
        return { name: item.name, accepted: blocking.length === 0, blocking_findings: blocking }
      }),
    }
  }
  throw new RangeError(`Unsupported security operation: ${inputValue.operation}`)
}
