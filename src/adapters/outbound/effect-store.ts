import { DescribeTableCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { EffectStore } from '../../application/effects.js'

type DynamoClient = {
  send(command: PutItemCommand | DescribeTableCommand): Promise<unknown>
}

export class DynamoEffectStore implements EffectStore {
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
