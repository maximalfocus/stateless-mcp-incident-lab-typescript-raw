import { isObject } from './schema.js'

export const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = { name: 'stateless-mcp-incident-lab', version: PROTOCOL_VERSION } as const

export function serverMeta(replica = 'raw-local-1'): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    'io.maximalfocus.stateless-incident-lab/replica': replica,
  }
}

export function discoveryResult(replica = 'raw-local-1'): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: SERVER_INFO,
    instructions:
      'Use discovery, catalogs, and explicit incident handles to investigate the synthetic incident lab.',
    ttlMs: 60000,
    cacheScope: 'public',
    _meta: serverMeta(replica),
  }
}

function jsonResponse(status: number, body: unknown): Record<string, unknown> {
  return { status, headers: { 'Content-Type': 'application/json' }, body }
}

export function handleHttp(requestValue: unknown): unknown {
  if (!isObject(requestValue) || !isObject(requestValue.body)) {
    throw new TypeError('HTTP request and JSON-RPC body are required')
  }
  const body = requestValue.body
  const id = body.id
  const params = isObject(body.params) ? body.params : undefined
  const meta = params !== undefined && isObject(params._meta) ? params._meta : undefined
  if (meta === undefined) {
    return jsonResponse(400, {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { field: 'params._meta', reason: 'required' },
      },
    })
  }
  return jsonResponse(200, { jsonrpc: '2.0', id, result: discoveryResult() })
}
