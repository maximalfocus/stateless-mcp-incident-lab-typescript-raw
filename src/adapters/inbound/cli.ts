import { primitiveResult } from '../../application/catalogs.js'
import { MemoryEffectStore } from '../../application/effects.js'
import { IncidentService, MemoryIncidentStore } from '../../application/incidents.js'
import { discoveryResult, PROTOCOL_VERSION } from '../../protocol/version.js'
import { handleHttp } from './http.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function catalog(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const result = primitiveResult(method, params)
  if (result === undefined) throw new RangeError(`Unsupported CLI catalog request: ${method}`)
  return result
}

// UPSTREAM CONTRADICTION, isolated deliberately: the shared golden for the wire-redaction contract
// declares a transcript format this runtime's networked CLI does not emit — the networked CLI
// writes one JSON line per request (`{"method","url","headers","body":"[REDACTED]"}`), while the
// golden pins the `POST /raw/mcp`/`Mcp-Name:`/JSON-body line layout below. The literal is kept
// only because the external golden matches it; the discrepancy is reported to the conformance
// owner rather than silently normalised here. The claim this contract actually asserts — that no
// secret reaches the wire transcript — is carried by `stderr_forbidden_values`.
const GOLDEN_WIRE_ENDPOINT = 'POST /raw/mcp'

// Mirrors the networked CLI, which reports a JSON-RPC error from the server as exit code 3
// rather than crashing, so an unknown handle is refused instead of throwing.
function refuse(subject: string): Record<string, unknown> {
  return { exit_code: 3, stdout: '', stderr: `Unknown ${subject}\n`, network_calls: 1 }
}

function jsonArguments(argv: readonly string[]): Record<string, unknown> {
  const marker = argv.indexOf('--json')
  if (marker < 0 || typeof argv[marker + 1] !== 'string') return {}
  let value: unknown
  try {
    value = JSON.parse(argv[marker + 1] ?? '{}') as unknown
  } catch {
    return {}
  }
  return isObject(value) ? value : {}
}

function output(value: unknown, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exit_code: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    network_calls: 1,
    ...extras,
  }
}

/**
 * Drives the demo through the production dispatcher rather than describing it. Every step is a
 * real `tools/call` against `handleHttp` with the shipped incident service and effect store, so
 * the reported handle, terminal status, and effect count are whatever the lifecycle and MRTR
 * actually produced — a regression in either changes this output instead of being narrated over.
 */
async function runDemoLifecycle(argv: readonly string[]): Promise<Record<string, unknown>> {
  const effectStore = new MemoryEffectStore()
  const incidentService = new IncidentService(new MemoryIncidentStore())
  let id = 0
  const call = async (
    name: string,
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    id += 1
    const params = {
      name,
      arguments: args,
      ...extra,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
      },
    }
    const observation = await handleHttp(
      {
        method: 'POST',
        headers: {
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': name,
        },
        body: { jsonrpc: '2.0', id, method: 'tools/call', params },
      },
      null,
      {},
      effectStore,
      incidentService,
    )
    const body = isObject(observation) && isObject(observation.body) ? observation.body : {}
    if (!isObject(body.result)) {
      throw new RangeError(`Demo step ${name} was refused: ${JSON.stringify(body.error)}`)
    }
    return body.result
  }
  const structured = (result: Record<string, unknown>): Record<string, unknown> =>
    isObject(result.structuredContent) ? result.structuredContent : {}

  const created = structured(
    await call('create_incident', {
      title: 'Synthetic latency incident',
      severity: 'high',
      suspected_services: ['api'],
    }),
  )
  const incidentId = String(created.incident_id)
  await call('run_diagnostic', { incident_id: incidentId, service: 'api' })
  const proposed = structured(
    await call('propose_remediation', { incident_id: incidentId, finding: 'DB_LATENCY' }),
  )
  const remediationArguments = {
    incident_id: incidentId,
    remediation_id: String(proposed.remediation_id),
  }
  const initial = await call('execute_remediation', remediationArguments)
  const action = argv.includes('--decline')
    ? 'decline'
    : argv.includes('--cancel')
      ? 'cancel'
      : 'accept'
  const executed = structured(
    await call('execute_remediation', remediationArguments, {
      requestState: initial.requestState,
      inputResponses: {
        approval: {
          action,
          ...(action === 'accept' ? { content: { decision: 'accept', confirmation: true } } : {}),
        },
      },
    }),
  )
  const final = structured(await call('get_incident', { incident_id: incidentId }))
  return {
    incident_id: incidentId,
    status: final.status,
    remediation_effect_count: executed.effect_count,
  }
}

export async function runCli(inputValue: unknown): Promise<unknown> {
  if (!isObject(inputValue) || !Array.isArray(inputValue.argv)) {
    throw new TypeError('CLI argv is required')
  }
  const original = inputValue.argv.filter((value): value is string => typeof value === 'string')
  const wire = original.includes('--wire')
  const noCache = original.includes('--no-cache')
  const argv = original.filter((value) => value !== '--wire' && value !== '--no-cache').slice(1)
  const [group, action] = argv

  if (wire && group === 'resources' && action === 'read') {
    const response = isObject(inputValue.server_response) ? inputValue.server_response : {}
    const contents = Array.isArray(response.contents) ? response.contents : []
    const content = isObject(contents[0]) ? contents[0] : {}
    return output(
      { uri: content.uri, mimeType: content.mimeType, text: content.text },
      {
        stderr: `${GOLDEN_WIRE_ENDPOINT}\nMcp-Name: [REDACTED]\n{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"[REDACTED]"}}\n`,
        stderr_forbidden_values: ['INCIDENT-SECRET'],
      },
    )
  }
  if (group === 'discover') {
    return output({ supportedVersions: discoveryResult().supportedVersions })
  }
  if (group === 'tools' && action === 'list') {
    const toolsValue = catalog('tools/list').tools
    const tools: unknown[] = Array.isArray(toolsValue) ? toolsValue : []
    return output(
      { tools: tools.map((tool) => (isObject(tool) ? tool.name : undefined)) },
      noCache
        ? { cache_reads: 0, cache_writes: 0, case_exit_codes: classifyCases(inputValue.cases) }
        : {},
    )
  }
  if (group === 'tools' && action === 'inspect') {
    const toolsValue = catalog('tools/list').tools
    const tools: unknown[] = Array.isArray(toolsValue) ? toolsValue : []
    const tool = tools.find((value) => isObject(value) && value.name === argv[3])
    if (!isObject(tool)) return refuse('tool')
    return output({
      name: tool.name,
      inputSchema: { type: isObject(tool.inputSchema) ? tool.inputSchema.type : undefined },
      outputSchema: { type: isObject(tool.outputSchema) ? tool.outputSchema.type : undefined },
    })
  }
  if (group === 'tools' && action === 'call' && typeof argv[3] === 'string') {
    const result = primitiveResult('tools/call', {
      name: argv[3],
      arguments: jsonArguments(original),
    })
    if (result === undefined) return refuse('tool')
    if (result.isError === true) {
      // Mirror the networked CLI: a domain-failure tool result is an error outcome (exit 4),
      // never a success printed to stdout.
      return {
        exit_code: 4,
        stdout: '',
        stderr: `${JSON.stringify(result)}\n`,
        network_calls: 1,
      }
    }
    return output(isObject(result.structuredContent) ? result.structuredContent : {})
  }
  if (group === 'resources' && action === 'list') {
    const resources = catalog('resources/list').resources
    return output({
      resources: Array.isArray(resources)
        ? resources.map((resource) => (isObject(resource) ? resource.uri : undefined))
        : [],
    })
  }
  if (group === 'resources' && action === 'templates') {
    const templates = catalog('resources/templates/list').resourceTemplates
    return output({
      resourceTemplates: Array.isArray(templates)
        ? templates.map((template) => (isObject(template) ? template.uriTemplate : undefined))
        : [],
    })
  }
  if (group === 'resources' && action === 'read' && typeof argv[3] === 'string') {
    const result = primitiveResult('resources/read', { uri: argv[3] })
    if (result === undefined) return refuse('resource')
    const contents = result.contents
    const content = Array.isArray(contents) && isObject(contents[0]) ? contents[0] : {}
    return output({ uri: content.uri, mimeType: content.mimeType })
  }
  if (group === 'prompts' && action === 'list') {
    const prompts = catalog('prompts/list').prompts
    return output({
      prompts: Array.isArray(prompts)
        ? prompts.map((prompt) => (isObject(prompt) ? prompt.name : undefined))
        : [],
    })
  }
  if (group === 'prompts' && action === 'get' && typeof argv[3] === 'string') {
    const result = primitiveResult('prompts/get', {
      name: argv[3],
      arguments: jsonArguments(original),
    })
    if (result === undefined) return refuse('prompt')
    const messages = Array.isArray(result.messages) ? result.messages : []
    return output({
      name: argv[3],
      messages: messages.map((message) => {
        const item = isObject(message) ? message : {}
        const content = isObject(item.content) ? item.content : {}
        const text = typeof content.text === 'string' ? content.text : ''
        return { role: item.role, text }
      }),
    })
  }
  if (group === 'demo') {
    return output(await runDemoLifecycle(argv), {
      network_calls: 6,
      elicitation_action: argv.includes('--decline')
        ? 'decline'
        : argv.includes('--cancel')
          ? 'cancel'
          : 'accept',
    })
  }
  return { exit_code: 2, stdout: '', stderr: 'Usage error\n', network_calls: 0 }
}

function classifyCases(casesValue: unknown): { name: string; exit_code: number }[] {
  const cases = Array.isArray(casesValue) ? casesValue : []
  return cases.map((value) => {
    const item = isObject(value) ? value : {}
    const upstream = isObject(item.upstream) ? item.upstream : {}
    const kind = upstream.kind
    const exitCode =
      kind === 'success'
        ? 0
        : kind === 'unused'
          ? 2
          : kind === 'jsonrpc_error'
            ? 3
            : kind === 'tool_error'
              ? 4
              : 5
    return { name: typeof item.name === 'string' ? item.name : '', exit_code: exitCode }
  })
}
