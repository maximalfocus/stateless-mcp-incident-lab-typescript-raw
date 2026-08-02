import { discoveryResult } from '../protocol/version.js'

export function discover(replica?: string): Record<string, unknown> {
  return discoveryResult(replica)
}
