use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng as DalekOsRng;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process,
};

#[derive(Debug, PartialEq, Eq)]
struct Options {
    validator_id: String,
    output_json: Option<PathBuf>,
}

#[derive(Debug)]
struct GeneratedKeys {
    validator_id: String,
    public_key_hex: String,
    signing_key_hex: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_args(env::args().skip(1))?;
    let generated = generate_keys(&options.validator_id);

    if let Some(output_path) = options.output_json {
        write_output_json(&output_path, &generated)?;
        println!("Wrote keypair JSON to {}", output_path.display());
    }

    print_summary(&generated);
    Ok(())
}

fn parse_args<I>(args: I) -> Result<Options, String>
where
    I: IntoIterator<Item = String>,
{
    let mut validator_id: Option<String> = None;
    let mut output_json: Option<PathBuf> = None;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--validator-id" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "missing value for --validator-id".to_string())?;
                validator_id = Some(value);
            }
            "--output-json" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "missing value for --output-json".to_string())?;
                output_json = Some(PathBuf::from(value));
            }
            "-h" | "--help" => {
                print_usage();
                process::exit(0);
            }
            _ => {
                return Err(format!("unknown argument '{arg}'\n\n{}", usage_text()));
            }
        }
    }

    let validator_id =
        validator_id.ok_or_else(|| format!("--validator-id is required\n\n{}", usage_text()))?;

    Ok(Options {
        validator_id,
        output_json,
    })
}

fn generate_keys(validator_id: &str) -> GeneratedKeys {
    let mut rng = DalekOsRng;
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    GeneratedKeys {
        validator_id: validator_id.to_string(),
        public_key_hex: hex::encode(verifying_key.to_bytes()),
        signing_key_hex: hex::encode(signing_key.to_bytes()),
    }
}

fn write_output_json(path: &Path, keys: &GeneratedKeys) -> Result<(), String> {
    let payload = serde_json::json!({
        "validator_id": keys.validator_id,
        "public_key_hex": keys.public_key_hex,
        "signing_key_hex": keys.signing_key_hex,
    });

    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|err| format!("failed to serialize output JSON: {err}"))?;

    fs::write(path, bytes).map_err(|err| format!("failed to write {}: {err}", path.display()))?;
    set_owner_only_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut perms = fs::metadata(path)
        .map_err(|err| format!("failed to read file metadata for {}: {err}", path.display()))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms).map_err(|err| {
        format!(
            "failed to set file permissions on {}: {err}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn print_summary(keys: &GeneratedKeys) {
    println!("validator_id={}", keys.validator_id);
    println!("public_key_hex={}", keys.public_key_hex);
    println!("signing_key_hex={}", keys.signing_key_hex);
    println!();
    println!("Node config snippet:");
    println!("validator_id = \"{}\"", keys.validator_id);
    println!("signing_key_hex = \"{}\"", keys.signing_key_hex);
    eprintln!("warning: keep signing_key_hex secret and never commit it");
}

fn print_usage() {
    println!("{}", usage_text());
}

fn usage_text() -> &'static str {
    "Usage: cargo run -p citizen-validator-keygen -- --validator-id <ID> [--output-json <PATH>]\n\
\n\
Options:\n\
  --validator-id <ID>    Validator identifier to tag in output\n\
  --output-json <PATH>   Optional JSON output file (written with 0600 permissions on Unix)\n\
  -h, --help             Show this help text"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_requires_validator_id() {
        let err = parse_args(Vec::<String>::new()).expect_err("validator-id should be required");
        assert!(err.contains("--validator-id is required"));
    }

    #[test]
    fn parse_args_supports_output_json() {
        let options = parse_args(vec![
            "--validator-id".to_string(),
            "validator-alpha".to_string(),
            "--output-json".to_string(),
            "./keys.json".to_string(),
        ])
        .expect("args should parse");

        assert_eq!(
            options,
            Options {
                validator_id: "validator-alpha".to_string(),
                output_json: Some(PathBuf::from("./keys.json")),
            }
        );
    }
}
