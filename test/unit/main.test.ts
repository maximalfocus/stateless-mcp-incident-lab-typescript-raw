import { describe, expect, it, vi } from 'vitest'
import { implementation, main } from '../../src/main.js'

describe('raw entry point', () => {
  it('identifies the implementation', () => {
    expect(implementation).toBe('raw')
  })

  it('prints its version', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(main(['--version'])).toBe(0)
    expect(write).toHaveBeenCalledWith('incident-mcp raw 0.1.0\n')
    write.mockRestore()
  })
})
