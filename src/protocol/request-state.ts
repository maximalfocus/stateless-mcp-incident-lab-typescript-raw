import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const EPHEMERAL_DEVELOPMENT_SECRET = randomBytes(32)

function secret(): Buffer | string {
  const configured = process.env.MCP_REQUEST_STATE_SECRET
  if (configured !== undefined && Buffer.byteLength(configured) >= 32) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MCP_REQUEST_STATE_SECRET must contain at least 32 bytes')
  }
  return EPHEMERAL_DEVELOPMENT_SECRET
}

export type RequestStateClaims = {
  method: string
  argumentsHash: string
  expiresAt: string
}

export function signRequestState(claims: RequestStateClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyRequestState(value: string): RequestStateClaims | undefined {
  const [payload, signature, extra] = value.split('.')
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined
  const expected = createHmac('sha256', secret()).update(payload).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, 'base64url')
  } catch {
    return undefined
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (
      typeof claims !== 'object' ||
      claims === null ||
      typeof (claims as Record<string, unknown>).method !== 'string' ||
      typeof (claims as Record<string, unknown>).argumentsHash !== 'string' ||
      typeof (claims as Record<string, unknown>).expiresAt !== 'string'
    ) {
      return undefined
    }
    return claims as RequestStateClaims
  } catch {
    return undefined
  }
}
