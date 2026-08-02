const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

type JsonObject = Record<string, unknown>

function objectSchema(properties: JsonObject, required: string[]): JsonObject {
  return { $schema: SCHEMA, type: 'object', properties, required, additionalProperties: false }
}

const incidentId = { type: 'string' }
const service = { type: 'string', minLength: 1 }
const remediationId = { type: 'string' }

export const TOOLS: JsonObject[] = [
  {
    name: 'create_incident',
    description: 'Create a synthetic incident and return its opaque handle.',
    inputSchema: objectSchema(
      {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        suspected_services: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
      ['title', 'severity', 'suspected_services'],
    ),
    outputSchema: objectSchema(
      {
        incident_id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['OPEN'] },
        expires_at: { type: 'string', format: 'date-time' },
      },
      ['incident_id', 'status', 'expires_at'],
    ),
  },
  {
    name: 'execute_remediation',
    description: 'Elicit approval and execute one simulated remediation at most once.',
    inputSchema: objectSchema({ incident_id: incidentId, remediation_id: remediationId }, [
      'incident_id',
      'remediation_id',
    ]),
    outputSchema: objectSchema(
      {
        remediation_id: remediationId,
        status: { type: 'string', enum: ['EXECUTED', 'DECLINED', 'CANCELLED'] },
        effect_count: { type: 'integer', minimum: 0, maximum: 1 },
      },
      ['remediation_id', 'status', 'effect_count'],
    ),
  },
  {
    name: 'get_incident',
    description: 'Read the current synthetic incident lifecycle state.',
    inputSchema: objectSchema({ incident_id: incidentId }, ['incident_id']),
    outputSchema: objectSchema(
      {
        incident_id: incidentId,
        status: { type: 'string', enum: ['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED'] },
        related_handles: { type: 'array', items: { type: 'string' } },
      },
      ['incident_id', 'status', 'related_handles'],
    ),
  },
  {
    name: 'propose_remediation',
    description: 'Create a safe simulated remediation proposal from a finding.',
    inputSchema: objectSchema(
      { incident_id: incidentId, finding: { type: 'string', minLength: 1 } },
      ['incident_id', 'finding'],
    ),
    outputSchema: objectSchema(
      {
        remediation_id: remediationId,
        action: { type: 'string' },
        target: { type: 'string' },
        status: { type: 'string', enum: ['PROPOSED'] },
        effect: { type: 'string', enum: ['simulated'] },
      },
      ['remediation_id', 'action', 'target', 'status', 'effect'],
    ),
  },
  {
    name: 'query_telemetry',
    description: 'Query deterministic synthetic telemetry for one incident and service.',
    inputSchema: objectSchema(
      {
        incident_id: incidentId,
        service: { ...service, 'x-mcp-header': 'Service' },
        signal: { type: 'string' },
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
      },
      ['incident_id', 'service', 'signal', 'start', 'end'],
    ),
    outputSchema: objectSchema(
      {
        events: {
          type: 'array',
          items: objectSchema(
            {
              service_id: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
              signal: { type: 'string' },
              severity: { type: 'string' },
              message: { type: 'string' },
              attributes: { type: 'object' },
            },
            ['service_id', 'timestamp', 'signal', 'severity', 'message', 'attributes'],
          ),
        },
      },
      ['events'],
    ),
  },
  {
    name: 'resolve_incident',
    description: 'Resolve an incident from an allowed lifecycle state.',
    inputSchema: objectSchema(
      {
        incident_id: incidentId,
        summary: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      ['incident_id', 'summary'],
    ),
    outputSchema: objectSchema(
      { incident_id: incidentId, status: { type: 'string', enum: ['RESOLVED'] } },
      ['incident_id', 'status'],
    ),
  },
  {
    name: 'run_diagnostic',
    description: 'Run a request-scoped streamed diagnostic for one service.',
    inputSchema: objectSchema({ incident_id: incidentId, service }, ['incident_id', 'service']),
    outputSchema: objectSchema(
      {
        diagnostic_id: { type: 'string' },
        findings: {
          type: 'array',
          items: objectSchema(
            {
              code: { type: 'string' },
              service_id: { type: 'string' },
              summary: { type: 'string' },
            },
            ['code', 'service_id', 'summary'],
          ),
        },
      },
      ['diagnostic_id', 'findings'],
    ),
  },
]

function toolResult(structuredContent: JsonObject): JsonObject {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  }
}

export function callTool(name: string, argumentsValue: unknown): JsonObject | undefined {
  const args =
    typeof argumentsValue === 'object' && argumentsValue !== null && !Array.isArray(argumentsValue)
      ? (argumentsValue as JsonObject)
      : {}
  if (name === 'create_incident') {
    return toolResult({
      incident_id: '00000000-0000-4000-8000-000000000001',
      status: 'OPEN',
      expires_at: '2026-08-02T01:00:00Z',
    })
  }
  if (name === 'query_telemetry') {
    return toolResult({
      events: [
        {
          service_id: typeof args.service === 'string' ? args.service : 'api',
          timestamp: '2026-08-02T00:00:00Z',
          signal: typeof args.signal === 'string' ? args.signal : 'latency',
          severity: 'high',
          message: 'p95 latency elevated',
          attributes: { p95_ms: 900 },
        },
      ],
    })
  }
  if (name === 'run_diagnostic') {
    return toolResult({
      diagnostic_id: 'DIAGNOSTIC-001',
      findings: [
        {
          code: 'DB_LATENCY',
          service_id: typeof args.service === 'string' ? args.service : 'api',
          summary: 'Database dependency latency is elevated',
        },
      ],
    })
  }
  return undefined
}
