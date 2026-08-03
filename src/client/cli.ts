import { cacheHints, cacheKey, ResponseCache } from './cache.js'
import { encodeHeaderValue } from '../protocol/headers.js'
import { PROTOCOL_VERSION } from '../protocol/version.js'

type JsonRpcResponse = { result?: unknown; error?: unknown }
type RpcOptions = {
  noCache?: boolean
  wire?: boolean
  warning?: (message: string) => void
  stale?: { seen: boolean }
}

const responseCache = new ResponseCache<JsonRpcResponse>()

export function clearResponseCache(): void {
  responseCache.clear()
}

function metadata(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'incident-mcp-raw-cli', version: '0.1.0' },
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finalSseResponse(
  payload: string,
  requestId: string | number,
): JsonRpcResponse | undefined {
  for (const block of payload.split(/\r?\n\r?\n/).reverse()) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data.length === 0) continue
    try {
      const parsed = JSON.parse(data) as unknown
      if (
        object(parsed).jsonrpc === '2.0' &&
        Object.is(object(parsed).id, requestId) &&
        ('result' in object(parsed) || 'error' in object(parsed))
      ) {
        return parsed as JsonRpcResponse
      }
    } catch {
      // An incomplete final event is a broken stream and is retried below.
    }
  }
  return undefined
}

function reissuedId(id: string | number): string | number {
  return typeof id === 'number' ? id + 1 : `${id}-retry`
}

export async function rpcCall(
  url: string,
  method: string,
  paramsValue: unknown = {},
  id: string | number = 1,
  options: RpcOptions = {},
): Promise<JsonRpcResponse> {
  const sourceParams = object(paramsValue)
  const key = `${url}|${cacheKey(method, sourceParams)}`
  if (options.noCache !== true) {
    const cached = responseCache.get(key)
    if (cached !== undefined) return cached
  }
  const params: Record<string, unknown> = {
    ...sourceParams,
    _meta: { ...object(sourceParams._meta), ...metadata() },
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    'Mcp-Method': method,
  }
  if (['tools/call', 'prompts/get'].includes(method) && typeof params.name === 'string') {
    headers['Mcp-Name'] = encodeHeaderValue(params.name)
  }
  if (method === 'resources/read' && typeof params.uri === 'string') {
    headers['Mcp-Name'] = encodeHeaderValue(params.uri)
  }
  const argumentsValue = object(params.arguments)
  if (
    method === 'tools/call' &&
    params.name === 'query_telemetry' &&
    typeof argumentsValue.service === 'string'
  ) {
    headers['Mcp-Param-Service'] = encodeHeaderValue(argumentsValue.service)
  }
  if (options.wire === true) {
    process.stderr.write(
      `${JSON.stringify({ method, url, headers: Object.keys(headers).sort(), body: '[REDACTED]' })}\n`,
    )
  }
  try {
    const perform = async (
      requestId: string | number,
      reissuesRemaining: number,
    ): Promise<JsonRpcResponse> => {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      })
      const contentType = response.headers.get('content-type') ?? ''
      let body: JsonRpcResponse
      if (contentType.toLowerCase().startsWith('text/event-stream')) {
        let payload: string
        try {
          payload = await response.text()
        } catch (error) {
          if (reissuesRemaining === 0) throw error
          return await perform(reissuedId(requestId), reissuesRemaining - 1)
        }
        const final = finalSseResponse(payload, requestId)
        if (final === undefined) {
          if (reissuesRemaining === 0) throw new Error('SSE stream ended before a final response')
          return await perform(reissuedId(requestId), reissuesRemaining - 1)
        }
        body = final
      } else {
        body = (await response.json()) as JsonRpcResponse
      }
      if (!response.ok && body.error === undefined) {
        throw new Error(`HTTP ${String(response.status)}`)
      }
      return body
    }
    const body = await perform(id, 1)
    const hints = cacheHints(body.result)
    if (options.noCache !== true && hints !== undefined) responseCache.set(key, body, hints.ttlMs)
    return body
  } catch (error) {
    if (options.noCache !== true) {
      const stale = responseCache.get(key, true)
      if (stale !== undefined) {
        if (options.stale !== undefined) options.stale.seen = true
        options.warning?.('Refresh failed; serving stale cached data.')
        return stale
      }
    }
    throw error
  }
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {}
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function write(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

export async function runNetworkCli(argv: readonly string[]): Promise<number> {
  const options: RpcOptions = {
    noCache: argv.includes('--no-cache'),
    wire: argv.includes('--wire'),
    warning: (message) => process.stderr.write(`${message}\n`),
  }
  const call = async (
    url: string,
    method: string,
    params: unknown = {},
    id: string | number = 1,
  ): Promise<JsonRpcResponse> => await rpcCall(url, method, params, id, options)
  const list = async (url: string, method: string): Promise<JsonRpcResponse> => {
    const fieldByMethod: Readonly<Record<string, string>> = {
      'tools/list': 'tools',
      'resources/list': 'resources',
      'resources/templates/list': 'resourceTemplates',
      'prompts/list': 'prompts',
    }
    const field = fieldByMethod[method]
    if (field === undefined) throw new TypeError(`Unsupported list method ${method}`)
    const silentOptions = { ...options }
    delete silentOptions.warning
    for (let attempt = 0; ; attempt += 1) {
      const items: unknown[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      let pageNumber = 0
      let aggregate: Record<string, unknown> | undefined
      let cacheScope: string | undefined
      let minimumTtl = Number.POSITIVE_INFINITY
      const stale = { seen: false }
      do {
        const response = await rpcCall(
          url,
          method,
          cursor === undefined ? {} : { cursor },
          pageNumber + 1,
          attempt === 0 ? { ...silentOptions, stale } : { ...options, noCache: true },
        )
        if (stale.seen) break
        if (response.error !== undefined) return response
        const page = object(response.result)
        if (!Array.isArray(page[field]) || page.resultType !== 'complete') {
          throw new TypeError(`Malformed ${method} page`)
        }
        const hints = cacheHints(page)
        if (hints === undefined || (cacheScope !== undefined && hints.cacheScope !== cacheScope)) {
          throw new TypeError(`Inconsistent ${method} cache hints`)
        }
        cacheScope = hints.cacheScope
        minimumTtl = Math.min(minimumTtl, hints.ttlMs)
        items.push(...(page[field] as unknown[]))
        aggregate ??= page
        const next = page.nextCursor
        if (next === undefined) cursor = undefined
        else if (typeof next !== 'string' || seenCursors.has(next)) {
          throw new TypeError(`Invalid ${method} nextCursor`)
        } else {
          seenCursors.add(next)
          cursor = next
        }
        pageNumber += 1
      } while (cursor !== undefined)
      if (stale.seen) continue
      return {
        result: {
          ...aggregate,
          [field]: items,
          ttlMs: minimumTtl,
          cacheScope,
          nextCursor: undefined,
        },
      }
    }
  }
  const filtered = argv.filter((value) => value !== '--wire' && value !== '--no-cache')
  const [group, action, url, name, rawArguments] = filtered
  if (group === undefined || action === undefined) return 2
  try {
    let response: JsonRpcResponse
    if (group === 'demo') {
      const mode = url
      if (!['--approve', '--decline', '--cancel'].includes(mode ?? '')) return 2
      const created = await call(action, 'tools/call', {
        name: 'create_incident',
        arguments: {
          title: 'Synthetic latency incident',
          severity: 'high',
          suspected_services: ['api'],
        },
      })
      const incidentId = String(object(object(created.result).structuredContent).incident_id)
      await call(action, 'tools/call', {
        name: 'run_diagnostic',
        arguments: { incident_id: incidentId, service: 'api' },
      })
      const proposed = await call(action, 'tools/call', {
        name: 'propose_remediation',
        arguments: { incident_id: incidentId, finding: 'DB_LATENCY' },
      })
      const remediationId = String(object(object(proposed.result).structuredContent).remediation_id)
      const initial = await call(action, 'tools/call', {
        name: 'execute_remediation',
        arguments: { incident_id: incidentId, remediation_id: remediationId },
      })
      const requestState = object(initial.result).requestState
      response = await call(action, 'tools/call', {
        name: 'execute_remediation',
        arguments: { incident_id: incidentId, remediation_id: remediationId },
        requestState,
        inputResponses: {
          approval: {
            action: mode === '--approve' ? 'accept' : mode === '--decline' ? 'decline' : 'cancel',
            ...(mode === '--approve' ? { content: { confirmation: true } } : {}),
          },
        },
      })
    } else if (group === 'discover') response = await call(action, 'server/discover')
    else if (url === undefined) return 2
    else if (group === 'tools' && action === 'list') response = await list(url, 'tools/list')
    else if (group === 'tools' && action === 'inspect') {
      response = await list(url, 'tools/list')
      const toolsValue = object(response.result).tools
      const tools: unknown[] = Array.isArray(toolsValue) ? toolsValue : []
      write(tools.find((tool) => object(tool).name === name) ?? null)
      return 0
    } else if (group === 'tools' && action === 'call' && name !== undefined) {
      response = await call(url, 'tools/call', { name, arguments: parseObject(rawArguments) })
    } else if (group === 'resources' && action === 'list') {
      response = await list(url, 'resources/list')
    } else if (group === 'resources' && action === 'templates') {
      response = await list(url, 'resources/templates/list')
    } else if (group === 'resources' && action === 'read' && name !== undefined) {
      response = await call(url, 'resources/read', { uri: name })
    } else if (group === 'prompts' && action === 'list') {
      response = await list(url, 'prompts/list')
    } else if (group === 'prompts' && action === 'get' && name !== undefined) {
      response = await call(url, 'prompts/get', { name, arguments: parseObject(rawArguments) })
    } else {
      process.stderr.write('Usage: incident-mcp discover <url> | <group> <action> <url> [...]\n')
      return 2
    }
    if (response.error !== undefined) {
      write(response.error, process.stderr)
      return 3
    }
    write(response.result)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 5
  }
}
