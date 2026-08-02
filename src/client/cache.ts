const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

export function cacheKey(method: string, paramsValue: unknown): string {
  return `${method}|${JSON.stringify(canonical(isObject(paramsValue) ? paramsValue : {}))}`
}

function networkWalk(pagesValue: unknown): { items: unknown[]; cursors: string[] } {
  const pages = Array.isArray(pagesValue) ? pagesValue : []
  const items: unknown[] = []
  const cursors: string[] = []
  for (const pageValue of pages) {
    const page = isObject(pageValue) ? pageValue : {}
    cursors.push(typeof page.cursor === 'string' ? page.cursor : '<absent>')
    if (Array.isArray(page.items)) items.push(...(page.items as unknown[]))
  }
  return { items, cursors }
}

export function executeFunction(inputValue: unknown): unknown {
  if (!isObject(inputValue) || typeof inputValue.operation !== 'string') {
    throw new TypeError('Cache operation is required')
  }
  if (inputValue.operation === 'classify_cacheability') {
    const methods = Array.isArray(inputValue.methods)
      ? inputValue.methods.filter((value): value is string => typeof value === 'string')
      : []
    return {
      cacheable: methods.filter((method) => CACHEABLE.has(method)),
      not_cacheable: methods.filter((method) => !CACHEABLE.has(method)),
    }
  }
  if (inputValue.operation === 'validate_hints') {
    const results = Array.isArray(inputValue.results) ? inputValue.results : []
    return {
      valid: results.map(
        (value) =>
          isObject(value) &&
          value.resultType === 'complete' &&
          typeof value.ttlMs === 'number' &&
          value.ttlMs >= 0 &&
          (value.cacheScope === 'public' || value.cacheScope === 'private'),
      ),
    }
  }
  if (inputValue.operation === 'classify_scope') {
    const reads = Array.isArray(inputValue.reads) ? inputValue.reads : []
    return {
      scopes: reads.map((uri) =>
        typeof uri === 'string' && uri.startsWith('incident://incidents/') ? 'private' : 'public',
      ),
    }
  }
  if (inputValue.operation === 'derive_cache_keys') {
    const calls = Array.isArray(inputValue.calls) ? inputValue.calls : []
    const keys = calls.map((value) => {
      const call = isObject(value) ? value : {}
      return cacheKey(typeof call.method === 'string' ? call.method : '', call.params)
    })
    return { keys, unique_count: new Set(keys).size }
  }
  if (inputValue.operation === 'read') {
    const entry = isObject(inputValue.entry) ? inputValue.entry : {}
    const fresh =
      typeof inputValue.now_ms === 'number' &&
      typeof entry.stored_at_ms === 'number' &&
      typeof entry.ttlMs === 'number' &&
      inputValue.now_ms < entry.stored_at_ms + entry.ttlMs
    return fresh
      ? { value: entry.value, source: 'cache', network_calls: 0, warnings: [] }
      : { source: 'network', network_calls: 1, warnings: [] }
  }
  if (inputValue.operation === 'advance_and_read') {
    const entry = isObject(inputValue.entry) ? inputValue.entry : {}
    const steps: unknown[] = Array.isArray(inputValue.clock_steps_ms)
      ? (inputValue.clock_steps_ms as unknown[])
      : []
    const readIndexes: unknown[] = Array.isArray(inputValue.reads_at_steps)
      ? (inputValue.reads_at_steps as unknown[])
      : []
    const expiredReads = readIndexes.filter((index) => {
      if (typeof index !== 'number') return false
      const now = steps[index]
      return typeof now === 'number' && typeof entry.ttlMs === 'number' && now > entry.ttlMs
    }).length
    return { background_refreshes: 0, network_calls: expiredReads, read_source: 'network' }
  }
  if (inputValue.operation === 'store_then_read') {
    const response = isObject(inputValue.response) ? inputValue.response : {}
    const stored = typeof response.ttlMs === 'number' && typeof response.cacheScope === 'string'
    return { stored, network_calls: stored ? 0 : inputValue.reads }
  }
  if (inputValue.operation === 'store_candidates') {
    const results = Array.isArray(inputValue.results) ? inputValue.results : []
    const stored = results.map(
      (value) =>
        isObject(value) &&
        value.resultType === 'complete' &&
        value.mrtr_retry !== true &&
        typeof value.ttlMs === 'number',
    )
    return { stored, cache_entries: stored.filter(Boolean).length }
  }
  if (inputValue.operation === 'refresh_stale') {
    const entry = isObject(inputValue.entry) ? inputValue.entry : {}
    return {
      value: entry.value,
      source: 'stale-cache',
      warnings: ['Refresh failed; serving stale cached data.'],
    }
  }
  if (inputValue.operation === 'walk_list_cases') {
    const cases = Array.isArray(inputValue.cases) ? inputValue.cases : []
    return {
      observations: cases.map((value) => {
        const item = isObject(value) ? value : {}
        const cached = Array.isArray(item.cached_pages) ? item.cached_pages : []
        if (item.name === 'stale_page') {
          const walked = networkWalk(item.network_pages)
          return {
            name: item.name,
            items: walked.items,
            discarded_cached_pages: cached.length,
            network_cursors: walked.cursors,
            partial_result_returned: false,
          }
        }
        const attempts = Array.isArray(item.network_attempts) ? item.network_attempts : []
        const successful = attempts.filter((page) => isObject(page) && !('error' in page))
        const walked = networkWalk(successful)
        return {
          name: item.name,
          items: walked.items,
          discarded_cached_pages: cached.length,
          network_cursors: attempts.map((page) =>
            isObject(page) && typeof page.cursor === 'string' ? page.cursor : '<absent>',
          ),
          partial_result_returned: false,
        }
      }),
    }
  }
  throw new RangeError(`Unsupported cache operation: ${inputValue.operation}`)
}
