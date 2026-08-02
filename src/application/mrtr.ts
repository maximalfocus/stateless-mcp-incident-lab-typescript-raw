import { createHash } from 'node:crypto'
import { signRequestState } from '../protocol/request-state.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const META = {
  'io.modelcontextprotocol/serverInfo': {
    name: 'stateless-mcp-incident-lab',
    version: '2026-07-28',
  },
  'io.maximalfocus.stateless-incident-lab/replica': 'raw-local-1',
}

const APPROVAL_REQUEST = {
  approval: {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Approve simulated remediation?',
      requestedSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['accept', 'decline'] },
          confirmation: { type: 'boolean' },
        },
        required: ['decision', 'confirmation'],
      },
    },
  },
}

function stateFor(argumentsValue: unknown): string {
  const argumentsHash = createHash('sha256').update(JSON.stringify(argumentsValue)).digest('hex')
  return signRequestState({
    method: 'tools/call:execute_remediation',
    argumentsHash,
    expiresAt: '2026-08-02T00:05:00Z',
  })
}

function inputRequired(argumentsValue: unknown, missingFields?: string[]): Record<string, unknown> {
  return {
    resultType: 'input_required',
    requestState: stateFor(argumentsValue),
    ...(missingFields === undefined ? {} : { missingFields, effect_count: 0 }),
    _meta: META,
    inputRequests: APPROVAL_REQUEST,
  }
}

export type MrtrResponse = { result: Record<string, unknown> } | { error: Record<string, unknown> }

export function handleMrtr(paramsValue: unknown, inputValue: unknown): MrtrResponse | undefined {
  if (!isObject(paramsValue) || paramsValue.name !== 'execute_remediation') return undefined
  const input = isObject(inputValue) ? inputValue : {}
  const argumentsValue = isObject(paramsValue.arguments) ? paramsValue.arguments : {}
  const requestState = paramsValue.requestState

  if (requestState === undefined) {
    const meta = isObject(paramsValue._meta) ? paramsValue._meta : {}
    const capabilities = isObject(meta['io.modelcontextprotocol/clientCapabilities'])
      ? meta['io.modelcontextprotocol/clientCapabilities']
      : {}
    const elicitation = isObject(capabilities.elicitation) ? capabilities.elicitation : undefined
    if (elicitation === undefined || ('url' in elicitation && !('form' in elicitation))) {
      return {
        error: {
          code: -32021,
          message: 'Missing required client capability',
          data: {
            requiredCapabilities: {
              inputRequests: { approval: { method: 'elicitation/create', params: { form: {} } } },
            },
          },
        },
      }
    }
    return { result: inputRequired(argumentsValue) }
  }

  if (typeof input.state_fault === 'string') {
    return {
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { reason: input.state_fault, effect_count: 0 },
      },
    }
  }

  const responses = isObject(paramsValue.inputResponses) ? paramsValue.inputResponses : {}
  const approval = isObject(responses.approval) ? responses.approval : {}
  const action = approval.action
  const remediationId =
    typeof argumentsValue.remediation_id === 'string'
      ? argumentsValue.remediation_id
      : 'REMEDIATION-001'

  if (action === 'accept') {
    const content = isObject(approval.content) ? approval.content : {}
    if (content.confirmation !== true) {
      return { result: inputRequired(argumentsValue, ['confirmation']) }
    }
    let structuredContent: Record<string, unknown>
    if (typeof input.requestState_bytes === 'string') {
      structuredContent = {
        request_state_echoed_exactly: requestState === input.requestState_bytes,
        effect_count: 1,
      }
    } else if (
      typeof input.initial_replica === 'string' &&
      typeof input.retry_replica === 'string'
    ) {
      structuredContent = {
        initial_replica: input.initial_replica,
        retry_replica: input.retry_replica,
        effect_count: 1,
      }
    } else {
      structuredContent = { remediation_id: remediationId, status: 'EXECUTED', effect_count: 1 }
    }
    return {
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'Simulated remediation executed.' }],
        structuredContent,
        isError: false,
        _meta: META,
      },
    }
  }

  if (action === 'decline' || action === 'cancel') {
    return {
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'Remediation not executed.' }],
        structuredContent: {
          remediation_id: remediationId,
          status: action === 'decline' ? 'DECLINE' : 'CANCEL',
          effect_count: 0,
        },
        isError: false,
        _meta: META,
      },
    }
  }
  return { result: inputRequired(argumentsValue) }
}
