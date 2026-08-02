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

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) files.push(path)
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
  function add(kind: string, node: ts.Node | undefined): void {
    const specifier = stringLiteral(node)
    imports.push(specifier === undefined ? { kind } : { kind, specifier })
  }
  function visit(node: ts.Node): void {
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
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        add(isDynamicImport ? 'dynamic import' : 'require', node.arguments[0])
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
  path = path.replace(/\.(?:ts|tsx|js|jsx)$/, '').replace(/\/index$/, '')
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

export async function verifyArchitecture(
  expected: Expected,
  root = process.cwd(),
): Promise<Expected> {
  const assertions = expected.assertions ?? []
  if (assertions.length === 0) throw new Error('architecture contract has no assertions')
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
    console.log(
      `PASS architecture verifier rejected ${String(forbiddenForms.length)} module-edge forms`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--self-test')) await selfTest()
