# TypeScript SDK Package Size & Install Baseline

Snapshot date: 2026-04-23.

## Tarball baseline (`npm pack --dry-run`)

- Package: `@citizen-protocol/typescript-sdk@0.1.0`
- Filename: `citizen-protocol-typescript-sdk-0.1.0.tgz`
- Package size: `15.6 kB`
- Unpacked size: `178.4 kB`
- Total files: `14`

## Install/build/test behavior baseline

- Install: uses lockfile-managed `npm install` for local workspace dependencies.
- Build: `npm run build` emits ESM+CJS bundles and generated declarations under `dist/`.
- Test: `npm test` runs build, TypeScript test emit (`dist-test/`), then Node test runner.
