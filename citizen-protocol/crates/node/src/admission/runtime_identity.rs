pub const RUNTIME_NETWORK_ID: &str = "citizen-localnet";

pub const RUNTIME_PSK_HASH: Option<&str> = option_env!("CITIZEN_RUNTIME_PSK_HASH");

pub const ACTIVE_MANIFEST_KEYS: &[&str] = &[];
pub const TRANSITION_MANIFEST_KEYS: &[&str] = &[];
pub const REVOKED_MANIFEST_KEYS: &[&str] = &[];

pub const REQUIRE_DUAL_SIGNATURE_DURING_TRANSITION: bool = true;
pub const TRANSITION_DUAL_SIGNATURE_UNTIL_UNIX_SECS: Option<i64> = None;

pub const MANIFEST_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;
pub const MANIFEST_MAX_FUTURE_SKEW_SECS: i64 = 300;
