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

export function primitiveResult(method: string): Record<string, unknown> | undefined {
  return method === 'tools/list' ? listTools() : undefined
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
