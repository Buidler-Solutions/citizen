# Citizen Node.js SDK — TypeScript Implementation Checkpoint Checklist

> Purpose: Convert the current SDK from JavaScript + declaration file support into a TypeScript-first, builder-safe standard while preserving API stability.

## Baseline (Current State Snapshot)

- [x] Confirm current package entrypoints (`main`/`exports`) and type declarations.
- [x] Confirm all tests are green before migration.
- [x] Capture current public API surface (exports, options, error shapes).
- [x] Record current package size and install behavior for comparison after conversion.

---

## Phase 1 — TypeScript Foundation

### Project setup

- [x] Add `typescript` as a dev dependency.
- [x] Add a strict `tsconfig.json` with:
  - [x] `strict: true`
  - [x] `noUncheckedIndexedAccess: true`
  - [x] `exactOptionalPropertyTypes: true`
  - [x] declaration output enabled
  - [x] source maps + declaration maps enabled
- [x] Add `typecheck` script (`tsc --noEmit`).

### Build pipeline

- [x] Add TypeScript build toolchain (e.g., `tsup` or `tsc` + bundler).
- [x] Emit both module formats:
  - [x] ESM build
  - [x] CJS build
- [x] Ensure generated `.d.ts` files are emitted from TS source (not handwritten).
- [x] Add `build` and `clean` scripts.

### Packaging standards

- [x] Update `package.json` `exports` map for:
  - [x] `import`
  - [x] `require`
  - [x] `types`
- [x] Validate package metadata (`files`, `engines`, `types`, `main`, optional `module`).
- [x] Validate tarball contents using `npm pack --dry-run`.

---

## Phase 2 — Source Migration

### Incremental conversion

- [x] Rename/port `src/index.js` to `src/index.ts`.
- [x] Replace manual declaration maintenance with inferred types from source.
- [x] Split large modules into typed submodules where helpful.
- [x] Add explicit public types for all builder-facing request/response payloads.

### API compatibility controls

- [x] Preserve existing public export names.
- [x] Preserve existing runtime behavior and defaults.
- [x] Keep error messages stable where clients may depend on them.
- [ ] Add deprecations (if needed) with migration notes instead of silent breaking changes.

---

## Phase 3 — Test & Quality Hardening

### Test migration

- [x] Port tests from `.js` to `.ts` (or enable TS execution for existing tests).
- [x] Keep canonicalization, signing, envelope flow, and receipt-path tests unchanged in behavior.
- [x] Add focused type-level tests for public APIs (compile-time contract checks).

### CI quality gates

- [x] Require passing checks in CI:
  - [x] `npm run typecheck`
  - [x] `npm test`
  - [x] `npm run build`
- [ ] Add linting (`eslint` + `@typescript-eslint`) and formatting checks.

---

## Phase 4 — Release Readiness

### Versioning and rollout

- [ ] Determine version bump strategy:
  - [ ] minor if no breaking API change
  - [ ] major if any breaking runtime or type-level contract change
- [ ] Publish prerelease (`next`/beta tag) for builder validation.
- [ ] Test integration with at least one real dApp flow before stable release.

### Documentation updates

- [x] Update `sdk/typescript/README.md` examples to TypeScript where appropriate.
- [x] Add migration notes for JS consumers (confirm continued JS support).
- [x] Document supported Node versions and module import patterns.

---

## Exit Criteria (Implementation Complete)

Mark complete only when all are true:

- [ ] SDK source is TypeScript-first.
- [ ] ESM + CJS artifacts publish correctly.
- [ ] Declarations are generated from source and match runtime exports.
- [ ] Existing builder flows pass integration tests.
- [x] CI includes typecheck/build/test gates.
- [x] Documentation is updated with TypeScript-first usage and migration notes.

---

## Optional Nice-to-Haves (Post-Conversion)

- [ ] Add API report generation to track accidental public-surface drift.
- [ ] Add changelog automation for SDK package releases.
- [ ] Add sample TypeScript app under `demo/` or `sdk/typescript/examples/`.
