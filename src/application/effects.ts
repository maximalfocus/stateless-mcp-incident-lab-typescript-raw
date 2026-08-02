export interface EffectStore {
  claim(remediationId: string): Promise<boolean>
  ready(): Promise<boolean>
}

export class MemoryEffectStore implements EffectStore {
  readonly #claimed = new Set<string>()

  claim(remediationId: string): Promise<boolean> {
    if (this.#claimed.has(remediationId)) return Promise.resolve(false)
    this.#claimed.add(remediationId)
    return Promise.resolve(true)
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true)
  }
}
