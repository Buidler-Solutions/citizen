use citizen_crypto::{
    hash_block_header, parse_verifying_key, verify_commit_proof, verify_signature, KeyRegistry,
};
use citizen_execution::{ExecutionConfig, ExecutionEngine, ExecutionError, ExecutionResult, WasmHost};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    Block, GovernanceProposal, LedgerEntry, NamespaceId, NamespaceRuleset, PrivacyMode,
    ProtocolError, ValidatorSetSnapshot,
};
use ed25519_dalek::Signature;
use parking_lot::RwLock;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tracing::debug;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, ProtocolError>;
type RuleHandler<S> = dyn Fn(&Ledger<S>, &LedgerEntry, &Value) -> Result<()> + Send + Sync;

pub struct Ledger<S: LedgerStorage + 'static> {
    storage: Arc<S>,
    namespace_rules: RwLock<HashMap<NamespaceId, NamespaceRuleset>>,
    key_registry: KeyRegistry,
    custom_rule_handlers: RwLock<HashMap<String, Arc<RuleHandler<S>>>>,
    wasm_engine: Option<Arc<ExecutionEngine>>,
}

impl<S: LedgerStorage + 'static> Ledger<S> {
    pub fn new(storage: Arc<S>, key_registry: KeyRegistry) -> Self {
        Self {
            storage,
            namespace_rules: RwLock::new(HashMap::new()),
            key_registry,
            custom_rule_handlers: RwLock::new(HashMap::new()),
            wasm_engine: None,
        }
    }

    /// Enable WASM execution in this ledger. Module execution will be handled
    /// by the provided engine with the given configuration.
    pub fn enable_wasm_execution(&mut self, config: ExecutionConfig) -> Result<()> {
        let engine = ExecutionEngine::new(config)
            .map_err(|e| ProtocolError::ValidationFailed(format!("wasm engine init: {e}")))?;
        self.wasm_engine = Some(Arc::new(engine));
        Ok(())
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
        self.validate_privacy_flag_guards(entry)?;
        Ok(())
    }

    fn validate_privacy_flag_guards(&self, entry: &LedgerEntry) -> Result<()> {
        if !entry.privacy_flag {
            return Ok(());
        }

        if entry.privacy_mode == PrivacyMode::None {
            return Err(ProtocolError::ValidationFailed(
                "code=PRIVACY_MODE_REQUIRED summary='privacy_flag=true requires encrypted privacy_mode' details='privacy_mode=none is incompatible with privacy_flag=true' guidance='Set privacy_mode to passphrase or hybrid and include required encryption fields.'".into(),
            ));
        }

        if Self::looks_like_email(entry.object_id.as_str()) {
            return Err(ProtocolError::ValidationFailed(format!(
                "code=PRIVACY_OBJECT_ID_PII summary='object_id appears to contain direct PII while privacy_flag=true' details='object_id={}' guidance='Use a non-PII object identifier (for example, a commitment-derived alias or opaque UUID).'",
                entry.object_id
            )));
        }

        let pii_payload_fields = [
            "email",
            "country",
            "fullName",
            "institution",
            "missionNeed",
            "firstName",
            "lastName",
            "phone",
            "address",
        ];
        let leaking_fields: Vec<&str> = pii_payload_fields
            .iter()
            .copied()
            .filter(|field| entry.payload.get(field).is_some())
            .collect();
        if !leaking_fields.is_empty() {
            return Err(ProtocolError::ValidationFailed(format!(
                "code=PRIVACY_PAYLOAD_PII summary='payload contains cleartext sensitive fields while privacy_flag=true' details='fields={}' guidance='Remove these fields from cleartext payload and keep them only inside encrypted ciphertext referenced by payload_commitment.'",
                leaking_fields.join(",")
            )));
        }

        Ok(())
    }

    fn looks_like_email(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.contains(' ') {
            return false;
        }
        let mut parts = trimmed.split('@');
        let local = parts.next().unwrap_or_default();
        let domain = parts.next().unwrap_or_default();
        parts.next().is_none() && !local.is_empty() && domain.contains('.')
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
            "envelope_multisig_policy" => self.envelope_multisig_policy(entry, config),
            "privacy_policy" => self.privacy_policy(entry, config),
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
            if Self::payload_field_value(&entry.payload, field_name).is_none() {
                return Err(ProtocolError::ValidationFailed(format!(
                    "payload field '{field_name}' is required for namespace {}",
                    entry.namespace
                )));
            }
        }
        Ok(())
    }

    fn payload_field_value<'a>(payload: &'a Value, field_path: &str) -> Option<&'a Value> {
        if field_path.is_empty() {
            return None;
        }

        let mut current = payload;
        for segment in field_path.split('.') {
            current = current.get(segment)?;
        }
        Some(current)
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

        if entry.action == "CREDIT_GRANT" {
            return Err(ProtocolError::ValidationFailed(
                "builder credit grants must use MULTISIG_CREDIT_GRANT or PROGRAMMABLE_CREDIT_GRANT action".into(),
            ));
        }

        if entry.action == "MULTISIG_CREDIT_GRANT" || entry.action == "PROGRAMMABLE_CREDIT_GRANT" {
            let required_approvals = config
                .get("required_grant_approvals")
                .and_then(Value::as_u64)
                .unwrap_or(3) as usize;
            let approvers = config
                .get("grant_approvers")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "builder credit policy requires grant_approvers for credit grant actions"
                            .into(),
                    )
                })?;
            let mut allowed_approvers: HashMap<String, String> = HashMap::new();
            for approver in approvers {
                let config_entry = approver.as_object().ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "grant_approvers entries must be objects containing id and public_key"
                            .into(),
                    )
                })?;
                let approver_id =
                    config_entry
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            ProtocolError::ValidationFailed(
                                "grant_approvers entries require string id".into(),
                            )
                        })?;
                let approver_public_key = config_entry
                    .get("public_key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "grant_approvers entries require string public_key".into(),
                        )
                    })?;
                parse_verifying_key(approver_public_key).map_err(|err| {
                    ProtocolError::ValidationFailed(format!(
                        "invalid grant_approvers public_key for {approver_id}: {err}"
                    ))
                })?;
                if allowed_approvers
                    .insert(approver_id.to_string(), approver_public_key.to_string())
                    .is_some()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "grant_approvers entries must be unique by id".into(),
                    ));
                }
            }
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

            if entry.action == "MULTISIG_CREDIT_GRANT" {
                let proofs = entry
                    .payload
                    .get("multisig_proofs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "MULTISIG_CREDIT_GRANT requires payload.multisig_proofs array".into(),
                        )
                    })?;
                self.validate_multisig_credit_grant_proofs(
                    entry,
                    amount,
                    required_approvals,
                    &allowed_approvers,
                    proofs,
                )?;
            } else {
                let programmable = config
                    .get("programmable_multisig")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "PROGRAMMABLE_CREDIT_GRANT requires programmable_multisig policy settings"
                                .into(),
                        )
                    })?;
                if !programmable
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(ProtocolError::ValidationFailed(
                        "PROGRAMMABLE_CREDIT_GRANT is disabled by governance policy".into(),
                    ));
                }

                let policy_id = programmable
                    .get("policy_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "programmable_multisig requires policy_id".into(),
                        )
                    })?;
                let payload_policy_id = entry
                    .payload
                    .get("policy_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "PROGRAMMABLE_CREDIT_GRANT requires payload.policy_id".into(),
                        )
                    })?;
                if payload_policy_id != policy_id {
                    return Err(ProtocolError::ValidationFailed(
                        "PROGRAMMABLE_CREDIT_GRANT payload.policy_id does not match governance policy"
                            .into(),
                    ));
                }

                let allowed_actors: HashSet<String> = programmable
                    .get("actors")
                    .and_then(Value::as_array)
                    .map(|actors| {
                        actors
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if allowed_actors.is_empty() {
                    return Err(ProtocolError::ValidationFailed(
                        "programmable_multisig requires at least one automation actor".into(),
                    ));
                }
                if !allowed_actors.contains(&entry.author) {
                    return Err(ProtocolError::ValidationFailed(
                        "PROGRAMMABLE_CREDIT_GRANT author is not an approved automation actor"
                            .into(),
                    ));
                }

                let max_grant_amount = programmable
                    .get("max_grant_amount")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                if amount > max_grant_amount {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "PROGRAMMABLE_CREDIT_GRANT amount exceeds policy max_grant_amount {max_grant_amount}"
                    )));
                }
            }
        }

        if entry.action == "SPONSOR_USAGE" {
            if entry.author != entry.object_id {
                return Err(ProtocolError::ValidationFailed(
                    "sponsored usage requires author to equal builder object_id".into(),
                ));
            }

            let credit_grant_id = entry
                .payload
                .get("credit_grant_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "sponsored usage requires payload.credit_grant_id".into(),
                    )
                })?;

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
            let grant_exists = entries.iter().any(|existing| {
                existing.entry_id.to_string() == credit_grant_id
                    && existing.object_id == entry.object_id
                    && (existing.action == "MULTISIG_CREDIT_GRANT"
                        || existing.action == "PROGRAMMABLE_CREDIT_GRANT")
            });
            if !grant_exists {
                return Err(ProtocolError::ValidationFailed(
                    "payload.credit_grant_id does not reference an active builder grant".into(),
                ));
            }

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

    fn envelope_multisig_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let targeted_actions = config
            .get("actions")
            .and_then(Value::as_array)
            .map(|actions| {
                actions
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<HashSet<&str>>()
            });
        if let Some(actions) = targeted_actions {
            if !actions.is_empty() && !actions.contains(entry.action.as_str()) {
                return Ok(());
            }
        }

        let allowed_signers = config
            .get("allowed_signers")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "envelope_multisig_policy requires allowed_signers array".into(),
                )
            })?;
        let mut allowed_signer_set: HashSet<&str> = HashSet::new();
        for signer in allowed_signers {
            let signer = signer.as_str().ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "envelope_multisig_policy allowed_signers entries must be strings".into(),
                )
            })?;
            if !allowed_signer_set.insert(signer) {
                return Err(ProtocolError::ValidationFailed(
                    "envelope_multisig_policy allowed_signers entries must be unique".into(),
                ));
            }
        }
        if allowed_signer_set.is_empty() {
            return Err(ProtocolError::ValidationFailed(
                "envelope_multisig_policy allowed_signers cannot be empty".into(),
            ));
        }

        let threshold = config
            .get("threshold")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "envelope_multisig_policy requires threshold".into(),
                )
            })? as usize;
        if threshold == 0 || threshold > allowed_signer_set.len() {
            return Err(ProtocolError::ValidationFailed(
                "envelope_multisig_policy threshold must be between 1 and allowed_signers length"
                    .into(),
            ));
        }

        let expected_scope = config
            .get("signature_scope")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "envelope_multisig_policy requires signature_scope".into(),
                )
            })?;

        let envelope_multisig = entry
            .payload
            .get("envelope_multisig")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "payload.envelope_multisig is required when envelope_multisig_policy is enabled"
                        .into(),
                )
            })?;

        let received_scope = envelope_multisig
            .get("signature_scope")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "payload.envelope_multisig.signature_scope is required".into(),
                )
            })?;
        if received_scope != expected_scope {
            return Err(ProtocolError::ValidationFailed(
                "payload.envelope_multisig.signature_scope does not match namespace policy".into(),
            ));
        }

        let signer_records = envelope_multisig
            .get("signers")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "payload.envelope_multisig.signers must be an array".into(),
                )
            })?;
        let mut unique_signers: HashSet<String> = HashSet::new();
        let mut signer_roles: HashMap<String, String> = HashMap::new();
        for signer_record in signer_records {
            let (signer_id, signer_role) = if let Some(signer_id) = signer_record.as_str() {
                (signer_id, None)
            } else {
                let signer_obj = signer_record.as_object().ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "payload.envelope_multisig.signers entries must be strings or objects"
                            .into(),
                    )
                })?;
                let signer_id = signer_obj
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "payload.envelope_multisig.signers object entries require id".into(),
                        )
                    })?;
                let signer_role = signer_obj.get("role").and_then(Value::as_str);
                (signer_id, signer_role)
            };

            if !allowed_signer_set.contains(signer_id) {
                return Err(ProtocolError::ValidationFailed(
                    "payload.envelope_multisig.signers includes signer outside allowed_signers"
                        .into(),
                ));
            }
            unique_signers.insert(signer_id.to_string());
            if let Some(role) = signer_role {
                signer_roles.insert(signer_id.to_string(), role.to_string());
            }
        }

        if unique_signers.len() < threshold {
            return Err(ProtocolError::ValidationFailed(format!(
                "payload.envelope_multisig.signers must include at least {threshold} unique signers"
            )));
        }

        if let Some(required_roles) = config.get("required_roles").and_then(Value::as_array) {
            let mut present_roles: HashSet<&str> = HashSet::new();
            for role in signer_roles.values() {
                present_roles.insert(role.as_str());
            }
            for required_role in required_roles {
                let required_role = required_role.as_str().ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "envelope_multisig_policy required_roles entries must be strings".into(),
                    )
                })?;
                if !present_roles.contains(required_role) {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "payload.envelope_multisig.signers is missing required role {required_role}"
                    )));
                }
            }
        }

        Ok(())
    }

    fn privacy_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let allow_encryption = config
            .get("allow_encryption")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if entry.privacy_mode != PrivacyMode::None && !allow_encryption {
            return Err(ProtocolError::ValidationFailed(format!(
                "namespace {} does not permit encrypted payloads",
                entry.namespace
            )));
        }
        if entry.privacy_mode == PrivacyMode::None {
            return Ok(());
        }
        if entry.ciphertext_hex.is_none()
            || entry.nonce_hex.is_none()
            || entry.payload_commitment.is_none()
        {
            return Err(ProtocolError::ValidationFailed(
                "encrypted entries must include ciphertext, nonce, and payload_commitment".into(),
            ));
        }
        if entry.privacy_mode == PrivacyMode::Passphrase
            && (entry.salt_hex.is_none() || entry.kdf_params.is_none())
        {
            return Err(ProtocolError::ValidationFailed(
                "passphrase mode requires salt_hex and kdf_params".into(),
            ));
        }
        if entry.privacy_mode == PrivacyMode::Hybrid {
            if entry.key_wrapped_secrets.is_empty() {
                return Err(ProtocolError::ValidationFailed(
                    "hybrid mode requires key_wrapped_secrets".into(),
                ));
            }
            for reader_id in &entry.authorized_readers {
                if !entry
                    .key_wrapped_secrets
                    .iter()
                    .any(|wrapped| &wrapped.reader_id == reader_id)
                {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "hybrid mode missing key wrap for authorized reader `{reader_id}`"
                    )));
                }
            }
            if let Some(policy_id) = entry.custodian_policy_id.as_deref() {
                if !self.is_governance_approved_custodian_policy(policy_id) {
                    return Err(ProtocolError::ValidationFailed(
                        "custodian policy is not governance-approved".into(),
                    ));
                }
            }
            for (field, readers) in &entry.field_reader_acls {
                if readers.is_empty() {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "field_reader_acls[{field}] must include at least one reader"
                    )));
                }
                if !readers.iter().all(|reader| {
                    entry
                        .authorized_readers
                        .iter()
                        .any(|allowed| allowed == reader)
                }) {
                    return Err(ProtocolError::ValidationFailed(
                        "field_reader_acls readers must be present in authorized_readers".into(),
                    ));
                }
            }
        }
        let receipt = entry.consent_receipt.as_ref().ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "encrypted entries require an embedded consent_receipt".into(),
            )
        })?;
        if Some(&receipt.data_hash) != entry.payload_commitment.as_ref() {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt data_hash must match payload commitment".into(),
            ));
        }
        if receipt.expires_at <= receipt.granted_at {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt must expire after grant timestamp".into(),
            ));
        }
        if receipt.authorized_readers != entry.authorized_readers {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt authorized_readers must match entry".into(),
            ));
        }
        if receipt.custodian_policy_id != entry.custodian_policy_id {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt custodian_policy_id must match entry".into(),
            ));
        }
        if receipt.field_reader_acls != entry.field_reader_acls {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt field_reader_acls must match entry".into(),
            ));
        }

        if entry.payload.get("privacy_mode").and_then(Value::as_str) == Some("field_selective_v1") {
            self.validate_selective_privacy_payload(entry)?;
        }
        Ok(())
    }

    fn is_governance_approved_custodian_policy(&self, _policy_id: &str) -> bool {
        true
    }

    fn validate_selective_privacy_payload(&self, entry: &LedgerEntry) -> Result<()> {
        let public_fields = entry
            .payload
            .get("public_fields")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "field_selective_v1 requires payload.public_fields object".into(),
                )
            })?;
        let allowlist = entry
            .payload
            .get("public_allowlist")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "field_selective_v1 requires payload.public_allowlist string array".into(),
                )
            })?;
        let mut allowlisted_fields = allowlist
            .iter()
            .map(|field| {
                field.as_str().map(str::to_owned).ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "payload.public_allowlist values must be strings".into(),
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        allowlisted_fields.sort();
        allowlisted_fields.dedup();

        if allowlisted_fields.len() != public_fields.len()
            || !allowlisted_fields
                .iter()
                .all(|field| public_fields.contains_key(field))
        {
            return Err(ProtocolError::ValidationFailed(
                "payload.public_allowlist must exactly match payload.public_fields keys".into(),
            ));
        }

        let expected_public_fields_commitment = {
            let canonical = canonical_json(&Value::Object(public_fields.clone()));
            hex::encode(Sha256::digest(canonical.as_bytes()))
        };
        let public_fields_commitment = entry
            .payload
            .get("public_fields_commitment")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "field_selective_v1 requires payload.public_fields_commitment".into(),
                )
            })?;
        if public_fields_commitment != expected_public_fields_commitment {
            return Err(ProtocolError::ValidationFailed(
                "payload.public_fields_commitment does not match canonical public_fields".into(),
            ));
        }

        if entry
            .payload
            .get("encrypted_fields_commitment")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(ProtocolError::ValidationFailed(
                "field_selective_v1 requires payload.encrypted_fields_commitment".into(),
            ));
        }

        Ok(())
    }

    fn validate_multisig_credit_grant_proofs(
        &self,
        entry: &LedgerEntry,
        amount: u64,
        required_approvals: usize,
        allowed_approvers: &HashMap<String, String>,
        proofs: &[Value],
    ) -> Result<()> {
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
            let configured_public_key = allowed_approvers.get(approver).ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "MULTISIG_CREDIT_GRANT includes approver outside grant_approvers".into(),
                )
            })?;

            let verifying_key_hex =
                proof
                    .get("public_key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "MULTISIG_CREDIT_GRANT proof requires public_key".into(),
                        )
                    })?;
            if verifying_key_hex != configured_public_key {
                return Err(ProtocolError::ValidationFailed(format!(
                    "MULTISIG_CREDIT_GRANT public_key does not match configured key for approver {approver}"
                )));
            }
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

            let message = self.multisig_credit_grant_signing_message(entry, amount, approver)?;
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
                "CREDIT_GRANT" | "MULTISIG_CREDIT_GRANT" | "PROGRAMMABLE_CREDIT_GRANT" => {
                    balance += amount
                }
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
                if entry
                    .payload
                    .get("wasm_bytes")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(ProtocolError::ValidationFailed(
                        "register module requires payload.wasm_bytes (base64-encoded WASM bytecode)".to_string(),
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
        self.validate_entry(entry)?;
        let requires_signature = self
            .namespace_rules
            .read()
            .get(&entry.namespace)
            .map(|ruleset| {
                ruleset
                    .validators
                    .iter()
                    .any(|rule| rule.name == "require_signature")
            })
            .unwrap_or(false);
        if requires_signature {
            self.verify_submission_signature(entry)?;
        }
        Ok(())
    }

    fn verify_submission_signature(&self, entry: &LedgerEntry) -> Result<()> {
        let verifying_key = self.resolve_submission_verifying_key(entry)?;
        let signing_payload = serde_json::json!({
            "entry_id": entry.entry_id,
            "namespace": entry.namespace,
            "action": entry.action,
            "object_id": entry.object_id,
            "payload": entry.payload,
            "author": entry.author,
            "timestamp": entry.timestamp,
        });
        let canonical_payload = canonical_json(&signing_payload);
        let signature_bytes = hex::decode(&entry.signature).map_err(|err| {
            ProtocolError::ValidationFailed(format!("invalid signature hex: {err}"))
        })?;
        let signature = Signature::from_slice(&signature_bytes).map_err(|err| {
            ProtocolError::ValidationFailed(format!("invalid signature bytes: {err}"))
        })?;
        if !verify_signature(&verifying_key, canonical_payload.as_bytes(), &signature) {
            return Err(ProtocolError::ValidationFailed(
                "signature verification failed for submission entry".to_string(),
            ));
        }
        Ok(())
    }

    fn resolve_submission_verifying_key(
        &self,
        entry: &LedgerEntry,
    ) -> Result<ed25519_dalek::VerifyingKey> {
        if let Some(public_key_hex) = entry
            .payload
            .get("author_public_key")
            .and_then(Value::as_str)
        {
            return parse_verifying_key(public_key_hex).map_err(|err| {
                ProtocolError::ValidationFailed(format!("invalid payload.author_public_key: {err}"))
            });
        }

        if let Some(encoded_key) = entry.author.strip_prefix("did:key:") {
            return parse_verifying_key(encoded_key).map_err(|err| {
                ProtocolError::ValidationFailed(format!("invalid did:key author public key: {err}"))
            });
        }

        if let Some(key) = self.key_registry.get(&entry.author) {
            return Ok(key);
        }

        Err(ProtocolError::ValidationFailed(
            "unable to resolve verifying key for submission; provide payload.author_public_key, use did:key author, or register author in validator key registry".to_string(),
        ))
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

    pub fn governance_proposals(&self) -> Result<Vec<GovernanceProposal>> {
        self.storage.governance_proposals()
    }

    pub fn storage(&self) -> Arc<S> {
        Arc::clone(&self.storage)
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value = canonical_json(&map[*key]);
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let encoded_items: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", encoded_items.join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

/// A [`WasmHost`] implementation that bridges WASM host functions to the
/// Citizen ledger storage. All operations are deterministic — given the same
/// entry and state, they return the same result.
struct LedgerWasmHost<S: LedgerStorage + 'static> {
    storage: Arc<S>,
}

impl<S: LedgerStorage + 'static> WasmHost for LedgerWasmHost<S> {
    fn read_namespace_entry(
        &self,
        namespace: &str,
        entry_id: &str,
    ) -> std::result::Result<Option<String>, ExecutionError> {
        let entries = self
            .storage
            .namespace_entries(&namespace.to_string())
            .map_err(|e| ExecutionError::HostError(e.to_string()))?;

        for entry in &entries {
            if entry.object_id == entry_id
                || entry.entry_id.to_string() == entry_id
            {
                return Ok(Some(
                    serde_json::to_string(&entry.payload)
                        .map_err(|e| ExecutionError::SerializationError(e.to_string()))?,
                ));
            }
        }
        Ok(None)
    }

    fn write_namespace_entry(
        &self,
        _namespace: &str,
        _payload_json: &str,
    ) -> std::result::Result<String, ExecutionError> {
        Err(ExecutionError::HostError(
            "write_namespace_entry is not yet supported in ledger-backed WASM host".into(),
        ))
    }

    fn verify_signature(
        &self,
        signer_did: &str,
        message_hex: &str,
        signature_hex: &str,
    ) -> std::result::Result<bool, ExecutionError> {
        let message_bytes = hex::decode(message_hex)
            .map_err(|e| ExecutionError::HostError(format!("invalid message hex: {e}")))?;
        let sig_bytes = hex::decode(signature_hex)
            .map_err(|e| ExecutionError::HostError(format!("invalid signature hex: {e}")))?;
        let sig = Signature::from_slice(&sig_bytes)
            .map_err(|e| ExecutionError::HostError(format!("invalid signature: {e}")))?;

        let pubkey = parse_verifying_key(signer_did)
            .map_err(|e| ExecutionError::HostError(format!("invalid DID: {e}")))?;

        Ok(pubkey.verify_strict(&message_bytes, &sig).is_ok())
    }

    fn check_governance_approval(
        &self,
        proposal_id: &str,
    ) -> std::result::Result<bool, ExecutionError> {
        // Security: fail closed.  A merely-submitted proposal must never be
        // treated as approved.  We check for an explicit APPROVED marker
        // entry in the governance namespace.  If no such entry exists we
        // return false regardless of whether the proposal is registered.
        let entries = self
            .storage
            .namespace_entries(&"governance".to_string())
            .map_err(|e| ExecutionError::HostError(e.to_string()))?;

        Ok(entries.iter().any(|e| {
            e.object_id == proposal_id && e.action == "APPROVED"
        }))
    }

    fn current_block_height(&self) -> std::result::Result<u64, ExecutionError> {
        self.storage
            .latest_height()
            .map_err(|e| ExecutionError::HostError(e.to_string()))
    }

    fn load_module_bytecode(
        &self,
        module_id: &str,
    ) -> std::result::Result<Vec<u8>, ExecutionError> {
        const MAX_BYTECODE_BYTES: usize = 1_048_576; // 1 MB

        let entries = self
            .storage
            .namespace_entries(&"execution.module".to_string())
            .map_err(|e| ExecutionError::HostError(e.to_string()))?;

        for entry in entries.iter().rev() {
            if entry.object_id == module_id && entry.action == "REGISTER_MODULE" {
                if let Some(b64) = entry.payload.get("wasm_bytes").and_then(|v| v.as_str()) {
                    if b64.len() > MAX_BYTECODE_BYTES {
                        return Err(ExecutionError::SecurityViolation(format!(
                            "module bytecode exceeds size limit: {} base64 chars (max {})",
                            b64.len(),
                            MAX_BYTECODE_BYTES
                        )));
                    }
                    use base64::Engine;
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|e| {
                            ExecutionError::HostError(format!("invalid base64 wasm: {e}"))
                        })?;
                    if decoded.len() > MAX_BYTECODE_BYTES {
                        return Err(ExecutionError::SecurityViolation(format!(
                            "module bytecode exceeds size limit: {} bytes (max {})",
                            decoded.len(),
                            MAX_BYTECODE_BYTES
                        )));
                    }
                    return Ok(decoded);
                }
            }
        }
        Err(ExecutionError::ModuleNotFound(module_id.to_string()))
    }

    fn store_state(
        &self,
        module_id: &str,
        key: &str,
        value: &str,
    ) -> std::result::Result<(), ExecutionError> {
        // Compute a tamper-evident commitment for the state entry.
        // This is not a cryptographic signature — it is a SHA-256 hash of the
        // canonical state payload that the namespace rules can verify.
        let canonical = format!("STATE_WRITE\n{module_id}\n{key}\n{value}");
        let commitment = hex::encode(Sha256::digest(canonical.as_bytes()));

        let entry = citizen_types::LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "execution.module".into(),
            action: "STATE_WRITE".into(),
            object_id: module_id.to_string(),
            payload: serde_json::json!({
                "state_key": key,
                "state_value": value,
                "system_generated": true,
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: format!("system.execution#{module_id}"),
            signature: commitment,
            timestamp: chrono::Utc::now().timestamp(),
        };
        self.storage
            .store_entry(entry)
            .map_err(|e| ExecutionError::HostError(e.to_string()))
    }

    fn load_state(
        &self,
        module_id: &str,
        key: &str,
    ) -> std::result::Result<Option<String>, ExecutionError> {
        let entries = self
            .storage
            .namespace_entries(&"execution.module".to_string())
            .map_err(|e| ExecutionError::HostError(e.to_string()))?;

        for entry in entries.iter().rev() {
            if entry.object_id == module_id && entry.action == "STATE_WRITE" {
                if let Some(state_key) = entry.payload.get("state_key").and_then(|v| v.as_str()) {
                    if state_key == key {
                        if let Some(state_value) = entry.payload.get("state_value").and_then(|v| v.as_str()) {
                            return Ok(Some(state_value.to_string()));
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    fn verify_signature_batch(
        &self,
        batch_json: &str,
    ) -> std::result::Result<u32, ExecutionError> {
        const MAX_BATCH_JSON: usize = 1_048_576; // 1 MB
        const MAX_BATCH_ITEMS: usize = 256;

        if batch_json.len() > MAX_BATCH_JSON {
            return Err(ExecutionError::SecurityViolation(format!(
                "batch JSON exceeds size limit: {} bytes (max {})",
                batch_json.len(),
                MAX_BATCH_JSON
            )));
        }

        let items: Vec<serde_json::Value> =
            serde_json::from_str(batch_json).map_err(|e| {
                ExecutionError::HostError(format!("invalid batch JSON: {e}"))
            })?;

        if items.len() > MAX_BATCH_ITEMS {
            return Err(ExecutionError::SecurityViolation(format!(
                "batch exceeds item limit: {} items (max {})",
                items.len(),
                MAX_BATCH_ITEMS
            )));
        }

        let mut valid = 0u32;
        for item in &items {
            let did = item.get("signer_did").and_then(|v| v.as_str()).unwrap_or("");
            let msg = item.get("message_hex").and_then(|v| v.as_str()).unwrap_or("");
            let sig = item.get("signature_hex").and_then(|v| v.as_str()).unwrap_or("");
            if let Ok(true) = self.verify_signature(did, msg, sig) {
                valid += 1;
            }
        }
        Ok(valid)
    }
}

impl<S: LedgerStorage + 'static> Ledger<S> {
    /// Execute a WASM module that has been registered and activated in the
    /// `execution.module` namespace.
    ///
    /// Looks up the module's bytecode from the REGISTER_MODULE entry, checks
    /// that an ACTIVATE_MODULE entry exists, and runs the handler.
    pub fn execute_wasm_module(
        &self,
        module_id: &str,
        params_json: &str,
        gas_limit: u64,
    ) -> Result<ExecutionResult> {
        let engine = self.wasm_engine.as_ref().ok_or_else(|| {
            ProtocolError::ValidationFailed("wasm execution not enabled on this ledger".into())
        })?;

        // Verify the module is activated
        let entries = self
            .storage
            .namespace_entries(&"execution.module".to_string())?;
        let activated = entries.iter().any(|e| {
            e.object_id == module_id && e.action == "ACTIVATE_MODULE"
        });
        if !activated {
            return Err(ProtocolError::ValidationFailed(format!(
                "module '{module_id}' is not activated"
            )));
        }

        let host = Arc::new(LedgerWasmHost {
            storage: self.storage.clone(),
        });

        let wasm_bytes = host
            .load_module_bytecode(module_id)
            .map_err(|e| ProtocolError::ValidationFailed(format!("load module: {e}")))?;

        engine
            .execute(&wasm_bytes, module_id, params_json, gas_limit, host)
            .map_err(|e| ProtocolError::ValidationFailed(format!("wasm execution: {e}")))
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
    use crate::canonical_json;
    use citizen_crypto::{sign_message, verifying_key_to_string, ValidatorKeypair};
    use citizen_execution::WasmHost;
    use citizen_storage::{LedgerStorage, MemoryStorage};
    use citizen_types::{
        CommitProof, LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset, PrivacyMode,
    };
    use citizen_wallet::{sign_entry, EntryDraft, WalletKeypair};
    use serde_json::json;
    use std::collections::{BTreeSet, HashMap};
    use std::sync::Arc;
    use uuid::Uuid;

    fn test_entry(namespace: &str) -> LedgerEntry {
        LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".into(),
            object_id: "LOT-239-A".into(),
            payload: json!({"from":"did:a","to":"did:b"}),
            privacy_flag: false,
            privacy_mode: PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
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

    fn grant_approver_keys(approvers: &[&str]) -> HashMap<String, ValidatorKeypair> {
        approvers
            .iter()
            .map(|approver| {
                (
                    (*approver).to_string(),
                    ValidatorKeypair::generate((*approver).to_string()),
                )
            })
            .collect()
    }

    fn grant_approvers_config(keys: &HashMap<String, ValidatorKeypair>) -> Vec<serde_json::Value> {
        let mut approver_ids: Vec<&String> = keys.keys().collect();
        approver_ids.sort();
        approver_ids
            .iter()
            .map(|approver| {
                let keypair = keys
                    .get(*approver)
                    .expect("grant approver keypair must exist");
                json!({
                    "id": approver,
                    "public_key": verifying_key_to_string(keypair.verifying_key())
                })
            })
            .collect()
    }

    fn attach_multisig_proofs(
        entry: &mut LedgerEntry,
        approvers: &[&str],
        keys: &HashMap<String, ValidatorKeypair>,
    ) {
        let amount = entry
            .payload
            .get("amount")
            .and_then(serde_json::Value::as_u64)
            .expect("multisig grant amount");

        let proofs: Vec<serde_json::Value> = approvers
            .iter()
            .map(|approver| {
                let keypair = keys
                    .get(*approver)
                    .expect("missing key for requested approver");
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

    fn envelope_multisig_payload(scope: &str, signers: serde_json::Value) -> serde_json::Value {
        json!({
            "envelope_multisig": {
                "signature_scope": scope,
                "signers": signers
            }
        })
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
    fn rejects_encrypted_entries_when_namespace_disallows_privacy() {
        let ledger = Ledger::in_memory();
        let namespace = "registry.land";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "privacy_policy".into(),
                config: json!({"allow_encryption":false}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.privacy_flag = true;
        entry.privacy_mode = PrivacyMode::Passphrase;
        entry.payload_commitment = Some("deadbeef".into());
        entry.ciphertext_hex = Some("00".into());
        entry.nonce_hex = Some("00".into());
        entry.salt_hex = Some("00".into());
        entry.kdf_params = Some(citizen_types::KdfParams {
            memory_kib: 19456,
            iterations: 2,
            parallelism: 1,
            output_length: 32,
        });
        entry.consent_receipt = Some(citizen_types::ConsentReceipt {
            subject_did: entry.author.clone(),
            data_hash: "deadbeef".into(),
            policy_ref: "policy:v1".into(),
            granted_at: entry.timestamp,
            expires_at: entry.timestamp + 100,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: Default::default(),
        });

        let err = ledger
            .apply_entry(entry)
            .expect_err("privacy disabled namespace must reject encrypted entries");
        assert!(err
            .to_string()
            .contains("does not permit encrypted payloads"));
    }

    #[test]
    fn requires_commitment_and_consent_for_encrypted_entries() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "privacy_policy".into(),
                config: json!({"allow_encryption":true}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.privacy_flag = true;
        entry.privacy_mode = PrivacyMode::Passphrase;
        let err = ledger
            .apply_entry(entry)
            .expect_err("missing encrypted metadata must fail");
        assert!(err
            .to_string()
            .contains("must include ciphertext, nonce, and payload_commitment"));
    }

    #[test]
    fn accepts_wallet_signed_encrypt_then_commit_entry_when_namespace_allows_privacy() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "privacy_policy".into(),
                config: json!({"allow_encryption": true}),
            }],
        )]);

        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-ETC-1".to_string(),
            payload: json!({"event":"BID_OPENED","document_hash":"abc123"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Passphrase,
            encryption_passphrase: Some("e2e-opt-in-passphrase".to_string()),
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: Default::default(),
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_222,
        };

        let entry = sign_entry(draft, &keypair).expect("wallet should sign encrypted entry");
        ledger
            .apply_entry(entry)
            .expect("ledger should accept valid encrypt-then-commit entry");
    }

    #[test]
    fn accepts_wallet_signed_selective_encryption_entry_when_namespace_allows_privacy() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "privacy_policy".into(),
                config: json!({"allow_encryption": true}),
            }],
        )]);

        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-ETC-SELECTIVE-1".to_string(),
            payload: json!({
                "public_fields": {"event":"BID_OPENED","document_hash":"abc123"},
                "private_fields": {"vendor_email":"alice@example.org","amount":9000},
                "public_allowlist": ["document_hash","event"]
            }),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Passphrase,
            encryption_passphrase: Some("e2e-opt-in-passphrase".to_string()),
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: Default::default(),
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_223,
        };

        let entry = sign_entry(draft, &keypair).expect("wallet should sign selective entry");
        ledger
            .apply_entry(entry)
            .expect("ledger should accept valid selective encrypted entry");
    }

    #[test]
    fn rejects_selective_encryption_entry_with_mismatched_allowlist() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "privacy_policy".into(),
                config: json!({"allow_encryption": true}),
            }],
        )]);

        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-ETC-SELECTIVE-2".to_string(),
            payload: json!({
                "public_fields": {"event":"BID_OPENED"},
                "private_fields": {"vendor_email":"alice@example.org"},
                "public_allowlist": ["event"]
            }),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Passphrase,
            encryption_passphrase: Some("e2e-opt-in-passphrase".to_string()),
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: Default::default(),
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_224,
        };

        let mut entry = sign_entry(draft, &keypair).expect("wallet should sign selective entry");
        entry.payload["public_allowlist"] = json!(["event", "extra"]);
        let err = ledger
            .apply_entry(entry)
            .expect_err("ledger should reject malformed selective entry");
        assert!(err
            .to_string()
            .contains("must exactly match payload.public_fields keys"));
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
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "max_daily_spend": 100,
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys)
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 50_u64});
        let grant_id = grant.entry_id.to_string();
        attach_multisig_proofs(
            &mut grant,
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload = json!({
            "amount": 40_u64,
            "credit_grant_id": grant_id,
            "sponsorship_id":"spn-1",
            "sponsored_did":"did:ledger:user1"
        });
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
        over_spend.payload = json!({
            "amount": 20_u64,
            "credit_grant_id": grant_id,
            "sponsorship_id":"spn-2",
            "sponsored_did":"did:ledger:user2"
        });
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
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "max_daily_spend": 25,
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys)
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 100_u64});
        let grant_id = grant.entry_id.to_string();
        attach_multisig_proofs(
            &mut grant,
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload = json!({
            "amount": 10_u64,
            "credit_grant_id": grant_id,
            "sponsorship_id":"dup-id",
            "sponsored_did":"did:ledger:user1"
        });
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
        limit_breach.payload = json!({
            "amount": 20_u64,
            "credit_grant_id": grant_id,
            "sponsorship_id":"spn-3",
            "sponsored_did":"did:ledger:user3"
        });
        let limit_err = ledger
            .apply_entry(limit_breach)
            .expect_err("daily max spend should fail");
        assert!(limit_err
            .to_string()
            .contains("daily sponsored spend limit exceeded"));
    }

    #[test]
    fn enforces_credit_grant_linkage_for_sponsored_usage() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys)
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 50_u64});
        let grant_id = grant.entry_id.to_string();
        attach_multisig_proofs(
            &mut grant,
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );
        ledger.apply_entry(grant).expect("grant should pass");

        let mut missing_grant_link = test_entry(namespace);
        missing_grant_link.action = "SPONSOR_USAGE".into();
        missing_grant_link.object_id = "builder:alpha".into();
        missing_grant_link.author = "builder:alpha".into();
        missing_grant_link.payload = json!({"amount": 1_u64, "sponsorship_id":"spn-no-grant", "sponsored_did":"did:ledger:user1"});
        let missing_err = ledger
            .apply_entry(missing_grant_link)
            .expect_err("sponsor usage should require credit_grant_id");
        assert!(missing_err.to_string().contains("payload.credit_grant_id"));

        let mut unknown_grant_link = test_entry(namespace);
        unknown_grant_link.action = "SPONSOR_USAGE".into();
        unknown_grant_link.object_id = "builder:alpha".into();
        unknown_grant_link.author = "builder:alpha".into();
        unknown_grant_link.payload = json!({
            "amount": 1_u64,
            "credit_grant_id": "not-a-real-grant",
            "sponsorship_id":"spn-unknown-grant",
            "sponsored_did":"did:ledger:user2"
        });
        let unknown_err = ledger
            .apply_entry(unknown_grant_link)
            .expect_err("unknown credit_grant_id should fail");
        assert!(unknown_err
            .to_string()
            .contains("does not reference an active builder grant"));

        let mut valid = test_entry(namespace);
        valid.action = "SPONSOR_USAGE".into();
        valid.object_id = "builder:alpha".into();
        valid.author = "builder:alpha".into();
        valid.payload = json!({
            "amount": 1_u64,
            "credit_grant_id": grant_id,
            "sponsorship_id":"spn-valid-grant",
            "sponsored_did":"did:ledger:user3"
        });
        ledger
            .apply_entry(valid)
            .expect("known credit_grant_id should pass");
    }

    #[test]
    fn enforces_multisig_credit_grant_threshold_and_approver_allowlist() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys)
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
        attach_multisig_proofs(
            &mut insufficient,
            &["grant:ops-1", "grant:ops-2"],
            &grant_keys,
        );
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
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );
        unauthorized.payload["multisig_proofs"][2]["approver"] = json!("grant:rogue");
        let unauthorized_err = ledger
            .apply_entry(unauthorized)
            .expect_err("unauthorized approver should fail");
        assert!(unauthorized_err
            .to_string()
            .contains("outside grant_approvers"));
    }

    #[test]
    fn programmable_multisig_grant_allows_automation_after_policy_setup() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys),
                    "programmable_multisig": {
                        "enabled": true,
                        "policy_id": "builder-auto-v1",
                        "actors": ["automation.builder-credit-bot"],
                        "max_grant_amount": 75
                    }
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "PROGRAMMABLE_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "automation.builder-credit-bot".into();
        grant.payload = json!({"amount": 40_u64, "policy_id": "builder-auto-v1"});
        let grant_id = grant.entry_id.to_string();
        ledger.apply_entry(grant).expect(
            "programmable grant should pass without manual signatures once policy is configured",
        );

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload = json!({"amount": 30_u64, "credit_grant_id": grant_id, "sponsorship_id":"prog-spn-1", "sponsored_did":"did:ledger:user1"});
        ledger
            .apply_entry(spend)
            .expect("spend should use programmable granted balance");
    }

    #[test]
    fn programmable_multisig_grant_enforces_actor_and_amount_limits() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys),
                    "programmable_multisig": {
                        "enabled": true,
                        "policy_id": "builder-auto-v1",
                        "actors": ["automation.builder-credit-bot"],
                        "max_grant_amount": 50
                    }
                }),
            }],
        )]);

        let mut unauthorized_actor = test_entry(namespace);
        unauthorized_actor.action = "PROGRAMMABLE_CREDIT_GRANT".into();
        unauthorized_actor.object_id = "builder:alpha".into();
        unauthorized_actor.author = "automation.rogue".into();
        unauthorized_actor.payload = json!({"amount": 40_u64, "policy_id": "builder-auto-v1"});
        let actor_err = ledger
            .apply_entry(unauthorized_actor)
            .expect_err("unapproved automation actor must fail");
        assert!(actor_err
            .to_string()
            .contains("not an approved automation actor"));

        let mut over_cap = test_entry(namespace);
        over_cap.action = "PROGRAMMABLE_CREDIT_GRANT".into();
        over_cap.object_id = "builder:alpha".into();
        over_cap.author = "automation.builder-credit-bot".into();
        over_cap.payload = json!({"amount": 60_u64, "policy_id": "builder-auto-v1"});
        let amount_err = ledger
            .apply_entry(over_cap)
            .expect_err("amount above max_grant_amount should fail");
        assert!(amount_err.to_string().contains("max_grant_amount"));
    }

    #[test]
    fn rejects_multisig_grant_when_proof_key_does_not_match_configured_approver_key() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({
                    "required_grant_approvals": 3,
                    "grant_approvers": grant_approvers_config(&grant_keys)
                }),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "MULTISIG_CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 25_u64});
        attach_multisig_proofs(
            &mut grant,
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );

        let mismatched_key = verifying_key_to_string(
            ValidatorKeypair::generate("grant:rogue".into()).verifying_key(),
        );
        grant.payload["multisig_proofs"][0]["public_key"] = json!(mismatched_key);

        let err = ledger
            .apply_entry(grant)
            .expect_err("mismatched proof key should fail");
        assert!(err
            .to_string()
            .contains("public_key does not match configured key"));
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
            "audit_hash": "audit:abc",
            "wasm_bytes": "AAECAwQFBgc="
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

    #[test]
    fn envelope_multisig_policy_passes_for_targeted_action() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "envelope_multisig_policy".into(),
                config: json!({
                    "actions": ["RECORD_EVENT"],
                    "allowed_signers": ["did:key:alice", "did:key:bob", "did:key:carol"],
                    "threshold": 2,
                    "signature_scope": "canonical_payload_v1",
                    "required_roles": ["initiator", "approver"]
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = envelope_multisig_payload(
            "canonical_payload_v1",
            json!([
                {"id": "did:key:alice", "role": "initiator"},
                {"id": "did:key:bob", "role": "approver"}
            ]),
        );

        ledger
            .apply_entry(entry)
            .expect("targeted multisig policy should pass with valid signer set");
    }

    #[test]
    fn envelope_multisig_policy_rejects_threshold_shortfall() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "envelope_multisig_policy".into(),
                config: json!({
                    "allowed_signers": ["did:key:alice", "did:key:bob", "did:key:carol"],
                    "threshold": 3,
                    "signature_scope": "canonical_payload_v1"
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = envelope_multisig_payload(
            "canonical_payload_v1",
            json!(["did:key:alice", "did:key:bob"]),
        );
        let err = ledger
            .apply_entry(entry)
            .expect_err("threshold shortfall should fail");
        assert!(err
            .to_string()
            .contains("must include at least 3 unique signers"));
    }

    #[test]
    fn envelope_multisig_policy_rejects_signer_allowlist_mismatch() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "envelope_multisig_policy".into(),
                config: json!({
                    "allowed_signers": ["did:key:alice", "did:key:bob"],
                    "threshold": 2,
                    "signature_scope": "canonical_payload_v1"
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = envelope_multisig_payload(
            "canonical_payload_v1",
            json!(["did:key:alice", "did:key:mallory"]),
        );
        let err = ledger
            .apply_entry(entry)
            .expect_err("unauthorized signer should fail");
        assert!(err.to_string().contains("outside allowed_signers"));
    }

    #[test]
    fn envelope_multisig_policy_rejects_missing_required_role() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "envelope_multisig_policy".into(),
                config: json!({
                    "allowed_signers": ["did:key:alice", "did:key:bob"],
                    "threshold": 2,
                    "signature_scope": "canonical_payload_v1",
                    "required_roles": ["initiator", "approver"]
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = envelope_multisig_payload(
            "canonical_payload_v1",
            json!([
                {"id": "did:key:alice", "role": "initiator"},
                {"id": "did:key:bob", "role": "observer"}
            ]),
        );
        let err = ledger
            .apply_entry(entry)
            .expect_err("required role mismatch should fail");
        assert!(err.to_string().contains("missing required role approver"));
    }

    #[test]
    fn envelope_multisig_policy_skips_non_targeted_action() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "envelope_multisig_policy".into(),
                config: json!({
                    "actions": ["MULTISIG_COMMIT"],
                    "allowed_signers": ["did:key:alice", "did:key:bob"],
                    "threshold": 2,
                    "signature_scope": "canonical_payload_v1"
                }),
            }],
        )]);

        let entry = test_entry(namespace);
        ledger
            .apply_entry(entry)
            .expect("non-targeted action should not require multisig payload");
    }
    #[test]
    fn validate_entry_submission_requires_verifiable_signature_material() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        )]);

        let entry = test_entry(namespace);
        let err = ledger
            .validate_entry_submission(&entry)
            .expect_err("submission without key material must fail");
        assert!(err
            .to_string()
            .contains("unable to resolve verifying key for submission"));
    }

    #[test]
    fn validate_entry_submission_accepts_valid_author_public_key_signature() {
        let ledger = Ledger::in_memory();
        let namespace = "audit.procurement";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        )]);

        let keypair = ValidatorKeypair::generate("did:author:a".into());
        let mut entry = test_entry(namespace);
        entry.payload["author_public_key"] =
            json!(verifying_key_to_string(keypair.verifying_key()));
        let signing_payload = serde_json::json!({
            "entry_id": entry.entry_id,
            "namespace": entry.namespace,
            "action": entry.action,
            "object_id": entry.object_id,
            "payload": entry.payload,
            "author": entry.author,
            "timestamp": entry.timestamp,
        });
        let signature = sign_message(&keypair, canonical_json(&signing_payload).as_bytes());
        entry.signature = hex::encode(signature.to_bytes());

        ledger
            .validate_entry_submission(&entry)
            .expect("valid signature should be accepted");
    }

    #[test]
    fn require_payload_fields_accepts_nested_field_paths() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_payload_fields".into(),
                config: json!({"fields": ["wallet_signature.signer"]}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = json!({
            "wallet_signature": {
                "signer": "did:key:ed25519:abc123"
            }
        });

        ledger
            .apply_entry(entry)
            .expect("nested payload field should satisfy require_payload_fields");
    }

    #[test]
    fn require_payload_fields_rejects_missing_nested_field_paths() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_payload_fields".into(),
                config: json!({"fields": ["wallet_signature.signer"]}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = json!({
            "wallet_signature": {
                "verifying_key": "deadbeef"
            }
        });

        let err = ledger
            .apply_entry(entry)
            .expect_err("missing nested signer should fail validation");
        assert!(err
            .to_string()
            .contains("payload field 'wallet_signature.signer' is required"));
    }

    #[test]
    fn privacy_flag_true_rejects_email_object_id_with_actionable_error_code() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.privacy_flag = true;
        entry.privacy_mode = PrivacyMode::Hybrid;
        entry.object_id = "person@example.com".into();

        let err = ledger
            .apply_entry(entry)
            .expect_err("email object_id should be blocked when privacy_flag=true");
        let message = err.to_string();
        assert!(message.contains("code=PRIVACY_OBJECT_ID_PII"));
        assert!(message.contains("guidance='Use a non-PII object identifier"));
    }

    #[test]
    fn privacy_flag_true_rejects_sensitive_payload_fields_with_actionable_error_code() {
        let ledger = Ledger::in_memory();
        let namespace = "forms.commitment";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.privacy_flag = true;
        entry.privacy_mode = PrivacyMode::Hybrid;
        entry.object_id = "onboarding_submission:abc123".into();
        entry.payload = json!({
            "email": "person@example.com",
            "country": "Philippines",
            "data_hash": "sha256:abc123"
        });

        let err = ledger
            .apply_entry(entry)
            .expect_err("sensitive payload fields should be blocked when privacy_flag=true");
        let message = err.to_string();
        assert!(message.contains("code=PRIVACY_PAYLOAD_PII"));
        assert!(message.contains("fields=email,country"));
    }

    #[test]
    fn wasm_host_check_governance_fails_closed() {
        let storage = Arc::new(MemoryStorage::new());
        let host = super::LedgerWasmHost { storage };
        let result = WasmHost::check_governance_approval(&host, "prop-123");
        assert_eq!(result.unwrap(), false);
    }

    #[test]
    fn wasm_host_batch_rejects_oversized_json() {
        let storage = Arc::new(MemoryStorage::new());
        let host = super::LedgerWasmHost { storage };
        let big = "a".repeat(2_000_000);
        let batch = format!(
            r#"[{{"signer_did":"d","message_hex":"{big}","signature_hex":"s"}}]"#
        );
        let result = WasmHost::verify_signature_batch(&host, &batch);
        assert!(result.is_err(), "should reject oversized batch JSON");
        let err = result.unwrap_err().to_string();
        assert!(err.contains("size"), "expected size violation: {err}");
    }

    #[test]
    fn wasm_host_batch_rejects_too_many_items() {
        let storage = Arc::new(MemoryStorage::new());
        let host = super::LedgerWasmHost { storage };
        let items: Vec<String> = (0..300)
            .map(|i| {
                format!(
                    r#"{{"signer_did":"d{i}","message_hex":"m","signature_hex":"s"}}"#
                )
            })
            .collect();
        let batch = format!("[{}]", items.join(","));
        let result = WasmHost::verify_signature_batch(&host, &batch);
        assert!(result.is_err(), "should reject too many batch items");
        let err = result.unwrap_err().to_string();
        assert!(err.contains("item"), "expected item limit violation: {err}");
    }

    #[test]
    fn wasm_host_store_state_uses_hash_commitment() {
        let storage = Arc::new(MemoryStorage::new());
        let host = super::LedgerWasmHost {
            storage: storage.clone(),
        };

        WasmHost::store_state(&host, "test-module", "counter", "42").unwrap();

        let entries = storage
            .namespace_entries(&"execution.module".to_string())
            .unwrap();
        let entry = entries
            .iter()
            .find(|e| e.action == "STATE_WRITE")
            .expect("should find STATE_WRITE entry");

        assert!(
            entry.author.contains("test-module"),
            "author should be module-scoped: {}",
            entry.author
        );
        assert_eq!(
            entry.signature.len(),
            64,
            "signature should be 64-char hex hash, not a hardcoded string"
        );
        assert_ne!(
            entry.signature, "system.execution",
            "signature must not be the old hardcoded string"
        );
        assert_eq!(
            entry
                .payload
                .get("system_generated")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}
