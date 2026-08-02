#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type TestMetadata = {
  spec_id: string
  boundary: string
  normalisation?: string[]
  property?: Record<string, Json>
}
type Fixture = {
  dir: string
  relativeDir: string
  category: string
  test: TestMetadata
  input: Json
  request: Json
  seed: Json
  expected: Json
}
type Result = { specId: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail?: string }

const DEFAULT_CONFORMANCE = '../stateless-mcp-incident-lab-conformance/conformance'
const ROOT = resolve(process.env.CONFORMANCE_PATH ?? DEFAULT_CONFORMANCE)
const ALLOW_EXTRA = '{{ALLOW_EXTRA}}'
const PLACEHOLDERS = new Set([
  '{{ANY_STRING}}',
  '{{GENERATED_ID}}',
  '{{TIMESTAMP}}',
  '{{ALLOW_EXTRA}}',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function placeholderTemplate(expected: string): RegExp | undefined {
  if (!expected.includes('{{')) return undefined
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\\\{\\\{(?:ANY_STRING|GENERATED_ID|TIMESTAMP)\\\}\\\}/g, '[^"]+')
  return pattern === escaped ? undefined : new RegExp(`^${pattern}$`)
}

export function matchValue(expected: unknown, actual: unknown, path = '$'): string[] {
  if (typeof expected === 'string' && PLACEHOLDERS.has(expected)) {
    if (expected === '{{ANY_STRING}}' && typeof actual !== 'string')
      return [`${path}: expected string`]
    if (expected === '{{GENERATED_ID}}' && (typeof actual !== 'string' || actual.length === 0)) {
      return [`${path}: expected generated identifier`]
    }
    if (
      expected === '{{TIMESTAMP}}' &&
      (typeof actual !== 'string' || !Number.isFinite(Date.parse(actual)))
    ) {
      return [`${path}: expected ISO timestamp`]
    }
    return []
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    const template = placeholderTemplate(expected)
    if (template !== undefined) {
      return template.test(actual) ? [] : [`${path}: placeholder template mismatch`]
    }
  }
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, actual)
      ? []
      : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`]
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array`]
    if (expected.length !== actual.length) {
      return [`${path}: expected ${String(expected.length)} items, got ${String(actual.length)}`]
    }
    return expected.flatMap((value, index) =>
      matchValue(value, actual[index], `${path}[${String(index)}]`),
    )
  }
  if (!isRecord(actual)) return [`${path}: expected object`]
  const expectedRecord = expected as Record<string, unknown>
  const allowExtra = expectedRecord[ALLOW_EXTRA] === true
  const errors: string[] = []
  for (const [key, value] of Object.entries(expectedRecord)) {
    if (key === ALLOW_EXTRA || key === 'assertions') continue
    if (key === 'final_response_count' && typeof value === 'number') {
      const events = Array.isArray(actual.events) ? actual.events : []
      const count = events.filter((event) => {
        if (!isRecord(event) || !isRecord(event.data)) return false
        return 'id' in event.data && ('result' in event.data || 'error' in event.data)
      }).length
      if (count !== value)
        errors.push(`${path}.${key}: expected ${String(value)}, got ${String(count)}`)
      continue
    }
    if (key === 'events_after_final' && Array.isArray(value)) {
      const events = Array.isArray(actual.events) ? actual.events : []
      const finalIndex = events.findIndex(
        (event) => isRecord(event) && isRecord(event.data) && 'id' in event.data,
      )
      const trailing = finalIndex < 0 ? events : events.slice(finalIndex + 1)
      errors.push(...matchValue(value, trailing, `${path}.${key}`))
      continue
    }
    if (key === 'metadata_error_absent' && typeof value === 'number') {
      if (JSON.stringify(actual).includes(`"code":${String(value)}`)) {
        errors.push(`${path}: forbidden metadata error ${String(value)}`)
      }
      continue
    }
    if (key === 'forbidden_headers' && Array.isArray(value)) {
      const headers = isRecord(actual.headers) ? actual.headers : {}
      const present = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
      for (const name of value) {
        if (typeof name === 'string' && present.has(name.toLowerCase())) {
          errors.push(`${path}.headers: forbidden ${name}`)
        }
      }
      continue
    }
    if (!(key in actual)) errors.push(`${path}.${key}: missing`)
    else errors.push(...matchValue(value, actual[key], `${path}.${key}`))
  }
  if (!allowExtra) {
    for (const key of Object.keys(actual)) {
      if (!(key in expectedRecord)) errors.push(`${path}.${key}: unexpected`)
    }
  }
  return errors
}

async function readJson(path: string, fallback: Json): Promise<Json> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Json
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function discover(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'stack') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await discover(path)))
    else if (entry.isFile() && entry.name === 'test.json') found.push(dirname(path))
  }
  return found.sort()
}

function lanePaths(workitems: string, lane: string): Set<string> {
  const start = workitems.indexOf(`## Lane: ${lane}`)
  if (start < 0) throw new Error(`Unknown WORKITEM lane ${lane}`)
  const rest = workitems.slice(start + 1)
  const next = rest.search(/^## Lane: /m)
  const section = next < 0 ? rest : rest.slice(0, next)
  return new Set([...section.matchAll(/`(conformance\/[^`]+)`/g)].map((match) => match[1] ?? ''))
}

async function loadFixture(dir: string): Promise<Fixture> {
  const test = (await readJson(join(dir, 'test.json'), {})) as unknown as TestMetadata
  const relativeDir = `conformance/${relative(ROOT, dir)}`
  return {
    dir,
    relativeDir,
    category: relative(ROOT, dir).split('/')[0] ?? '',
    test,
    input: await readJson(join(dir, 'input.json'), {}),
    request: await readJson(join(dir, 'request.json'), {}),
    seed: await readJson(join(dir, 'seed.json'), null),
    expected: await readJson(join(dir, 'expected.json'), {}),
  }
}

async function importCandidate(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>
}

async function execute(fixture: Fixture): Promise<unknown> {
  const { boundary, property } = fixture.test
  if (boundary === 'lint-assertion') {
    const module = await importCandidate('scripts/verify-architecture.ts')
    return (module.verifyArchitecture as (expected: Json) => unknown)(fixture.expected)
  }
  if (boundary === 'http' || boundary === 'http-contract' || boundary === 'tool-call') {
    const modulePath =
      fixture.category === 'versioning' ? 'src/protocol/version.ts' : 'src/adapters/inbound/http.ts'
    const module = await importCandidate(modulePath)
    return await (module.handleHttp as (request: Json, seed: Json, input: Json) => unknown)(
      fixture.request,
      fixture.seed,
      fixture.input,
    )
  }
  if (boundary === 'sse') {
    const module = await importCandidate('src/adapters/inbound/sse.ts')
    return await (module.handleSse as (request: Json, seed: Json, input: Json) => unknown)(
      fixture.request,
      fixture.seed,
      fixture.input,
    )
  }
  if (boundary === 'cli') {
    const module = await importCandidate('src/adapters/inbound/cli.ts')
    return await (module.runCli as (input: Json) => unknown)(fixture.input)
  }
  if (boundary === 'state-machine') {
    const module = await importCandidate('src/application/incidents.ts')
    return await (module.runStateMachine as (input: Json, seed: Json) => unknown)(
      fixture.input,
      fixture.seed,
    )
  }
  if (boundary === 'trace-span') {
    const module = await importCandidate('src/adapters/outbound/telemetry.ts')
    return await (module.captureTrace as (input: Json, request: Json, seed: Json) => unknown)(
      fixture.input,
      fixture.request,
      fixture.seed,
    )
  }
  if (boundary === 'property') {
    const module = await importCandidate('src/properties.ts')
    return await (module.checkProperty as (property: Record<string, Json>) => unknown)(
      property ?? {},
    )
  }
  if (
    boundary === 'function' ||
    boundary === 'workflow-assertion' ||
    boundary === 'metric-assertion'
  ) {
    const functionModules: Record<string, string> = {
      protocol: 'src/protocol/codec.ts',
      transport: 'src/client/http.ts',
      primitives: 'src/application/catalogs.ts',
      cache: 'src/client/cache.ts',
      dependencies: 'src/dependencies/index.ts',
    }
    const module = await importCandidate(
      functionModules[fixture.category] ?? `src/${fixture.category}/index.ts`,
    )
    return await (module.executeFunction as (input: Json, test: TestMetadata) => unknown)(
      fixture.input,
      fixture.test,
    )
  }
  throw new Error(`Unsupported boundary ${boundary}`)
}

async function runFixture(fixture: Fixture): Promise<Result> {
  try {
    const actual = await execute(fixture)
    const errors = matchValue(fixture.expected, actual)
    return errors.length === 0
      ? { specId: fixture.test.spec_id, status: 'PASS' }
      : { specId: fixture.test.spec_id, status: 'FAIL', detail: errors.slice(0, 5).join('; ') }
  } catch (error) {
    return {
      specId: fixture.test.spec_id,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function main(): Promise<number> {
  const lane = option('--lane') ?? 'raw'
  const specFilter = new Set((option('--spec') ?? '').split(',').filter(Boolean))
  const dirs = await discover(ROOT)
  const workitems = await readFile(resolve(ROOT, '..', 'WORKITEMS.md'), 'utf8')
  const selected = lanePaths(workitems, lane)
  const fixtures = await Promise.all(dirs.map(loadFixture))
  const runnable = fixtures.filter(
    (fixture) =>
      selected.has(fixture.relativeDir) &&
      (specFilter.size === 0 || specFilter.has(fixture.test.spec_id)),
  )

  console.log(
    `DISCOVERED ${String(fixtures.length)} SELECTED ${String(runnable.length)} LANE ${lane}`,
  )
  if (process.argv.includes('--discover-only')) return fixtures.length === 197 ? 0 : 1
  if (specFilter.size > 0 && runnable.length !== specFilter.size) {
    console.error(
      `Requested ${String(specFilter.size)} spec IDs but selected ${String(runnable.length)}`,
    )
    return 1
  }

  const results = await Promise.all(runnable.map(runFixture))
  for (const result of results) {
    console.log(`${result.status} ${result.specId}${result.detail ? ` — ${result.detail}` : ''}`)
  }
  const passed = results.filter((result) => result.status === 'PASS').length
  const failed = results.length - passed
  console.log(
    `SUMMARY ${String(passed)} passed, ${String(failed)} failed, ${String(fixtures.length - runnable.length)} skipped`,
  )
  return failed === 0 ? 0 : 1
}

if (
  basename(process.argv[1] ?? '') === 'runner.ts' ||
  basename(process.argv[1] ?? '') === 'runner.js'
) {
  process.exitCode = await main()
}
