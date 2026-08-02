export function healthResponse(dependenciesReady: boolean): Record<string, unknown> {
  return {
    status: dependenciesReady ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
    body: { status: dependenciesReady ? 'ok' : 'unavailable' },
  }
}
