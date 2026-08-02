import { describe, expect, it, vi } from 'vitest'
import { healthResponse } from '../../src/adapters/inbound/health.js'
import { handleSse } from '../../src/adapters/inbound/sse.js'
import { captureTrace } from '../../src/adapters/outbound/telemetry.js'
import { executeFunction as catalogFunction } from '../../src/application/catalogs.js'
import { cacheKey, executeFunction as cacheFunction } from '../../src/client/cache.js'
import { discoverWithVersionRecovery } from '../../src/client/version.js'
import {
  deriveParameterHeader,
  executeFunction as transportFunction,
  validHeaderAnnotation,
} from '../../src/client/http.js'
import { transition } from '../../src/domain/incident.js'
import { checkProperty } from '../../src/properties.js'
import { decodeHeaderValue, encodeHeaderValue } from '../../src/protocol/headers.js'
import { signRequestState, verifyRequestState } from '../../src/protocol/request-state.js'
import { executeFunction as securityFunction } from '../../src/protocol/validation.js'
import { main } from '../../src/main.js'

const request = {
  body: {
    id: 1,
    params: { _meta: { progressToken: 'p' } },
  },
}

describe('reachable defensive paths', () => {
  it('runs the default entry point and health variants', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(main([])).toBe(0)
    expect(write).toHaveBeenCalledWith('Stateless MCP Incident Lab — raw implementation\n')
    write.mockRestore()
    expect(healthResponse(true)).toMatchObject({ status: 200 })
    expect(healthResponse(false)).toMatchObject({ status: 503 })
  })

  it('round-trips and rejects malformed encoded headers', () => {
    expect(encodeHeaderValue('服务')).toBe('=?base64?5pyN5Yqh?=')
    expect(decodeHeaderValue(encodeHeaderValue('服务'))).toBe('服务')
    expect(decodeHeaderValue('plain')).toBe('plain')
    expect(() => decodeHeaderValue('=?base64?A?=')).toThrow('Malformed Base64 sentinel')
  })

  it('derives only scalar mirrored headers', () => {
    expect(deriveParameterHeader({}, 'value', 'Value')).toEqual({})
    expect(deriveParameterHeader({ value: 3 }, 'value', 'Value')).toEqual({
      'Mcp-Param-Value': '3',
    })
    expect(deriveParameterHeader({ value: true }, 'value', 'Value')).toEqual({
      'Mcp-Param-Value': 'true',
    })
    expect(() => deriveParameterHeader({ value: {} }, 'value', 'Value')).toThrow('must be a scalar')
    expect(validHeaderAnnotation('Safe-1')).toBe(true)
    expect(validHeaderAnnotation('unsafe value')).toBe(false)
  })

  it('rejects malformed transport function requests', () => {
    expect(() => transportFunction(null)).toThrow('must be named')
    expect(() => transportFunction({ operation: 'header_codec_round_trip', value: 1 })).toThrow(
      'must be a string',
    )
    expect(() => transportFunction({ operation: 'unknown' })).toThrow('Unsupported')
  })

  it('recovers protocol versions or reports no selection', () => {
    expect(discoverWithVersionRecovery([null, 'old']).selected_version).toBeNull()
  })

  it('signs, verifies, and rejects corrupt request state', () => {
    const claims = { method: 'tools/call', argumentsHash: 'abc', expiresAt: '2026-08-02T00:05:00Z' }
    const signed = signRequestState(claims)
    expect(signed.split('.')).toHaveLength(2)
    expect(verifyRequestState(signed)).toEqual(claims)
    expect(verifyRequestState('bad')).toBeUndefined()
    expect(verifyRequestState(`${signed}.extra`)).toBeUndefined()
    expect(verifyRequestState(`${signed.slice(0, -1)}x`)).toBeUndefined()

    for (const value of [null, {}, { method: 'x' }, { method: 'x', argumentsHash: 'y' }]) {
      expect(
        verifyRequestState(
          signRequestState(value as unknown as Parameters<typeof signRequestState>[0]),
        ),
      ).toBeUndefined()
    }
  })

  it('rejects malformed SSE requests and unsupported telemetry', () => {
    expect(() => handleSse(null, null, {})).toThrow('JSON-RPC request')
    expect(() => handleSse({ body: {} }, null, {})).toThrow('id and params')
    expect(() => handleSse({ body: { id: 1, params: { _meta: {} } } }, null, {})).toThrow(
      'Progress token',
    )
    expect(() => captureTrace({ operation: 'unknown' }, request, null)).toThrow('Unsupported')
  })

  it('rejects unsupported catalog and security operations', () => {
    expect(() => catalogFunction({ operation: 'unknown' })).toThrow('Unsupported')
    expect(() => securityFunction(null)).toThrow('required')
    expect(() => securityFunction({ operation: 'unknown' })).toThrow('Unsupported')
    expect(securityFunction({ operation: 'validate_json_schema', schema: {} })).toEqual({
      valid: true,
    })
    expect(
      securityFunction({
        operation: 'validate_json_schema',
        schema_builder: { depth: 64 },
        limits: { max_depth: 64, max_subschemas: 256 },
      }),
    ).toEqual({ valid: true })
    expect(
      securityFunction({
        operation: 'validate_json_schema',
        schema_builder: { subschema_count: 256 },
        limits: { max_depth: 64, max_subschemas: 256 },
      }),
    ).toEqual({ valid: true })
    expect(
      securityFunction({ operation: 'validate_json_schema', schema: { $ref: '#/$defs/local' } }),
    ).toEqual({ valid: true })
    expect(
      securityFunction({
        operation: 'encode_mirrored_header',
        values: ['safe', '=?base64?YXBp?=', '=?base64?A?='],
      }),
    ).toEqual({
      observations: [
        { value_index: 0, accepted: true },
        { value_index: 1, accepted: true },
        { value_index: 2, accepted: false, reason: 'invalid Base64 sentinel' },
      ],
    })
  })

  it('exercises negative cache and property laws', () => {
    expect(() => cacheFunction(null)).toThrow('required')
    expect(cacheKey('x', { b: [2, { z: 1, a: 2 }], a: 1 })).toBe('x|{"a":1,"b":[2,{"a":2,"z":1}]}')
    expect(
      cacheFunction({ operation: 'classify_cacheability', methods: [1, 'tools/call'] }),
    ).toEqual({
      cacheable: [],
      not_cacheable: ['tools/call'],
    })
    expect(
      cacheFunction({
        operation: 'validate_hints',
        results: [
          { resultType: 'wrong', ttlMs: 1, cacheScope: 'public' },
          { resultType: 'complete', ttlMs: '1', cacheScope: 'public' },
          { resultType: 'complete', ttlMs: -1, cacheScope: 'public' },
          { resultType: 'complete', ttlMs: 1, cacheScope: 'wrong' },
          { resultType: 'complete', ttlMs: 1, cacheScope: 'private' },
        ],
      }),
    ).toEqual({ valid: [false, false, false, false, true] })
    expect(
      cacheFunction({ operation: 'classify_scope', reads: [1, 'incident://incidents/x'] }),
    ).toEqual({
      scopes: ['public', 'private'],
    })
    for (const entry of [
      { stored_at_ms: 0, ttlMs: 1 },
      { stored_at_ms: '0', ttlMs: 1 },
      { stored_at_ms: 0, ttlMs: '1' },
    ]) {
      expect(cacheFunction({ operation: 'read', now_ms: 2, entry })).toEqual({
        source: 'network',
        network_calls: 1,
        warnings: [],
      })
    }
    expect(
      cacheFunction({
        operation: 'advance_and_read',
        entry: { ttlMs: 1000 },
        clock_steps_ms: [1000, 1001],
        reads_at_steps: [0, 'bad', 1],
      }),
    ).toEqual({ background_refreshes: 0, network_calls: 1, read_source: 'network' })
    expect(
      cacheFunction({ operation: 'store_then_read', response: { ttlMs: 1 }, reads: 2 }),
    ).toEqual({ stored: false, network_calls: 2 })
    expect(
      cacheFunction({
        operation: 'store_then_read',
        response: { ttlMs: 1, cacheScope: 'public' },
        reads: 2,
      }),
    ).toEqual({ stored: true, network_calls: 0 })
    expect(
      cacheFunction({
        operation: 'store_candidates',
        results: [
          { resultType: 'wrong', ttlMs: 1 },
          { resultType: 'complete', mrtr_retry: true, ttlMs: 1 },
          { resultType: 'complete' },
          { resultType: 'complete', ttlMs: 1 },
        ],
      }),
    ).toEqual({ stored: [false, false, false, true], cache_entries: 1 })
    expect(() => cacheFunction({ operation: 'unknown' })).toThrow('Unsupported')

    expect(checkProperty({ target: 'encode_header', examples: [1] })).toEqual({ holds: false })
    expect(
      checkProperty({ target: 'derive_cache_key', kind: 'invariant', examples: [[{}]] }),
    ).toEqual({ holds: false })
    expect(
      checkProperty({
        target: 'derive_cache_key',
        kind: 'metamorphic',
        examples: [
          [
            { method: 'x', params: {} },
            { method: 'x', params: {} },
          ],
        ],
      }),
    ).toEqual({ holds: false })
    expect(
      checkProperty({ target: 'derive_cache_key', kind: 'metamorphic', examples: [[{}]] }),
    ).toEqual({ holds: false })
    expect(checkProperty({ target: 'list_catalog', examples: [[1]] })).toEqual({ holds: false })
    expect(checkProperty({ target: 'verify_request_state', examples: [] })).toEqual({
      holds: false,
    })
    expect(checkProperty({ target: 'verify_request_state', examples: [{}] })).toEqual({
      holds: false,
    })
    expect(checkProperty({ target: 'execute_on_replica', examples: [{}] })).toEqual({
      holds: false,
    })
    expect(
      checkProperty({
        target: 'execute_on_replica',
        examples: [{ request: { method: 1 }, replicas: ['a'] }],
      }),
    ).toEqual({ holds: false })
    expect(
      checkProperty({ target: 'execute_concurrent_retries', examples: [0], min: 0, max: 1 }),
    ).toEqual({ holds: false })
    expect(
      checkProperty({ target: 'execute_concurrent_retries', examples: [1], min: 2, max: 1 }),
    ).toEqual({ holds: false })
  })

  it('returns no transition for invalid lifecycle actions', () => {
    expect(transition('OPEN', 'execute_remediation')).toBeUndefined()
  })
})
