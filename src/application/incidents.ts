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
  create(record: IncidentRecord): Promise<void>
  get(incidentId: string): Promise<IncidentRecord | undefined>
  save(record: IncidentRecord): Promise<void>
  ready(): Promise<boolean>
}

export class MemoryIncidentStore implements IncidentStore {
  readonly #records = new Map<string, IncidentRecord>()

  create(record: IncidentRecord): Promise<void> {
    this.#records.set(record.incidentId, { ...record })
    return Promise.resolve()
  }

  get(incidentId: string): Promise<IncidentRecord | undefined> {
    const record = this.#records.get(incidentId)
    return Promise.resolve(record === undefined ? undefined : { ...record })
  }

  save(record: IncidentRecord): Promise<void> {
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

  async call(name: string, argumentsValue: unknown): Promise<ObjectValue | undefined> {
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
      await this.#store.create({ incidentId, status: 'OPEN', expiresAt })
      return toolResult({ incident_id: incidentId, status: 'OPEN', expires_at: expiresAt })
    }
    if (
      !['get_incident', 'run_diagnostic', 'propose_remediation', 'resolve_incident'].includes(name)
    ) {
      return undefined
    }
    const incidentId = typeof args.incident_id === 'string' ? args.incident_id : undefined
    if (incidentId === undefined) return undefined
    const record = await this.#store.get(incidentId)
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
        await this.#store.save(record)
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
      await this.#store.save(record)
      return toolResult({
        remediation_id: remediationId,
        action: 'throttle_synthetic_traffic',
        target: 'api',
        status: 'PROPOSED',
        effect: 'simulated',
      })
    }
    if (name === 'resolve_incident') {
      record.status = 'RESOLVED'
      await this.#store.save(record)
      return toolResult({ incident_id: incidentId, status: 'RESOLVED' })
    }
    return undefined
  }

  async markMitigated(incidentId: string, remediationId: string): Promise<boolean> {
    const record = await this.#store.get(incidentId)
    if (
      record === undefined ||
      record.remediationId !== remediationId ||
      record.status !== 'INVESTIGATING'
    )
      return false
    record.status = 'MITIGATED'
    await this.#store.save(record)
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
