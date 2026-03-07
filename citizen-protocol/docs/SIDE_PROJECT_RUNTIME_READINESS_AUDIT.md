# Side-Project Runtime Readiness Audit

Date: 2026-03-07

## Scope

Audit targets for integration with the Citizen runtime (`citizen-node`):

- Node.js SDK (`sdk/nodejs`)
- Builder dApp (`dapp/apps/api`, `dapp/apps/web`)
- Explorer (`explorer/backend`, `explorer/frontend`)
- Wallet React app (`wallet/react`)
- Browser extension wallet (`wallet/browser`)
- Builder demo app (`demo`)
- Developer Laboratory app (`laboratory/`, if present)

## Overall assessment

The side-project ecosystem is **partially deployment-ready**:

- ✅ Runtime-connected surfaces are present and mostly functional.
- ⚠️ Some projects still have release-blocking or production-hardening gaps.
- ❌ Developer Laboratory MVP is not present in the repository yet.

## Findings by project

### 1) Node.js SDK (`sdk/nodejs`) — **Ready with baseline validation**

- SDK README claims working status and runtime submit/receipt support.
- Test suite runs and passes for envelope submission, wallet signing flow, and receipt polling.
- Includes helper builders for builder credits.

Status: ✅ Ready for runtime integration.

### 2) Builder dApp (`dapp/`) — **Mostly working, but lint workflow is broken/incomplete**

- Runtime integration is documented and wired through `.../api/v1/envelopes/submit` network targets.
- API package build succeeds.
- Web package build succeeds.
- Workspace/web lint command currently fails (`next lint` invokes with invalid directory handling).
- API lint is placeholder-only (`echo "lint not configured"`).

Status: ⚠️ Usable for integration demos, but CI quality gates need completion.

Required completion items:
1. Fix `apps/web` lint command so it executes successfully in local + CI runs.
2. Replace API lint placeholder with actual lint/type policy (e.g., ESLint + strict TS checks).
3. Add a minimal end-to-end publish smoke test against local runtime.

### 3) Explorer backend (`explorer/backend`) — **Buildable and type-checked**

- Backend lint and build complete.
- Explorer README contract aligns to runtime-facing canonical endpoints.

Status: ✅ Ready as backend integration surface.

### 4) Explorer frontend (`explorer/frontend`) — **Build dependency gap for standalone production build**

- Frontend build fails in static prerender when backend is unreachable (`fetch failed`, `ECONNREFUSED`).
- App performs server-side fetches during prerender without graceful offline fallback for initial build.

Status: ⚠️ Functional when backend is up, but not robust for isolated build/deploy pipelines.

Required completion items:
1. Make home page rendering resilient when backend is unavailable during build (fallback UI, runtime-only fetch, or dynamic render strategy).
2. Document required backend boot order for production pipelines.

### 5) Wallet React (`wallet/react`) — **Working after dependency install**

- README includes explicit validation targets.
- Lint, tests, and production build succeed.

Status: ✅ Ready for runtime-connected use.

### 6) Browser extension wallet (`wallet/browser`) — **Ready with explicit quality gates**

- Extension project includes explicit `lint` and `test` scripts in package automation.
- Automated smoke coverage exists for provider injection + signing flow (`src/inpage.test.ts`).
- Dedicated CI workflow executes install, lint, test, and build on wallet/browser changes.

Status: ✅ Ready for runtime integration with baseline CI enforcement.

### 7) Demo app for builders (`demo`) — **Runtime integration present, but no automated verification gates**

- Demo README documents runtime-backed publish/read flow through canonical endpoints.
- Package scripts currently expose runtime/dev start only (no tests/lint/build gate).

Status: ⚠️ Good for demos, but production-hardening and regression safety are incomplete.

Required completion items:
1. Add API-level smoke tests for challenge/sign/submit flow.
2. Add lint and basic CI checks.

### 8) Developer Laboratory (`laboratory/`) — **Missing implementation**

- Blueprint calls this out as a new app and recommends creating a Laboratory MVP.
- No `laboratory/` directory exists in the repository at audit time.

Status: ❌ Not implemented yet.

Required completion items:
1. Create `laboratory/` MVP with network selector, submit/query console, signer integration, and receipt verification.

## Deployment recommendation

The runtime-adjacent ecosystem should be classified as:

- **Runtime core**: production candidate (subject to operator readiness runbooks).
- **Side projects**: **mixed readiness** (some production-capable, some demo-grade, and one missing app).

Before declaring full-stack deployment readiness across all side projects, close the required items above, especially:

1. `laboratory/` MVP implementation.
2. dApp lint/CI quality gate fixes.
3. Explorer frontend offline/prerender resilience.
4. Automated validation for demo app.
