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
