import { encodeHeaderValue } from '../protocol/headers.js'
import { PROTOCOL_VERSION } from '../protocol/version.js'

type JsonRpcResponse = { result?: unknown; error?: unknown }

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

export async function rpcCall(
  url: string,
  method: string,
  paramsValue: unknown = {},
  id: string | number = 1,
): Promise<JsonRpcResponse> {
  const params: Record<string, unknown> = { ...object(paramsValue), _meta: metadata() }
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
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const body = (await response.json()) as JsonRpcResponse
  if (!response.ok && body.error === undefined) throw new Error(`HTTP ${String(response.status)}`)
  return body
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
  const filtered = argv.filter((value) => value !== '--wire' && value !== '--no-cache')
  const [group, action, url, name, rawArguments] = filtered
  if (group === undefined || action === undefined) return 2
  try {
    let response: JsonRpcResponse
    if (group === 'demo') {
      const mode = url
      if (!['--approve', '--decline', '--cancel'].includes(mode ?? '')) return 2
      const created = await rpcCall(action, 'tools/call', {
        name: 'create_incident',
        arguments: {
          title: 'Synthetic latency incident',
          severity: 'high',
          suspected_services: ['api'],
        },
      })
      const incidentId = String(object(object(created.result).structuredContent).incident_id)
      const proposed = await rpcCall(action, 'tools/call', {
        name: 'propose_remediation',
        arguments: { incident_id: incidentId, finding: 'DB_LATENCY' },
      })
      const remediationId = String(object(object(proposed.result).structuredContent).remediation_id)
      const initial = await rpcCall(action, 'tools/call', {
        name: 'execute_remediation',
        arguments: { incident_id: incidentId, remediation_id: remediationId },
      })
      const requestState = object(initial.result).requestState
      response = await rpcCall(action, 'tools/call', {
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
    } else if (group === 'discover') response = await rpcCall(action, 'server/discover')
    else if (url === undefined) return 2
    else if (group === 'tools' && action === 'list') response = await rpcCall(url, 'tools/list')
    else if (group === 'tools' && action === 'inspect') {
      response = await rpcCall(url, 'tools/list')
      const toolsValue = object(response.result).tools
      const tools: unknown[] = Array.isArray(toolsValue) ? toolsValue : []
      write(tools.find((tool) => object(tool).name === name) ?? null)
      return 0
    } else if (group === 'tools' && action === 'call' && name !== undefined) {
      response = await rpcCall(url, 'tools/call', { name, arguments: parseObject(rawArguments) })
    } else if (group === 'resources' && action === 'list') {
      response = await rpcCall(url, 'resources/list')
    } else if (group === 'resources' && action === 'templates') {
      response = await rpcCall(url, 'resources/templates/list')
    } else if (group === 'resources' && action === 'read' && name !== undefined) {
      response = await rpcCall(url, 'resources/read', { uri: name })
    } else if (group === 'prompts' && action === 'list') {
      response = await rpcCall(url, 'prompts/list')
    } else if (group === 'prompts' && action === 'get' && name !== undefined) {
      response = await rpcCall(url, 'prompts/get', { name, arguments: parseObject(rawArguments) })
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
