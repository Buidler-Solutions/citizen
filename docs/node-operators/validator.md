# Validator Guide

Validators are the consensus participants in the Citizen network. They propose blocks, vote on proposals, and maintain the ledger.

## Validator Responsibilities

1. **Stay online** — validators must maintain uptime to participate in consensus
2. **Vote on blocks** — every validator must vote on proposed blocks
3. **Vote on governance** — participate in governance proposals
4. **Maintain synchronization** — keep the ledger in sync with the network

## Admission Process

New validators must be admitted through governance:

1. **Generate node identity** — create a cryptographic identity for the node
2. **Submit admission manifest** — apply for validator status through a governance proposal
3. **Pass preflight checks** — the node must pass admission preflight validation
4. **Receive approval** — the governance vote must pass with required quorum
5. **Join consensus** — upon approval, the validator joins the consensus set

### Generating Node Identity

```bash
./target/release/citizen-node --generate-identity
```

This creates the identity key pair stored in `data/IDENTITY`.

### Admission Manifest

See `citizen-protocol/docs/ADMISSION_MANIFEST_GENERATION_HOWTO.md` for the full admission manifest format and generation process.

## Validator Operations

### Monitoring Quorum

Ensure enough validators are online to maintain >2/3 quorum:

```bash
curl http://localhost:7001/consensus/status | jq '.validators.online'
```

If online validators drop below the quorum threshold, the network halts until enough validators return.

### Key Management

Validator identity keys should be backed up securely. See [Key Management](../compliance/security.md#key-management) in the security policies.

### View Changes

If the leader becomes unresponsive, the network automatically triggers a view change. No operator intervention is required, but you should monitor for excessive view changes which may indicate network issues.

## Security Best Practices

- Run validators on dedicated infrastructure
- Keep the node identity key secure and backed up
- Monitor node health and uptime
- Use firewall rules to restrict API access
- Regularly update to the latest protocol version
