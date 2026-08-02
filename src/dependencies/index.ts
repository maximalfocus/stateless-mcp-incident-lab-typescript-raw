import { existsSync, readFileSync } from 'node:fs'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isObject(value)) throw new TypeError(`${path} must contain an object`)
  return value
}

function suppressionViolations(requiredFields: string[]): string[] {
  if (!existsSync('dependency-exceptions.json')) return []
  const document = readObject('dependency-exceptions.json')
  const suppressions = Array.isArray(document.suppressions) ? document.suppressions : []
  return suppressions.flatMap((value, index) => {
    if (!isObject(value)) return [`suppressions[${String(index)}] must be an object`]
    const missing = requiredFields.filter((field) => !(field in value))
    if (typeof value.expires_at === 'string' && Date.parse(value.expires_at) <= Date.now()) {
      missing.push('expires_at must be in the future')
    }
    return missing.map((field) => `suppressions[${String(index)}]: ${field}`)
  })
}

export function executeFunction(inputValue: unknown): unknown {
  if (!isObject(inputValue) || typeof inputValue.subject !== 'string') {
    throw new TypeError('Dependency subject is required')
  }
  const packageJson = readObject('package.json')
  const lock = readObject('package-lock.json')
  if (inputValue.subject === 'dependency_install') {
    const root = isObject(lock.packages) && isObject(lock.packages['']) ? lock.packages[''] : {}
    const reproducible =
      typeof lock.lockfileVersion === 'number' &&
      root.name === packageJson.name &&
      root.version === packageJson.version
    return {
      violations: reproducible ? [] : ['package metadata and lockfile root differ'],
      lockfiles: ['package-lock.json'],
      resolution_reproducible: reproducible,
    }
  }
  if (inputValue.subject === 'runtime_licenses') {
    const allowed = new Set(
      Array.isArray(inputValue.allow)
        ? inputValue.allow.filter((value): value is string => typeof value === 'string')
        : [],
    )
    const packages = isObject(lock.packages) ? lock.packages : {}
    const exceptions = existsSync('dependency-exceptions.json')
      ? readObject('dependency-exceptions.json')
      : {}
    const suppressions = Array.isArray(exceptions.suppressions) ? exceptions.suppressions : []
    const violations = Object.entries(packages)
      .filter(([path, value]) => path !== '' && isObject(value) && value.dev !== true)
      .flatMap(([path, value]) => {
        const license = isObject(value) && typeof value.license === 'string' ? value.license : ''
        const excepted = suppressions.some(
          (item) => isObject(item) && item.package === path && item.license === license,
        )
        return allowed.has(license) || excepted
          ? []
          : [`${path}: unapproved license ${license || '<missing>'}`]
      })
      .sort()
    return { violations }
  }
  if (inputValue.subject === 'npm_audit') {
    if (!isObject(inputValue.report) || !isObject(inputValue.report.vulnerabilities)) {
      throw new TypeError('npm audit report is required')
    }
    const unsuppressed = Object.entries(inputValue.report.vulnerabilities)
      .filter(
        ([, value]) =>
          isObject(value) && (value.severity === 'high' || value.severity === 'critical'),
      )
      .map(([name, value]) => `${name}:${String(isObject(value) ? value.severity : 'unknown')}`)
      .sort()
    return { violations: unsuppressed, unsuppressed }
  }
  if (inputValue.subject === 'vulnerability_suppressions') {
    const required = Array.isArray(inputValue.required_fields)
      ? inputValue.required_fields.filter((value): value is string => typeof value === 'string')
      : []
    return { violations: suppressionViolations(required) }
  }
  if (inputValue.subject === 'raw_dependency_graph') {
    const forbidden = Array.isArray(inputValue.forbidden)
      ? inputValue.forbidden.filter((value): value is string => typeof value === 'string')
      : []
    const packages = isObject(lock.packages) ? lock.packages : {}
    const matched = Object.entries(packages)
      .filter(([path, value]) => {
        const name = isObject(value) && typeof value.name === 'string' ? value.name : ''
        return forbidden.some(
          (item) =>
            name === item ||
            path === `node_modules/${item}` ||
            path.endsWith(`/node_modules/${item}`),
        )
      })
      .map(([, value]) => (isObject(value) && typeof value.name === 'string' ? value.name : ''))
    return {
      violations: matched.length === 0 ? [] : ['forbidden SDK dependency'],
      matched_packages: matched,
    }
  }
  throw new RangeError(`Unsupported dependency subject: ${inputValue.subject}`)
}
