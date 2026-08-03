import { discoveryResult, PROTOCOL_VERSION } from '../protocol/version.js'

export function discoverWithVersionRecovery(
  offeredVersions: readonly unknown[],
): Record<string, unknown> {
  const attempts: Record<string, unknown>[] = []
  for (let index = 0; index < offeredVersions.length; index += 1) {
    const version = offeredVersions[index]
    if (typeof version !== 'string') continue
    if (version === PROTOCOL_VERSION) {
      attempts.push({ id: index + 1, version, result: discoveryResult() })
      return { attempts, selected_version: version }
    }
    attempts.push({
      id: index + 1,
      version,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { requested: version, supported: [PROTOCOL_VERSION] },
      },
    })
  }
  return { attempts, selected_version: null }
}
