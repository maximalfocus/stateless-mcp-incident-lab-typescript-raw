import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEffectStoreFromEnv, DynamoEffectStore } from '../../src/adapters/outbound/index.js'

const originalTable = process.env.DYNAMODB_TABLE
afterEach(() => {
  if (originalTable === undefined) delete process.env.DYNAMODB_TABLE
  else process.env.DYNAMODB_TABLE = originalTable
  vi.restoreAllMocks()
})

describe('DynamoDB effect store', () => {
  it('claims an effect and recognizes a conditional duplicate', async () => {
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' })
    const store = new DynamoEffectStore('effects', undefined, { send })
    expect(await store.claim('r')).toBe(true)
    expect(await store.claim('r')).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('atomically claims an effect and mitigates its incident', async () => {
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ name: 'TransactionCanceledException' })
      .mockRejectedValueOnce(new Error('transaction unavailable'))
    const store = new DynamoEffectStore('effects', undefined, { send })
    await expect(store.claimAndMitigate('i', 'r')).resolves.toBe(true)
    await expect(store.claimAndMitigate('i', 'r')).resolves.toBe(false)
    await expect(store.claimAndMitigate('i', 'r')).rejects.toThrow('transaction unavailable')
    const input = (send.mock.calls[0]?.[0] as { input?: { TransactItems?: unknown[] } }).input
    expect(input?.TransactItems).toHaveLength(2)
  })

  it('persists incident records in the same DynamoDB table', async () => {
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          status: { S: 'INVESTIGATING' },
          expires_at: { S: '2026-08-02T01:00:00Z' },
          remediation_id: { S: 'r' },
        },
      })
      .mockResolvedValueOnce({})
    const store = new DynamoEffectStore('incidents', undefined, { send })
    await store.create({
      incidentId: 'i',
      status: 'OPEN',
      expiresAt: '2026-08-02T01:00:00Z',
    })
    await expect(store.get('i')).resolves.toEqual({
      incidentId: 'i',
      status: 'INVESTIGATING',
      expiresAt: '2026-08-02T01:00:00Z',
      remediationId: 'r',
    })
    await store.save({
      incidentId: 'i',
      status: 'MITIGATED',
      expiresAt: '2026-08-02T01:00:00Z',
      remediationId: 'r',
    })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('propagates storage failures and reports readiness', async () => {
    const failure = new Error('unavailable')
    const failedSend = vi.fn<(command: unknown) => Promise<unknown>>().mockRejectedValue(failure)
    const failed = new DynamoEffectStore('effects', undefined, { send: failedSend })
    await expect(failed.claim('r')).rejects.toThrow('unavailable')
    expect(await failed.ready()).toBe(false)

    const readySend = vi.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({})
    expect(await new DynamoEffectStore('effects', undefined, { send: readySend }).ready()).toBe(
      true,
    )
  })

  it('requires a table name and creates the configured adapter', () => {
    expect(() => new DynamoEffectStore('')).toThrow('table name')
    delete process.env.DYNAMODB_TABLE
    expect(createEffectStoreFromEnv()).toBeUndefined()
    process.env.DYNAMODB_TABLE = 'effects'
    expect(createEffectStoreFromEnv()).toBeInstanceOf(DynamoEffectStore)
  })
})
