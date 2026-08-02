import { describe, expect, it } from 'vitest'
import {
  IncidentService,
  MemoryIncidentStore,
  type IncidentRecord,
} from '../../src/application/index.js'

type Result = {
  content?: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function structured(result: unknown): Record<string, unknown> {
  return (result as Result).structuredContent ?? {}
}

function expectCompatible(result: unknown): Record<string, unknown> {
  const value = result as Result
  expect(value.isError).toBe(false)
  expect(value.content).toEqual([{ type: 'text', text: JSON.stringify(value.structuredContent) }])
  return value.structuredContent ?? {}
}

describe('runtime incident service', () => {
  it('copies records and enforces compare-and-set transitions', async () => {
    const store = new MemoryIncidentStore()
    const source: IncidentRecord = {
      incidentId: 'i',
      status: 'OPEN',
      expiresAt: '2026-08-02T01:00:00Z',
    }
    await store.create(source)
    source.status = 'RESOLVED'
    expect(await store.get('i')).toEqual({
      incidentId: 'i',
      status: 'OPEN',
      expiresAt: '2026-08-02T01:00:00Z',
    })
    const fetched = await store.get('i')
    expect(fetched).toBeDefined()
    if (fetched !== undefined) fetched.status = 'INVESTIGATING'
    expect((await store.get('i'))?.status).toBe('OPEN')
    await expect(
      store.save({ incidentId: 'i', status: 'MITIGATED', expiresAt: source.expiresAt }, 'RESOLVED'),
    ).rejects.toThrow('Concurrent incident transition')
    expect(await store.ready()).toBe(true)
  })

  it('validates creation and emits exact compatibility output', async () => {
    const service = new IncidentService(new MemoryIncidentStore(), () => 0)
    const invalid = [
      {},
      { title: '', severity: 'high', suspected_services: [] },
      { title: 'x', suspected_services: [] },
      { title: 'x', severity: 'high', suspected_services: 'api' },
    ]
    for (const args of invalid) {
      await expect(service.call('create_incident', args)).resolves.toBeUndefined()
    }
    const result = await service.call('create_incident', {
      title: 'x',
      severity: 'high',
      suspected_services: ['api'],
    })
    const value = expectCompatible(result)
    expect(value.incident_id).toMatch(/^[0-9a-f-]{36}$/)
    expect({ ...value, incident_id: '<id>' }).toEqual({
      incident_id: '<id>',
      status: 'OPEN',
      expires_at: '1970-01-01T01:00:00.000Z',
    })
  })

  it('executes the complete lifecycle and exact timeline contract', async () => {
    let now = 0
    const store = new MemoryIncidentStore()
    const service = new IncidentService(store, () => now)
    const created = structured(
      await service.call('create_incident', {
        title: 'x',
        severity: 'high',
        suspected_services: ['api'],
      }),
    )
    const incidentId = String(created.incident_id)

    const opened = expectCompatible(await service.call('get_incident', { incident_id: incidentId }))
    expect(opened).toEqual({ incident_id: incidentId, status: 'OPEN', related_handles: [] })

    const premature = (await service.call('propose_remediation', {
      incident_id: incidentId,
      finding: 'DB_LATENCY',
    })) as Result
    expect(premature).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'Investigate the incident before proposing remediation.' }],
      isError: true,
    })

    const diagnostic = expectCompatible(
      await service.call('run_diagnostic', { incident_id: incidentId }),
    )
    expect(diagnostic.diagnostic_id).toMatch(/^[0-9a-f-]{36}$/)
    expect({ ...diagnostic, diagnostic_id: '<id>' }).toEqual({
      diagnostic_id: '<id>',
      findings: [
        {
          code: 'DB_LATENCY',
          service_id: 'api',
          summary: 'Database dependency latency is elevated',
        },
      ],
    })

    const proposed = expectCompatible(
      await service.call('propose_remediation', {
        incident_id: incidentId,
        finding: 'DB_LATENCY',
      }),
    )
    expect(proposed.remediation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect({ ...proposed, remediation_id: '<id>' }).toEqual({
      remediation_id: '<id>',
      action: 'throttle_synthetic_traffic',
      target: 'api',
      status: 'PROPOSED',
      effect: 'simulated',
    })
    const remediationId = String(proposed.remediation_id)
    await expect(service.markMitigated(incidentId, 'wrong')).resolves.toBe(false)
    await expect(service.markMitigated(incidentId, remediationId)).resolves.toBe(true)
    expect(structured(await service.call('get_incident', { incident_id: incidentId }))).toEqual({
      incident_id: incidentId,
      status: 'MITIGATED',
      related_handles: [],
    })

    const uri = `incident://incidents/${incidentId}/timeline`
    const timeline = await service.readTimeline(uri)
    expect(timeline).toEqual({
      resultType: 'complete',
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: '{"events":[{"service_id":"api","signal":"latency","severity":"high","timestamp":"2026-08-02T00:00:00Z"}]}',
        },
      ],
      ttlMs: 1000,
      cacheScope: 'private',
    })
    await expect(service.readTimeline(`prefix-${uri}`)).resolves.toBeUndefined()
    await expect(service.readTimeline(`${uri}/suffix`)).resolves.toBeUndefined()

    expectCompatible(
      await service.call('resolve_incident', { incident_id: incidentId, summary: 'done' }),
    )
    const afterResolved = (await service.call('run_diagnostic', {
      incident_id: incidentId,
      service: 'db',
    })) as Result
    expect(afterResolved.isError).toBe(true)

    now = 60 * 60_000
    const expired = (await service.call('get_incident', { incident_id: incidentId })) as Result
    expect(expired).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'Unknown or expired incident; create another incident.' }],
      isError: true,
    })
    await expect(service.readTimeline(uri)).resolves.toEqual(expired)
  })

  it('does not mutate incident storage after cancellation', async () => {
    const store = new MemoryIncidentStore()
    const controller = new AbortController()
    controller.abort()
    const record = { incidentId: 'i', status: 'OPEN' as const, expiresAt: '2026-08-02T01:00:00Z' }
    await expect(store.create(record, controller.signal)).rejects.toThrow('Operation aborted')
    await expect(store.get('i', controller.signal)).rejects.toThrow('Operation aborted')
    await expect(store.save(record, undefined, controller.signal)).rejects.toThrow(
      'Operation aborted',
    )
    await expect(
      new IncidentService(store).call(
        'create_incident',
        {
          title: 'x',
          severity: 'high',
          suspected_services: [],
        },
        controller.signal,
      ),
    ).rejects.toThrow('Operation aborted')
    await expect(store.get('i')).resolves.toBeUndefined()
  })

  it('rejects operations without handles or unsupported names', async () => {
    const service = new IncidentService(new MemoryIncidentStore(), () => 0)
    await expect(service.call('get_incident', {})).resolves.toBeUndefined()
    await expect(service.call('unknown', { incident_id: 'i' })).resolves.toBeUndefined()
    await expect(service.markMitigated('missing', 'r')).resolves.toBe(false)
  })
})
