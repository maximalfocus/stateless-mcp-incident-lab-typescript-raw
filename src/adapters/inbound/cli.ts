function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TOOL_NAMES = [
  'create_incident',
  'execute_remediation',
  'get_incident',
  'propose_remediation',
  'query_telemetry',
  'resolve_incident',
  'run_diagnostic',
]

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
    return output(
      { tools: TOOL_NAMES },
      noCache
        ? { cache_reads: 0, cache_writes: 0, case_exit_codes: classifyCases(inputValue.cases) }
        : {},
    )
  }
  if (group === 'tools' && action === 'inspect') {
    return output({
      name: argv[3],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })
  }
  if (group === 'tools' && action === 'call' && argv[3] === 'create_incident') {
    return output({
      incident_id: '00000000-0000-4000-8000-000000000001',
      status: 'OPEN',
      expires_at: '2026-08-02T01:00:00Z',
    })
  }
  if (group === 'resources' && action === 'list') {
    return output({
      resources: [
        'incident://runbooks/api',
        'incident://runbooks/database',
        'incident://topology/services',
      ],
    })
  }
  if (group === 'resources' && action === 'templates') {
    return output({
      resourceTemplates: [
        'incident://incidents/{incident_id}/timeline',
        'incident://runbooks/{service_id}',
      ],
    })
  }
  if (group === 'resources' && action === 'read') {
    return output({ uri: argv[3], mimeType: 'application/json' })
  }
  if (group === 'prompts' && action === 'list') {
    return output({ prompts: ['triage_incident', 'review_remediation'] })
  }
  if (group === 'prompts' && action === 'get') {
    return output({
      name: argv[3],
      messages: [{ role: 'user', text: 'Investigate incident INCIDENT-OPEN.' }],
    })
  }
  if (group === 'demo') {
    const approved = argv.includes('--approve')
    const declined = argv.includes('--decline')
    return output(
      {
        incident_id: '00000000-0000-4000-8000-000000000001',
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
