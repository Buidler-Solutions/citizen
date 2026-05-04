#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const evidenceRoot = path.join(repoRoot, 'citizen-protocol', 'docs', 'evidence', 'wallet-backup-vault');

const defaultScanRoots = [
  path.join(evidenceRoot),
  path.join(repoRoot, 'wallet', 'desktop', 'src-tauri'),
  path.join(repoRoot, 'vaultier')
];

const includeExt = new Set(['.md', '.json', '.log', '.txt']);
const forbiddenPatterns = [
  /BEGIN\s+PRIVATE\s+KEY/i,
  /mnemonic\s*[:=]/i,
  /seed\s*phrase\s*[:=]/i,
  /\b(passphrase|password)\b\s*[:=]\s*[^\s]/i,
  /CITIZEN_BACKUP_(DECOY|CRITICAL|SLOT)_PASSWORD\s*[:=]/i,
  /"(decoy|critical|slot)_password"\s*:\s*".+"/i
];

async function walk(dir, bucket) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'target' || entry.name.startsWith('.git')) {
        continue;
      }
      await walk(fullPath, bucket);
    } else if (entry.isFile()) {
      if (includeExt.has(path.extname(entry.name).toLowerCase())) {
        bucket.push(fullPath);
      }
    }
  }
}

const files = [];
for (const scanRoot of defaultScanRoots) {
  await walk(scanRoot, files);
}

const findings = [];
for (const file of files) {
  const contents = await fs.readFile(file, 'utf8');
  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(line)) {
        findings.push({ file: path.relative(repoRoot, file), line: i + 1, text: line.trim().slice(0, 200) });
        break;
      }
    }
  }
}

const output = {
  schema: 'citizen.wallet.desktop.tv3.secret-scan.v1',
  scanned_file_count: files.length,
  scanned_roots: defaultScanRoots.map((p) => path.relative(repoRoot, p)),
  findings,
  status: findings.length === 0 ? 'pass' : 'fail',
  generated_at: new Date().toISOString()
};

console.log(JSON.stringify(output, null, 2));
if (findings.length > 0) {
  process.exitCode = 1;
}
