//! Response builder for contract return values.

use alloc::string::String;
use serde_json::Value;

/// A contract response. Contains JSON that the host reads back.
///
/// Build with [`Response::success`], [`Response::data`], or [`Response::raw`].
pub struct Response {
    json: String,
}

impl Response {
    /// Simple success: `{"ok":true}`.
    pub fn success() -> Self {
        Response {
            json: String::from("{\"ok\":true}"),
        }
    }

    /// JSON value response. Wraps the value as-is.
    ///
    /// ```ignore
    /// Response::data(json!({"is_admin": true, "role": "commissioner"}))
    /// ```
    pub fn data(value: Value) -> Self {
        Response {
            json: serde_json::to_string(&value).unwrap_or_default(),
        }
    }

    /// String data response: `{"ok":true,"data":"value"}`.
    pub fn data_str(s: &str) -> Self {
        let escaped = serde_json::to_string(s).unwrap_or_default();
        let mut buf = String::from("{\"ok\":true,\"data\":");
        buf.push_str(&escaped);
        buf.push('}');
        Response { json: buf }
    }

    /// Raw JSON string (no wrapping).
    pub fn raw(json_str: &str) -> Self {
        Response {
            json: String::from(json_str),
        }
    }

    /// Get the response as bytes for the WASM result.
    pub fn as_bytes(&self) -> &[u8] {
        self.json.as_bytes()
    }
}
