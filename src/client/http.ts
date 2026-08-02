const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/
const SAFE_HEADER_VALUE = /^[\x20-\x7e]*$/

export function encodeHeaderValue(value: string): string {
  return SAFE_HEADER_VALUE.test(value)
    ? value
    : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export function decodeHeaderValue(value: string): string {
  const match = SENTINEL.exec(value)
  if (match === null) return value
  const encoded = match[1]
  if (encoded === undefined) throw new TypeError('Malformed Base64 sentinel')
  return Buffer.from(encoded, 'base64').toString('utf8')
}

export function deriveParameterHeader(
  argumentsValue: Record<string, unknown>,
  argument: string,
  header: string,
): Record<string, string> {
  const value = argumentsValue[argument]
  if (value === undefined || value === null) return {}
  let scalar: string
  if (typeof value === 'string') scalar = value
  else if (typeof value === 'number' && Number.isFinite(value)) scalar = String(value)
  else if (typeof value === 'boolean') scalar = value ? 'true' : 'false'
  else throw new TypeError(`Annotated argument ${argument} must be a scalar`)
  return { [`Mcp-Param-${header}`]: encodeHeaderValue(scalar) }
}

export function validHeaderAnnotation(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}
