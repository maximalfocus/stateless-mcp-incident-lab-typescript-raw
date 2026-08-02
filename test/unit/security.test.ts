import { describe, expect, it } from 'vitest'
import { scanCapabilities } from '../../src/adapters/inbound/security.js'

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
