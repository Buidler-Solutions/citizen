//! Typed storage abstractions — Solidity-like state variable access.
//!
//! Provides [`Item<T>`] for single-value storage and [`Map<K, V>`] for
//! keyed lookups, both backed by `host_store_state` / `host_load_state`.

use crate::api::{store_state, load_state};
use crate::ContractError;
use alloc::string::String;
use alloc::string::ToString;
use alloc::format;
use serde::{Serialize, de::DeserializeOwned};

/// The default storage accessor. Provides untyped key-value operations
/// and serves as the factory for [`Item`] and [`Map`] instances.
#[derive(Clone, Copy)]
pub struct Storage;

impl Storage {
    /// Store a typed value at the given key (JSON-serialized).
    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), ContractError> {
        let json = serde_json::to_string(value)
            .map_err(|e| ContractError::Serde(e.to_string()))?;
        if store_state(key, &json) {
            Ok(())
        } else {
            Err(ContractError::Storage("store_state returned failure".into()))
        }
    }

    /// Store a raw string value at the given key.
    pub fn set_str(&self, key: &str, value: &str) -> Result<(), ContractError> {
        if store_state(key, value) {
            Ok(())
        } else {
            Err(ContractError::Storage("store_state returned failure".into()))
        }
    }

    /// Load a typed value from the given key (JSON-deserialized).
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ContractError> {
        match load_state(key) {
            Some(json) => {
                let value = serde_json::from_str(&json)
                    .map_err(|e| ContractError::Serde(e.to_string()))?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    /// Load a raw string value from the given key.
    pub fn get_str(&self, key: &str) -> Option<String> {
        load_state(key)
    }

    /// Check whether a key exists in state.
    pub fn exists(&self, key: &str) -> bool {
        load_state(key).is_some()
    }

    /// Remove a key from state by storing an empty value.
    pub fn remove(&self, key: &str) {
        let _ = store_state(key, "");
    }

    /// Create a typed single-value accessor (like a Solidity state variable).
    pub fn item<T: Serialize + DeserializeOwned>(&self, key: &str) -> Item<T> {
        Item { key: String::from(key), _phantom: core::marker::PhantomData }
    }

    /// Create a typed keyed map accessor (like a Solidity `mapping`).
    pub fn map<K: ToString, V: Serialize + DeserializeOwned>(&self, prefix: &str) -> Map<K, V> {
        Map { prefix: String::from(prefix), _phantom: core::marker::PhantomData }
    }
}

/// A typed single-value storage slot (Solidity state variable equivalent).
///
/// ```ignore
/// let admin_count: Item<u64> = storage.item("admin_count");
/// admin_count.save(&42)?;
/// let count = admin_count.load()?.unwrap_or(0);
/// ```
pub struct Item<T> {
    key: String,
    _phantom: core::marker::PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned> Item<T> {
    pub fn save(&self, value: &T) -> Result<(), ContractError> {
        let json = serde_json::to_string(value)
            .map_err(|e| ContractError::Serde(e.to_string()))?;
        if store_state(&self.key, &json) {
            Ok(())
        } else {
            Err(ContractError::Storage("store_state failed".into()))
        }
    }

    pub fn load(&self) -> Result<Option<T>, ContractError> {
        match load_state(&self.key) {
            Some(json) => {
                Ok(Some(serde_json::from_str(&json)
                    .map_err(|e| ContractError::Serde(e.to_string()))?))
            }
            None => Ok(None),
        }
    }

    pub fn exists(&self) -> bool {
        load_state(&self.key).is_some()
    }

    pub fn remove(&self) {
        let _ = store_state(&self.key, "");
    }

    pub fn update<F>(&self, f: F) -> Result<T, ContractError>
    where
        F: FnOnce(T) -> T,
        T: Default,
    {
        let current = self.load()?.unwrap_or_default();
        let updated = f(current);
        self.save(&updated)?;
        Ok(updated)
    }
}

/// A typed keyed map (Solidity `mapping(K => V)` equivalent).
///
/// ```ignore
/// let admins: Map<String, Admin> = storage.map("admin");
/// admins.save(&"did:key:...", &Admin { ... })?;
/// let admin = admins.load(&"did:key:...")?;
/// ```
pub struct Map<K, V> {
    prefix: String,
    _phantom: core::marker::PhantomData<(K, V)>,
}

impl<K: ToString, V: Serialize + DeserializeOwned> Map<K, V> {
    fn key(&self, k: &K) -> String {
        format!("{}:{}", self.prefix, k.to_string())
    }

    pub fn save(&self, key: &K, value: &V) -> Result<(), ContractError> {
        let k = self.key(key);
        let json = serde_json::to_string(value)
            .map_err(|e| ContractError::Serde(e.to_string()))?;
        if store_state(&k, &json) {
            Ok(())
        } else {
            Err(ContractError::Storage("store_state failed".into()))
        }
    }

    pub fn load(&self, key: &K) -> Result<Option<V>, ContractError> {
        let k = self.key(key);
        match load_state(&k) {
            Some(json) => {
                Ok(Some(serde_json::from_str(&json)
                    .map_err(|e| ContractError::Serde(e.to_string()))?))
            }
            None => Ok(None),
        }
    }

    pub fn exists(&self, key: &K) -> bool {
        let k = self.key(key);
        load_state(&k).is_some()
    }

    pub fn remove(&self, key: &K) {
        let k = self.key(key);
        let _ = store_state(&k, "");
    }
}
