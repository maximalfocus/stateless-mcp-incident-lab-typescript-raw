import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts')) files.push(path)
  }
  return files
}

export function scanCapabilities(
  sources: Record<string, string>,
  forbiddenImports: string[],
  forbiddenCalls: string[],
): { file: string; capability: string }[] {
  const violations: { file: string; capability: string }[] = []
  for (const [file, source] of Object.entries(sources)) {
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''")
    for (const name of forbiddenImports) {
      const pattern = new RegExp(
        `(?:from\\s+|import\\s*\\()(['"])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`,
      )
      if (pattern.test(source)) violations.push({ file, capability: name })
    }
    for (const name of forbiddenCalls) {
      const pattern = new RegExp(`(?<![.\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`)
      if (pattern.test(codeOnly)) violations.push({ file, capability: name })
    }
  }
  return violations
}

export function verifySecurity(inputValue: unknown): unknown {
  if (!isObject(inputValue) || inputValue.operation !== 'scan_capabilities') {
    throw new TypeError('Security scan operation is required')
  }
  const forbiddenImports = Array.isArray(inputValue.forbidden_imports)
    ? inputValue.forbidden_imports.filter((value): value is string => typeof value === 'string')
    : []
  const forbiddenCalls = Array.isArray(inputValue.forbidden_calls)
    ? inputValue.forbidden_calls.filter((value): value is string => typeof value === 'string')
    : []
  const sources = Object.fromEntries(
    sourceFiles('src').map((path) => [relative('.', path), readFileSync(path, 'utf8')]),
  )
  const violations = scanCapabilities(sources, forbiddenImports, forbiddenCalls)
  return { observations: { violations, simulated_effects_only: violations.length === 0 } }
}
