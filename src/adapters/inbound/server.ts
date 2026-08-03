import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  IncidentService,
  MemoryEffectStore,
  MemoryIncidentStore,
  type EffectStore,
  type IncidentStore,
} from '../../application/index.js'
import { healthResponse } from './health.js'
import { handleHttp } from './http.js'
import { handleSse } from './sse.js'

const DEFAULT_BODY_LIMIT = 1024 * 1024
const DEFAULT_DEADLINE_MS = 5000
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 25

export type TelemetryRecord = {
  method: string
  name: string
  request_id: string | number
  replica: string
  latency_ms: number
  result_type: 'complete' | 'error'
  trace_id?: string
}

export type ServerOptions = {
  host?: string
  port?: number
  bodyLimitBytes?: number
  deadlineMs?: number
  diagnosticIntervalMs?: number
  effectStore?: EffectStore
  incidentStore?: IncidentStore
  ready?: () => boolean | Promise<boolean>
  telemetry?: (record: TelemetryRecord) => void
  diagnosticCancelled?: () => void
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(', ')
  }
  return headers
}

function send(response: ServerResponse, observation: unknown): void {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) {
    throw new TypeError('HTTP adapter returned an invalid response')
  }
  const value = observation as Record<string, unknown>
  const status = typeof value.status === 'number' ? value.status : 500
  const headers =
    typeof value.headers === 'object' && value.headers !== null && !Array.isArray(value.headers)
      ? (value.headers as Record<string, string>)
      : {}
  response.writeHead(status, headers)
  if (value.body === null || value.body === undefined) response.end()
  else response.end(JSON.stringify(value.body))
}

function sendParseError(response: ServerResponse): void {
  response.writeHead(400, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunkValue of request) {
    const chunk = Buffer.from(chunkValue as Uint8Array)
    bytes += chunk.length
    if (bytes > limit) {
      request.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function sendSse(
  response: ServerResponse,
  observation: unknown,
  signal: AbortSignal,
  intervalMs: number,
): Promise<boolean> {
  const value = observation as { headers?: Record<string, string>; events?: unknown[] }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...value.headers,
  })
  const events = value.events ?? []
  const cancelled = (): boolean => signal.aborted || response.destroyed
  const stopCancelledStream = (): false => {
    if (!response.destroyed) response.destroy()
    return false
  }
  for (const [index, eventValue] of events.entries()) {
    if (cancelled()) return stopCancelledStream()
    if (index > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
      if (cancelled()) return stopCancelledStream()
    }
    const event =
      typeof eventValue === 'object' && eventValue !== null && !Array.isArray(eventValue)
        ? (eventValue as Record<string, unknown>)
        : {}
    if (typeof event.event === 'string') response.write(`event: ${event.event}\n`)
    response.write(`data: ${JSON.stringify(event.data)}\n\n`)
  }
  response.end()
  return true
}

function deadlineResponse(body: unknown, deadlineMs: number): unknown {
  const id =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as { id?: unknown }).id
      : undefined
  return {
    status: 504,
    headers: { 'Content-Type': 'application/json' },
    body: {
      jsonrpc: '2.0',
      ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
      error: {
        code: -31998,
        message: 'Request deadline exceeded',
        data: { deadlineMs },
      },
    },
  }
}

async function withinDeadline(
  work: Promise<unknown>,
  controller: AbortController,
  body: unknown,
  deadlineMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<unknown>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Request deadline exceeded'))
      resolve(deadlineResponse(body, deadlineMs))
    }, deadlineMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function telemetryRecord(
  body: unknown,
  observation: unknown,
  startedAt: number,
): TelemetryRecord | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const requestBody = body as Record<string, unknown>
  if (
    typeof requestBody.method !== 'string' ||
    (typeof requestBody.id !== 'string' && typeof requestBody.id !== 'number')
  )
    return undefined
  const params =
    typeof requestBody.params === 'object' &&
    requestBody.params !== null &&
    !Array.isArray(requestBody.params)
      ? (requestBody.params as Record<string, unknown>)
      : {}
  const candidateName =
    typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : ''
  const name = candidateName.includes('incident://incidents/') ? '[REDACTED]' : candidateName
  const value =
    typeof observation === 'object' && observation !== null && !Array.isArray(observation)
      ? (observation as Record<string, unknown>)
      : {}
  const responseBody =
    typeof value.body === 'object' && value.body !== null && !Array.isArray(value.body)
      ? (value.body as Record<string, unknown>)
      : {}
  const result =
    typeof responseBody.result === 'object' &&
    responseBody.result !== null &&
    !Array.isArray(responseBody.result)
      ? (responseBody.result as Record<string, unknown>)
      : {}
  const meta =
    typeof params._meta === 'object' && params._meta !== null && !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {}
  const traceparent = typeof meta.traceparent === 'string' ? meta.traceparent : ''
  const traceMatch = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent)
  return {
    method: requestBody.method,
    name,
    request_id: requestBody.id,
    replica: 'raw-local-1',
    latency_ms: Math.max(0, Date.now() - startedAt),
    result_type: 'error' in responseBody || result.isError === true ? 'error' : 'complete',
    ...(traceMatch?.[1] === undefined ? {} : { trace_id: traceMatch[1].toLowerCase() }),
  }
}

export function createRawServer(options: ServerOptions = {}): Server {
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const diagnosticIntervalMs = options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS
  const telemetry =
    options.telemetry ??
    ((record: TelemetryRecord) => process.stderr.write(`${JSON.stringify(record)}\n`))
  const effectStore = options.effectStore ?? new MemoryEffectStore()
  const incidentStore = options.incidentStore ?? new MemoryIncidentStore()
  const incidentService = new IncidentService(incidentStore)
  const ready =
    options.ready ??
    (async () => {
      const secretReady =
        process.env.NODE_ENV !== 'production' ||
        (process.env.MCP_REQUEST_STATE_SECRET !== undefined &&
          Buffer.byteLength(process.env.MCP_REQUEST_STATE_SECRET) >= 32)
      const persistenceReady =
        process.env.NODE_ENV !== 'production' ||
        (options.effectStore !== undefined && options.incidentStore !== undefined) ||
        process.env.EFFECT_STORE === 'memory'
      return (
        secretReady &&
        persistenceReady &&
        (await effectStore.ready()) &&
        (await incidentStore.ready())
      )
    })
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path === '/raw/healthz') {
        send(response, healthResponse(await ready()))
        return
      }
      if (path !== '/raw/mcp') {
        send(response, { status: 404, headers: { 'Content-Type': 'application/json' }, body: null })
        return
      }
      const origin = request.headers.origin
      if (
        origin !== undefined &&
        !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
      ) {
        send(response, { status: 403, headers: { 'Content-Type': 'application/json' }, body: null })
        return
      }
      if (request.method !== 'POST') {
        send(response, {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST' },
          body: null,
        })
        return
      }
      const bodyBytes = await readBody(request, bodyLimit)
      if (bodyBytes === undefined) {
        send(
          response,
          await handleHttp(
            { method: request.method, headers: headersOf(request), body: {} },
            null,
            {
              body_bytes: bodyLimit + 1,
              configured_limit_bytes: bodyLimit,
            },
            effectStore,
            incidentService,
          ),
        )
        return
      }
      let body: unknown
      try {
        body = JSON.parse(bodyBytes.toString('utf8')) as unknown
      } catch {
        sendParseError(response)
        return
      }
      const requestValue = { method: request.method, headers: headersOf(request), body }
      const startedAt = Date.now()
      const finish = (observation: unknown): void => {
        const record = telemetryRecord(body, observation, startedAt)
        if (record !== undefined) telemetry(record)
        send(response, observation)
      }
      const acceptsSse = request.headers.accept?.includes('text/event-stream') === true
      const meta =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta
          : undefined
      const controller = new AbortController()
      request.once('aborted', () => {
        controller.abort(new Error('Client disconnected'))
      })
      if (acceptsSse && meta?.progressToken !== undefined) {
        const validation = await withinDeadline(
          handleHttp(
            requestValue,
            null,
            { body_bytes: bodyBytes.length, configured_limit_bytes: bodyLimit },
            effectStore,
            incidentService,
            controller.signal,
          ),
          controller,
          body,
          deadlineMs,
        )
        const validationValue =
          typeof validation === 'object' && validation !== null && !Array.isArray(validation)
            ? (validation as Record<string, unknown>)
            : {}
        const validationBody =
          typeof validationValue.body === 'object' &&
          validationValue.body !== null &&
          !Array.isArray(validationValue.body)
            ? (validationValue.body as Record<string, unknown>)
            : {}
        if (validationValue.status !== 200 || 'error' in validationBody) {
          finish(validation)
          return
        }
        let completed = false
        response.once('close', () => {
          if (!completed) controller.abort(new Error('Client disconnected'))
        })
        const deadlineTimer = setTimeout(() => {
          controller.abort(new Error('Request deadline exceeded'))
        }, deadlineMs)
        try {
          completed = await sendSse(
            response,
            await handleSse(requestValue, null, { final_result: validationBody.result }),
            controller.signal,
            diagnosticIntervalMs,
          )
        } finally {
          clearTimeout(deadlineTimer)
        }
        if (!completed) options.diagnosticCancelled?.()
        else {
          const record = telemetryRecord(body, validation, startedAt)
          if (record !== undefined) telemetry(record)
        }
        return
      }
      const observation = await withinDeadline(
        handleHttp(
          requestValue,
          null,
          {
            body_bytes: bodyBytes.length,
            configured_limit_bytes: bodyLimit,
          },
          effectStore,
          incidentService,
          controller.signal,
        ),
        controller,
        body,
        deadlineMs,
      )
      finish(observation)
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
        }),
      )
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return createServer((request, response) => {
    void handler(request, response)
  })
}

export async function startRawServer(options: ServerOptions = {}): Promise<Server> {
  const server = createRawServer(options)
  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.PORT ?? 3101)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}
