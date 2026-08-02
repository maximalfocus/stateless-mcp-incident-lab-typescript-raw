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
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new TypeError('Malformed Base64 sentinel')
  }
  return decoded.toString('utf8')
}
