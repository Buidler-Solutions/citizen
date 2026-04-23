#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sdkRoot = resolve(new URL('..', import.meta.url).pathname);
const changelogPath = resolve(sdkRoot, 'docs/CHANGELOG.md');

function run(cmd) {
  return execSync(cmd, { cwd: sdkRoot, encoding: 'utf8' }).trim();
}

const [, , flag] = process.argv;
const checkMode = flag === '--check';

const pkg = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const today = new Date().toISOString().slice(0, 10);

const latestTag = (() => {
  try {
    return run('git describe --tags --abbrev=0 2>/dev/null');
  } catch {
    return '';
  }
})();

const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
const commitsRaw = run(`git log -n 25 ${range} --pretty=format:%s -- sdk/typescript`);
const commits = commitsRaw
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const header = `## ${version} - ${today}`;
const bodyLines = commits.length > 0 ? commits.map((line) => `- ${line}`) : ['- No user-facing SDK changes recorded.'];
const generatedSection = `${header}\n\n${bodyLines.join('\n')}\n`;

const existing = readFileSync(changelogPath, 'utf8').trimEnd();
const [titleLine, ...restLines] = existing.split('\n');
const rest = restLines.join('\n').trimStart();
const nextContent = `${titleLine}\n\n${generatedSection}\n${rest}\n`;

if (checkMode) {
  if (existing.includes(header)) {
    process.exit(0);
  }

  console.error('CHANGELOG.md is missing an entry for the current SDK version.');
  console.error('Run: npm run changelog:generate');
  process.exit(1);
}

writeFileSync(changelogPath, nextContent);
console.log(`Updated ${changelogPath} with ${header}`);
