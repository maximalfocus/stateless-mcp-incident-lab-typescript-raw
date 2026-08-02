import {
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import type { EffectStore } from '../../application/effects.js'
import type { IncidentRecord, IncidentStore } from '../../application/incidents.js'

type DynamoClient = {
  send(command: unknown): Promise<unknown>
}

type DynamoResult = { Item?: Record<string, { S?: string }> }

export class DynamoEffectStore implements EffectStore, IncidentStore {
  readonly #client: DynamoClient
  readonly #tableName: string

  constructor(tableName: string, endpoint = process.env.DYNAMODB_ENDPOINT, client?: DynamoClient) {
    if (tableName.length === 0) throw new TypeError('DynamoDB table name is required')
    this.#tableName = tableName
    this.#client =
      client ??
      new DynamoDBClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
        ...(endpoint === undefined ? {} : { endpoint }),
      })
  }

  async claim(remediationId: string): Promise<boolean> {
    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            PK: { S: `REMEDIATION#${remediationId}` },
            SK: { S: 'EFFECT' },
            status: { S: 'EXECUTED' },
            executed_at: { S: new Date().toISOString() },
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
      return true
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'ConditionalCheckFailedException'
      ) {
        return false
      }
      throw error
    }
  }

  async create(record: IncidentRecord): Promise<void> {
    await this.#putIncident(record, 'attribute_not_exists(PK)')
  }

  async get(incidentId: string): Promise<IncidentRecord | undefined> {
    const result = (await this.#client.send(
      new GetItemCommand({
        TableName: this.#tableName,
        Key: { PK: { S: `INCIDENT#${incidentId}` }, SK: { S: 'STATE' } },
        ConsistentRead: true,
      }),
    )) as DynamoResult
    const item = result.Item
    const status = item?.status?.S
    const expiresAt = item?.expires_at?.S
    if (
      item === undefined ||
      !['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED'].includes(status ?? '') ||
      expiresAt === undefined
    ) {
      return undefined
    }
    const remediationId = item.remediation_id?.S
    return {
      incidentId,
      status: status as IncidentRecord['status'],
      expiresAt,
      ...(remediationId === undefined ? {} : { remediationId }),
    }
  }

  save(record: IncidentRecord): Promise<void> {
    return this.#putIncident(record)
  }

  async #putIncident(record: IncidentRecord, conditionExpression?: string): Promise<void> {
    await this.#client.send(
      new PutItemCommand({
        TableName: this.#tableName,
        Item: {
          PK: { S: `INCIDENT#${record.incidentId}` },
          SK: { S: 'STATE' },
          status: { S: record.status },
          expires_at: { S: record.expiresAt },
          expires_at_epoch: { N: String(Math.floor(Date.parse(record.expiresAt) / 1000)) },
          ...(record.remediationId === undefined
            ? {}
            : { remediation_id: { S: record.remediationId } }),
        },
        ...(conditionExpression === undefined ? {} : { ConditionExpression: conditionExpression }),
      }),
    )
  }

  async ready(): Promise<boolean> {
    try {
      await this.#client.send(new DescribeTableCommand({ TableName: this.#tableName }))
      return true
    } catch {
      return false
    }
  }
}

export function createEffectStoreFromEnv(): DynamoEffectStore | undefined {
  const tableName = process.env.DYNAMODB_TABLE
  return tableName === undefined ? undefined : new DynamoEffectStore(tableName)
}
