import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MemoryEffectStore, type EffectStore } from '../../application/index.js'
import { healthResponse } from './health.js'
import { handleHttp } from './http.js'
import { handleSse } from './sse.js'

const DEFAULT_BODY_LIMIT = 1024 * 1024

export type ServerOptions = {
  host?: string
  port?: number
  bodyLimitBytes?: number
  effectStore?: EffectStore
  ready?: () => boolean | Promise<boolean>
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

function sendSse(response: ServerResponse, observation: unknown): void {
  const value = observation as { headers?: Record<string, string>; events?: unknown[] }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...value.headers,
  })
  for (const eventValue of value.events ?? []) {
    const event =
      typeof eventValue === 'object' && eventValue !== null && !Array.isArray(eventValue)
        ? (eventValue as Record<string, unknown>)
        : {}
    if (typeof event.event === 'string') response.write(`event: ${event.event}\n`)
    response.write(`data: ${JSON.stringify(event.data)}\n\n`)
  }
  response.end()
}

export function createRawServer(options: ServerOptions = {}): Server {
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT
  const effectStore = options.effectStore ?? new MemoryEffectStore()
  const ready =
    options.ready ??
    (async () => {
      const secretReady =
        process.env.NODE_ENV !== 'production' ||
        (process.env.MCP_REQUEST_STATE_SECRET !== undefined &&
          Buffer.byteLength(process.env.MCP_REQUEST_STATE_SECRET) >= 32)
      const persistenceReady =
        process.env.NODE_ENV !== 'production' ||
        options.effectStore !== undefined ||
        process.env.EFFECT_STORE === 'memory'
      return secretReady && persistenceReady && (await effectStore.ready())
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
      const acceptsSse = request.headers.accept?.includes('text/event-stream') === true
      const meta =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta
          : undefined
      if (acceptsSse && meta?.progressToken !== undefined) {
        const validation = await handleHttp(
          requestValue,
          null,
          { body_bytes: bodyBytes.length, configured_limit_bytes: bodyLimit },
          effectStore,
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
          send(response, validation)
          return
        }
        sendSse(response, await handleSse(requestValue, null, {}))
        return
      }
      send(
        response,
        await handleHttp(
          requestValue,
          null,
          {
            body_bytes: bodyBytes.length,
            configured_limit_bytes: bodyLimit,
          },
          effectStore,
        ),
      )
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
