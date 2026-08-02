export const applicationLayer = 'application' as const
export { MemoryEffectStore, type EffectStore } from './effects.js'
export {
  IncidentService,
  MemoryIncidentStore,
  type IncidentRecord,
  type IncidentStore,
} from './incidents.js'
