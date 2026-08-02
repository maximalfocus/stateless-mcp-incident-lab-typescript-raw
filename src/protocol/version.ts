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

function remediationInputRequired(id: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'input_required',
      requestState: 'raw.signed.request-state',
      _meta: serverMeta(),
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Approve simulated remediation?',
            requestedSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['accept', 'decline'] } },
              required: ['decision'],
            },
          },
        },
      },
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
  if (Array.isArray(input.requests)) {
    if (input.requests.every((item) => isObject(item) && 'protocol_version' in item)) {
      return jsonResponse(200, {
        responses: input.requests.map((item, index) => {
          const version =
            isObject(item) && typeof item.protocol_version === 'string' ? item.protocol_version : ''
          return version === PROTOCOL_VERSION
            ? { jsonrpc: '2.0', id: index + 1, result: discoveryResult() }
            : unsupportedVersion(index + 1, version)
        }),
      })
    }
    if (input.requests.every((item) => isObject(item) && 'client_capabilities' in item)) {
      return jsonResponse(200, {
        responses: input.requests.map((item, index) => {
          const capabilities =
            isObject(item) && isObject(item.client_capabilities) ? item.client_capabilities : {}
          const elicitation = isObject(capabilities.elicitation)
            ? capabilities.elicitation
            : undefined
          if (elicitation !== undefined && isObject(elicitation.form))
            return remediationInputRequired(index + 1)
          return {
            jsonrpc: '2.0',
            id: index + 1,
            error: {
              code: -32021,
              message: 'Missing required client capability',
              data: {
                requiredCapabilities: {
                  inputRequests: {
                    approval: { method: 'elicitation/create', params: { form: {} } },
                  },
                },
              },
            },
          }
        }),
      })
    }
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
