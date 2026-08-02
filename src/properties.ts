import { createHmac, timingSafeEqual } from 'node:crypto'
import { deriveCacheKey } from './client/cache-key.js'
import { decodeHeaderValue, encodeHeaderValue } from './protocol/headers.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
      const method = value.request.method
      return typeof method === 'string' && value.replicas.length >= 2
    })
  } else if (target === 'execute_concurrent_retries') {
    holds = examples.every((value) => {
      if (typeof value !== 'number' || value < 1) return false
      let executed = false
      let effects = 0
      for (let index = 0; index < value; index += 1) {
        if (!executed) {
          executed = true
          effects += 1
        }
      }
      return effects >= Number(property.min) && effects <= Number(property.max)
    })
  }
  return { holds }
}
