import { afterEach, describe, expect, it } from 'vitest'
import { scanCapabilities } from '../../src/adapters/inbound/security.js'
import { signRequestState, verifyRequestState } from '../../src/protocol/request-state.js'

const originalNodeEnv = process.env.NODE_ENV
const originalSecret = process.env.MCP_REQUEST_STATE_SECRET
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalSecret === undefined) delete process.env.MCP_REQUEST_STATE_SECRET
  else process.env.MCP_REQUEST_STATE_SECRET = originalSecret
})

describe('security capability scan', () => {
  it('rejects forbidden imports and direct capability calls', () => {
    expect(
      scanCapabilities(
        { 'src/bad.ts': "import { exec } from 'node:child_process'; exec('x')" },
        ['node:child_process'],
        ['exec'],
      ),
    ).toEqual([
      { file: 'src/bad.ts', capability: 'node:child_process' },
      { file: 'src/bad.ts', capability: 'exec' },
    ])
  })

  it('accepts property-method and textual near misses', () => {
    expect(
      scanCapabilities(
        { 'src/good.ts': "const match = regex.exec(value); const text = 'spawn('" },
        ['node:child_process'],
        ['exec', 'spawn'],
      ),
    ).toEqual([])
  })
})

describe('request-state key and envelope validation', () => {
  const claims = { method: 'tools/call', argumentsHash: 'hash', expiresAt: '2030-01-01T00:00:00Z' }

  it('requires a sufficiently long production key', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MCP_REQUEST_STATE_SECRET
    expect(() => signRequestState(claims)).toThrow('at least 32 bytes')
    process.env.MCP_REQUEST_STATE_SECRET = 'x'.repeat(31)
    expect(() => signRequestState(claims)).toThrow('at least 32 bytes')
    process.env.MCP_REQUEST_STATE_SECRET = 'x'.repeat(32)
    expect(verifyRequestState(signRequestState(claims))).toEqual(claims)
  })

  it('rejects missing, extra, short, and corrupt envelope segments', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.MCP_REQUEST_STATE_SECRET
    const signed = signRequestState(claims)
    const [payload, signature] = signed.split('.') as [string, string]
    for (const invalid of [
      '',
      payload,
      `.${signature}`,
      `${payload}.`,
      `${signed}.extra`,
      `${payload}.AA`,
      `A${payload.slice(1)}.${signature}`,
    ]) {
      expect(verifyRequestState(invalid)).toBeUndefined()
    }
  })
})
