export interface EffectStore {
  claim(remediationId: string, signal?: AbortSignal): Promise<boolean>
  ready(): Promise<boolean>
}

export class MemoryEffectStore implements EffectStore {
  readonly #claimed = new Set<string>()

  claim(remediationId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error('Operation aborted'),
      )
    }
    if (this.#claimed.has(remediationId)) return Promise.resolve(false)
    this.#claimed.add(remediationId)
    return Promise.resolve(true)
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true)
  }
}
