#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { startRawServer } from './adapters/inbound/index.js'
import { createEffectStoreFromEnv } from './adapters/outbound/index.js'
import { runNetworkCli } from './client/cli.js'

export const implementation = 'raw' as const

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--version')) {
    process.stdout.write('incident-mcp raw 0.1.0\n')
    return 0
  }
  if (argv.length === 0) {
    process.stdout.write('Stateless MCP Incident Lab — raw implementation\n')
    return 0
  }
  return 2
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === 'serve') {
    const effectStore = createEffectStoreFromEnv()
    const server = await startRawServer(
      effectStore === undefined ? {} : { effectStore, incidentStore: effectStore },
    )
    const address = server.address()
    const location = typeof address === 'object' && address !== null ? address.port : 3101
    process.stdout.write(`incident-mcp raw listening on ${String(location)}\n`)
    return 0
  }
  if (argv.includes('--version') || argv.length === 0) return main(argv)
  return await runNetworkCli(argv)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run()
}
