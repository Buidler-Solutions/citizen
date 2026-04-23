import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve(import.meta.dirname, '..');
const indexSourcePath = path.join(rootDir, 'src', 'index.ts');
const typesSourcePath = path.join(rootDir, 'src', 'types.ts');
const reportPath = path.join(rootDir, 'docs', 'PUBLIC_API_SURFACE_BASELINE.md');

function parseNamedExports(source) {
  const names = new Set();
  const exportBlockRegex = /export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g;
  for (const match of source.matchAll(exportBlockRegex)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const [left] = trimmed.split(/\s+as\s+/);
      names.add(left.trim());
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function parseTypeExports(source) {
  const names = new Set();
  const declarationRegex = /export\s+(?:type|interface|class|enum|const|function)\s+([A-Za-z0-9_]+)/g;
  for (const match of source.matchAll(declarationRegex)) {
    names.add(match[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function toBulletList(items) {
  return items.map((item) => `- \`${item}\``).join('\n');
}

const indexSource = readFileSync(indexSourcePath, 'utf8');
const typesSource = readFileSync(typesSourcePath, 'utf8');

const runtimeExports = parseNamedExports(indexSource);
const typeExports = parseTypeExports(typesSource);

const report = `# TypeScript SDK Public API Surface Baseline

Captured from \`sdk/typescript/src/index.ts\` and \`sdk/typescript/src/types.ts\` exports.

## Runtime exports

${toBulletList(runtimeExports)}

## Public builder-facing types

${toBulletList(typeExports)}
`;

const checkMode = process.argv.includes('--check');
if (checkMode) {
  const existing = readFileSync(reportPath, 'utf8');
  if (existing !== report) {
    console.error('Public API surface baseline is out of date.');
    console.error('Run: npm run api:report');
    process.exit(1);
  }
  console.log('Public API surface baseline is up to date.');
  process.exit(0);
}

writeFileSync(reportPath, report);
console.log(`Wrote ${path.relative(rootDir, reportPath)}`);
