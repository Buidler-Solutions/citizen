use citizen_crypto::{
    hash_block_header, parse_verifying_key, verify_commit_proof, verify_signature, KeyRegistry,
};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    Block, GovernanceProposal, LedgerEntry, NamespaceId, NamespaceRuleset, ProtocolError,
    ValidatorSetSnapshot,
};
use ed25519_dalek::Signature;
use parking_lot::RwLock;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::debug;

pub type Result<T> = std::result::Result<T, ProtocolError>;
type RuleHandler<S> = dyn Fn(&Ledger<S>, &LedgerEntry, &Value) -> Result<()> + Send + Sync;

pub struct Ledger<S: LedgerStorage + 'static> {
    storage: Arc<S>,
    namespace_rules: RwLock<HashMap<NamespaceId, NamespaceRuleset>>,
    key_registry: KeyRegistry,
    custom_rule_handlers: RwLock<HashMap<String, Arc<RuleHandler<S>>>>,
}

impl<S: LedgerStorage + 'static> Ledger<S> {
    pub fn new(storage: Arc<S>, key_registry: KeyRegistry) -> Self {
        Self {
            storage,
            namespace_rules: RwLock::new(HashMap::new()),
            key_registry,
            custom_rule_handlers: RwLock::new(HashMap::new()),
        }
    }

    pub fn register_rule_handler<F>(&self, rule_name: impl Into<String>, handler: F)
    where
        F: Fn(&Ledger<S>, &LedgerEntry, &Value) -> Result<()> + Send + Sync + 'static,
    {
        self.custom_rule_handlers
            .write()
            .insert(rule_name.into(), Arc::new(handler));
    }

    pub fn bootstrap_namespaces(&self, namespaces: Vec<NamespaceRuleset>) {
        let mut guard = self.namespace_rules.write();
        for ruleset in namespaces {
            guard.insert(ruleset.descriptor.namespace.clone(), ruleset);
        }
    }

    pub fn namespace_ruleset(&self, namespace: &str) -> Option<NamespaceRuleset> {
        self.namespace_rules.read().get(namespace).cloned()
    }

    pub fn apply_block(&self, block: Block) -> Result<()> {
        self.validate_block(&block)?;
        for entry in &block.entries {
            self.apply_entry(entry.clone())?;
        }
        self.storage.store_block(block)?;
        Ok(())
    }

    pub fn validate_block(&self, block: &Block) -> Result<()> {
        let header_hash = hash_block_header(&block.header);
        debug!(height = block.header.height, hash = %header_hash, "validating block");
        verify_commit_proof(
            &self.key_registry,
            &block.header,
            &block.header.commit_proof,
        )?;
        for entry in &block.entries {
            self.validate_entry(entry)?;
        }
        Ok(())
    }

    fn validate_entry(&self, entry: &LedgerEntry) -> Result<()> {
        let rules_guard = self.namespace_rules.read();
        let ruleset = rules_guard
            .get(&entry.namespace)
            .ok_or_else(|| ProtocolError::InvalidNamespace(entry.namespace.clone()))?;
        if !ruleset.writers.is_empty() && !ruleset.writers.contains(&entry.author) {
            return Err(ProtocolError::ValidationFailed(format!(
                "author {} is not permitted for namespace {}",
                entry.author, entry.namespace
            )));
        }
        for rule in &ruleset.validators {
            self.validate_rule(entry, &rule.name, &rule.config)?;
        }
        Ok(())
    }

    fn validate_rule(&self, entry: &LedgerEntry, rule_name: &str, config: &Value) -> Result<()> {
        match rule_name {
            "require_signature" => self.require_signature(entry),
            // Backwards-compatible alias for existing configs.
            "prevent_double_transfer" => {
                self.unique_by_field(entry, &Value::String("object_id".into()))
            }
            "unique_by_field" => self.unique_by_field(entry, config),
            "require_payload_fields" => self.require_payload_fields(entry, config),
            "allowed_actions" => self.allowed_actions(entry, config),
            "consent_policy" => self.consent_policy(entry, config),
            "author_matches_object_id" => self.author_matches_object_id(entry),
            "builder_credit_policy" => self.builder_credit_policy(entry, config),
            "asset_control_policy" => self.asset_control_policy(entry, config),
            "wasm_runtime_policy" => self.wasm_runtime_policy(entry, config),
            "interop_adapter_policy" => self.interop_adapter_policy(entry, config),
            _ => {
                let handler = self
                    .custom_rule_handlers
                    .read()
                    .get(rule_name)
                    .cloned()
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(format!(
                            "unknown namespace rule '{rule_name}' for namespace {}",
                            entry.namespace
                        ))
                    })?;
                handler(self, entry, config)
            }
        }
    }

    fn require_signature(&self, entry: &LedgerEntry) -> Result<()> {
        if entry.signature.is_empty() {
            return Err(ProtocolError::ValidationFailed(
                "missing entry signature".into(),
            ));
        }
        Ok(())
    }

    fn unique_by_field(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let field_path = if let Some(path) = config.as_str() {
            path
        } else {
            config
                .get("field_path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "unique_by_field requires a string config or { field_path }".into(),
                    )
                })?
        };
        let object_value = self.extract_field(entry, field_path)?;
        let entries = self.storage.namespace_entries(&entry.namespace)?;
        for existing in entries.iter() {
            let existing_value = self.extract_field(existing, field_path)?;
            if existing_value == object_value && existing.entry_id != entry.entry_id {
                return Err(ProtocolError::ValidationFailed(format!(
                    "field '{field_path}' value '{object_value}' already exists in namespace {}",
                    entry.namespace
                )));
            }
        }
        Ok(())
    }

    fn require_payload_fields(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let fields = config
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "require_payload_fields requires { fields: [..] } config".into(),
                )
            })?;
        for field in fields {
            let field_name = field.as_str().ok_or_else(|| {
                ProtocolError::ValidationFailed("payload field names must be strings".into())
            })?;
            if entry.payload.get(field_name).is_none() {
                return Err(ProtocolError::ValidationFailed(format!(
                    "payload field '{field_name}' is required for namespace {}",
                    entry.namespace
                )));
            }
        }
        Ok(())
    }

    fn allowed_actions(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let actions = config
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "allowed_actions requires { actions: [..] } config".into(),
                )
            })?;
        if actions
            .iter()
            .any(|action| action.as_str() == Some(entry.action.as_str()))
        {
            Ok(())
        } else {
            Err(ProtocolError::ValidationFailed(format!(
                "action '{}' is not allowed for namespace {}",
                entry.action, entry.namespace
            )))
        }
    }

    fn consent_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let required_fields = config
            .get("required_fields")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "consent_policy requires { required_fields: [..], max_ttl_secs } config".into(),
                )
            })?;
        for field in required_fields {
            let Some(field_name) = field.as_str() else {
                return Err(ProtocolError::ValidationFailed(
                    "consent_policy required_fields must be strings".into(),
                ));
            };
            if entry.payload.get(field_name).is_none() {
                return Err(ProtocolError::ValidationFailed(format!(
                    "consent receipt is missing required payload field '{field_name}'"
                )));
            }
        }

        let expires_at = entry
            .payload
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "consent receipt requires numeric payload.expires_at".into(),
                )
            })?;
        let max_ttl_secs = config
            .get("max_ttl_secs")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed("consent_policy requires max_ttl_secs".into())
            })?;
        let ttl = expires_at - entry.timestamp;
        if ttl <= 0 {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt expires_at must be in the future".into(),
            ));
        }
        if ttl > max_ttl_secs {
            return Err(ProtocolError::ValidationFailed(format!(
                "consent receipt ttl {}s exceeds allowed {}s",
                ttl, max_ttl_secs
            )));
        }
        Ok(())
    }

    fn author_matches_object_id(&self, entry: &LedgerEntry) -> Result<()> {
        if entry.author != entry.object_id {
            return Err(ProtocolError::ValidationFailed(format!(
                "author {} must match object_id {}",
                entry.author, entry.object_id
            )));
        }
        Ok(())
    }

    fn builder_credit_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let amount = entry
            .payload
            .get("amount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "builder credit entries require numeric payload.amount".into(),
                )
            })?;
        if amount == 0 {
            return Err(ProtocolError::ValidationFailed(
                "builder credit payload.amount must be greater than zero".into(),
            ));
        }

        if entry.action == "TRANSFER_CREDITS" || entry.payload.get("to_builder").is_some() {
            return Err(ProtocolError::ValidationFailed(
                "builder fee credits are non-transferable".into(),
            ));
        }

        if entry.action == "CREDIT_GRANT"
            && config
                .get("enforce_dedicated_grant_opcode")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(ProtocolError::ValidationFailed(
                "builder credit grants must use MULTISIG_CREDIT_GRANT action".into(),
            ));
        }

        if entry.action == "MULTISIG_CREDIT_GRANT" {
            let required_approvals = config
                .get("required_grant_approvals")
                .and_then(Value::as_u64)
                .unwrap_or(3) as usize;
            let approvers = config
                .get("grant_approvers")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "builder credit policy requires grant_approvers for MULTISIG_CREDIT_GRANT"
                            .into(),
                    )
                })?;
            let allowed_approvers: HashSet<String> = approvers
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect();
            if allowed_approvers.is_empty() {
                return Err(ProtocolError::ValidationFailed(
                    "builder credit policy grant_approvers cannot be empty".into(),
                ));
            }
            if required_approvals == 0 || required_approvals > allowed_approvers.len() {
                return Err(ProtocolError::ValidationFailed(
                    "required_grant_approvals must be between 1 and grant_approvers length".into(),
                ));
            }

            let proofs = entry
                .payload
                .get("multisig_proofs")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "MULTISIG_CREDIT_GRANT requires payload.multisig_proofs array".into(),
                    )
                })?;

            let mut unique_approvals: HashSet<String> = HashSet::new();
            for proof in proofs {
                let approver = proof
                    .get("approver")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "MULTISIG_CREDIT_GRANT proof requires approver".into(),
                        )
                    })?;
                if !allowed_approvers.contains(approver) {
                    return Err(ProtocolError::ValidationFailed(
                        "MULTISIG_CREDIT_GRANT includes approver outside grant_approvers".into(),
                    ));
                }

                let verifying_key_hex = proof
                    .get("public_key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "MULTISIG_CREDIT_GRANT proof requires public_key".into(),
                        )
                    })?;
                let verifying_key = parse_verifying_key(verifying_key_hex).map_err(|err| {
                    ProtocolError::ValidationFailed(format!(
                        "invalid MULTISIG_CREDIT_GRANT public_key for approver {approver}: {err}"
                    ))
                })?;

                let signature_hex =
                    proof
                        .get("signature")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            ProtocolError::ValidationFailed(
                                "MULTISIG_CREDIT_GRANT proof requires signature".into(),
                            )
                        })?;
                let signature_bytes = hex::decode(signature_hex).map_err(|err| {
                    ProtocolError::ValidationFailed(format!(
                        "invalid MULTISIG_CREDIT_GRANT signature hex for approver {approver}: {err}"
                    ))
                })?;
                let signature = Signature::from_slice(&signature_bytes).map_err(|err| {
                    ProtocolError::ValidationFailed(format!(
                        "invalid MULTISIG_CREDIT_GRANT signature bytes for approver {approver}: {err}"
                    ))
                })?;

                let message =
                    self.multisig_credit_grant_signing_message(entry, amount, approver)?;
                if !verify_signature(&verifying_key, message.as_bytes(), &signature) {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "MULTISIG_CREDIT_GRANT signature verification failed for approver {approver}"
                    )));
                }

                unique_approvals.insert(approver.to_string());
            }

            if unique_approvals.len() < required_approvals {
                return Err(ProtocolError::ValidationFailed(format!(
                    "MULTISIG_CREDIT_GRANT requires at least {required_approvals} unique approvals"
                )));
            }
        }

        if entry.action == "SPONSOR_USAGE" {
            if entry.author != entry.object_id {
                return Err(ProtocolError::ValidationFailed(
                    "sponsored usage requires author to equal builder object_id".into(),
                ));
            }

            let sponsorship_id = entry
                .payload
                .get("sponsorship_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "sponsored usage requires payload.sponsorship_id".into(),
                    )
                })?;

            let entries = self.storage.namespace_entries(&entry.namespace)?;
            if entries.iter().any(|existing| {
                existing
                    .payload
                    .get("sponsorship_id")
                    .and_then(Value::as_str)
                    == Some(sponsorship_id)
            }) {
                return Err(ProtocolError::ValidationFailed(
                    "sponsorship_id has already been used".into(),
                ));
            }

            let current_balance =
                self.compute_builder_credit_balance(&entry.namespace, &entry.object_id)?;
            if current_balance < amount as i128 {
                return Err(ProtocolError::ValidationFailed(format!(
                    "insufficient builder credits: available {current_balance}, requested {amount}"
                )));
            }

            if let Some(max_daily_spend) = config.get("max_daily_spend").and_then(Value::as_u64) {
                let day_start = entry.timestamp - (entry.timestamp.rem_euclid(86_400));
                let daily_spend: u64 = entries
                    .iter()
                    .filter(|existing| {
                        existing.object_id == entry.object_id
                            && existing.action == "SPONSOR_USAGE"
                            && existing.timestamp >= day_start
                            && existing.timestamp <= entry.timestamp
                    })
                    .filter_map(|existing| existing.payload.get("amount").and_then(Value::as_u64))
                    .sum();
                if daily_spend.saturating_add(amount) > max_daily_spend {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "daily sponsored spend limit exceeded: cap {max_daily_spend}, attempted {}",
                        daily_spend.saturating_add(amount)
                    )));
                }
            }
        }

        Ok(())
    }

    fn multisig_credit_grant_signing_message(
        &self,
        entry: &LedgerEntry,
        amount: u64,
        approver: &str,
    ) -> Result<String> {
        serde_json::to_string(&serde_json::json!({
            "entry_id": entry.entry_id,
            "namespace": entry.namespace,
            "action": entry.action,
            "object_id": entry.object_id,
            "author": entry.author,
            "amount": amount,
            "timestamp": entry.timestamp,
            "approver": approver
        }))
        .map_err(|err| {
            ProtocolError::ValidationFailed(format!(
                "failed to serialize MULTISIG_CREDIT_GRANT signing payload: {err}"
            ))
        })
    }

    fn compute_builder_credit_balance(&self, namespace: &str, builder_id: &str) -> Result<i128> {
        let entries = self.storage.namespace_entries(&namespace.to_string())?;
        let mut seen_sponsorship_ids: HashSet<String> = HashSet::new();
        let mut balance: i128 = 0;

        for entry in entries {
            if entry.object_id != builder_id {
                continue;
            }

            let amount = entry
                .payload
                .get("amount")
                .and_then(Value::as_u64)
                .unwrap_or_default() as i128;
            match entry.action.as_str() {
                "CREDIT_GRANT" | "MULTISIG_CREDIT_GRANT" => balance += amount,
                "SPONSOR_USAGE" => {
                    let sponsorship_id = entry
                        .payload
                        .get("sponsorship_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !sponsorship_id.is_empty() && seen_sponsorship_ids.insert(sponsorship_id) {
                        balance -= amount;
                    }
                }
                _ => {}
            }
        }
        Ok(balance)
    }

    fn asset_control_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let issuer = entry
            .payload
            .get("issuer")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "asset control entries require payload.issuer".to_string(),
                )
            })?;
        let asset_code = entry
            .payload
            .get("asset_code")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "asset control entries require payload.asset_code".to_string(),
                )
            })?;

        let allowed_flags: HashSet<String> = config
            .get("allowed_policy_flags")
            .and_then(Value::as_array)
            .map(|flags| {
                flags
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();

        let disclosure_mode = entry
            .payload
            .get("disclosure")
            .and_then(Value::as_object)
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("public");
        if !["public", "hashed"].contains(&disclosure_mode) {
            return Err(ProtocolError::ValidationFailed(format!(
                "unsupported disclosure mode '{disclosure_mode}'"
            )));
        }
        if disclosure_mode == "hashed"
            && entry
                .payload
                .get("disclosure")
                .and_then(Value::as_object)
                .and_then(|value| value.get("commitment"))
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(ProtocolError::ValidationFailed(
                "hashed disclosure mode requires payload.disclosure.commitment".to_string(),
            ));
        }

        let payload_flags: Vec<String> = entry
            .payload
            .get("policy_flags")
            .and_then(Value::as_array)
            .map(|flags| {
                flags
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !allowed_flags.is_empty()
            && payload_flags
                .iter()
                .any(|flag| !allowed_flags.contains(flag))
        {
            return Err(ProtocolError::ValidationFailed(
                "asset policy flag is not allowed by governance".to_string(),
            ));
        }

        match entry.action.as_str() {
            "TRUSTLINE_OPEN" => {
                if entry.author != entry.object_id {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline opening requires author to equal account object_id".into(),
                    ));
                }
                let max_holding = entry
                    .payload
                    .get("max_holding")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "trustline opening requires payload.max_holding".into(),
                        )
                    })?;
                if max_holding == 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline max_holding must be greater than zero".into(),
                    ));
                }
                Ok(())
            }
            "TRUSTLINE_CLOSE" => {
                if entry.author != entry.object_id {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline closing requires author to equal account object_id".into(),
                    ));
                }
                let current = self.compute_asset_holding(
                    &entry.namespace,
                    &entry.object_id,
                    issuer,
                    asset_code,
                )?;
                if current > 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline cannot close while holdings remain".into(),
                    ));
                }
                Ok(())
            }
            "ASSET_HOLD" => {
                let amount = entry
                    .payload
                    .get("amount")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "asset holds require numeric payload.amount".to_string(),
                        )
                    })?;
                if amount == 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "asset hold amount must be greater than zero".into(),
                    ));
                }
                if entry.author != issuer {
                    return Err(ProtocolError::ValidationFailed(
                        "asset holds must be authorized by payload.issuer".into(),
                    ));
                }
                let trustline = self
                    .latest_asset_trustline(&entry.namespace, &entry.object_id, issuer, asset_code)?
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "no active trustline for requested issuer/asset".into(),
                        )
                    })?;
                if trustline.action == "TRUSTLINE_CLOSE" {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline is closed for requested issuer/asset".into(),
                    ));
                }
                let max_holding = trustline
                    .payload
                    .get("max_holding")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "active trustline missing max_holding".into(),
                        )
                    })?;
                let current = self.compute_asset_holding(
                    &entry.namespace,
                    &entry.object_id,
                    issuer,
                    asset_code,
                )?;
                if current.saturating_add(amount as i128) > max_holding as i128 {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "trustline capacity exceeded: cap {max_holding}, attempted {}",
                        current.saturating_add(amount as i128)
                    )));
                }
                Ok(())
            }
            "ASSET_REVOKE" => {
                let amount = entry
                    .payload
                    .get("amount")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "asset revocations require numeric payload.amount".to_string(),
                        )
                    })?;
                if amount == 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "asset revocation amount must be greater than zero".into(),
                    ));
                }
                if entry.author != issuer {
                    return Err(ProtocolError::ValidationFailed(
                        "asset revocations must be authorized by payload.issuer".into(),
                    ));
                }
                let trustline = self
                    .latest_asset_trustline(&entry.namespace, &entry.object_id, issuer, asset_code)?
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "no active trustline for requested issuer/asset".into(),
                        )
                    })?;
                if trustline.action == "TRUSTLINE_CLOSE" {
                    return Err(ProtocolError::ValidationFailed(
                        "trustline is closed for requested issuer/asset".into(),
                    ));
                }
                let trustline_flags: HashSet<String> = trustline
                    .payload
                    .get("policy_flags")
                    .and_then(Value::as_array)
                    .map(|flags| {
                        flags
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if !trustline_flags.contains("clawback_enabled") {
                    return Err(ProtocolError::ValidationFailed(
                        "asset revocations require trustline policy flag clawback_enabled".into(),
                    ));
                }
                let current = self.compute_asset_holding(
                    &entry.namespace,
                    &entry.object_id,
                    issuer,
                    asset_code,
                )?;
                if current < amount as i128 {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "insufficient held assets for revocation: available {current}, requested {amount}"
                    )));
                }
                Ok(())
            }
            "ASSET_RELEASE" => {
                let amount = entry
                    .payload
                    .get("amount")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "asset releases require numeric payload.amount".to_string(),
                        )
                    })?;
                if amount == 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "asset release amount must be greater than zero".into(),
                    ));
                }
                if entry.author != entry.object_id {
                    return Err(ProtocolError::ValidationFailed(
                        "asset releases must be signed by account holder".into(),
                    ));
                }
                let current = self.compute_asset_holding(
                    &entry.namespace,
                    &entry.object_id,
                    issuer,
                    asset_code,
                )?;
                if current < amount as i128 {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "insufficient held assets: available {current}, requested {amount}"
                    )));
                }
                Ok(())
            }
            _ => Err(ProtocolError::ValidationFailed(
                "asset control action is not supported".into(),
            )),
        }
    }

    fn latest_asset_trustline(
        &self,
        namespace: &str,
        account_id: &str,
        issuer: &str,
        asset_code: &str,
    ) -> Result<Option<LedgerEntry>> {
        let entries = self.storage.namespace_entries(&namespace.to_string())?;
        Ok(entries
            .into_iter()
            .filter(|entry| {
                entry.object_id == account_id
                    && matches!(entry.action.as_str(), "TRUSTLINE_OPEN" | "TRUSTLINE_CLOSE")
                    && entry.payload.get("issuer").and_then(Value::as_str) == Some(issuer)
                    && entry.payload.get("asset_code").and_then(Value::as_str) == Some(asset_code)
            })
            .max_by_key(|entry| entry.timestamp))
    }

    fn compute_asset_holding(
        &self,
        namespace: &str,
        account_id: &str,
        issuer: &str,
        asset_code: &str,
    ) -> Result<i128> {
        let entries = self.storage.namespace_entries(&namespace.to_string())?;
        let mut holding = 0_i128;
        for entry in entries {
            if entry.object_id != account_id {
                continue;
            }
            if entry.payload.get("issuer").and_then(Value::as_str) != Some(issuer)
                || entry.payload.get("asset_code").and_then(Value::as_str) != Some(asset_code)
            {
                continue;
            }

            let amount = entry
                .payload
                .get("amount")
                .and_then(Value::as_u64)
                .unwrap_or_default() as i128;
            match entry.action.as_str() {
                "ASSET_HOLD" => holding = holding.saturating_add(amount),
                "ASSET_RELEASE" => holding = holding.saturating_sub(amount),
                "ASSET_REVOKE" => holding = holding.saturating_sub(amount),
                _ => {}
            }
        }
        Ok(holding)
    }

    fn extract_field<'a>(&self, entry: &'a LedgerEntry, field_path: &str) -> Result<&'a str> {
        match field_path {
            "object_id" => Ok(entry.object_id.as_str()),
            "action" => Ok(entry.action.as_str()),
            "author" => Ok(entry.author.as_str()),
            payload_field if payload_field.starts_with("payload.") => {
                let key = payload_field.trim_start_matches("payload.");
                entry
                    .payload
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(format!(
                            "payload field '{key}' must exist and be a string"
                        ))
                    })
            }
            other => Err(ProtocolError::ValidationFailed(format!(
                "unsupported field_path '{other}'"
            ))),
        }
    }

    fn wasm_runtime_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let module_id = entry
            .payload
            .get("module_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "wasm runtime entries require payload.module_id".to_string(),
                )
            })?;
        if module_id != entry.object_id {
            return Err(ProtocolError::ValidationFailed(
                "wasm runtime object_id must equal payload.module_id".to_string(),
            ));
        }

        let allowed_classes: HashSet<String> = config
            .get("allowed_module_classes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();

        match entry.action.as_str() {
            "REGISTER_MODULE" => {
                let module_class = entry
                    .payload
                    .get("module_class")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "register module requires payload.module_class".to_string(),
                        )
                    })?;
                if !allowed_classes.is_empty() && !allowed_classes.contains(module_class) {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "module_class '{module_class}' is not governance approved"
                    )));
                }
                if entry
                    .payload
                    .get("wasm_hash")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "register module requires payload.wasm_hash".to_string(),
                    ));
                }
                if entry
                    .payload
                    .get("audit_hash")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "register module requires payload.audit_hash".to_string(),
                    ));
                }
                Ok(())
            }
            "ACTIVATE_MODULE" => {
                let required_approvals = config
                    .get("required_governance_approvals")
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                let approvals = entry
                    .payload
                    .get("governance_approvals")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "activate module requires payload.governance_approvals".to_string(),
                        )
                    })?;
                if approvals < required_approvals {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "governance approvals {approvals} below required {required_approvals}"
                    )));
                }
                Ok(())
            }
            "EXECUTE_MODULE" => {
                let gas_limit = entry
                    .payload
                    .get("deterministic_gas_limit")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "execute module requires payload.deterministic_gas_limit".to_string(),
                        )
                    })?;
                if gas_limit == 0 {
                    return Err(ProtocolError::ValidationFailed(
                        "deterministic gas limit must be greater than zero".to_string(),
                    ));
                }
                if entry
                    .payload
                    .get("deterministic_receipt_hash")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "execute module requires payload.deterministic_receipt_hash".to_string(),
                    ));
                }
                Ok(())
            }
            _ => Err(ProtocolError::ValidationFailed(
                "wasm runtime action is not supported".to_string(),
            )),
        }
    }

    fn interop_adapter_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let allowed_standards: HashSet<String> = config
            .get("allowed_standards")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let standard = entry
            .payload
            .get("standard")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "interop adapter entries require payload.standard".to_string(),
                )
            })?;
        if !allowed_standards.is_empty() && !allowed_standards.contains(standard) {
            return Err(ProtocolError::ValidationFailed(format!(
                "interop standard '{standard}' is not governance approved"
            )));
        }

        match entry.action.as_str() {
            "REGISTER_ADAPTER" => {
                if entry
                    .payload
                    .get("adapter_id")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "register adapter requires payload.adapter_id".to_string(),
                    ));
                }
                if entry
                    .payload
                    .get("spec_ref")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "register adapter requires payload.spec_ref".to_string(),
                    ));
                }
                Ok(())
            }
            "LINK_IDENTIFIER" => {
                if entry
                    .payload
                    .get("remote_id")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "link identifier requires payload.remote_id".to_string(),
                    ));
                }
                Ok(())
            }
            "EMIT_PROOF" => {
                if entry
                    .payload
                    .get("proof_hash")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "emit proof requires payload.proof_hash".to_string(),
                    ));
                }
                Ok(())
            }
            _ => Err(ProtocolError::ValidationFailed(
                "interop adapter action is not supported".to_string(),
            )),
        }
    }

    pub fn validate_entry_submission(&self, entry: &LedgerEntry) -> Result<()> {
        self.validate_entry(entry)
    }

    pub fn apply_entry(&self, entry: LedgerEntry) -> Result<()> {
        self.validate_entry(&entry)?;
        self.storage.store_entry(entry)
    }

    pub fn update_validator_set(&self, snapshot: ValidatorSetSnapshot) -> Result<()> {
        for (validator_id, meta) in &snapshot.validators {
            let key = parse_verifying_key(&meta.public_key)?;
            self.key_registry.insert(validator_id.clone(), key);
        }
        self.storage.store_validator_set(snapshot)
    }

    pub fn track_governance(&self, proposal: GovernanceProposal) -> Result<()> {
        self.storage.track_governance_proposal(proposal)
    }

    pub fn storage(&self) -> Arc<S> {
        Arc::clone(&self.storage)
    }
}

impl Ledger<MemoryStorage> {
    pub fn in_memory() -> Self {
        Self::new(Arc::new(MemoryStorage::new()), KeyRegistry::new())
    }
}

#[cfg(test)]
mod tests {
    use super::Ledger;
    use citizen_crypto::{sign_message, verifying_key_to_string, ValidatorKeypair};
    use citizen_types::{
        CommitProof, LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset,
    };
    use serde_json::json;
    use std::collections::BTreeSet;
    use uuid::Uuid;

    fn test_entry(namespace: &str) -> LedgerEntry {
        LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".into(),
            object_id: "LOT-239-A".into(),
            payload: json!({"from":"did:a","to":"did:b"}),
            author: "did:a".into(),
            signature: "sig".into(),
            timestamp: 1_736_500_000,
        }
    }

    fn namespace_with_rules(name: &str, rules: Vec<NamespaceRule>) -> NamespaceRuleset {
        NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: name.to_string(),
                version: 1,
                rules_hash: "rules-v1".into(),
                governed_by: "governance".into(),
            },
            writers: BTreeSet::new(),
            validators: rules,
        }
    }

    fn attach_multisig_proofs(entry: &mut LedgerEntry, approvers: &[&str]) {
        let amount = entry
            .payload
            .get("amount")
            .and_then(serde_json::Value::as_u64)
            .expect("multisig grant amount");

        let proofs: Vec<serde_json::Value> = approvers
            .iter()
            .map(|approver| {
                let keypair = ValidatorKeypair::generate((*approver).to_string());
                let message = serde_json::to_string(&json!({
                    "entry_id": entry.entry_id,
                    "namespace": entry.namespace,
                    "action": entry.action,
                    "object_id": entry.object_id,
                    "author": entry.author,
                    "amount": amount,
                    "timestamp": entry.timestamp,
                    "approver": approver
                }))
                .expect("serialize signing message");
                let signature = sign_message(&keypair, message.as_bytes());
                json!({
                    "approver": approver,
                    "public_key": verifying_key_to_string(keypair.verifying_key()),
                    "signature": hex::encode(signature.to_bytes())
                })
            })
            .collect();

        entry.payload = json!({"amount": amount, "multisig_proofs": proofs});
    }

    #[test]
    fn supports_generic_field_uniqueness_on_payload() {
        let ledger = Ledger::in_memory();
        let namespace = "registry.land";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "unique_by_field".into(),
                config: json!({"field_path":"payload.to"}),
            }],
        )]);

        let first = test_entry(namespace);
        let second = test_entry(namespace);

        ledger.apply_entry(first).expect("first entry should store");
        let err = ledger
            .apply_block(citizen_types::Block {
                header: citizen_types::BlockHeader {
                    height: 1,
                    prev_hash: "0x00".into(),
                    entry_root: "root".into(),
                    proposer: "validator-a".into(),
                    timestamp: 1_736_500_001,
                    commit_proof: CommitProof {
                        aggregated_signature: "".into(),
                        participant_ids: BTreeSet::new(),
                    },
                },
                entries: vec![second],
            })
            .expect_err("duplicate payload.to must fail");

        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn supports_custom_business_rule_handlers() {
        let ledger = Ledger::in_memory();
        let namespace = "business.custom";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_region".into(),
                config: json!({"allowed":["eu-west"]}),
            }],
        )]);
        ledger.register_rule_handler("require_region", |_, entry, config| {
            let allowed = config
                .get("allowed")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    citizen_types::ProtocolError::ValidationFailed(
                        "require_region expects {allowed:[..]}".into(),
                    )
                })?;
            let entry_region = entry
                .payload
                .get("region")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    citizen_types::ProtocolError::ValidationFailed("region is required".into())
                })?;
            if allowed.iter().any(|v| v.as_str() == Some(entry_region)) {
                Ok(())
            } else {
                Err(citizen_types::ProtocolError::ValidationFailed(
                    "region not allowed".into(),
                ))
            }
        });

        let mut entry = test_entry(namespace);
        entry.payload = json!({"region":"eu-west"});

        ledger
            .apply_block(citizen_types::Block {
                header: citizen_types::BlockHeader {
                    height: 1,
                    prev_hash: "0x00".into(),
                    entry_root: "root".into(),
                    proposer: "validator-a".into(),
                    timestamp: 1_736_500_001,
                    commit_proof: CommitProof {
                        aggregated_signature: "".into(),
                        participant_ids: BTreeSet::new(),
                    },
                },
                entries: vec![entry],
            })
            .expect("custom rule should pass");
    }

    #[test]
    fn enforces_identity_allowed_actions() {
        let ledger = Ledger::in_memory();
        let namespace = "identity.citizen";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "allowed_actions".into(),
                config: json!({"actions":["REGISTER_IDENTITY","UPDATE_CLAIM","REVOKE_IDENTITY"]}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.action = "INVALID_ACTION".into();
        let err = ledger
            .apply_entry(entry)
            .expect_err("invalid action must fail");
        assert!(err.to_string().contains("is not allowed"));
    }

    #[test]
    fn enforces_author_matches_object_id_rule() {
        let ledger = Ledger::in_memory();
        let namespace = "identity.citizen";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "author_matches_object_id".into(),
                config: json!({}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.object_id = "did:ledger:alice".into();
        entry.author = "did:ledger:bob".into();
        let err = ledger
            .apply_entry(entry)
            .expect_err("identity subject mismatch must fail");
        assert!(err.to_string().contains("must match object_id"));
    }

    #[test]
    fn enforces_consent_policy_ttl_checks() {
        let ledger = Ledger::in_memory();
        let namespace = "consent.receipt";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "consent_policy".into(),
                config: json!({
                    "required_fields":["data_hash", "policy_ref", "expires_at"],
                    "max_ttl_secs": 3_600
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = json!({
            "data_hash":"0xabc",
            "policy_ref":"policy:v1",
            "expires_at": entry.timestamp + 7_200
        });
        let err = ledger
            .apply_entry(entry)
            .expect_err("ttl above max must fail");
        assert!(err.to_string().contains("exceeds allowed"));
    }

    #[test]
    fn enforces_builder_credit_non_transferability_and_balance() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "max_daily_spend": 100,
                    "enforce_dedicated_grant_opcode": true,
                    "required_grant_approvals": 3,
                    "grant_approvers": ["grant:ops-1", "grant:ops-2", "grant:ops-3", "grant:ops-4", "grant:ops-5"]
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 50_u64});
        attach_multisig_proofs(&mut grant, &["grant:ops-1", "grant:ops-2", "grant:ops-3"]);
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload =
            json!({"amount": 40_u64, "sponsorship_id":"spn-1", "sponsored_did":"did:ledger:user1"});
        ledger.apply_entry(spend).expect("spend should pass");

        let mut transfer = test_entry(namespace);
        transfer.action = "TRANSFER_CREDITS".into();
        transfer.object_id = "builder:alpha".into();
        transfer.author = "builder:alpha".into();
        transfer.payload = json!({"amount": 1_u64, "to_builder":"builder:beta"});
        let transfer_err = ledger
            .apply_entry(transfer)
            .expect_err("transfers should be rejected");
        assert!(transfer_err.to_string().contains("non-transferable"));

        let mut over_spend = test_entry(namespace);
        over_spend.action = "SPONSOR_USAGE".into();
        over_spend.object_id = "builder:alpha".into();
        over_spend.author = "builder:alpha".into();
        over_spend.payload =
            json!({"amount": 20_u64, "sponsorship_id":"spn-2", "sponsored_did":"did:ledger:user2"});
        let balance_err = ledger
            .apply_entry(over_spend)
            .expect_err("overspend should fail");
        assert!(balance_err
            .to_string()
            .contains("insufficient builder credits"));
    }

    #[test]
    fn enforces_builder_sponsorship_daily_limit_and_unique_sponsorship_id() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "max_daily_spend": 25,
                    "enforce_dedicated_grant_opcode": true,
                    "required_grant_approvals": 3,
                    "grant_approvers": ["grant:ops-1", "grant:ops-2", "grant:ops-3", "grant:ops-4", "grant:ops-5"]
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 100_u64});
        attach_multisig_proofs(&mut grant, &["grant:ops-1", "grant:ops-2", "grant:ops-3"]);
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload = json!({"amount": 10_u64, "sponsorship_id":"dup-id", "sponsored_did":"did:ledger:user1"});
        ledger
            .apply_entry(spend.clone())
            .expect("first spend should pass");

        let duplicate_err = ledger
            .apply_entry(spend)
            .expect_err("duplicate sponsorship_id should fail");
        assert!(duplicate_err.to_string().contains("already been used"));

        let mut limit_breach = test_entry(namespace);
        limit_breach.action = "SPONSOR_USAGE".into();
        limit_breach.object_id = "builder:alpha".into();
        limit_breach.author = "builder:alpha".into();
        limit_breach.payload =
            json!({"amount": 20_u64, "sponsorship_id":"spn-3", "sponsored_did":"did:ledger:user3"});
        let limit_err = ledger
            .apply_entry(limit_breach)
            .expect_err("daily max spend should fail");
        assert!(limit_err
            .to_string()
            .contains("daily sponsored spend limit exceeded"));
    }

    #[test]
    fn enforces_multisig_credit_grant_threshold_and_approver_allowlist() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "enforce_dedicated_grant_opcode": true,
                    "required_grant_approvals": 3,
                    "grant_approvers": ["grant:ops-1", "grant:ops-2", "grant:ops-3", "grant:ops-4", "grant:ops-5"]
                }),
            }],
        )]);

        let mut legacy_grant = test_entry(namespace);
        legacy_grant.action = "CREDIT_GRANT".into();
        legacy_grant.object_id = "builder:alpha".into();
        legacy_grant.author = "governance:ops".into();
        legacy_grant.payload = json!({"amount": 25_u64});
        let legacy_err = ledger
            .apply_entry(legacy_grant)
            .expect_err("legacy opcode should be rejected");
        assert!(legacy_err
            .to_string()
            .contains("must use MULTISIG_CREDIT_GRANT"));

        let mut insufficient = test_entry(namespace);
        insufficient.action = "MULTISIG_CREDIT_GRANT".into();
        insufficient.object_id = "builder:alpha".into();
        insufficient.author = "governance:ops".into();
        insufficient.payload = json!({"amount": 25_u64});
        attach_multisig_proofs(&mut insufficient, &["grant:ops-1", "grant:ops-2"]);
        let insufficient_err = ledger
            .apply_entry(insufficient)
            .expect_err("insufficient approvals should fail");
        assert!(insufficient_err
            .to_string()
            .contains("requires at least 3 unique approvals"));

        let mut unauthorized = test_entry(namespace);
        unauthorized.action = "MULTISIG_CREDIT_GRANT".into();
        unauthorized.object_id = "builder:alpha".into();
        unauthorized.author = "governance:ops".into();
        unauthorized.payload = json!({"amount": 25_u64});
        attach_multisig_proofs(
            &mut unauthorized,
            &["grant:ops-1", "grant:ops-2", "grant:rogue"],
        );
        let unauthorized_err = ledger
            .apply_entry(unauthorized)
            .expect_err("unauthorized approver should fail");
        assert!(unauthorized_err
            .to_string()
            .contains("outside grant_approvers"));
    }

    #[test]
    fn enforces_asset_trustline_capacity_release_and_clawback_controls() {
        let ledger = Ledger::in_memory();
        let namespace = "asset.control";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "asset_control_policy".into(),
                config: json!({"allowed_policy_flags": ["kyc_required", "attestation_required", "clawback_enabled"]}),
            }],
        )]);

        let mut trustline = test_entry(namespace);
        trustline.action = "TRUSTLINE_OPEN".into();
        trustline.object_id = "did:ledger:alice".into();
        trustline.author = "did:ledger:alice".into();
        trustline.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "max_holding": 100_u64,
            "policy_flags": ["kyc_required"],
            "disclosure": {"mode":"hashed", "commitment":"0xabc"}
        });
        ledger
            .apply_entry(trustline)
            .expect("trustline should pass");

        let mut hold = test_entry(namespace);
        hold.action = "ASSET_HOLD".into();
        hold.object_id = "did:ledger:alice".into();
        hold.author = "issuer:treasury".into();
        hold.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 80_u64,
            "policy_flags": ["kyc_required"],
            "disclosure": {"mode":"public"}
        });
        ledger.apply_entry(hold).expect("hold should pass");

        let mut over_cap = test_entry(namespace);
        over_cap.action = "ASSET_HOLD".into();
        over_cap.object_id = "did:ledger:alice".into();
        over_cap.author = "issuer:treasury".into();
        over_cap.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 30_u64,
            "policy_flags": ["kyc_required"],
            "disclosure": {"mode":"public"}
        });
        let cap_err = ledger
            .apply_entry(over_cap)
            .expect_err("holding above trustline cap should fail");
        assert!(cap_err.to_string().contains("trustline capacity exceeded"));

        let mut release = test_entry(namespace);
        release.action = "ASSET_RELEASE".into();
        release.object_id = "did:ledger:alice".into();
        release.author = "did:ledger:alice".into();
        release.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 20_u64,
            "policy_flags": ["kyc_required"],
            "disclosure": {"mode":"public"}
        });
        ledger.apply_entry(release).expect("release should pass");

        let mut invalid_flag = test_entry(namespace);
        invalid_flag.action = "ASSET_HOLD".into();
        invalid_flag.object_id = "did:ledger:alice".into();
        invalid_flag.author = "issuer:treasury".into();
        invalid_flag.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 5_u64,
            "policy_flags": ["unaudited_flag"],
            "disclosure": {"mode":"public"}
        });
        let flag_err = ledger
            .apply_entry(invalid_flag)
            .expect_err("unknown policy flags should be rejected");
        assert!(flag_err
            .to_string()
            .contains("asset policy flag is not allowed"));

        let mut revoke_without_flag = test_entry(namespace);
        revoke_without_flag.action = "ASSET_REVOKE".into();
        revoke_without_flag.object_id = "did:ledger:alice".into();
        revoke_without_flag.author = "issuer:treasury".into();
        revoke_without_flag.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 5_u64,
            "policy_flags": ["kyc_required"],
            "disclosure": {"mode":"public"}
        });
        let revoke_without_flag_err = ledger
            .apply_entry(revoke_without_flag)
            .expect_err("revocation without clawback flag should fail");
        assert!(revoke_without_flag_err
            .to_string()
            .contains("clawback_enabled"));

        let mut clawback_trustline = test_entry(namespace);
        clawback_trustline.action = "TRUSTLINE_OPEN".into();
        clawback_trustline.object_id = "did:ledger:bob".into();
        clawback_trustline.author = "did:ledger:bob".into();
        clawback_trustline.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "max_holding": 100_u64,
            "policy_flags": ["kyc_required", "clawback_enabled"],
            "disclosure": {"mode":"public"}
        });
        ledger
            .apply_entry(clawback_trustline)
            .expect("clawback trustline should pass");

        let mut bob_hold = test_entry(namespace);
        bob_hold.action = "ASSET_HOLD".into();
        bob_hold.object_id = "did:ledger:bob".into();
        bob_hold.author = "issuer:treasury".into();
        bob_hold.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 30_u64,
            "policy_flags": ["kyc_required", "clawback_enabled"],
            "disclosure": {"mode":"public"}
        });
        ledger.apply_entry(bob_hold).expect("bob hold should pass");

        let mut revoke_with_flag = test_entry(namespace);
        revoke_with_flag.action = "ASSET_REVOKE".into();
        revoke_with_flag.object_id = "did:ledger:bob".into();
        revoke_with_flag.author = "issuer:treasury".into();
        revoke_with_flag.payload = json!({
            "issuer": "issuer:treasury",
            "asset_code": "CITZ-CRED",
            "amount": 10_u64,
            "policy_flags": ["kyc_required", "clawback_enabled"],
            "disclosure": {"mode":"public"}
        });
        ledger
            .apply_entry(revoke_with_flag)
            .expect("revocation with clawback flag should pass");
    }

    #[test]
    fn enforces_wasm_runtime_policy_requirements() {
        let ledger = Ledger::in_memory();
        let namespace = "execution.module";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "wasm_runtime_policy".into(),
                config: json!({
                    "allowed_module_classes": ["asset", "interop"],
                    "required_governance_approvals": 3
                }),
            }],
        )]);

        let mut register = test_entry(namespace);
        register.action = "REGISTER_MODULE".into();
        register.object_id = "module.asset.v1".into();
        register.payload = json!({
            "module_id": "module.asset.v1",
            "module_class": "asset",
            "wasm_hash": "wasm:abc",
            "audit_hash": "audit:abc"
        });
        ledger
            .apply_entry(register)
            .expect("registered module should pass policy");

        let mut activate = test_entry(namespace);
        activate.action = "ACTIVATE_MODULE".into();
        activate.object_id = "module.asset.v1".into();
        activate.payload = json!({
            "module_id": "module.asset.v1",
            "governance_approvals": 2
        });

        let err = ledger
            .apply_entry(activate)
            .expect_err("activation below quorum should fail");
        assert!(err
            .to_string()
            .contains("governance approvals 2 below required 3"));
    }

    #[test]
    fn enforces_interop_adapter_policy_standard_allowlist() {
        let ledger = Ledger::in_memory();
        let namespace = "interop.adapter";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "interop_adapter_policy".into(),
                config: json!({"allowed_standards":["did-core","vc-data-model"]}),
            }],
        )]);

        let mut register = test_entry(namespace);
        register.action = "REGISTER_ADAPTER".into();
        register.object_id = "adapter.did.v1".into();
        register.payload = json!({
            "adapter_id":"adapter.did.v1",
            "standard":"did-core",
            "spec_ref":"https://www.w3.org/TR/did-core/"
        });
        ledger
            .apply_entry(register)
            .expect("did-core adapter should pass policy");

        let mut unsupported = test_entry(namespace);
        unsupported.action = "LINK_IDENTIFIER".into();
        unsupported.object_id = "did:ledger:alice".into();
        unsupported.payload = json!({
            "standard":"custom-oneoff",
            "remote_id":"did:web:example.com:alice"
        });
        let err = ledger
            .apply_entry(unsupported)
            .expect_err("unsupported standards must fail");
        assert!(err
            .to_string()
            .contains("interop standard 'custom-oneoff' is not governance approved"));
    }
}
