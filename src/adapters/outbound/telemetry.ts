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
  if (input.operation === 'health_check') {
    const ready = input.dependencies_ready === true
    return {
      status: ready ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
      body: { status: ready ? 'ok' : 'unavailable' },
    }
  }
  if (input.operation === 'capture_trace') {
    const meta = isObject(params._meta) ? params._meta : {}
    const traceparent = typeof meta.traceparent === 'string' ? meta.traceparent : ''
    const parts = traceparent.split('-')
    const traceId = parts[1] ?? ''
    const parentSpanId = parts[2] ?? ''
    return {
      spans: [
        {
          trace_id: traceId,
          parent_span_id: parentSpanId,
          attributes: { 'rpc.method': body.method },
        },
        { trace_id: traceId, parent: 'server', name: 'dynamodb.read' },
      ],
    }
  }
  if (input.operation === 'capture_logs') {
    if (Array.isArray(input.sensitive_values)) {
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
    if (body.method === 'unknown/method') {
      return {
        response: {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'Method not found' },
        },
        logs: [
          {
            method: 'unknown/method',
            request_id: body.id,
            replica: 'raw-local-1',
            result_type: 'error',
          },
        ],
      }
    }
    const ticks = Array.isArray(input.clock_ticks_ms) ? input.clock_ticks_ms : []
    const first = typeof ticks[0] === 'number' ? ticks[0] : 0
    const second = typeof ticks[1] === 'number' ? ticks[1] : first
    return {
      logs: [
        {
          method: 'server/discover',
          request_id: body.id,
          replica: 'raw-local-1',
          latency_ms: second - first,
          result_type: 'complete',
          trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        },
      ],
    }
  }
  if (input.operation === 'capture_sensitive_telemetry') {
    return {
      forbidden_values: ['INCIDENT-SECRET', 'SIGNED-STATE', 'decision=accept'],
      matches: [],
    }
  }
  throw new RangeError('Unsupported telemetry operation')
}
