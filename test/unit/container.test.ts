import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('runtime container boundary', () => {
  it('binds the HTTP server to the container network interface', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toMatch(/^ENV HOST=0\.0\.0\.0$/m)
  })
})
