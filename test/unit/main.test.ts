import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawServer, startRawServer } from '../../src/adapters/inbound/index.js'
import { rpcCall, runNetworkCli } from '../../src/client/cli.js'
import { implementation, main, run } from '../../src/main.js'

const servers: ReturnType<typeof createRawServer>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    ),
  )
})

async function launch(options: Parameters<typeof createRawServer>[0] = {}): Promise<string> {
  const server = createRawServer(options)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${String(port)}`
}

describe('raw entry point', () => {
  it('identifies the implementation and prints entry-point messages', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(implementation).toBe('raw')
    expect(main(['--version'])).toBe(0)
    expect(main([])).toBe(0)
    expect(main(['unknown'])).toBe(2)
    expect(await run(['--version'])).toBe(0)
    expect(await run([])).toBe(0)
    expect(write).toHaveBeenCalledWith('incident-mcp raw 0.1.0\n')
  })

  it('starts a configurable server', async () => {
    const server = await startRawServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0)
  })

  it('serves health and MCP over the public HTTP boundary', async () => {
    const base = await launch()
    const health = await fetch(`${base}/raw/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const response = await rpcCall(`${base}/raw/mcp`, 'server/discover')
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
    })
  })

  it('handles public HTTP errors, readiness, bounds, and SSE', async () => {
    const unavailable = await launch({ ready: () => false })
    expect((await fetch(`${unavailable}/raw/healthz`)).status).toBe(503)
    expect((await fetch(`${unavailable}/missing`)).status).toBe(404)
    const parseError = await fetch(`${unavailable}/raw/mcp`, { method: 'POST', body: '{' })
    expect(parseError.status).toBe(400)
    expect(await parseError.json()).toMatchObject({ error: { code: -32700 } })

    const bounded = await launch({ bodyLimitBytes: 10 })
    const tooLarge = await fetch(`${bounded}/raw/mcp`, { method: 'POST', body: 'x'.repeat(20) })
    expect(tooLarge.status).toBe(413)

    const sse = await fetch(`${unavailable}/raw/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'run_diagnostic',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'run_diagnostic',
          arguments: { incident_id: 'i', service: 'api' },
          _meta: { progressToken: 'p' },
        },
      }),
    })
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    expect(await sse.text()).toContain('notifications/progress')
  })

  it('runs every advertised CLI family through HTTP', async () => {
    const base = await launch()
    const url = `${base}/raw/mcp`
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const commands = [
      ['discover', url],
      ['tools', 'list', url],
      ['tools', 'inspect', url, 'create_incident'],
      [
        'tools',
        'call',
        url,
        'create_incident',
        '{"title":"x","severity":"high","suspected_services":["api"]}',
      ],
      ['resources', 'list', url],
      ['resources', 'templates', url],
      ['resources', 'read', url, 'incident://topology/services'],
      ['prompts', 'list', url],
      ['prompts', 'get', url, 'triage_incident', '{"incident_id":"i"}'],
      ['demo', url, '--approve'],
      ['demo', url, '--decline'],
      ['demo', url, '--cancel'],
    ] as const
    for (const command of commands) expect(await runNetworkCli(command)).toBe(0)
    expect(await runNetworkCli([])).toBe(2)
    expect(await runNetworkCli(['tools'])).toBe(2)
    expect(await runNetworkCli(['unknown', 'action', url])).toBe(2)
    expect(await runNetworkCli(['tools', 'call', url, 'create_incident', '[]'])).toBe(5)
    expect(await runNetworkCli(['tools', 'call', url, 'unknown'])).toBe(3)
    expect(await runNetworkCli(['discover', 'http://127.0.0.1:1/raw/mcp'])).toBe(5)
  })
})
