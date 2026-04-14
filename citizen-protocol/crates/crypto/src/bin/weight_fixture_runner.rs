use citizen_crypto::{compute_block_weight, compute_entry_weight};
use citizen_types::{Block, LedgerEntry};
use serde::Serialize;

#[derive(Debug, Serialize)]
struct FixtureWeightReport {
    fixture_id: String,
    kind: String,
    expected_weight_bytes: u64,
    computed_weight_bytes: u64,
}

fn main() {
    let mut reports = Vec::new();
    let fixtures = [
        (
            "entry_case_baseline",
            "entry",
            "entry_case_baseline.json",
            323_u64,
        ),
        (
            "entry_case_empty_payload",
            "entry",
            "entry_case_empty_payload.json",
            272_u64,
        ),
        (
            "entry_case_unicode_nested",
            "entry",
            "entry_case_unicode_nested.json",
            361_u64,
        ),
        (
            "entry_case_large_payload",
            "entry",
            "entry_case_large_payload.json",
            1117_u64,
        ),
        (
            "entry_case_selective_encrypted_fields",
            "entry",
            "entry_case_selective_encrypted_fields.json",
            1064_u64,
        ),
        (
            "block_case_empty",
            "block",
            "block_case_empty.json",
            253_u64,
        ),
        (
            "block_case_mixed_entries",
            "block",
            "block_case_mixed_entries.json",
            1004_u64,
        ),
        (
            "block_case_simulation_regression",
            "block",
            "block_case_simulation_regression.json",
            1295_u64,
        ),
    ];
    for (fixture_id, kind, source_file, expected_weight_bytes) in fixtures {
        let fixture_path = format!("docs/fixtures/indexer-metrics/weights/v1/{source_file}");
        let json = std::fs::read_to_string(&fixture_path).expect("fixture json");
        let computed_weight_bytes = match kind {
            "entry" => {
                let entry: LedgerEntry = serde_json::from_str(&json).expect("entry fixture");
                compute_entry_weight(&entry).expect("entry weight")
            }
            "block" => {
                let block: Block = serde_json::from_str(&json).expect("block fixture");
                compute_block_weight(&block).expect("block weight")
            }
            other => panic!("unsupported fixture kind: {other}"),
        };
        reports.push(FixtureWeightReport {
            fixture_id: fixture_id.to_string(),
            kind: kind.to_string(),
            expected_weight_bytes,
            computed_weight_bytes,
        });
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&reports).expect("serialize fixture report")
    );
}
