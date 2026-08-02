import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawServer, startRawServer } from '../../src/adapters/inbound/index.js'
import { rpcCall, runNetworkCli } from '../../src/client/cli.js'
import { implementation, main, run } from '../../src/main.js'

const servers: ReturnType<typeof createRawServer>[] = []
const originalNodeEnv = process.env.NODE_ENV
const originalSecret = process.env.MCP_REQUEST_STATE_SECRET
const originalEffectStore = process.env.EFFECT_STORE
afterEach(async () => {
  vi.restoreAllMocks()
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalSecret === undefined) delete process.env.MCP_REQUEST_STATE_SECRET
  else process.env.MCP_REQUEST_STATE_SECRET = originalSecret
  if (originalEffectStore === undefined) delete process.env.EFFECT_STORE
  else process.env.EFFECT_STORE = originalEffectStore
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

  it('fails production readiness without persistence and a shared signing secret', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MCP_REQUEST_STATE_SECRET
    delete process.env.EFFECT_STORE
    const unconfigured = await launch()
    expect((await fetch(`${unconfigured}/raw/healthz`)).status).toBe(503)

    process.env.MCP_REQUEST_STATE_SECRET = 'x'.repeat(32)
    process.env.EFFECT_STORE = 'memory'
    const configured = await launch()
    expect((await fetch(`${configured}/raw/healthz`)).status).toBe(200)
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
    const wrongMethod = await fetch(`${unavailable}/raw/mcp`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    const invalidOrigin = await fetch(`${unavailable}/raw/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
      body: '{',
    })
    expect(invalidOrigin.status).toBe(403)
    const parseError = await fetch(`${unavailable}/raw/mcp`, { method: 'POST', body: '{' })
    expect(parseError.status).toBe(400)
    expect(await parseError.json()).toMatchObject({ error: { code: -32700 } })

    const invalidMetadata = await fetch(`${unavailable}/raw/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    })
    expect(await invalidMetadata.json()).toMatchObject({ error: { code: -32602 } })
    const unsupported = await fetch(`${unavailable}/raw/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
        'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
      }),
    })
    expect(await unsupported.json()).toMatchObject({ error: { code: -32022 } })
    const malformedHeader = await fetch(`${unavailable}/raw/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'resources/read',
        'Mcp-Name': '=?base64?A?=',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri: 'incident://topology/services',
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        },
      }),
    })
    expect(await malformedHeader.json()).toMatchObject({ error: { code: -32020 } })

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
          _meta: {
            progressToken: 'p',
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        },
      }),
    })
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    expect(await sse.text()).toContain('notifications/progress')
  })

  it('persists the incident lifecycle through the public HTTP boundary', async () => {
    const base = await launch()
    const url = `${base}/raw/mcp`
    const created = await rpcCall(url, 'tools/call', {
      name: 'create_incident',
      arguments: { title: 'latency', severity: 'high', suspected_services: ['api'] },
    })
    const incidentId = String(
      (created.result as { structuredContent: { incident_id: string } }).structuredContent
        .incident_id,
    )
    const opened = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: incidentId },
    })
    expect(opened.result).toMatchObject({ structuredContent: { status: 'OPEN' } })

    await rpcCall(url, 'tools/call', {
      name: 'run_diagnostic',
      arguments: { incident_id: incidentId, service: 'api' },
    })
    const proposed = await rpcCall(url, 'tools/call', {
      name: 'propose_remediation',
      arguments: { incident_id: incidentId, finding: 'DB_LATENCY' },
    })
    const remediationId = String(
      (proposed.result as { structuredContent: { remediation_id: string } }).structuredContent
        .remediation_id,
    )
    const initial = await rpcCall(url, 'tools/call', {
      name: 'execute_remediation',
      arguments: { incident_id: incidentId, remediation_id: remediationId },
    })
    const requestState = (initial.result as { requestState: string }).requestState
    await rpcCall(url, 'tools/call', {
      name: 'execute_remediation',
      arguments: { incident_id: incidentId, remediation_id: remediationId },
      requestState,
      inputResponses: {
        approval: { action: 'accept', content: { decision: 'accept', confirmation: true } },
      },
    })
    const mitigated = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: incidentId },
    })
    expect(mitigated.result).toMatchObject({ structuredContent: { status: 'MITIGATED' } })

    await rpcCall(url, 'tools/call', {
      name: 'resolve_incident',
      arguments: { incident_id: incidentId, summary: 'resolved' },
    })
    const resolved = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: incidentId },
    })
    expect(resolved.result).toMatchObject({ structuredContent: { status: 'RESOLVED' } })

    const missing = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: 'missing' },
    })
    expect(missing.result).toMatchObject({ isError: true })
  })

  it('applies one effect under concurrent accepted HTTP retries', async () => {
    const base = await launch()
    const url = `${base}/raw/mcp`
    const argumentsValue = { incident_id: 'i', remediation_id: 'r' }
    const initial = await rpcCall(url, 'tools/call', {
      name: 'execute_remediation',
      arguments: argumentsValue,
    })
    const requestState = (initial.result as { requestState: string }).requestState
    const retries = await Promise.all(
      Array.from(
        { length: 20 },
        async (_, index) =>
          await rpcCall(
            url,
            'tools/call',
            {
              name: 'execute_remediation',
              arguments: argumentsValue,
              requestState,
              inputResponses: {
                approval: { action: 'accept', content: { decision: 'accept', confirmation: true } },
              },
            },
            index + 2,
          ),
      ),
    )
    const effects = retries.map(
      (retry) =>
        (retry.result as { structuredContent: { effect_count: number } }).structuredContent
          .effect_count,
    )
    expect(effects.reduce((sum, value) => sum + value, 0)).toBe(1)
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
      [
        'tools',
        'call',
        url,
        'query_telemetry',
        '{"incident_id":"i","service":"服务","signal":"latency","start":"2026-08-02T00:00:00Z","end":"2026-08-02T00:01:00Z"}',
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
