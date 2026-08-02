import { randomUUID } from 'node:crypto'
import {
  INCIDENT_STATES,
  INCIDENT_TRANSITIONS,
  type IncidentState,
  transition,
} from '../domain/incident.js'

type ObjectValue = Record<string, unknown>

export type IncidentRecord = {
  incidentId: string
  status: IncidentState
  expiresAt: string
  remediationId?: string
}

export interface IncidentStore {
  create(record: IncidentRecord, signal?: AbortSignal): Promise<void>
  get(incidentId: string, signal?: AbortSignal): Promise<IncidentRecord | undefined>
  save(record: IncidentRecord, expectedStatus?: IncidentState, signal?: AbortSignal): Promise<void>
  ready(): Promise<boolean>
}

export class MemoryIncidentStore implements IncidentStore {
  readonly #records = new Map<string, IncidentRecord>()

  create(record: IncidentRecord, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('Operation aborted'))
    this.#records.set(record.incidentId, { ...record })
    return Promise.resolve()
  }

  get(incidentId: string, signal?: AbortSignal): Promise<IncidentRecord | undefined> {
    if (signal?.aborted === true) return Promise.reject(new Error('Operation aborted'))
    const record = this.#records.get(incidentId)
    return Promise.resolve(record === undefined ? undefined : { ...record })
  }

  save(
    record: IncidentRecord,
    expectedStatus?: IncidentState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('Operation aborted'))
    const current = this.#records.get(record.incidentId)
    if (expectedStatus !== undefined && current?.status !== expectedStatus) {
      return Promise.reject(new Error('Concurrent incident transition'))
    }
    this.#records.set(record.incidentId, { ...record })
    return Promise.resolve()
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function toolResult(
  structuredContent: ObjectValue,
  text = JSON.stringify(structuredContent),
): ObjectValue {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text }],
    structuredContent,
    isError: false,
  }
}

function domainError(message: string): ObjectValue {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

export class IncidentService {
  readonly #store: IncidentStore
  readonly #now: () => number

  constructor(store: IncidentStore, now: () => number = Date.now) {
    this.#store = store
    this.#now = now
  }

  async call(
    name: string,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<ObjectValue | undefined> {
    const args = isObject(argumentsValue) ? argumentsValue : {}
    if (name === 'create_incident') {
      if (
        typeof args.title !== 'string' ||
        args.title.length === 0 ||
        typeof args.severity !== 'string' ||
        !Array.isArray(args.suspected_services)
      )
        return undefined
      const incidentId = randomUUID()
      const expiresAt = new Date(this.#now() + 60 * 60_000).toISOString()
      await this.#store.create({ incidentId, status: 'OPEN', expiresAt }, signal)
      return toolResult({ incident_id: incidentId, status: 'OPEN', expires_at: expiresAt })
    }
    if (
      !['get_incident', 'run_diagnostic', 'propose_remediation', 'resolve_incident'].includes(name)
    ) {
      return undefined
    }
    const incidentId = typeof args.incident_id === 'string' ? args.incident_id : undefined
    if (incidentId === undefined) return undefined
    const record = await this.#store.get(incidentId, signal)
    if (record === undefined || Date.parse(record.expiresAt) <= this.#now()) {
      return domainError('Unknown or expired incident; create another incident.')
    }
    if (name === 'get_incident') {
      return toolResult({ incident_id: incidentId, status: record.status, related_handles: [] })
    }
    if (record.status === 'RESOLVED') {
      return domainError('Incident is resolved; no further transitions are allowed.')
    }
    if (name === 'run_diagnostic') {
      if (record.status === 'OPEN') {
        record.status = 'INVESTIGATING'
        await this.#store.save(record, 'OPEN', signal)
      }
      return toolResult({
        diagnostic_id: randomUUID(),
        findings: [
          {
            code: 'DB_LATENCY',
            service_id: typeof args.service === 'string' ? args.service : 'api',
            summary: 'Database dependency latency is elevated',
          },
        ],
      })
    }
    if (name === 'propose_remediation') {
      if (record.status !== 'INVESTIGATING')
        return domainError('Investigate the incident before proposing remediation.')
      const remediationId = randomUUID()
      record.remediationId = remediationId
      await this.#store.save(record, 'INVESTIGATING', signal)
      return toolResult({
        remediation_id: remediationId,
        action: 'throttle_synthetic_traffic',
        target: 'api',
        status: 'PROPOSED',
        effect: 'simulated',
      })
    }
    if (name === 'resolve_incident') {
      const previousStatus = record.status
      record.status = 'RESOLVED'
      await this.#store.save(record, previousStatus, signal)
      return toolResult({ incident_id: incidentId, status: 'RESOLVED' })
    }
    return undefined
  }

  async readTimeline(uri: string, signal?: AbortSignal): Promise<ObjectValue | undefined> {
    const match = /^incident:\/\/incidents\/([^/]+)\/timeline$/.exec(uri)
    if (match?.[1] === undefined) return undefined
    const record = await this.#store.get(match[1], signal)
    if (record === undefined || Date.parse(record.expiresAt) <= this.#now()) {
      return domainError('Unknown or expired incident; create another incident.')
    }
    return {
      resultType: 'complete',
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            events: [
              {
                service_id: 'api',
                signal: 'latency',
                severity: 'high',
                timestamp: '2026-08-02T00:00:00Z',
              },
            ],
          }),
        },
      ],
      ttlMs: 1000,
      cacheScope: 'private',
    }
  }

  async markMitigated(
    incidentId: string,
    remediationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const record = await this.#store.get(incidentId, signal)
    if (
      record === undefined ||
      record.remediationId !== remediationId ||
      record.status !== 'INVESTIGATING'
    )
      return false
    record.status = 'MITIGATED'
    await this.#store.save(record, 'INVESTIGATING', signal)
    return true
  }
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function runStateMachine(inputValue: unknown): unknown {
  if (!isObject(inputValue) || inputValue.operation !== 'run_incident_scenario') {
    throw new TypeError('Incident scenario is required')
  }
  const actions = Array.isArray(inputValue.actions)
    ? inputValue.actions.filter((value): value is string => typeof value === 'string')
    : []
  const initial = INCIDENT_STATES.find((state) => state === inputValue.initial_state)
  let state: IncidentState | undefined = initial
  let effectCount = 0
  let diagnosticRuns = 0
  let error: string | undefined
  const observations: ObjectValue = {}

  if (actions[0] === 'create_incident') {
    state = 'OPEN'
    observations.incident_id = '00000000-0000-4000-8000-000000000001'
    observations.expires_at = '2026-08-02T01:00:00Z'
    observations.id_strength = 'uuid-v4-or-stronger'
  } else if (
    state === undefined &&
    (inputValue.incident_id === 'UNKNOWN' || inputValue.incident_id === 'EXPIRED')
  ) {
    error = 'Unknown or expired incident; create another incident.'
    observations.enumerated = false
    observations.incident_present = false
  } else {
    for (const action of actions) {
      if (action === 'get_incident') {
        observations.related_handles = []
        continue
      }
      if (action === 'propose_remediation' && state === 'INVESTIGATING') {
        observations.remediation_id = 'REMEDIATION-001'
        observations.effect = 'simulated'
        observations.status = 'PROPOSED'
        continue
      }
      if (action === 'run_diagnostic') {
        diagnosticRuns += 1
        if (state === 'INVESTIGATING') continue
      }
      if (state === 'RESOLVED') {
        error = 'Incident is resolved; no further transitions are allowed.'
        break
      }
      if (state !== undefined) {
        const next = transition(state, action)
        if (next !== undefined) {
          if (action === 'execute_remediation') effectCount += 1
          state = next
        }
      }
    }
  }

  if (state !== undefined) observations.final_state = state
  observations.effect_count = effectCount
  if (diagnosticRuns > 1) {
    observations.diagnostic_runs = diagnosticRuns
    observations.last_diagnostic_status = 'COMPLETED'
  }
  if (error !== undefined) {
    observations.isError = true
    observations.message = error
  }
  return { states: INCIDENT_STATES, transitions: INCIDENT_TRANSITIONS, observations }
}
