# Localnet Runbook: >2/3 BFT Validator Consensus + 3-of-5 Builder Credit Grant

This runbook gives you an end-to-end **real localnet** flow (no mock ledger writes):

1. Submit a normal ledger entry and verify finality with the validator quorum.
2. Submit a `builder.credits` grant using `MULTISIG_CREDIT_GRANT` with a **3-of-5** signer policy.

It is designed for repeatable local testing on the current CITIZEN node/runtime.

---

## 1) What is possible right now?

Yes—this works in localnet today.

- Localnet validator configs run with `quorum_bps = 6667` (>2/3).
- With 3 validators, `ceil(0.6667 * 3) = 3`, so all 3 validators must participate in commit.
- `builder.credits` enforces multisig grant policy (`required_grant_approvals = 3`, `grant_approvers = 5`) and validates each proof cryptographically.

---

## 2) Prerequisites

From repo root:

```bash
cd citizen-protocol
cargo --version
jq --version
```

If `jq` is unavailable, use Python for JSON edits.

---

## 3) Start localnet

```bash
cd citizen-protocol
scripts/run_localnet.sh
```

In another terminal, wait for health:

```bash
curl -s http://127.0.0.1:8081/health | jq
curl -s http://127.0.0.1:8082/health | jq
curl -s http://127.0.0.1:8083/health | jq
```

---

## 4) Create an author wallet key (for normal entry + grant author)

```bash
cd citizen-protocol
cargo run -q -p citizen-wallet -- init --path /tmp/localnet-author-wallet.json
cargo run -q -p citizen-wallet -- keygen \
  --path /tmp/localnet-author-wallet.json \
  --label localnet-author \
  --password testpass
cargo run -q -p citizen-wallet -- list-keys --path /tmp/localnet-author-wallet.json
```

Capture the generated `key_id` (call it `$AUTHOR_KEY_ID`).

---

## 5) Submit a non-dummy ledger entry and verify >2/3 BFT consensus finality

### 5.1 Sign a realistic content entry

```bash
AUTHOR_KEY_ID="<PASTE_KEY_ID>"

ENTRY_JSON=$(cargo run -q -p citizen-wallet -- sign-entry \
  --path /tmp/localnet-author-wallet.json \
  --key-id "$AUTHOR_KEY_ID" \
  --namespace content.article \
  --action PUBLISH_ARTICLE \
  --object-id article:land-titling-report-2026-02 \
  --author did:example:newsroom.local \
  --payload-json '{
    "title":"Municipal Land Titling Audit Report",
    "content":"Quarterly verified report of land-title transfers and disputes.",
    "signedMessage":"Editorial approval ticket #LT-2026-02",
    "network":"citizen-localnet",
    "document_hash":"sha256:7f0c0d7f2af5f25f8b8e137fcd7d812319f8b95e2ef0b77d7c5f011adf8d7bb2",
    "source_url":"https://records.local/land/audit/LT-2026-02"
  }' \
  --password testpass)

printf '%s\n' "$ENTRY_JSON" > /tmp/article-entry.json
```

### 5.2 Submit entry

```bash
SUBMIT_RESPONSE=$(cargo run -q -p citizen-wallet -- submit \
  --entry-json "$(cat /tmp/article-entry.json)" \
  --api-url http://127.0.0.1:8081)

printf '%s\n' "$SUBMIT_RESPONSE" | jq
```

### 5.3 Verify finality and commit participants

```bash
RECEIPT_ID=$(printf '%s\n' "$SUBMIT_RESPONSE" | jq -r '.receipt.receipt_id')
curl -sS "http://127.0.0.1:8081/api/v1/receipts/$RECEIPT_ID" | jq
```

Check:

- `receipt.status == "Accepted"`
- `receipt.finality.block_height` is present
- `receipt.finality.commit_proof.participant_ids | length == 3`

That confirms effective >2/3 BFT quorum on a 3-validator network (all 3 required).

---

## 6) Localnet sample 3-of-5 grant signer set

The localnet configs include this non-production sample signer set for `builder.credits`:

| Approver | Public key | Secret key (localnet sample only) |
|---|---|---|
| `grant:ops-1` | `11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc` | `9a86444c078543e827a58208a0a072443a88ff5f8fe4bd3a8d375c8bf097c891` |
| `grant:ops-2` | `4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b` | `ee4fab6db4b73d209b3827182cc165a908ded422a20fe34e3874bb59a826f1ca` |
| `grant:ops-3` | `05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc` | `3b40a6544ba83499ada977fdeedfc0f925509e5bb920fae29d9f30b23fb1770b` |
| `grant:ops-4` | `871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500` | `68f38f22e6a85df6febff76e9290ee3503808cf1a002f021bae3743ea6ec3091` |
| `grant:ops-5` | `64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b` | `7ba5087c453e08e6dba4705a54a43b806a340cd875022e1a215f2af6cfc8cf8d` |

> These secrets are for localnet testing only. Never reuse outside local development.

---

## 7) Build and submit a `MULTISIG_CREDIT_GRANT` (3-of-5)

### 7.1 Create unsigned grant entry (signed by author wallet)

```bash
GRANT_ENTRY=$(cargo run -q -p citizen-wallet -- sign-entry \
  --path /tmp/localnet-author-wallet.json \
  --key-id "$AUTHOR_KEY_ID" \
  --namespace builder.credits \
  --action MULTISIG_CREDIT_GRANT \
  --object-id builder:city-records-labs \
  --author did:example:grant.orchestrator \
  --payload-json '{"amount":1200,"reason":"Q1 civic indexing sponsorship","ticket_id":"grant-ticket-2026-02-17"}' \
  --password testpass)

printf '%s\n' "$GRANT_ENTRY" > /tmp/grant-entry.json
```

### 7.2 Generate 3 proofs (new CLI helper)

```bash
cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
  --entry-json "$(cat /tmp/grant-entry.json)" \
  --approver grant:ops-1 \
  --secret-key-hex 9a86444c078543e827a58208a0a072443a88ff5f8fe4bd3a8d375c8bf097c891 \
  --expected-public-key 11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc \
  > /tmp/proof-1.json

cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
  --entry-json "$(cat /tmp/grant-entry.json)" \
  --approver grant:ops-3 \
  --secret-key-hex 3b40a6544ba83499ada977fdeedfc0f925509e5bb920fae29d9f30b23fb1770b \
  --expected-public-key 05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc \
  > /tmp/proof-3.json

cargo run -q -p citizen-wallet -- sign-builder-credit-proof \
  --entry-json "$(cat /tmp/grant-entry.json)" \
  --approver grant:ops-5 \
  --secret-key-hex 7ba5087c453e08e6dba4705a54a43b806a340cd875022e1a215f2af6cfc8cf8d \
  --expected-public-key 64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b \
  > /tmp/proof-5.json
```

### 7.3 Attach proofs into payload

```bash
jq --slurpfile p1 /tmp/proof-1.json \
   --slurpfile p3 /tmp/proof-3.json \
   --slurpfile p5 /tmp/proof-5.json \
   '.payload.multisig_proofs = [
      ($p1[0] | {approver,public_key,signature}),
      ($p3[0] | {approver,public_key,signature}),
      ($p5[0] | {approver,public_key,signature})
    ]' \
   /tmp/grant-entry.json > /tmp/grant-entry-final.json
```

### 7.4 Submit multisig grant

```bash
GRANT_RESPONSE=$(cargo run -q -p citizen-wallet -- submit \
  --entry-json "$(cat /tmp/grant-entry-final.json)" \
  --api-url http://127.0.0.1:8081)

printf '%s\n' "$GRANT_RESPONSE" | jq
```

### 7.5 Verify builder credit balance

```bash
curl -sS http://127.0.0.1:8081/api/v1/builder-credits/builder:city-records-labs | jq
```

Expect credited balance to increase by `1200`.

---

## 8) Quick negative test (2-of-5 should fail)

Use only two proofs in `payload.multisig_proofs`, submit again, and verify rejection error contains:

- `MULTISIG_CREDIT_GRANT requires at least 3 unique approvals`

---

## 9) Teardown

Stop `scripts/run_localnet.sh` with `Ctrl+C`.

Optional cleanup:

```bash
rm -f /tmp/localnet-author-wallet.json /tmp/article-entry.json /tmp/grant-entry*.json /tmp/proof-*.json
```

---

## 10) Operational notes

- Keep localnet grant keys separate from validator signing keys.
- For staging/prod, do not embed grant secret keys in repo or configs.
- Move proof signing to isolated signer services/HSM-backed key custody before any non-local deployment.
