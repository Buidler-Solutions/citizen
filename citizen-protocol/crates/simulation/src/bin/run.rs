use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use citizen_simulation::{SimulationHarness, SimulationReport};
use citizen_types::{NetworkModel, SimulationConfig, SimulationScenario};
use tracing_subscriber::FmtSubscriber;

#[derive(Clone, Debug)]
struct CliOptions {
    validators: usize,
    scenario: SimulationScenario,
    duration_secs: u64,
    matrix: bool,
    out_dir: PathBuf,
}

#[derive(Clone, Debug, serde::Serialize)]
struct ReleaseMatrixReport {
    generated_at: String,
    duration_secs: u64,
    runs: Vec<ReleaseMatrixRun>,
}

#[derive(Clone, Debug, serde::Serialize)]
struct ReleaseMatrixRun {
    validators: usize,
    scenario: String,
    report_path: Option<String>,
    duration_secs: u64,
    max_height: u64,
    min_height: u64,
    broadcasts: u64,
    unicasts: u64,
    dropped: u64,
    latency_p50_ms: u64,
    latency_p90_ms: u64,
    latency_p99_ms: u64,
    latency_samples: usize,
}

#[tokio::main]
async fn main() {
    let subscriber = FmtSubscriber::builder().with_target(false).finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let options = parse_cli(std::env::args().collect());
    if let Err(err) = std::fs::create_dir_all(&options.out_dir) {
        panic!(
            "failed to create output directory {}: {err}",
            options.out_dir.display()
        );
    }

    if options.matrix {
        run_release_matrix(&options).await;
        return;
    }

    let config = SimulationConfig {
        validators: options.validators,
        scenario: options.scenario,
        network: default_network_model(),
    };

    let report = run_simulation(config, options.duration_secs).await;
    print_report(&report);
}

async fn run_release_matrix(options: &CliOptions) {
    let validator_sizes = [50, 75, 100];
    let scenarios = [
        SimulationScenario::Normal,
        SimulationScenario::PartialFailure,
        SimulationScenario::QuorumLoss,
        SimulationScenario::MaliciousLeader,
        SimulationScenario::ByzantineSubset,
        SimulationScenario::NetworkPartition,
    ];

    let mut runs = Vec::new();
    for validators in validator_sizes {
        for scenario in scenarios.iter().cloned() {
            let config = SimulationConfig {
                validators,
                scenario: scenario.clone(),
                network: default_network_model(),
            };
            let report = run_simulation(config, options.duration_secs).await;
            print_matrix_line(validators, &scenario, &report);
            runs.push(matrix_run(validators, scenario, &report));
        }
    }

    let matrix = ReleaseMatrixReport {
        generated_at: Utc::now().to_rfc3339(),
        duration_secs: options.duration_secs,
        runs,
    };

    let filename = format!(
        "simulation-release-gate-{}.json",
        Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = options.out_dir.join(filename);
    let payload = serde_json::to_vec_pretty(&matrix).expect("serialize release matrix");
    std::fs::write(&path, payload).expect("write release matrix report");
    println!("Release gate matrix artifact written to {}", path.display());
}

fn matrix_run(
    validators: usize,
    scenario: SimulationScenario,
    report: &SimulationReport,
) -> ReleaseMatrixRun {
    let heights: Vec<u64> = report.final_heights.values().copied().collect();
    let max_height = heights.iter().copied().max().unwrap_or(0);
    let min_height = heights.iter().copied().min().unwrap_or(0);
    ReleaseMatrixRun {
        validators,
        scenario: scenario_label(&scenario).to_owned(),
        report_path: report
            .golden_artifact
            .as_ref()
            .map(|path| path.display().to_string()),
        duration_secs: report.duration_secs,
        max_height,
        min_height,
        broadcasts: report.message_counters.broadcasts,
        unicasts: report.message_counters.unicasts,
        dropped: report.message_counters.dropped,
        latency_p50_ms: report.latency_ms.p50,
        latency_p90_ms: report.latency_ms.p90,
        latency_p99_ms: report.latency_ms.p99,
        latency_samples: report.latency_ms.samples,
    }
}

fn print_matrix_line(validators: usize, scenario: &SimulationScenario, report: &SimulationReport) {
    let heights: Vec<u64> = report.final_heights.values().copied().collect();
    let max_height = heights.iter().copied().max().unwrap_or(0);
    let min_height = heights.iter().copied().min().unwrap_or(0);
    println!(
        "[matrix] validators={} scenario={} height(min/max)={}/{} latency(p50/p90/p99)={}/{}/{} samples={} artifact={}",
        validators,
        scenario_label(scenario),
        min_height,
        max_height,
        report.latency_ms.p50,
        report.latency_ms.p90,
        report.latency_ms.p99,
        report.latency_ms.samples,
        report
            .golden_artifact
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "none".to_string())
    );
}

fn scenario_label(scenario: &SimulationScenario) -> &'static str {
    match scenario {
        SimulationScenario::Normal => "normal",
        SimulationScenario::PartialFailure => "partial_failure",
        SimulationScenario::QuorumLoss => "quorum_loss",
        SimulationScenario::MaliciousLeader => "malicious_leader",
        SimulationScenario::ByzantineSubset => "byzantine_subset",
        SimulationScenario::NetworkPartition => "network_partition",
    }
}

async fn run_simulation(config: SimulationConfig, duration_secs: u64) -> SimulationReport {
    let harness = SimulationHarness::new(config).expect("simulation init");
    harness
        .execute(Duration::from_secs(duration_secs))
        .await
        .expect("simulation run")
}

fn print_report(report: &SimulationReport) {
    println!("Simulation finished after {}s", report.duration_secs);
    println!("Final heights: {:#?}", report.final_heights);
    println!(
        "Latency percentiles (ms): p50={}, p90={}, p99={} ({} samples)",
        report.latency_ms.p50,
        report.latency_ms.p90,
        report.latency_ms.p99,
        report.latency_ms.samples
    );
    println!(
        "Messages: broadcasts={}, unicasts={}, dropped={}",
        report.message_counters.broadcasts,
        report.message_counters.unicasts,
        report.message_counters.dropped
    );
    if let Some(path) = report.golden_artifact.as_ref() {
        println!("Golden report written to {}", path.display());
    }
}

fn default_network_model() -> NetworkModel {
    NetworkModel {
        same_region_rtt_ms: (20, 50),
        cross_region_rtt_ms: (80, 180),
        jitter_ms: 20,
        packet_loss: 0.01,
    }
}

fn parse_cli(args: Vec<String>) -> CliOptions {
    let mut options = CliOptions {
        validators: 50,
        scenario: SimulationScenario::Normal,
        duration_secs: 10,
        matrix: false,
        out_dir: PathBuf::from("reports/releases"),
    };

    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--matrix" => options.matrix = true,
            "--validators" => {
                idx += 1;
                options.validators = parse_usize_arg(&args, idx, "--validators");
            }
            "--duration-secs" => {
                idx += 1;
                options.duration_secs = parse_u64_arg(&args, idx, "--duration-secs");
            }
            "--scenario" => {
                idx += 1;
                options.scenario = parse_scenario_arg(&args, idx);
            }
            "--out-dir" => {
                idx += 1;
                options.out_dir = Path::new(required_arg(&args, idx, "--out-dir")).to_path_buf();
            }
            "--help" | "-h" => {
                print_help_and_exit();
            }
            other => {
                panic!("unknown option: {other}. Use --help for supported options.");
            }
        }
        idx += 1;
    }

    options
}

fn parse_scenario_arg(args: &[String], idx: usize) -> SimulationScenario {
    match required_arg(args, idx, "--scenario") {
        "normal" => SimulationScenario::Normal,
        "partial_failure" => SimulationScenario::PartialFailure,
        "quorum_loss" => SimulationScenario::QuorumLoss,
        "malicious_leader" => SimulationScenario::MaliciousLeader,
        "byzantine_subset" => SimulationScenario::ByzantineSubset,
        "network_partition" => SimulationScenario::NetworkPartition,
        value => panic!(
            "unsupported scenario '{value}'. Expected one of: normal, partial_failure, quorum_loss, malicious_leader, byzantine_subset, network_partition"
        ),
    }
}

fn parse_usize_arg(args: &[String], idx: usize, flag: &str) -> usize {
    required_arg(args, idx, flag)
        .parse::<usize>()
        .unwrap_or_else(|_| panic!("{flag} expects a positive integer"))
}

fn parse_u64_arg(args: &[String], idx: usize, flag: &str) -> u64 {
    required_arg(args, idx, flag)
        .parse::<u64>()
        .unwrap_or_else(|_| panic!("{flag} expects a positive integer"))
}

fn required_arg<'a>(args: &'a [String], idx: usize, flag: &str) -> &'a str {
    args.get(idx)
        .map(String::as_str)
        .unwrap_or_else(|| panic!("missing value for {flag}"))
}

fn print_help_and_exit() -> ! {
    println!(
        "citizen-simulation run options:\n\
         --matrix                         Run mandatory release gate matrix (50/75/100 x all scenarios)\n\
         --validators <n>                 Validator count for single simulation run (default: 50)\n\
         --scenario <name>                Scenario for single run: normal | partial_failure | quorum_loss | malicious_leader | byzantine_subset | network_partition\n\
         --duration-secs <n>              Simulation duration in seconds (default: 10)\n\
         --out-dir <path>                 Output directory for release matrix report (default: reports/releases)\n\
         -h, --help                       Show this help"
    );
    std::process::exit(0);
}
