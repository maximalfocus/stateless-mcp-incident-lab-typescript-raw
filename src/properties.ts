import { createHmac, timingSafeEqual } from 'node:crypto'
import { catalogMeta, primitiveResult } from './application/catalogs.js'
import { deriveCacheKey } from './client/cache-key.js'
import { transition, type IncidentState } from './domain/incident.js'
import { decodeHeaderValue, encodeHeaderValue } from './protocol/headers.js'
import { discoveryResult } from './protocol/version.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REPLICA_META_KEY = 'io.maximalfocus.stateless-incident-lab/replica'

const REPLICA_RESULTS: Readonly<Record<string, (replica: string) => Record<string, unknown>>> = {
  'server/discover': (replica) => discoveryResult(replica),
}

function replicaResult(
  method: string,
  params: unknown,
  replica: string,
): Record<string, unknown> | undefined {
  const build = REPLICA_RESULTS[method]
  if (build !== undefined) return build(replica)
  const result = primitiveResult(method, params)
  return result === undefined ? undefined : { ...result, _meta: catalogMeta(replica) }
}

// Produces the real response the named replica would return, split into the replica identity and
// the payload that the stateless law requires to be identical on every replica.
function replicaObservation(
  method: string,
  params: unknown,
  replica: string,
): { marker: unknown; payload: string } | undefined {
  const result = replicaResult(method, params, replica)
  if (result === undefined) return undefined
  const meta = isObject(result._meta) ? result._meta : {}
  const { [REPLICA_META_KEY]: marker, ...normalizedMeta } = meta
  return { marker, payload: JSON.stringify({ ...result, _meta: normalizedMeta }) }
}

function hmac(secret: Buffer, payload: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

function tamperRejected(example: unknown): boolean {
  if (!isObject(example) || typeof example.secret_hex !== 'string' || !isObject(example.payload)) {
    return false
  }
  const bit = typeof example.bit === 'number' ? example.bit : 0
  const secret = Buffer.from(example.secret_hex, 'hex')
  const payload = Buffer.from(JSON.stringify(example.payload), 'utf8')
  const signature = hmac(secret, payload)
  const tampered = Buffer.from(payload)
  const byte = Math.floor(bit / 8) % tampered.length
  tampered[byte] = (tampered[byte] ?? 0) ^ (1 << (bit % 8))
  const candidate = hmac(secret, tampered)
  return candidate.length === signature.length && !timingSafeEqual(candidate, signature)
}

export function checkProperty(property: Record<string, unknown>): unknown {
  const target = property.target
  const examples = Array.isArray(property.examples) ? (property.examples as unknown[]) : []
  let holds = false
  if (target === 'encode_header') {
    const generated = Array.from({ length: 200 }, (_, index) => `值-${String(index)}-api`)
    holds = [...examples, ...generated].every(
      (value) => typeof value === 'string' && decodeHeaderValue(encodeHeaderValue(value)) === value,
    )
  } else if (target === 'derive_cache_key' && property.kind === 'invariant') {
    holds = examples.every((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || !isObject(pair[0]) || !isObject(pair[1])) {
        return false
      }
      const left = pair[0]
      const right = pair[1]
      return (
        deriveCacheKey(String(left.method), left.params) ===
        deriveCacheKey(String(right.method), right.params)
      )
    })
  } else if (target === 'derive_cache_key' && property.kind === 'metamorphic') {
    holds = examples.every((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || !isObject(pair[0]) || !isObject(pair[1])) {
        return false
      }
      return (
        deriveCacheKey(String(pair[0].method), pair[0].params) !==
        deriveCacheKey(String(pair[1].method), pair[1].params)
      )
    })
  } else if (target === 'list_catalog') {
    holds = examples.every((value) => {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return false
      const first = [...value].sort((a, b) => a.localeCompare(b, 'en'))
      const second = [...value].reverse().sort((a, b) => a.localeCompare(b, 'en'))
      return JSON.stringify(first) === JSON.stringify(second)
    })
  } else if (target === 'verify_request_state') {
    holds = examples.length > 0 && examples.every(tamperRejected)
  } else if (target === 'execute_on_replica') {
    holds = examples.every((value) => {
      if (!isObject(value) || !isObject(value.request) || !Array.isArray(value.replicas))
        return false
      const replicas = value.replicas.filter((item): item is string => typeof item === 'string')
      const method = value.request.method
      const params = value.request.params
      if (typeof method !== 'string' || replicas.length < 2) return false
      const observations = replicas.map((replica) => replicaObservation(method, params, replica))
      const first = observations[0]
      if (first === undefined) return false
      return observations.every(
        (observation, index) =>
          observation !== undefined &&
          observation.payload === first.payload &&
          observation.marker === replicas[index],
      )
    })
  } else if (target === 'execute_concurrent_retries') {
    holds = examples.every((value) => {
      if (typeof value !== 'number' || value < 1) return false
      let state: IncidentState = 'INVESTIGATING'
      let effects = 0
      for (let index = 0; index < value; index += 1) {
        const next = transition(state, 'execute_remediation')
        if (next === undefined) continue
        state = next
        effects += 1
      }
      return effects >= Number(property.min) && effects <= Number(property.max)
    })
  }
  return { holds }
}
