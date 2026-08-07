import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('runtime container boundary', () => {
  it('declares HOST=0.0.0.0 in the runtime image so container traffic reaches the server', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toMatch(/^FROM node:24-alpine AS runtime$[\s\S]*?^ENV HOST=0\.0\.0\.0$/m)
  })
})
