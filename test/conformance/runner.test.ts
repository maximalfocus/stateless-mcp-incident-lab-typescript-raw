import { describe, expect, it } from 'vitest'
import { matchValue } from './runner.js'

describe('strict golden matching', () => {
  it('rejects extra fields by default', () => {
    expect(matchValue({ value: 1 }, { value: 1, leaked: true })).toContain('$.leaked: unexpected')
  })

  it('allows extras only at the annotated object', () => {
    expect(matchValue({ '{{ALLOW_EXTRA}}': true, value: 1 }, { value: 1, extra: true })).toEqual([])
    expect(matchValue({ child: { value: 1 } }, { child: { value: 1, extra: true } })).not.toEqual(
      [],
    )
  })

  it('enforces placeholder types', () => {
    expect(matchValue('{{ANY_STRING}}', 42)).not.toEqual([])
    expect(matchValue('{{ANY_STRING}}', 'replica-a')).toEqual([])
    expect(matchValue('{{TIMESTAMP}}', 'not-a-date')).not.toEqual([])
    expect(matchValue('{{TIMESTAMP}}', '2026-08-02T00:00:00Z')).toEqual([])
  })

  it('ignores executable assertion metadata rather than treating it as output', () => {
    expect(
      matchValue({ assertions: [{ type: 'strict_http_shape' }], status: 200 }, { status: 200 }),
    ).toEqual([])
  })

  it('enforces absent metadata errors without treating the directive as output', () => {
    const expected = {
      response: { '{{ALLOW_EXTRA}}': true },
      metadata_error_absent: -32020,
    }
    expect(matchValue(expected, { response: { status: 200 } })).toEqual([])
    expect(matchValue(expected, { response: { body: { error: { code: -32020 } } } })).not.toEqual(
      [],
    )
  })

  it('enforces forbidden headers without treating the directive as output', () => {
    const expected = {
      headers: { '{{ALLOW_EXTRA}}': true },
      forbidden_headers: ['Mcp-Session-Id'],
    }
    expect(matchValue(expected, { headers: {} })).toEqual([])
    expect(matchValue(expected, { headers: { 'mcp-session-id': 'x' } })).not.toEqual([])
  })
})
