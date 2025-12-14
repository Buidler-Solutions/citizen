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
}
