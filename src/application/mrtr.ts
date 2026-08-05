import { createHash } from 'node:crypto'
import { signRequestState, verifyRequestState } from '../protocol/request-state.js'
import type { EffectStore } from './effects.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const META = {
  'io.modelcontextprotocol/serverInfo': {
    name: 'stateless-mcp-incident-lab',
    version: '2026-07-28',
  },
  'io.maximalfocus.stateless-incident-lab/replica':
    process.env.REPLICA_ID ?? process.env.HOSTNAME ?? 'raw-local-1',
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

function hashArguments(argumentsValue: unknown): string {
  return createHash('sha256').update(JSON.stringify(argumentsValue)).digest('hex')
}

function stateFor(argumentsValue: unknown, clock?: string): string {
  const now = clock === undefined ? Date.now() : Date.parse(clock)
  return signRequestState({
    method: 'tools/call:execute_remediation',
    argumentsHash: hashArguments(argumentsValue),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
  })
}

function inputRequired(
  argumentsValue: unknown,
  missingFields?: string[],
  clock?: string,
): Record<string, unknown> {
  return {
    resultType: 'input_required',
    requestState: stateFor(argumentsValue, clock),
    ...(missingFields === undefined ? {} : { missingFields, effect_count: 0 }),
    _meta: META,
    inputRequests: APPROVAL_REQUEST,
  }
}

export type MrtrResponse = { result: Record<string, unknown> } | { error: Record<string, unknown> }
type RemediationValidator = (
  incidentId: string,
  remediationId: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown> | undefined>

export async function handleMrtr(
  paramsValue: unknown,
  inputValue: unknown,
  effectStore?: EffectStore,
  signal?: AbortSignal,
  validateRemediation?: RemediationValidator,
): Promise<MrtrResponse | undefined> {
  if (!isObject(paramsValue) || paramsValue.name !== 'execute_remediation') return undefined
  const input = isObject(inputValue) ? inputValue : {}
  const argumentsValue = isObject(paramsValue.arguments) ? paramsValue.arguments : {}
  const requestState = paramsValue.requestState
  const missingArguments = ['incident_id', 'remediation_id'].filter(
    (field) => typeof argumentsValue[field] !== 'string' || argumentsValue[field].length === 0,
  )
  if (missingArguments.length > 0) {
    return {
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { reason: 'Missing required arguments', missing: missingArguments },
      },
    }
  }

  if (requestState === undefined) {
    const invalidRemediation = await validateRemediation?.(
      String(argumentsValue.incident_id),
      String(argumentsValue.remediation_id),
      signal,
    )
    if (invalidRemediation !== undefined) return { result: { ...invalidRemediation, _meta: META } }
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
    return {
      result: inputRequired(
        argumentsValue,
        undefined,
        typeof input.clock === 'string' ? input.clock : undefined,
      ),
    }
  }

  const invalidState = (reason: string): MrtrResponse => ({
    error: {
      code: -32602,
      message: 'Invalid params',
      data: { reason, effect_count: 0 },
    },
  })
  if (typeof requestState !== 'string') return invalidState('tampered')
  const claims = verifyRequestState(requestState)
  if (claims === undefined) return invalidState('tampered')
  const now = typeof input.clock === 'string' ? Date.parse(input.clock) : Date.now()
  if (Date.parse(claims.expiresAt) <= now) return invalidState('expired')
  if (claims.method !== 'tools/call:execute_remediation') return invalidState('method_mismatch')
  if (claims.argumentsHash !== hashArguments(argumentsValue)) {
    return invalidState('arguments_mismatch')
  }
  const invalidRemediation = await validateRemediation?.(
    String(argumentsValue.incident_id),
    String(argumentsValue.remediation_id),
    signal,
  )
  if (invalidRemediation !== undefined) return { result: { ...invalidRemediation, _meta: META } }

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
      return {
        result: inputRequired(
          argumentsValue,
          ['confirmation'],
          typeof input.clock === 'string' ? input.clock : undefined,
        ),
      }
    }
    const incidentId = String(argumentsValue.incident_id)
    const effectApplied =
      effectStore === undefined
        ? true
        : effectStore.claimAndMitigate === undefined
          ? await effectStore.claim(remediationId, signal)
          : await effectStore.claimAndMitigate(incidentId, remediationId, signal)
    const structuredContent = {
      remediation_id: remediationId,
      status: 'EXECUTED',
      effect_count: effectApplied ? 1 : 0,
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
    const status = action === 'decline' ? 'DECLINED' : 'CANCELLED'
    return {
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'Remediation not executed.' }],
        structuredContent: {
          remediation_id: remediationId,
          status,
          effect_count: 0,
        },
        isError: false,
        _meta: META,
      },
    }
  }
  return {
    result: inputRequired(
      argumentsValue,
      undefined,
      typeof input.clock === 'string' ? input.clock : undefined,
    ),
  }
}
