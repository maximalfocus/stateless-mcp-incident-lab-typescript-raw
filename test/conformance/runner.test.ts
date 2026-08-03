import { describe, expect, it } from 'vitest'
import { main, matchValue, validateExpected } from './runner.js'

describe('raw conformance replay', () => {
  it('passes the complete selected lane in-process', async () => {
    const original = process.argv
    process.argv = ['node', 'runner.ts', '--lane', 'raw']
    try {
      expect(await main()).toBe(0)
    } finally {
      process.argv = original
    }
  })
})

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

  it('matches placeholders embedded in serialized outputs', () => {
    expect(
      matchValue(
        '{"id":"{{GENERATED_ID}}","at":"{{TIMESTAMP}}"}',
        '{"id":"incident-1","at":"2026-08-02T00:00:00Z"}',
      ),
    ).toEqual([])
  })

  it('enforces placeholder types and formats', () => {
    expect(matchValue('{{ANY_STRING}}', 42)).not.toEqual([])
    expect(matchValue('{{ANY_STRING}}', '')).not.toEqual([])
    expect(matchValue('{{ANY_STRING}}', 'replica-a')).toEqual([])
    expect(matchValue('{{TIMESTAMP}}', '2026-08-02')).not.toEqual([])
    expect(matchValue('{{TIMESTAMP}}', '2026-08-02T00:00:00Z')).toEqual([])
  })

  it('fails closed on malformed directives and unknown placeholders', () => {
    expect(() => {
      validateExpected({ value: '{{UNKNOWN}}' })
    }).toThrow('unknown placeholder')
    expect(() => {
      validateExpected({ '{{ALLOW_EXTRA}}': false })
    }).toThrow('must be true')
    expect(() => {
      validateExpected({ assertions: null })
    }).toThrow('array required')
    expect(() => {
      validateExpected({ assertions: [{ type: 'strict_http_shape', ignored: true }] })
    }).toThrow('invalid strict_http_shape directive')
  })

  it('distinguishes directives from observable architecture assertions', () => {
    expect(
      matchValue({ assertions: [{ type: 'strict_http_shape' }], status: 200 }, { status: 200 }),
    ).toEqual([])
    expect(matchValue({ assertions: [{ type: 'no_import' }] }, {})).toContain(
      '$.assertions: missing',
    )
  })

  it('derives SSE final-count and trailing-event assertions', () => {
    const actual = {
      events: [
        { event: 'message', data: { method: 'notifications/progress' } },
        { event: 'message', data: { id: 1, result: {} } },
      ],
    }
    expect(
      matchValue(
        {
          events: [
            { event: 'message', data: { method: 'notifications/progress' } },
            { event: 'message', data: { id: 1, result: {} } },
          ],
          final_response_count: 1,
          events_after_final: [],
        },
        actual,
      ),
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
