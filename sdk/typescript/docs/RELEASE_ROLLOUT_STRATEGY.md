# TypeScript SDK Release & Rollout Strategy

This document completes the remaining release-readiness checklist items for the TypeScript SDK.

## Version bump policy

Use semantic versioning with the following guardrails:

- **Patch**: internal fixes with no runtime API or public type contract change.
- **Minor**: additive, backwards-compatible runtime APIs and/or exported type additions.
- **Major**: any breaking runtime behavior, removed/renamed export, stricter required field in public request/response types, or changed error contract that existing builders may rely on.

## Deprecation policy

When introducing replacements for existing APIs:

1. keep the old API callable for at least one minor release,
2. add `@deprecated` JSDoc on the exported symbol,
3. add migration guidance in `README.md` and release notes,
4. remove only on the next major release.

Current checkpoint status: no deprecations are required because the TypeScript migration preserved export names and runtime behavior.

## Prerelease process (`next` tag)

From `sdk/typescript/`:

```bash
npm run release:check
npm run release:next
```

Where:

- `release:check` runs typecheck, tests, production build, API surface drift checks, and verifies that `docs/CHANGELOG.md` contains the current package version entry.
- `release:next` publishes a prerelease package to npm with the `next` dist-tag for builder validation.

For non-publishing validation in CI or local dry runs, use:

```bash
npm run release:pack
```

This validates publishable contents via `npm pack --dry-run` after running release gates.

## Changelog automation

From `sdk/typescript/`:

```bash
npm run changelog:generate
npm run changelog:check
```

- `changelog:generate` prepends a versioned changelog section using commit subjects since the latest tag (or full history when no tag exists).
- `changelog:check` fails if `docs/CHANGELOG.md` does not yet include the current `package.json` version header.
