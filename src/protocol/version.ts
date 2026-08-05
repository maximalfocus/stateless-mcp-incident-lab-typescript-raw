import { discoverWithVersionRecovery } from '../client/version.js'
import { isObject } from './schema.js'

export const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = { name: 'stateless-mcp-incident-lab', version: PROTOCOL_VERSION } as const

export function serverMeta(
  replica = process.env.REPLICA_ID ?? process.env.HOSTNAME ?? 'raw-local-1',
): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    'io.maximalfocus.stateless-incident-lab/replica': replica,
  }
}

export function discoveryResult(
  replica = process.env.REPLICA_ID ?? process.env.HOSTNAME ?? 'raw-local-1',
): Record<string, unknown> {
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

function unsupportedVersion(id: unknown, requested: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32022,
      message: 'Unsupported protocol version',
      data: { requested, supported: [PROTOCOL_VERSION] },
    },
  }
}

export function handleHttp(
  requestValue: unknown,
  seedValue: unknown,
  inputValue: unknown,
): unknown {
  void seedValue
  if (!isObject(requestValue) || !isObject(requestValue.body)) {
    throw new TypeError('HTTP request and JSON-RPC body are required')
  }
  const body = requestValue.body
  const id = body.id
  const params = isObject(body.params) ? body.params : undefined
  const meta = params !== undefined && isObject(params._meta) ? params._meta : undefined
  const input = isObject(inputValue) ? inputValue : {}
  if (input.operation === 'discover_with_version_recovery') {
    const offered = Array.isArray(input.offered_versions) ? input.offered_versions : []
    return jsonResponse(200, discoverWithVersionRecovery(offered))
  }
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
  const requestedVersion = meta['io.modelcontextprotocol/protocolVersion']
  if (requestedVersion !== PROTOCOL_VERSION) {
    return jsonResponse(400, unsupportedVersion(id, String(requestedVersion)))
  }
  return jsonResponse(200, { jsonrpc: '2.0', id, result: discoveryResult() })
}
