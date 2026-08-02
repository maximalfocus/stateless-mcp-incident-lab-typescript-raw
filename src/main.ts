#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

export const implementation = 'raw' as const

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--version')) {
    process.stdout.write('incident-mcp raw 0.1.0\n')
    return 0
  }
  process.stdout.write('Stateless MCP Incident Lab — raw implementation\n')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
