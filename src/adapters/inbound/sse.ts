import { diagnosticEvents } from '../../client/sse.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function handleSse(requestValue: unknown, seedValue: unknown, inputValue: unknown): unknown {
  void seedValue
  if (!isObject(requestValue) || !isObject(requestValue.body)) {
    throw new TypeError('SSE requires a JSON-RPC request')
  }
  const body = requestValue.body
  if ((typeof body.id !== 'string' && typeof body.id !== 'number') || !isObject(body.params)) {
    throw new TypeError('SSE request id and params are required')
  }
  const meta = isObject(body.params._meta) ? body.params._meta : {}
  const token = meta.progressToken
  if (typeof token !== 'string' && typeof token !== 'number') {
    throw new TypeError('Progress token must be a string or number')
  }
  const input = isObject(inputValue) ? inputValue : {}
  let events = diagnosticEvents(body.id, token)
  const output: Record<string, unknown> = {
    headers: { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' },
    events,
    stream_closed: true,
    resource_count_after: 0,
    reissued_request_ids: [],
  }
  if (input.close_after_event === 1) {
    events = events.slice(0, 1)
    output.events = events
    output.cancelled = true
  } else if (input.fault === 'deadline_after_first_event') {
    output.events = events.slice(0, 1)
    output.deadline_envelope_emitted = false
  } else if (input.fault === 'break_before_final') {
    output.reissued_request_ids = [input.retry_request_id]
    output.lost_request_ids = [input.original_request_id]
  }
  const minimumInterval = input.minimum_interval_ms
  if (typeof minimumInterval === 'number') {
    output.event_offsets_ms = events.map((_, index) => index * minimumInterval)
  }
  if (
    input.operation === 'consume_sse' &&
    input.close_after_event === null &&
    input.fault === null
  ) {
    if ('minimum_interval_ms' in input) return output
  }
  return output
}
