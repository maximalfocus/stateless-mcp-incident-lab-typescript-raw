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

function importsOf(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (node.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)) {
        imports.push(argument.text)
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
      for (const specifier of importsOf(file, await readFile(file, 'utf8'))) {
        const imported = canonicalImport(root, file, specifier)
        if (assertion.type === 'no_import' && new RegExp(assertion.import_pattern).test(imported)) {
          violations.push(`${rel}: forbidden import ${specifier} → ${imported}`)
        }
        if (assertion.type === 'no_deep_import' && deepImportViolation(assertion, rel, imported)) {
          violations.push(`${rel}: deep import ${specifier} → ${imported}`)
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
    await writeFile(
      join(root, 'src/application/bad.ts'),
      "import { incident } from '../domain/incidents/internal.js'\nexport { incident }\n",
    )
    let rejected = false
    try {
      await verifyArchitecture(boundary, root)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('self-test: deep import violation was accepted')
    console.log('PASS architecture verifier near-miss and violation self-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--self-test')) await selfTest()
