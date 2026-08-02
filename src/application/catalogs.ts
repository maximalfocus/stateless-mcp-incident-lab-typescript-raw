import { callTool, TOOLS } from './tools.js'

const SERVER_INFO = { name: 'stateless-mcp-incident-lab', version: '2026-07-28' }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function catalogMeta(replica = 'raw-local-1'): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    'io.maximalfocus.stateless-incident-lab/replica': replica,
  }
}

export function listTools(): Record<string, unknown> {
  return {
    resultType: 'complete',
    tools: TOOLS,
    ttlMs: 60000,
    cacheScope: 'public',
    _meta: catalogMeta(),
  }
}

const PUBLIC_CATALOG = { resultType: 'complete', ttlMs: 60000, cacheScope: 'public' }

export function primitiveResult(
  method: string,
  paramsValue: unknown = {},
): Record<string, unknown> | undefined {
  const params = isObject(paramsValue) ? paramsValue : {}
  if (method === 'tools/list' && !Object.hasOwn(params, 'cursor')) return listTools()
  if (method === 'tools/call' && typeof params.name === 'string') {
    const result = callTool(params.name, params.arguments)
    return result === undefined ? undefined : { ...result, _meta: catalogMeta() }
  }
  if (method === 'resources/list') {
    return {
      ...PUBLIC_CATALOG,
      resources: [
        { uri: 'incident://runbooks/api', name: 'API runbook', mimeType: 'text/markdown' },
        {
          uri: 'incident://runbooks/database',
          name: 'Database runbook',
          mimeType: 'text/markdown',
        },
        {
          uri: 'incident://topology/services',
          name: 'Service topology',
          mimeType: 'application/json',
        },
      ],
      _meta: catalogMeta(),
    }
  }
  if (method === 'resources/read' && typeof params.uri === 'string') {
    const publicResources: Record<string, Record<string, unknown>> = {
      'incident://topology/services': {
        uri: 'incident://topology/services',
        mimeType: 'application/json',
        text: '{"services":[{"service_id":"api","dependencies":["database"],"health":"degraded","region":"ap-southeast-1"},{"service_id":"database","dependencies":[],"health":"healthy","region":"ap-southeast-1"}]}',
      },
      'incident://runbooks/api': {
        uri: 'incident://runbooks/api',
        mimeType: 'text/markdown',
        text: '# API runbook\n\nInspect latency and downstream database health.',
        _meta: { revision: 1, updated_at: '2026-08-02T00:00:00Z' },
      },
    }
    const publicContent = publicResources[params.uri]
    if (publicContent !== undefined) {
      return { ...PUBLIC_CATALOG, contents: [publicContent], _meta: catalogMeta() }
    }
    if (params.uri === 'incident://incidents/INCIDENT-OPEN/timeline') {
      return {
        resultType: 'complete',
        contents: [
          {
            uri: params.uri,
            mimeType: 'application/json',
            text: '{"events":[{"service_id":"api","signal":"latency","severity":"high","timestamp":"2026-08-02T00:00:00Z"}]}',
          },
        ],
        ttlMs: 1000,
        cacheScope: 'private',
        _meta: catalogMeta(),
      }
    }
  }
  if (method === 'prompts/list') {
    return {
      ...PUBLIC_CATALOG,
      prompts: [
        { name: 'triage_incident', arguments: [{ name: 'incident_id', required: true }] },
        {
          name: 'review_remediation',
          arguments: [
            { name: 'incident_id', required: true },
            { name: 'remediation_id', required: true },
          ],
        },
      ],
      _meta: catalogMeta(),
    }
  }
  if (method === 'prompts/get' && params.name === 'triage_incident') {
    const argumentsValue = isObject(params.arguments) ? params.arguments : {}
    if (typeof argumentsValue.incident_id === 'string') {
      return {
        resultType: 'complete',
        description: 'Triage a synthetic incident',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Investigate incident ${argumentsValue.incident_id} using incident://incidents/${argumentsValue.incident_id}/timeline.`,
            },
          },
        ],
        _meta: catalogMeta(),
      }
    }
  }
  if (method === 'prompts/get' && params.name === 'review_remediation') {
    const args = isObject(params.arguments) ? params.arguments : {}
    if (typeof args.incident_id === 'string' && typeof args.remediation_id === 'string') {
      return {
        resultType: 'complete',
        description: 'Review a simulated remediation',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Review evidence for remediation ${args.remediation_id} on incident ${args.incident_id} before approval.`,
            },
          },
        ],
        _meta: catalogMeta(),
      }
    }
  }
  if (method === 'resources/templates/list') {
    return {
      ...PUBLIC_CATALOG,
      resourceTemplates: [
        {
          uriTemplate: 'incident://incidents/{incident_id}/timeline',
          name: 'Incident timeline',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'incident://runbooks/{service_id}',
          name: 'Service runbook',
          mimeType: 'text/markdown',
        },
      ],
      _meta: catalogMeta(),
    }
  }
  return undefined
}

export function primitiveError(
  method: string,
  paramsValue: unknown,
): Record<string, unknown> | undefined {
  const params = isObject(paramsValue) ? paramsValue : {}
  if (method === 'tools/list' && typeof params.cursor === 'string') {
    return { code: -32602, message: 'Invalid params', data: { reason: 'Invalid cursor' } }
  }
  if (method === 'prompts/get') {
    const argumentsValue = isObject(params.arguments) ? params.arguments : {}
    if (params.name === 'triage_incident' && typeof argumentsValue.incident_id !== 'string') {
      return {
        code: -32602,
        message: 'Invalid params',
        data: { reason: 'Missing required argument', argument: 'incident_id' },
      }
    }
    if (
      typeof params.name === 'string' &&
      !['triage_incident', 'review_remediation'].includes(params.name)
    ) {
      return {
        code: -32602,
        message: 'Invalid params',
        data: { reason: 'Unknown prompt', name: params.name },
      }
    }
  }
  if (method === 'resources/read' && typeof params.uri === 'string') {
    return {
      code: -32602,
      message: 'Invalid params',
      data: { reason: 'Unknown resource', uri: params.uri },
    }
  }
  return undefined
}

export function executeFunction(inputValue: unknown): unknown {
  if (!isObject(inputValue)) throw new TypeError('Primitive operation must be an object')
  if (inputValue.operation === 'classify_tool_failure') {
    return {
      observations: [
        {
          name: 'domain_failure',
          kind: 'tool_result',
          result: {
            resultType: 'complete',
            content: [
              { type: 'text', text: 'Unknown or expired incident; create another incident.' },
            ],
            isError: true,
          },
        },
        {
          name: 'malformed_protocol_input',
          kind: 'jsonrpc_error',
          error: {
            code: -32602,
            message: 'Invalid params',
            data: { field: 'params.arguments', reason: 'must be an object' },
          },
        },
      ],
    }
  }
  if (inputValue.operation !== 'walk_paginated_list') {
    throw new RangeError('Unsupported primitive function operation')
  }
  const pages = Array.isArray(inputValue.pages) ? inputValue.pages : []
  const requestedCursors: string[] = []
  const items: unknown[] = []
  let terminatedBy = 'absent_nextCursor'
  for (const pageValue of pages) {
    const page = isObject(pageValue) ? pageValue : {}
    const requestParams = isObject(page.request_params) ? page.request_params : {}
    requestedCursors.push(
      Object.hasOwn(requestParams, 'cursor') && typeof requestParams.cursor === 'string'
        ? requestParams.cursor
        : Object.hasOwn(requestParams, 'cursor')
          ? ''
          : '<absent>',
    )
    const result = isObject(page.result) ? page.result : {}
    const pageItems: unknown[] = Array.isArray(result.tools) ? (result.tools as unknown[]) : []
    items.push(...pageItems)
    if (!Object.hasOwn(result, 'nextCursor')) break
    if (typeof result.nextCursor !== 'string') {
      terminatedBy = 'invalid_nextCursor'
      break
    }
  }
  return {
    requested_cursors: requestedCursors,
    items,
    terminated_by: terminatedBy,
    partial_result_returned: false,
  }
}
