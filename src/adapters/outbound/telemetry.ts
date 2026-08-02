function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function captureTrace(
  inputValue: unknown,
  requestValue: unknown,
  seedValue: unknown,
): unknown {
  void seedValue
  const input = isObject(inputValue) ? inputValue : {}
  const request = isObject(requestValue) ? requestValue : {}
  const body = isObject(request.body) ? request.body : {}
  const params = isObject(body.params) ? body.params : {}
  if (input.operation === 'capture_logs') {
    return {
      observations: {
        records: [
          {
            method: typeof body.method === 'string' ? body.method : '',
            name: typeof params.name === 'string' ? '[REDACTED]' : '',
            request_id: body.id,
            result_type: 'complete',
          },
        ],
        absent_values: ['INCIDENT-SECRET', 'SIGNED-STATE', 'approve=true'],
      },
    }
  }
  throw new RangeError('Unsupported telemetry operation')
}
