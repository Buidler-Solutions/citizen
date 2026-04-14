use std::process::Command;

#[test]
fn weight_fixture_runner_is_reproducible_across_processes() {
    let first = Command::new(env!("CARGO_BIN_EXE_weight_fixture_runner"))
        .current_dir("../..")
        .output()
        .expect("first process invocation");
    assert!(first.status.success(), "first process failed");

    let second = Command::new(env!("CARGO_BIN_EXE_weight_fixture_runner"))
        .current_dir("../..")
        .output()
        .expect("second process invocation");
    assert!(second.status.success(), "second process failed");

    assert_eq!(first.stdout, second.stdout, "cross-process output drift");

    let report: serde_json::Value =
        serde_json::from_slice(&first.stdout).expect("runner report json output");
    let rows = report.as_array().expect("runner report rows");
    assert!(!rows.is_empty(), "expected non-empty fixture report");

    for row in rows {
        let expected = row["expected_weight_bytes"]
            .as_u64()
            .expect("expected bytes");
        let computed = row["computed_weight_bytes"]
            .as_u64()
            .expect("computed bytes");
        assert_eq!(
            expected,
            computed,
            "fixture weight mismatch for {}",
            row["fixture_id"].as_str().unwrap_or("<unknown>")
        );
    }
}
