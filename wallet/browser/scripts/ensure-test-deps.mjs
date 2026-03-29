import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const requiredPackages = ['vite', '@vitejs/plugin-react', 'vitest'];

const missing = requiredPackages.filter((pkg) => {
  try {
    require.resolve(pkg);
    return false;
  } catch {
    return true;
  }
});

if (missing.length === 0) {
  process.exit(0);
}

console.log(`[wallet/browser] Missing test deps: ${missing.join(', ')}. Installing dev dependencies...`);
const result = spawnSync('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
