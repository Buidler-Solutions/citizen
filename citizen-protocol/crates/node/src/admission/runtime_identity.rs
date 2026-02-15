pub const RUNTIME_NETWORK_ID: &str = "citizen-localnet";

pub const RUNTIME_PSK_HASH: Option<&str> = option_env!("CITIZEN_RUNTIME_PSK_HASH");

pub const TRUSTED_MANIFEST_KEYS: &[&str] = &[];

pub const MANIFEST_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;
pub const MANIFEST_MAX_FUTURE_SKEW_SECS: i64 = 300;
