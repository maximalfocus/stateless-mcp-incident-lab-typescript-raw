import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawServer, startRawServer } from '../../src/adapters/inbound/index.js'
import { MemoryIncidentStore } from '../../src/application/index.js'
import { ResponseCache } from '../../src/client/cache.js'
import { clearResponseCache, rpcCall, runNetworkCli } from '../../src/client/cli.js'
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

async function proposedIncidentStore(): Promise<MemoryIncidentStore> {
  const store = new MemoryIncidentStore()
  await store.create({
    incidentId: 'i',
    status: 'INVESTIGATING',
    remediationId: 'r',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  return store
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

  it('uses cache hints and honors cache bypass in the network client', async () => {
    clearResponseCache()
    const base = await launch()
    const url = `${base}/raw/mcp`
    const realFetch = globalThis.fetch
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      calls += 1
      return await realFetch(...args)
    })
    await rpcCall(url, 'tools/list')
    await rpcCall(url, 'tools/list')
    expect(calls).toBe(1)
    await rpcCall(url, 'tools/list', {}, 2, { noCache: true })
    expect(calls).toBe(2)

    let now = 0
    const cache = new ResponseCache<string>(() => now)
    expect(cache.get('missing')).toBeUndefined()
    cache.set('ignored', 'value', -1)
    cache.set('key', 'value', 1)
    now = 2
    expect(cache.get('key')).toBeUndefined()
    expect(cache.get('key', true)).toBe('value')
    cache.clear()
    expect(cache.get('key', true)).toBeUndefined()
  })

  it('persists the incident lifecycle through the public HTTP boundary', async () => {
    const base = await launch()
    const url = `${base}/raw/mcp`
    const created = await rpcCall(url, 'tools/call', {
      name: 'create_incident',
      arguments: { title: 'latency', severity: 'high', suspected_services: ['api'] },
    })
    const incidentId = (created.result as { structuredContent: { incident_id: string } })
      .structuredContent.incident_id
    const opened = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: incidentId },
    })
    expect(opened.result).toMatchObject({ structuredContent: { status: 'OPEN' } })
    const timeline = await rpcCall(url, 'resources/read', {
      uri: `incident://incidents/${incidentId}/timeline`,
    })
    expect(timeline.result).toMatchObject({
      cacheScope: 'private',
      contents: [{ mimeType: 'application/json' }],
    })

    const premature = await rpcCall(url, 'tools/call', {
      name: 'propose_remediation',
      arguments: { incident_id: incidentId, finding: 'DB_LATENCY' },
    })
    expect(premature.result).toMatchObject({ isError: true })

    await rpcCall(url, 'tools/call', {
      name: 'run_diagnostic',
      arguments: { incident_id: incidentId, service: 'api' },
    })
    const proposed = await rpcCall(url, 'tools/call', {
      name: 'propose_remediation',
      arguments: { incident_id: incidentId, finding: 'DB_LATENCY' },
    })
    const remediationId = (proposed.result as { structuredContent: { remediation_id: string } })
      .structuredContent.remediation_id
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
    const afterResolution = await rpcCall(url, 'tools/call', {
      name: 'run_diagnostic',
      arguments: { incident_id: incidentId, service: 'api' },
    })
    expect(afterResolution.result).toMatchObject({ isError: true })

    const missing = await rpcCall(url, 'tools/call', {
      name: 'get_incident',
      arguments: { incident_id: 'missing' },
    })
    expect(missing.result).toMatchObject({ isError: true })
  })

  it('cancels live SSE work when the client disconnects', async () => {
    let cancellations = 0
    const base = await launch({
      diagnosticIntervalMs: 100,
      diagnosticCancelled: () => {
        cancellations += 1
      },
      telemetry: () => undefined,
    })
    const controller = new AbortController()
    const response = await fetch(`${base}/raw/mcp`, {
      method: 'POST',
      signal: controller.signal,
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
    await response.body?.getReader().read()
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(cancellations).toBe(1)
  })

  it('closes an SSE stream when its post-header deadline expires', async () => {
    let cancellations = 0
    const base = await launch({
      deadlineMs: 10,
      diagnosticIntervalMs: 100,
      diagnosticCancelled: () => {
        cancellations += 1
      },
      telemetry: () => undefined,
    })
    const response = await fetch(`${base}/raw/mcp`, {
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
    if (response.body === null) throw new Error('expected an SSE response body')
    const reader = response.body.getReader()
    await reader.read()
    const outcome = await Promise.race([
      reader.read().then(
        () => 'closed',
        () => 'closed',
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          resolve('timeout')
        }, 250),
      ),
    ])
    expect(outcome).toBe('closed')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(cancellations).toBe(1)
  })

  it('fails closed on malformed progress tokens and consumes live SSE finals', async () => {
    const store = new MemoryIncidentStore()
    await store.create({
      incidentId: 'streamed',
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const base = await launch({ incidentStore: store, diagnosticIntervalMs: 0 })
    const malformed = await fetch(`${base}/raw/mcp`, {
      method: 'POST',
      headers: {
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
          arguments: { incident_id: 'streamed', service: 'api' },
          _meta: {
            progressToken: {},
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        },
      }),
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: -32602 } })

    const streamed = await rpcCall(base + '/raw/mcp', 'tools/call', {
      name: 'run_diagnostic',
      arguments: { incident_id: 'streamed', service: 'api' },
      _meta: { progressToken: 'progress-1' },
    })
    expect(streamed.result).toMatchObject({
      structuredContent: { findings: [{ code: 'DB_LATENCY' }] },
    })
  })

  it('validates signed request state before looking up remediation ownership', async () => {
    const base = await launch({ incidentStore: new MemoryIncidentStore() })
    const response = await rpcCall(base + '/raw/mcp', 'tools/call', {
      name: 'execute_remediation',
      arguments: { incident_id: 'missing', remediation_id: 'forged' },
      requestState: 'tampered',
      inputResponses: {
        approval: { action: 'accept', content: { decision: 'accept', confirmation: true } },
      },
    })
    expect(response).toMatchObject({ error: { code: -32602, data: { reason: 'tampered' } } })
  })

  it('rejects execution for an unproposed remediation before claiming an effect', async () => {
    const claim = vi.fn(() => Promise.resolve(true))
    const base = await launch({ effectStore: { claim, ready: () => Promise.resolve(true) } })
    const response = await rpcCall(base + '/raw/mcp', 'tools/call', {
      name: 'execute_remediation',
      arguments: { incident_id: 'missing', remediation_id: 'forged' },
    })
    expect(response.result).toMatchObject({ isError: true })
    expect(claim).not.toHaveBeenCalled()
  })

  it('enforces live request deadlines without applying a late effect', async () => {
    let effectApplied = false
    const effectStore = {
      ready: () => Promise.resolve(true),
      claim: (_remediationId: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            effectApplied = true
            resolve(true)
          }, 100)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve(false)
            },
            { once: true },
          )
        }),
    }
    const base = await launch({
      deadlineMs: 10,
      effectStore,
      incidentStore: await proposedIncidentStore(),
      telemetry: () => undefined,
    })
    const url = `${base}/raw/mcp`
    const args = { incident_id: 'i', remediation_id: 'r' }
    const initial = await rpcCall(url, 'tools/call', {
      name: 'execute_remediation',
      arguments: args,
    })
    const requestState = (initial.result as { requestState: string }).requestState
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'execute_remediation',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'execute_remediation',
          arguments: args,
          requestState,
          inputResponses: {
            approval: { action: 'accept', content: { decision: 'accept', confirmation: true } },
          },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        },
      }),
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ id: 2, error: { code: -31998 } })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(effectApplied).toBe(false)
  })

  it('emits correlated redacted telemetry from live requests', async () => {
    const records: Array<Record<string, unknown>> = []
    const base = await launch({ telemetry: (record) => records.push(record) })
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    await rpcCall(`${base}/raw/mcp`, 'resources/read', {
      uri: 'incident://incidents/secret/timeline',
      _meta: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    })
    expect(records).toContainEqual(
      expect.objectContaining({
        method: 'resources/read',
        name: '[REDACTED]',
        result_type: 'error',
        trace_id: traceId,
      }),
    )
    expect(JSON.stringify(records)).not.toContain('secret')
  })

  it('keeps live decline and cancel statuses inside the advertised output schema', async () => {
    const base = await launch({ incidentStore: await proposedIncidentStore() })
    const url = `${base}/raw/mcp`
    const argumentsValue = { incident_id: 'i', remediation_id: 'r' }
    const initial = await rpcCall(url, 'tools/call', {
      name: 'execute_remediation',
      arguments: argumentsValue,
    })
    const requestState = (initial.result as { requestState: string }).requestState
    for (const [action, status] of [
      ['decline', 'DECLINED'],
      ['cancel', 'CANCELLED'],
    ] as const) {
      const result = await rpcCall(url, 'tools/call', {
        name: 'execute_remediation',
        arguments: argumentsValue,
        requestState,
        inputResponses: { approval: { action } },
      })
      expect(result.result).toMatchObject({ structuredContent: { status, effect_count: 0 } })
    }
  })

  it('applies one effect under concurrent accepted HTTP retries', async () => {
    const base = await launch({ incidentStore: await proposedIncidentStore() })
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

  it('reissues a broken SSE request with a new JSON-RPC id', async () => {
    const requestIds: unknown[] = []
    let attempt = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      requestIds.push(request.id)
      attempt += 1
      if (attempt === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: message\ndata: {"method":"notifications/progress"}\n\n',
              ),
            )
            controller.error(new Error('broken stream'))
          },
        })
        return Promise.resolve(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        )
      }
      return Promise.resolve(
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete' } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
    })
    await expect(
      rpcCall('https://example.test/raw/mcp', 'tools/call', {
        name: 'run_diagnostic',
        arguments: { incident_id: 'i', service: 'api' },
        _meta: { progressToken: 'p' },
      }),
    ).resolves.toMatchObject({ result: { resultType: 'complete' } })
    expect(requestIds).toEqual([1, 2])
  })

  it('accepts the documented --json marker on the network CLI', async () => {
    clearResponseCache()
    const store = new MemoryIncidentStore()
    const base = await launch({ incidentStore: store })
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    expect(
      await runNetworkCli([
        'tools',
        'call',
        `${base}/raw/mcp`,
        'create_incident',
        '--json',
        JSON.stringify({ title: 'API latency', severity: 'high', suspected_services: ['api'] }),
      ]),
    ).toBe(0)
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      structuredContent: { status: 'OPEN' },
    })
  })

  it('walks opaque list cursors, including the empty string, to a complete CLI snapshot', async () => {
    clearResponseCache()
    const requests: Array<Record<string, unknown>> = []
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      requests.push(request)
      const params = (request.params ?? {}) as Record<string, unknown>
      const first = !Object.hasOwn(params, 'cursor')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              tools: [{ name: first ? 'first' : 'second' }],
              ...(first ? { nextCursor: '' } : {}),
              ttlMs: first ? 100 : 50,
              cacheScope: 'public',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    })
    expect(await runNetworkCli(['tools', 'list', 'https://example.test/raw/mcp'])).toBe(0)
    expect(requests.map((request) => request.id)).toEqual([1, 2])
    expect((requests[1]?.params as Record<string, unknown>).cursor).toBe('')
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      tools: [{ name: 'first' }, { name: 'second' }],
      ttlMs: 50,
      cacheScope: 'public',
    })
  })

  it('serves a stale list snapshot with a warning when the forced refresh fails', async () => {
    clearResponseCache()
    const output: string[] = []
    const warnings: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk))
      return true
    })
    let online: boolean = true
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (!online) return Promise.reject(new Error('fetch failed'))
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              tools: [{ name: 'cached' }],
              ttlMs: 0,
              cacheScope: 'public',
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
    })
    expect(await runNetworkCli(['tools', 'list', 'https://stale.test/raw/mcp'])).toBe(0)
    online = false
    output.length = 0
    expect(await runNetworkCli(['tools', 'list', 'https://stale.test/raw/mcp'])).toBe(0)
    expect(warnings.join('')).toContain('Refresh failed; serving stale cached data.')
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ tools: [{ name: 'cached' }] })
    clearResponseCache()
  })

  it('bounds a server-controlled list cursor walk', async () => {
    clearResponseCache()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let page = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      page += 1
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              tools: [],
              nextCursor: `cursor-${String(page)}`,
              ttlMs: 0,
              cacheScope: 'public',
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
    })
    expect(await runNetworkCli(['tools', 'list', 'https://endless.test/raw/mcp'])).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(100)
    clearResponseCache()
  })

  it('reports a JSON-RPC error from tools inspect instead of a null tool', async () => {
    clearResponseCache()
    const errors: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: 'Internal error' },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
    })
    expect(
      await runNetworkCli(['tools', 'inspect', 'https://broken.test/raw/mcp', 'run_diagnostic']),
    ).toBe(3)
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ code: -32603 })
  })

  it('exits 3 when tools inspect names a tool the catalog does not advertise', async () => {
    clearResponseCache()
    const base = await launch()
    const errors: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    expect(await runNetworkCli(['tools', 'inspect', `${base}/raw/mcp`, 'no_such_tool'])).toBe(3)
    expect(errors.join('')).toContain('Unknown tool')
    clearResponseCache()
  })

  it('rejects malformed, cyclic, and cache-scope-inconsistent list pages', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let mode: 'malformed' | 'cursor' | 'scope' = 'malformed'
    let page = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
      const request = JSON.parse(init.body) as Record<string, unknown>
      page += 1
      const result =
        mode === 'malformed'
          ? { resultType: 'complete', ttlMs: 10, cacheScope: 'public' }
          : mode === 'cursor'
            ? {
                resultType: 'complete',
                tools: [],
                nextCursor: 7,
                ttlMs: 10,
                cacheScope: 'public',
              }
            : {
                resultType: 'complete',
                tools: [],
                ...(page === 1 ? { nextCursor: 'next' } : {}),
                ttlMs: 10,
                cacheScope: page === 1 ? 'public' : 'private',
              }
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    expect(await runNetworkCli(['tools', 'list', 'https://malformed.test/raw/mcp'])).toBe(5)
    mode = 'cursor'
    page = 0
    expect(await runNetworkCli(['tools', 'list', 'https://cursor.test/raw/mcp'])).toBe(5)
    mode = 'scope'
    page = 0
    expect(await runNetworkCli(['tools', 'list', 'https://scope.test/raw/mcp'])).toBe(5)
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
      ['resources', 'read', url, 'incident://runbooks/database'],
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
