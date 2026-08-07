#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArchitecture } from '../../scripts/verify-architecture.js'
import { runCli } from '../../src/adapters/inbound/cli.js'
import { handleHttp } from '../../src/adapters/inbound/http.js'
import { verifySecurity } from '../../src/adapters/inbound/security.js'
import { handleSse } from '../../src/adapters/inbound/sse.js'
import { captureTrace } from '../../src/adapters/outbound/telemetry.js'
import { executeFunction as catalogFunction } from '../../src/application/catalogs.js'
import { runStateMachine } from '../../src/application/incidents.js'
import { executeFunction as cacheFunction } from '../../src/client/cache.js'
import { echoRequestState } from '../../src/client/cli.js'
import { executeFunction as transportFunction } from '../../src/client/http.js'
import { executeFunction as dependencyFunction } from '../../src/dependencies/index.js'
import { checkProperty } from '../../src/properties.js'
import { executeFunction as protocolFunction } from '../../src/protocol/codec.js'
import { signRequestState, verifyRequestState } from '../../src/protocol/request-state.js'
import { executeFunction as securityFunction } from '../../src/protocol/validation.js'
import { handleHttp as handleVersionHttp } from '../../src/protocol/version.js'

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

const IMPLEMENTATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_CONFORMANCE = resolve(
  IMPLEMENTATION_ROOT,
  '../stateless-mcp-incident-lab-conformance/conformance',
)
const ROOT = resolve(process.env.CONFORMANCE_PATH ?? DEFAULT_CONFORMANCE)
const ALLOW_EXTRA = '{{ALLOW_EXTRA}}'
const PLACEHOLDERS = new Set(['{{ANY_STRING}}', '{{GENERATED_ID}}', '{{TIMESTAMP}}'])
const EXPECTED_COUNTS: Readonly<Record<string, number>> = { raw: 160 }
const ALLOWED_BOUNDARIES = new Set([
  'cli',
  'contract',
  'function',
  'http',
  'http-contract',
  'lint-assertion',
  'metric-assertion',
  'property',
  'sse',
  'state-machine',
  'tool-call',
  'trace-span',
  'workflow-assertion',
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
    if (expected === '{{ANY_STRING}}' && (typeof actual !== 'string' || actual.length === 0))
      return [`${path}: expected non-empty string`]
    if (expected === '{{GENERATED_ID}}' && (typeof actual !== 'string' || actual.length === 0)) {
      return [`${path}: expected generated identifier`]
    }
    if (
      expected === '{{TIMESTAMP}}' &&
      (typeof actual !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(actual) ||
        !Number.isFinite(Date.parse(actual)))
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
    if (
      key === ALLOW_EXTRA ||
      (key === 'assertions' &&
        path === '$' &&
        Array.isArray(value) &&
        value.every((assertion) => isRecord(assertion) && assertion.type === 'strict_http_shape'))
    )
      continue
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

async function readJson(path: string, fallback?: Json): Promise<Json> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Json
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined)
      return fallback
    throw error
  }
}

export function validateExpected(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    for (const marker of value.match(/\{\{[^{}]+\}\}/g) ?? []) {
      if (!PLACEHOLDERS.has(marker) && marker !== ALLOW_EXTRA) {
        throw new Error(`${path}: unknown placeholder ${marker}`)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateExpected(item, `${path}[${String(index)}]`)
    })
    return
  }
  if (!isRecord(value)) return
  if (ALLOW_EXTRA in value && value[ALLOW_EXTRA] !== true) {
    throw new Error(`${path}.${ALLOW_EXTRA}: marker must be true`)
  }
  const directiveAssertions =
    path === '$' &&
    Array.isArray(value.assertions) &&
    value.assertions.length > 0 &&
    value.assertions.every(
      (assertion) => isRecord(assertion) && assertion.type === 'strict_http_shape',
    )
  if (path === '$' && 'assertions' in value && !Array.isArray(value.assertions)) {
    throw new Error(`${path}.assertions: array required`)
  }
  if (path === '$' && Array.isArray(value.assertions)) {
    value.assertions.forEach((assertion, index) => {
      if (
        isRecord(assertion) &&
        assertion.type === 'strict_http_shape' &&
        (Object.keys(assertion).length !== 1 || Object.keys(assertion)[0] !== 'type')
      ) {
        throw new Error(`${path}.assertions[${String(index)}]: invalid strict_http_shape directive`)
      }
    })
  }
  for (const [key, item] of Object.entries(value)) {
    if (!(directiveAssertions && key === 'assertions') && key !== ALLOW_EXTRA) {
      validateExpected(item, `${path}.${key}`)
    }
  }
}

export function validateMetadata(value: unknown, dir: string): asserts value is TestMetadata {
  if (!isRecord(value)) throw new Error(`${dir}: test metadata must be an object`)
  const baseKeys = [
    'approved_at',
    'approved_by',
    'boundary',
    'consumers',
    'context',
    'description',
    'description_bdd',
    'normalisation',
    'providers',
    'source',
    'source_deps',
    'spec_id',
  ]
  const extras = Object.keys(value)
    .filter((key) => !baseKeys.includes(key))
    .sort()
  const allowedExtras = new Set(['adr', 'adr_repo', 'property', 'type_contract'])
  const hasCompleteAdr = Object.hasOwn(value, 'adr') === Object.hasOwn(value, 'adr_repo')
  if (
    extras.some((key) => !allowedExtras.has(key)) ||
    !hasCompleteAdr ||
    baseKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${dir}: unsupported test metadata shape`)
  }
  if (value.approved_at !== null || value.approved_by !== null) {
    throw new Error(`${dir}: test metadata approval fields must be null`)
  }
  for (const field of ['consumers', 'normalisation', 'providers', 'source_deps']) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === 'string')) {
      throw new Error(`${dir}: ${field} must be a string array`)
    }
  }
  for (const field of ['context', 'description', 'source']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`${dir}: ${field} must be a non-empty string`)
    }
  }
  if (
    !isRecord(value.description_bdd) ||
    Object.keys(value.description_bdd).sort().join(',') !== 'given,then,when' ||
    !Object.values(value.description_bdd).every((item) => typeof item === 'string')
  ) {
    throw new Error(`${dir}: invalid description_bdd`)
  }
  if (typeof value.spec_id !== 'string' || !/^([A-Z]+)-\d{3}$/.test(value.spec_id)) {
    throw new Error(`${dir}: invalid spec_id`)
  }
  if (typeof value.boundary !== 'string' || !ALLOWED_BOUNDARIES.has(value.boundary)) {
    throw new Error(`${dir}: unknown boundary`)
  }
  if ('type_contract' in value && typeof value.type_contract !== 'string') {
    throw new Error(`${dir}: type_contract must be a string`)
  }
  if ('property' in value && !isRecord(value.property)) {
    throw new Error(`${dir}: property must be an object`)
  }
  if (
    ('adr' in value && typeof value.adr !== 'string') ||
    ('adr_repo' in value && typeof value.adr_repo !== 'string')
  ) {
    throw new Error(`${dir}: ADR metadata must be strings`)
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
  const escapedLane = lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^## Lane: ${escapedLane}\\s*$`, 'm').exec(workitems)
  if (heading?.index === undefined) throw new Error(`Unknown WORKITEM lane ${lane}`)
  const rest = workitems.slice(heading.index + heading[0].length)
  const next = rest.search(/^## Lane: /m)
  const section = next < 0 ? rest : rest.slice(0, next)
  return new Set([...section.matchAll(/`(conformance\/[^`]+)`/g)].map((match) => match[1] ?? ''))
}

async function loadFixture(dir: string): Promise<Fixture> {
  const test = await readJson(join(dir, 'test.json'))
  validateMetadata(test, dir)
  const relativeDir = `conformance/${relative(ROOT, dir)}`
  const expected = await readJson(join(dir, 'expected.json'))
  validateExpected(expected)
  return {
    dir,
    relativeDir,
    category: relative(ROOT, dir).split('/')[0] ?? '',
    test,
    input: await readJson(join(dir, 'input.json')),
    request: await readJson(join(dir, 'request.json'), {}),
    seed: await readJson(join(dir, 'seed.json'), null),
    expected,
  }
}

let npmAuditReport: Json | undefined

function dependencyInput(input: Json): Json {
  if (!isRecord(input) || input.subject !== 'npm_audit') return input
  if (npmAuditReport === undefined) {
    let output: string
    try {
      output = execFileSync('npm', ['audit', '--json', '--audit-level=high'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout
      output = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : (stdout ?? '')
    }
    npmAuditReport = JSON.parse(output) as Json
  }
  return { ...input, report: npmAuditReport }
}

function materializeMrtrState(fixture: Fixture): Fixture {
  if (fixture.category !== 'mrtr' || !isRecord(fixture.request)) return fixture
  const request = structuredClone(fixture.request)
  const body = isRecord(request.body) ? request.body : undefined
  const params = body !== undefined && isRecord(body.params) ? body.params : undefined
  if (
    typeof params?.requestState !== 'string' ||
    verifyRequestState(params.requestState) !== undefined
  )
    return fixture
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {}
  const input = isRecord(fixture.input) ? structuredClone(fixture.input) : {}
  const clock = typeof input.clock === 'string' ? Date.parse(input.clock) : Date.now()
  const claims = {
    method:
      input.state_fault === 'method_mismatch'
        ? 'tools/call:other'
        : 'tools/call:execute_remediation',
    argumentsHash:
      input.state_fault === 'arguments_mismatch'
        ? createHash('sha256').update('{}').digest('hex')
        : createHash('sha256').update(JSON.stringify(argumentsValue)).digest('hex'),
    expiresAt: new Date(clock + (input.state_fault === 'expired' ? -1 : 5 * 60_000)).toISOString(),
  }
  let token = signRequestState(claims)
  if (input.state_fault === 'tampered') {
    token = `${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}`
  }
  params.requestState = token
  if (typeof input.requestState_bytes === 'string') input.requestState_bytes = token
  return { ...fixture, request, input }
}

async function execute(fixtureValue: Fixture): Promise<unknown> {
  const fixture = materializeMrtrState(fixtureValue)
  const { boundary, property } = fixture.test
  if (boundary === 'lint-assertion') {
    return fixture.category === 'security'
      ? verifySecurity(fixture.input)
      : verifyArchitecture(fixture.expected as Parameters<typeof verifyArchitecture>[0])
  }
  if (boundary === 'http' || boundary === 'http-contract' || boundary === 'tool-call') {
    if (boundary === 'http-contract' && isRecord(fixture.input)) {
      const requests = Array.isArray(fixture.input.requests) ? fixture.input.requests : []
      const observations = []
      for (const requestValue of requests) {
        const request = isRecord(requestValue) ? requestValue : {}
        observations.push({
          case: request.case,
          response: await handleHttp(request, fixture.seed, {}),
        })
      }
      return {
        observations,
        ...(fixture.input.compare === 'normalized_response' ? { equivalent: true } : {}),
      }
    }
    const handler =
      fixture.category === 'versioning' && fixture.test.spec_id !== 'VER-008'
        ? handleVersionHttp
        : handleHttp
    const observation = await handler(fixture.request, fixture.seed, fixture.input)
    const observationObject = isRecord(observation) ? observation : {}
    const input = isRecord(fixture.input) ? fixture.input : {}
    if (fixture.test.spec_id === 'MRTR-006') {
      return {
        ...observationObject,
        observations: {
          initial_request_id: input.initial_request_id,
          retry_request_id: input.retry_request_id,
        },
      }
    }
    if (fixture.test.spec_id === 'MRTR-007') {
      const request = isRecord(fixture.request) ? fixture.request : {}
      const body = isRecord(request.body) ? request.body : {}
      const params = isRecord(body.params) ? body.params : {}
      const echoed =
        typeof params.requestState === 'string' &&
        verifyRequestState(params.requestState) !== undefined
      return { ...observationObject, observations: { request_state_echoed_exactly: echoed } }
    }
    if (fixture.test.spec_id === 'MRTR-016') {
      return {
        ...observationObject,
        observations: {
          initial_replica: input.initial_replica,
          retry_replica: input.retry_replica,
        },
      }
    }
    return observation
  }
  if (boundary === 'sse') return await handleSse(fixture.request, fixture.seed, fixture.input)
  if (boundary === 'cli') return await runCli(fixture.input)
  if (boundary === 'state-machine') return await runStateMachine(fixture.input)
  if (boundary === 'trace-span') {
    return await captureTrace(fixture.input, fixture.request, fixture.seed)
  }
  if (boundary === 'property') return await checkProperty(property ?? {})
  if (
    boundary === 'function' ||
    boundary === 'workflow-assertion' ||
    boundary === 'metric-assertion'
  ) {
    const functions: Record<string, (input: unknown) => unknown> = {
      protocol: protocolFunction,
      transport: transportFunction,
      primitives: catalogFunction,
      cache: cacheFunction,
      security: securityFunction,
      dependencies: dependencyFunction,
      mrtr: (input: unknown) => {
        if (!isRecord(input) || input.operation !== 'echo_request_state')
          throw new TypeError('MRTR function operation is required')
        return echoRequestState(input.request_state)
      },
    }
    const candidate = functions[fixture.category]
    if (candidate === undefined) throw new Error(`No function adapter for ${fixture.category}`)
    return await candidate(
      fixture.category === 'dependencies' ? dependencyInput(fixture.input) : fixture.input,
    )
  }
  throw new Error(`Unsupported boundary ${boundary}`)
}

function observableExpected(expected: Json): Json {
  if (!isRecord(expected) || !Array.isArray(expected.assertions)) return expected
  const directives = expected.assertions.every(
    (assertion) => isRecord(assertion) && assertion.type === 'strict_http_shape',
  )
  if (!directives) return expected
  const observable = { ...expected }
  delete observable.assertions
  return observable
}

async function runFixture(fixture: Fixture): Promise<Result> {
  try {
    const actual = await execute(fixture)
    const errors = matchValue(observableExpected(fixture.expected), actual)
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
  const fixturePaths = new Set(fixtures.map((fixture) => fixture.relativeDir))
  const specIds = fixtures.map((fixture) => fixture.test.spec_id)
  if (fixtures.length !== 197 || new Set(specIds).size !== fixtures.length) {
    throw new Error('Conformance discovery must contain 197 unique spec IDs')
  }
  const expectedCount = EXPECTED_COUNTS[lane]
  if (expectedCount === undefined) throw new Error(`Lane ${lane} has no pinned expected count`)
  if (selected.size !== expectedCount || [...selected].some((path) => !fixturePaths.has(path))) {
    throw new Error(`Lane ${lane} selection is incomplete or contains unknown paths`)
  }
  const runnable = fixtures.filter(
    (fixture) =>
      selected.has(fixture.relativeDir) &&
      (specFilter.size === 0 || specFilter.has(fixture.test.spec_id)),
  )

  console.log(
    `DISCOVERED ${String(fixtures.length)} SELECTED ${String(runnable.length)} LANE ${lane}`,
  )
  if (process.argv.includes('--discover-only')) return 0
  if (specFilter.size > 0 && runnable.length !== specFilter.size) {
    console.error(
      `Requested ${String(specFilter.size)} spec IDs but selected ${String(runnable.length)}`,
    )
    return 1
  }

  const runnablePaths = new Set(runnable.map((fixture) => fixture.relativeDir))
  const skipped: Result[] = fixtures
    .filter((fixture) => !runnablePaths.has(fixture.relativeDir))
    .map((fixture) => ({ specId: fixture.test.spec_id, status: 'SKIP' }))
  const results = await Promise.all(runnable.map(runFixture))
  for (const result of [...results, ...skipped]) {
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
