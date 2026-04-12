# CITIZEN Namespace Builder Guide (for DApp Teams)

This guide explains, end-to-end, how a dApp builder can implement a namespace for **any business data use case** (identity, procurement, land, supply-chain, education, legal records, etc.) on CITIZEN.

It is written for application teams that need to:
- model domain-specific ledger entries,
- enforce deterministic validation rules,
- deploy/operate validators or observer-integrated services,
- evolve namespace rules through governance safely.

---

## 1) Core mental model

On CITIZEN, a namespace is the boundary between:
- generic protocol infrastructure (consensus, storage, signatures), and
- your business logic (who can write, what shape data must have, what constraints must hold).

In practice, every entry has a `namespace` string and is validated against that namespace ruleset before a block is accepted.

---

## 2) What a namespace consists of

A complete namespace implementation has 4 layers:

1. **Domain schema (off-chain contract):**
   - which actions exist,
   - payload shape for each action,
   - signing requirements,
   - uniqueness/immutability constraints.

2. **On-chain namespace descriptor (registry):**
   - namespace id,
   - version,
   - rules hash,
   - governance authority.

3. **Node-enforced ruleset (runtime validation):**
   - writer allow-list,
   - ordered validators/rules,
   - built-in and/or custom rule handlers.

4. **Governance process:**
   - registration/update proposals,
   - validator votes (>=80%),
   - activation discipline (versioned rollout).

---

## 3) Data model used by the node

### 3.1 Ledger entry envelope

All business data is embedded in `LedgerEntry`:

- `namespace`: selects your domain.
- `action`: your business action name.
- `object_id`: domain object id (parcel, case id, batch id, document id, etc.).
- `payload`: arbitrary JSON body for business fields.
- `author`, `signature`: identity + authenticity context.

Because `payload` is JSON, your use case is not constrained to a fixed schema at protocol level; schema is enforced by namespace rules.

### 3.2 Namespace descriptor

`NamespaceDescriptor` carries governance-level identity and versioning of a namespace (`namespace`, `version`, `rules_hash`, `governed_by`).

### 3.3 Namespace ruleset

`NamespaceRuleset` defines runtime validation:
- `writers`: optional set of allowed authors.
- `validators`: ordered list of `NamespaceRule { name, config }`.

Rule order matters: rules execute in declared order during entry validation.

---

## 4) How validation flows inside the ledger

For each block entry, the ledger engine:
1. checks namespace exists,
2. checks writer permission (if `writers` not empty),
3. executes each namespace rule.

Rule dispatch behavior:
- Built-in handlers:
  - `require_signature`
  - `prevent_double_transfer` (legacy alias)
  - `unique_by_field`
  - `require_payload_fields`
- Otherwise, it tries a **custom registered handler** by rule name.
- If no built-in/custom handler matches, validation fails deterministically.

This design is what makes namespaces modular for arbitrary business use cases.

---

## 5) Built-in rules you can use immediately

## 5.0 Off-chain encrypted files policy extension (namespace-governed)

For namespaces that support encrypted off-chain files and encrypted payload fields,
include policy rules that declare explicit action allowlists and field-level
encryption requirements.

Recommended action set for encrypted-file flow:

- `ENCRYPTED_FILE_UPLOAD`
- `ENCRYPTED_FILE_SHARE`
- `ENCRYPTED_FILE_REVOKE`
- `ENCRYPTED_PAYLOAD_FIELD_COMMIT`

Recommended namespace rule blocks:

```json
[
  {
    "name": "offchain_encrypted_file_policy",
    "config": {
      "enabled": true,
      "allowed_actions": [
        "ENCRYPTED_FILE_UPLOAD",
        "ENCRYPTED_FILE_SHARE",
        "ENCRYPTED_FILE_REVOKE"
      ],
      "max_file_size_bytes": 104857600,
      "allowed_mime_types": [
        "audio/mpeg",
        "audio/wav",
        "video/mp4",
        "video/webm",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "image/jpeg",
        "image/png",
        "image/webp"
      ],
      "allowed_encryption_modes": ["passphrase_file", "hybrid_file_acl_dek"],
      "required_consent_policy_ref": "consent.policy.encrypted-files.v1"
    }
  },
  {
    "name": "offchain_encrypted_payload_field_policy",
    "config": {
      "policy_version": 2,
      "min_supported_policy_version": 1,
      "migration_guide_ref": "docs/policies/offchain-payload-fields-v2",
      "offchain_encrypted_fields": [
        "payload.subject.ssn",
        "payload.subject.medical_record"
      ]
    }
  }
]
```

Notes:

- `offchain_encrypted_file_policy.allowed_actions` controls which
  `ENCRYPTED_FILE_*` actions are accepted by nodes for the namespace.
- `offchain_encrypted_file_policy.allowed_mime_types` should be treated as the
  canonical allowlist by wallet/SDK surfaces so builders get pre-submit
  validation for attachments (audio/video/docs/sheets/images) before API
  rejection.
- `offchain_encrypted_payload_field_policy.offchain_encrypted_fields` declares
  required field paths that must be supplied as encrypted off-chain refs (never
  plaintext in payload).
- Policy version fields (`policy_version`, `min_supported_policy_version`) must
  be governance-managed and updated with migration guidance for client teams.

## 5.1 `require_signature`

Ensures `entry.signature` is non-empty.

Use when every write must be explicitly signed.

---

## 5.2 `unique_by_field`

Enforces uniqueness within the namespace for a configured field path.

Accepted config forms:
- string: `"object_id"`
- object: `{ "field_path": "payload.contract_id" }`

Supported field paths:
- `object_id`
- `action`
- `author`
- `payload.<field>` (string payload values)

Typical use cases:
- one-time registration IDs,
- unique procurement reference numbers,
- unique external case IDs,
- anti-double-transfer behavior by object id.

---

## 5.3 `prevent_double_transfer` (compatibility alias)

Legacy name mapped internally to `unique_by_field("object_id")`.

Use `unique_by_field` for new designs; keep this only to preserve existing configs.

---

## 5.4 `require_payload_fields`

Ensures required keys exist in `payload`.

Config format:

```json
{
  "fields": ["from", "to", "document_hash", "region"]
}
```

Typical use cases:
- minimum schema enforcement,
- required compliance attributes,
- mandatory references to off-chain docs.

---

## 6) Register custom business rules (extensibility)

If built-ins are insufficient, register your own rule handler in node/bootstrap code:

```rust
ledger.register_rule_handler("require_region", |_, entry, config| {
    let allowed = config
        .get("allowed")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ProtocolError::ValidationFailed("require_region expects {allowed:[..]}".into()))?;

    let region = entry
        .payload
        .get("region")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ProtocolError::ValidationFailed("region is required".into()))?;

    if allowed.iter().any(|v| v.as_str() == Some(region)) {
        Ok(())
    } else {
        Err(ProtocolError::ValidationFailed("region not allowed".into()))
    }
});
```

### Best practices for custom handlers

- Keep handlers **deterministic** (no randomness, no network calls).
- Treat handler config as immutable rule parameters.
- Return explicit, audit-friendly error messages.
- Keep logic pure and side-effect free.
- Avoid expensive operations in consensus-critical path.

---

## 7) Step-by-step: implement a new namespace for any use case

### Secure decision policy (default + change path)

Use this policy for every dApp namespace request:

1. **Reuse by default**
   - If the dApp semantics fit an already approved namespace/ruleset, reuse it.
   - This keeps attack surface and governance overhead low.

2. **Govern only deltas**
   - If new semantics are required, submit a namespace/ruleset version proposal.
   - Require validator governance approval before activation.

3. **Activation hard gate**
   - Require readiness attestations from every active validator.
   - Validators must prove support for all rules in the proposed ruleset (including custom handlers).
   - Activation is rejected if any validator is missing support.

4. **Mandatory adversarial tests before execution**
   - Namespace updates must include passing evidence for:
     - schema-failure rejection,
     - duplicate rejection,
     - replay rejection,
     - writer bypass rejection.

The governance crate exposes this flow directly via:

- `decide_namespace_path(...)` to choose **reuse** vs **governance-required**.
- `validate_namespace_activation(...)` to enforce validator readiness + mandatory tests before activation.

## Step 1 — Define business actions and invariants

For each action, define:
- required payload keys,
- who can author,
- uniqueness rules,
- optional cross-field constraints.

Example (procurement):
- `RECORD_TENDER`
- `SUBMIT_BID`
- `AWARD_CONTRACT`

Invariants:
- `tender_id` unique,
- `document_hash` required,
- author must belong to approved institutions.

---

## Step 2 — Create the namespace descriptor

Define namespace identity/version metadata (`NamespaceDescriptor`):
- `namespace = "audit.procurement"`
- `version = 1`
- `rules_hash = "..."`
- `governed_by = "governance"`

The `rules_hash` should represent your canonical rules specification (off-chain doc/package hash).

---

## Step 3 — Build runtime ruleset

Construct `NamespaceRuleset` with:
- optional `writers` allow-list,
- ordered validators.

Example:

```rust
NamespaceRuleset {
    descriptor: NamespaceDescriptor {
        namespace: "audit.procurement".into(),
        version: 1,
        rules_hash: "sha256:...".into(),
        governed_by: "governance".into(),
    },
    writers: ["did:org:procurement-office".into()].into_iter().collect(),
    validators: vec![
        NamespaceRule { name: "require_signature".into(), config: serde_json::json!({}) },
        NamespaceRule {
            name: "require_payload_fields".into(),
            config: serde_json::json!({"fields": ["tender_id", "document_hash", "region"]}),
        },
        NamespaceRule {
            name: "unique_by_field".into(),
            config: serde_json::json!({"field_path": "payload.tender_id"}),
        },
        NamespaceRule {
            name: "require_region".into(),
            config: serde_json::json!({"allowed": ["eu-west", "eu-central"]}),
        },
    ],
}
```

---

## Step 4 — Register custom handlers during node startup

At node initialization, before processing live traffic:

1. instantiate ledger,
2. `bootstrap_namespaces(...)`,
3. `register_rule_handler(...)` for every custom rule name used in your rulesets.

If a ruleset references a custom rule that is not registered, writes for that namespace will fail.

---

## Step 5 — Load namespace rules through configuration

`NodeConfig` already supports `namespaces: Vec<NamespaceRuleset>` and bootstraps them via:

```rust
ledger.bootstrap_namespaces(config.namespaces.clone());
```

So a builder can distribute namespace definitions as node configuration artifacts (and later governance-managed updates).

---

## Step 6 — Version safely

When changing rules:
- increment descriptor version,
- update rules hash,
- coordinate validator rollout,
- use governance to approve and record changes,
- avoid ambiguous mixed-rule windows.

A good production pattern:
- v1 and v2 are both known during migration window,
- clients explicitly target version by namespace policy,
- activate stricter rules only after supermajority readiness.

---

## Step 7 — Validate with simulations and test matrices

For each namespace, run scenario tests:
- valid write path per action,
- missing field rejection,
- wrong author rejection,
- duplicate id rejection,
- custom policy rejection,
- throughput under realistic block cadence.

Also include adversarial cases:
- malformed payload types,
- replay attempts with changed metadata,
- attempts to bypass writer list.

---

## 8) dApp integration contract (client-side)

Your dApp should publish a clear namespace contract for integrators:

1. namespace id and version,
2. action catalog,
3. payload JSON schema per action,
4. signing requirements,
5. error-code mapping from validator responses,
6. migration/deprecation policy.

Even though on-chain payload is flexible JSON, clients should enforce strict schema locally before submit.

---

## 9) Practical templates for common use cases

## 9.1 Identity-style namespace

Rules:
- `require_signature`
- `require_payload_fields`: `subject`, `claims_hash`
- `unique_by_field`: `payload.subject`

---

## 9.2 Registry namespace (asset/land)

Rules:
- `require_signature`
- `require_payload_fields`: `from`, `to`
- `unique_by_field`: `object_id` (or use legacy `prevent_double_transfer`)

---

## 9.3 Audit namespace

Rules:
- `require_signature`
- `require_payload_fields`: `event`, `document_hash`, `timestamp`
- optional custom rule: `allowed_event_codes`

---

## 9.4 Supply-chain namespace

Rules:
- `require_signature`
- `require_payload_fields`: `batch_id`, `facility_id`, `status`
- `unique_by_field`: `payload.batch_id`
- custom rule: allowed state transitions

---

## 10) Governance and operational recommendations

- Treat namespace rule changes as protocol-sensitive governance actions.
- Maintain public changelogs for every ruleset version.
- Keep rule configs declarative and audit-friendly.
- Pin client SDKs to namespace versions.
- Run pre-deploy replay tests with historical entries.

---

## 11) Troubleshooting checklist

If writes fail unexpectedly:

1. Namespace registered?
2. Writer in allow-list?
3. Required payload keys present?
4. `unique_by_field` path points to string value?
5. Custom rule name registered on every validating node?
6. Config version drift between validators?

---

## 12) Minimal implementation blueprint (quick start)

1. Define namespace spec (`docs/<namespace>-spec.md`).
2. Build `NamespaceRuleset` (built-ins first).
3. Add custom handlers only where necessary.
4. Put ruleset in node config `namespaces`.
5. Bootstrap + run local multi-node test.
6. Add governance proposal for production registration/update.
7. Publish client schema package and examples.

---

## 13) Final takeaway

CITIZEN namespaces are intentionally modular:
- JSON payload gives data flexibility,
- deterministic rulesets give safety,
- custom handlers give business extensibility,
- governance gives controlled evolution.

That combination lets a dApp builder support virtually any structured public-record use case on the same ledger while preserving consensus integrity and auditability.
