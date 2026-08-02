import { TOOLS } from './tools.js'

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

export function primitiveResult(method: string): Record<string, unknown> | undefined {
  if (method === 'tools/list') return listTools()
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

export function executeFunction(inputValue: unknown): unknown {
  if (!isObject(inputValue) || inputValue.operation !== 'walk_paginated_list') {
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
