# Exercises

Hands-on practice exercises for mastering Citizen smart contract development. Each exercise builds on concepts from the guides and introduces progressively more complex patterns.

## How to use these exercises

Each exercise page follows the same structure:

1. **Problem statement** — What you're building and the requirements
2. **Starter code** — A template to fill in
3. **Hints** — Step-by-step guidance (try without them first!)
4. **Complete solution** — Full working implementation with explanation
5. **Test cases** — Verify your contract works correctly

### Setup

Before starting, make sure you have:

- [x] Rust toolchain with `wasm32-unknown-unknown` target ([Installation](../installation.md))
- [x] Read the [Hello World tutorial](../hello-world.md)
- [x] Local node running (`bash scripts/start-local-stack.sh`)
- [x] A deployment script ready (see [Deployment](../deployment.md))

### Workflow

```bash
# 1. Create a new contract crate
cargo new --lib exercise-counter
cd exercise-counter

# 2. Set up Cargo.toml (see each exercise)

# 3. Write your solution in src/lib.rs

# 4. Build to WASM
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown

# 5. Deploy and test (use the deployment script from each exercise)
```

## Exercise list

| # | Exercise | Concepts practiced | Difficulty |
|---|----------|-------------------|------------|
| 1 | [Counter](counter.md) | Basic storage, events, responses | ![Beginner](https://img.shields.io/badge/Difficulty-Beginner-green) |
| 2 | [Token](token.md) | Maps, arithmetic, transfer logic | ![Beginner](https://img.shields.io/badge/Difficulty-Beginner-green) |
| 3 | [Access Control](access-control.md) | Authorization, roles, owner pattern | ![Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow) |
| 4 | [Voting](voting.md) | State machines, time-based logic, enumeration | ![Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow) |
| 5 | [Multi-Contract](multi-contract.md) | Cross-contract calls, composition | ![Advanced](https://img.shields.io/badge/Difficulty-Advanced-orange) |
| 6 | [Auction](auction.md) | Complex state, deadlines, refunds | ![Advanced](https://img.shields.io/badge/Difficulty-Advanced-red) |

## Learning path

```text
Beginner ────────────────────────────────────────── Advanced

Counter ──► Token ──► Access Control ──► Voting ──► Multi-Contract ──► Auction
   │           │            │                │             │               │
   │           │            │                │             │               │
storage    maps         signatures     state machine  cross-contract   deadlines
events     arithmetic   roles          enumeration    composition      refunds
responses  validation   owner pattern  time logic     integration      edge cases
```

## Skills checklist

By completing all exercises, you will have practiced:

- [x] Creating and building WASM contracts
- [x] Using `Item<T>` and `Map<K,V>` storage patterns
- [x] Extracting parameters with `ctx.param()`, `ctx.param_or()`, `ctx.param_opt()`
- [x] Verifying Ed25519 signatures
- [x] Checking governance approval
- [x] Implementing role-based access control
- [x] Emitting structured events
- [x] Building complex response objects
- [x] Implementing state machines
- [x] Working with block-height-based deadlines
- [x] Maintaining enumeration indexes
- [x] Making cross-contract calls
- [x] Handling edge cases and error paths
- [x] Writing integration tests

## Reference contracts

The repository includes several real-world contracts you can study:

| Contract | Location | Demonstrates |
|----------|----------|-------------|
| admin-registry-v2 | `modules/admin-registry-v2/` | Full admin management with SDK |
| voting-trust | `modules/voting-trust/` | Complete governance voting system |
| ctzn-token | `modules/ctzn-token/` | Soulbound token with tiers and access control |
| admin-registry | `modules/admin-registry/` | Raw WASM (no SDK) for comparison |
