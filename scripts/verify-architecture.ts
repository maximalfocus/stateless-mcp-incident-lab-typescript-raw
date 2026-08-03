#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

type NoImport = { type: 'no_import'; from_glob: string; import_pattern: string }
type NoDeepImport = {
  type: 'no_deep_import'
  from_glob: string
  module_pattern: string
  allowed_entry: string
  same_module: 'allow' | 'deny'
}
type Assertion = NoImport | NoDeepImport
type Expected = { assertions?: Assertion[] }

function slash(path: string): string {
  return path.split(sep).join('/')
}

function globRegex(glob: string): RegExp {
  let source = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    const next = glob[i + 1]
    if (char === '*' && next === '*') {
      source += '.*'
      i += 1
    } else if (char === '*') source += '[^/]*'
    else source += char?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? ''
  }
  return new RegExp(`${source}$`)
}

// Every extension `tsc` compiles into the shipped bundle must be scanned, or a module edge
// declared in a `.mts`/`.cts` sibling would silently escape the boundary assertions.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
    }
  }
  await walk(join(root, 'src'))
  return files.sort()
}

type ModuleEdge = { specifier?: string; kind: string }

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function importsOf(path: string, text: string): ModuleEdge[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const imports: ModuleEdge[] = []
  const requireAliases = new Set<string>()
  const createRequireNames = new Set(['createRequire'])
  const moduleNamespaces = new Set<string>()
  const isCreateRequireCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && createRequireNames.has(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        moduleNamespaces.has(node.expression.expression.text) &&
        node.expression.name.text === 'createRequire'))
  function add(kind: string, node: ts.Node | undefined): void {
    const specifier = stringLiteral(node)
    imports.push(specifier === undefined ? { kind } : { kind, specifier })
  }
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      stringLiteral(node.moduleSpecifier) === 'node:module' &&
      node.importClause?.namedBindings !== undefined
    ) {
      const bindings = node.importClause.namedBindings
      if (ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text)
      else {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === 'createRequire') {
            createRequireNames.add(element.name.text)
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCreateRequireCall(node.initializer)
    ) {
      requireAliases.add(node.name.text)
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) add(ts.SyntaxKind[node.kind], node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add('ImportEqualsDeclaration', node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      add(
        'ImportTypeNode',
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument,
      )
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        (ts.isIdentifier(node.expression) &&
          (node.expression.text === 'require' || requireAliases.has(node.expression.text))) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === 'require' ||
            requireAliases.has(node.expression.expression.text)) &&
          node.expression.name.text === 'resolve') ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === 'require' ||
            requireAliases.has(node.expression.expression.text)) &&
          stringLiteral(node.expression.argumentExpression) === 'resolve') ||
        isCreateRequireCall(node.expression)
      const isImportMetaResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.expression.name.text === 'resolve'
      if (isDynamicImport || isRequire || isImportMetaResolve) {
        add(
          isDynamicImport
            ? 'dynamic import'
            : isImportMetaResolve
              ? 'import.meta.resolve'
              : 'require',
          node.arguments[0],
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

function canonicalImport(root: string, from: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  let path = slash(relative(root, resolve(dirname(from), specifier)))
  path = path.replace(/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/, '').replace(/\/index$/, '')
  return path
}

function moduleParts(pattern: string): { prefix: string; suffix: string } {
  const marker = pattern.indexOf('*')
  if (marker < 0) return { prefix: pattern, suffix: '' }
  return { prefix: pattern.slice(0, marker), suffix: pattern.slice(marker + 1) }
}

function deepImportViolation(assertion: NoDeepImport, from: string, imported: string): boolean {
  const { prefix, suffix } = moduleParts(assertion.module_pattern)
  if (!imported.startsWith(prefix)) return false
  const remainder = imported.slice(prefix.length)
  const moduleName = remainder.split('/')[0]
  if (
    !moduleName ||
    (suffix && !remainder.slice(moduleName.length).startsWith(suffix.slice(0, -1)))
  ) {
    return false
  }
  const moduleRoot = `${prefix}${moduleName}`
  if (
    imported === moduleRoot ||
    imported === `${moduleRoot}/${assertion.allowed_entry.replace(/\.ts$/, '')}`
  ) {
    return false
  }
  if (
    assertion.same_module === 'allow' &&
    (from === `${moduleRoot}.ts` || from.startsWith(`${moduleRoot}/`))
  ) {
    return false
  }
  return imported.startsWith(`${moduleRoot}/`)
}

function validateAssertion(value: unknown, index: number): asserts value is Assertion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`architecture assertion ${String(index)} must be an object`)
  }
  const assertion = value as Record<string, unknown>
  const common = typeof assertion.from_glob === 'string' && assertion.from_glob.length > 0
  if (assertion.type === 'no_import') {
    const keys = Object.keys(assertion).sort().join(',')
    if (
      !common ||
      typeof assertion.import_pattern !== 'string' ||
      keys !== 'from_glob,import_pattern,type'
    ) {
      throw new Error(`architecture assertion ${String(index)} has invalid no_import shape`)
    }
    try {
      new RegExp(assertion.import_pattern)
    } catch {
      throw new Error(`architecture assertion ${String(index)} has invalid import_pattern`)
    }
    return
  }
  if (assertion.type === 'no_deep_import') {
    const keys = Object.keys(assertion).sort().join(',')
    if (
      !common ||
      typeof assertion.module_pattern !== 'string' ||
      typeof assertion.allowed_entry !== 'string' ||
      !['allow', 'deny'].includes(String(assertion.same_module)) ||
      keys !== 'allowed_entry,from_glob,module_pattern,same_module,type'
    ) {
      throw new Error(`architecture assertion ${String(index)} has invalid no_deep_import shape`)
    }
    return
  }
  throw new Error(`architecture assertion ${String(index)} has unsupported type`)
}

export async function verifyArchitecture(
  expected: Expected,
  root = process.cwd(),
): Promise<Expected> {
  const assertions = expected.assertions ?? []
  if (assertions.length === 0) throw new Error('architecture contract has no assertions')
  assertions.forEach((assertion, index) => {
    validateAssertion(assertion, index)
  })
  const files = await sourceFiles(root)
  const violations: string[] = []
  for (const assertion of assertions) {
    const fromRegex = globRegex(assertion.from_glob)
    const matched = files.filter((file) => fromRegex.test(slash(relative(root, file))))
    if (matched.length === 0) violations.push(`${assertion.from_glob}: matched no source files`)
    for (const file of matched) {
      const rel = slash(relative(root, file))
      for (const edge of importsOf(file, await readFile(file, 'utf8'))) {
        if (edge.specifier === undefined) {
          violations.push(`${rel}: unresolved ${edge.kind} module edge`)
          continue
        }
        const imported = canonicalImport(root, file, edge.specifier)
        if (assertion.type === 'no_import' && new RegExp(assertion.import_pattern).test(imported)) {
          violations.push(`${rel}: forbidden import ${edge.specifier} → ${imported}`)
        }
        if (assertion.type === 'no_deep_import' && deepImportViolation(assertion, rel, imported)) {
          violations.push(`${rel}: deep import ${edge.specifier} → ${imported}`)
        }
      }
    }
  }
  if (violations.length > 0) throw new Error(violations.join('\n'))
  return { assertions }
}

async function selfTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'incident-arch-'))
  try {
    await mkdir(join(root, 'src/domain/incidents'), { recursive: true })
    await mkdir(join(root, 'src/application'), { recursive: true })
    await writeFile(join(root, 'src/domain/incidents/index.ts'), 'export const incident = 1\n')
    await writeFile(
      join(root, 'src/application/good.ts'),
      "import { incident } from '../domain/incidents/index.js'\nexport { incident }\n",
    )
    const boundary: Expected = {
      assertions: [
        {
          type: 'no_deep_import',
          from_glob: 'src/**',
          module_pattern: 'src/domain/*/',
          allowed_entry: 'index.ts',
          same_module: 'allow',
        },
      ],
    }
    await verifyArchitecture(boundary, root)
    const bad = join(root, 'src/application/bad.ts')
    const forbiddenForms = [
      "import { incident } from '../domain/incidents/internal.js'\n",
      "export { incident } from '../domain/incidents/internal.js'\n",
      "import incident = require('../domain/incidents/internal.js')\n",
      "const incident = require('../domain/incidents/internal.js')\n",
      "const incident = import('../domain/incidents/internal.js')\n",
      "export type Incident = import('../domain/incidents/internal.js').Incident\n",
      "const target = '../domain/incidents/internal.js'; import(target)\n",
      "const target = '../domain/incidents/internal.js'; require(target)\n",
      "const path = require.resolve('../domain/incidents/internal.js')\n",
      "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); req('../domain/incidents/internal.js')\n",
      "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); req['resolve']('../domain/incidents/internal.js')\n",
      "import { createRequire as makeRequire } from 'node:module'; const req = makeRequire(import.meta.url); req('../domain/incidents/internal.js')\n",
      "import * as moduleApi from 'node:module'; moduleApi.createRequire(import.meta.url)('../domain/incidents/internal.js')\n",
      "import { createRequire } from 'node:module'; createRequire(import.meta.url)('../domain/incidents/internal.js')\n",
      "const path = import.meta.resolve('../domain/incidents/internal.js')\n",
    ]
    for (const form of forbiddenForms) {
      await writeFile(bad, form)
      let rejected = false
      try {
        await verifyArchitecture(boundary, root)
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error(`self-test: module edge was accepted: ${form}`)
    }
    await writeFile(bad, 'export const clean = 1\n')
    await verifyArchitecture(boundary, root)
    for (const extension of ['.mts', '.cts']) {
      const sibling = join(root, `src/application/bad${extension}`)
      await writeFile(sibling, "import '../domain/incidents/internal.js'\n")
      let rejected = false
      try {
        await verifyArchitecture(boundary, root)
      } catch {
        rejected = true
      }
      await rm(sibling, { force: true })
      if (!rejected) throw new Error(`self-test: ${extension} module edge was not scanned`)
    }
    const malformedAssertions: unknown[] = [
      { type: 'unknown', from_glob: 'src/**' },
      { type: 'no_import', from_glob: 'src/**', import_pattern: '^x', ignored: true },
      { type: 'no_deep_import', from_glob: 'src/**', module_pattern: 'src/x/*/' },
    ]
    for (const assertion of malformedAssertions) {
      let rejected = false
      try {
        await verifyArchitecture({ assertions: [assertion] } as Expected, root)
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error('self-test: malformed architecture assertion was accepted')
    }
    console.log(
      `PASS architecture verifier rejected ${String(forbiddenForms.length)} module-edge forms across 4 TypeScript source extensions and ${String(malformedAssertions.length)} malformed assertion shapes`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--self-test')) await selfTest()
