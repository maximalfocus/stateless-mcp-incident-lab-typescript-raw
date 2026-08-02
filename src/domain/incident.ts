export const INCIDENT_STATES = ['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED'] as const
export type IncidentState = (typeof INCIDENT_STATES)[number]

export const INCIDENT_TRANSITIONS = [
  { from: 'OPEN', to: 'INVESTIGATING', trigger: 'run_diagnostic' },
  { from: 'INVESTIGATING', to: 'MITIGATED', trigger: 'execute_remediation' },
  { from: 'OPEN', to: 'RESOLVED', trigger: 'resolve_incident' },
  { from: 'INVESTIGATING', to: 'RESOLVED', trigger: 'resolve_incident' },
  { from: 'MITIGATED', to: 'RESOLVED', trigger: 'resolve_incident' },
] as const

export function transition(state: IncidentState, action: string): IncidentState | undefined {
  return INCIDENT_TRANSITIONS.find((item) => item.from === state && item.trigger === action)?.to
}
