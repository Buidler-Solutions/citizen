# Dependency Alert Triage (Rust lockfile)

## `rand` alert note (`< 0.8.6`)

If `Cargo.lock` already contains `rand 0.8.6`, running:

```bash
cargo update -p rand@0.8.5 --precise 0.8.6
```

will fail with:

- `package ID specification rand@0.8.5 did not match any packages`

because `0.8.5` is no longer present in the current resolution.

Use one of these instead:

```bash
cargo update -p rand@0.8.6 --precise 0.8.6
cargo update -p rand@0.9.3 --precise 0.9.3
```

And confirm lockfile state with:

```bash
rg -n 'rand 0\.8\.5|name = "rand"' Cargo.lock
```
