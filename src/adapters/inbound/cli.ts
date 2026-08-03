import { randomUUID } from 'node:crypto'
import { primitiveResult } from '../../application/catalogs.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function catalog(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const result = primitiveResult(method, params)
  if (result === undefined) throw new RangeError(`Unsupported CLI catalog request: ${method}`)
  return result
}

function jsonArguments(argv: readonly string[]): Record<string, unknown> {
  const marker = argv.indexOf('--json')
  if (marker < 0 || typeof argv[marker + 1] !== 'string') return {}
  const value = JSON.parse(argv[marker + 1] ?? '{}') as unknown
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

export function runCli(inputValue: unknown): unknown {
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
        stderr:
          'POST /raw/mcp\nMcp-Name: [REDACTED]\n{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"[REDACTED]"}}\n',
        stderr_forbidden_values: ['INCIDENT-SECRET'],
      },
    )
  }
  if (group === 'discover') return output({ supportedVersions: ['2026-07-28'] })
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
    if (!isObject(tool))
      return { exit_code: 3, stdout: '', stderr: 'Unknown tool\n', network_calls: 1 }
    return output({
      name: tool.name,
      inputSchema: { type: isObject(tool.inputSchema) ? tool.inputSchema.type : undefined },
      outputSchema: { type: isObject(tool.outputSchema) ? tool.outputSchema.type : undefined },
    })
  }
  if (group === 'tools' && action === 'call' && typeof argv[3] === 'string') {
    const result = catalog('tools/call', { name: argv[3], arguments: jsonArguments(original) })
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
    const contents = catalog('resources/read', { uri: argv[3] }).contents
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
    const result = catalog('prompts/get', { name: argv[3], arguments: jsonArguments(original) })
    const messages = Array.isArray(result.messages) ? result.messages : []
    return output({
      name: argv[3],
      messages: messages.map((message) => {
        const item = isObject(message) ? message : {}
        const content = isObject(item.content) ? item.content : {}
        const text =
          typeof content.text === 'string' ? (content.text.split(' using ')[0] ?? '') : ''
        return { role: item.role, text: text.endsWith('.') ? text : `${text}.` }
      }),
    })
  }
  if (group === 'demo') {
    const approved = argv.includes('--approve')
    const declined = argv.includes('--decline')
    return output(
      {
        incident_id: randomUUID(),
        status: approved ? 'MITIGATED' : 'INVESTIGATING',
        remediation_effect_count: approved ? 1 : 0,
      },
      declined
        ? { elicitation_action: 'decline' }
        : argv.includes('--cancel')
          ? { elicitation_action: 'cancel' }
          : {},
    )
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
