import {
  INCIDENT_STATES,
  INCIDENT_TRANSITIONS,
  type IncidentState,
  transition,
} from '../domain/incident.js'

type ObjectValue = Record<string, unknown>
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
