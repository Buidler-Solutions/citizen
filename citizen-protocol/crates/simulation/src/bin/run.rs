use std::time::Duration;

use citizen_simulation::SimulationHarness;
use citizen_types::{NetworkModel, SimulationConfig, SimulationScenario};
use tracing_subscriber::FmtSubscriber;

#[tokio::main]
async fn main() {
    let subscriber = FmtSubscriber::builder().with_target(false).finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let config = SimulationConfig {
        validators: 50,
        scenario: SimulationScenario::Normal,
        network: NetworkModel {
            same_region_rtt_ms: (20, 50),
            cross_region_rtt_ms: (80, 180),
            jitter_ms: 20,
            packet_loss: 0.01,
        },
    };

    let harness = SimulationHarness::new(config).expect("simulation init");
    let report = harness
        .execute(Duration::from_secs(10))
        .await
        .expect("simulation run");
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
