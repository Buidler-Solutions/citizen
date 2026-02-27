import { spawn } from "node:child_process";
import { CitizenNodeClient } from "../src/index.js";

const NODE_URL = process.env.CITIZEN_NODE_URL ?? "http://127.0.0.1:8081";
const HEALTH_URL = `${NODE_URL}/health`;
const NODE_MODE = (process.env.CITIZEN_NODE_MODE ?? "external").toLowerCase();
const LOCAL_CONFIG_PATH = process.env.CITIZEN_LOCAL_CONFIG_PATH ?? "config/localnet/validator-alpha.toml";
const LOCAL_PROTOCOL_DIR = process.env.CITIZEN_LOCAL_PROTOCOL_DIR ?? "citizen-protocol";
const LOCAL_BUILD_COMMAND = process.env.CITIZEN_LOCAL_BUILD_COMMAND ?? "cargo build -p citizen-node";
const START_COMMAND = process.env.CITIZEN_NODE_START_COMMAND;
const STOP_COMMAND = process.env.CITIZEN_NODE_STOP_COMMAND;

const HEALTH_POLL_INTERVAL_MS = Number(process.env.CITIZEN_NODE_HEALTH_POLL_INTERVAL_MS ?? 1_000);
const HEALTH_TIMEOUT_MS = Number(
  process.env.CITIZEN_NODE_HEALTH_TIMEOUT_MS ?? (NODE_MODE === "local" ? 120_000 : 30_000)
);

class DeterministicStubSigner {
  constructor({ signerId = "did:ledger:builder:smoke", signature = "stub-signature" } = {}) {
    this.signerId = signerId;
    this.signature = signature;
  }

  async getSignerId() {
    return this.signerId;
  }

  async sign() {
    return this.signature;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      stdio: "inherit",
      ...options
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command}`));
      }
    });
  });
}

function startBackgroundCommand(command, options = {}) {
  const child = spawn("bash", ["-lc", command], {
    stdio: "inherit",
    ...options
  });

  child.once("error", (error) => {
    console.error("node_start_failed", error);
  });

  return child;
}

async function waitForHealthyNode({ timeoutMs = HEALTH_TIMEOUT_MS, pollIntervalMs = HEALTH_POLL_INTERVAL_MS } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Node health probe did not pass within ${timeoutMs}ms (${HEALTH_URL})`);
}

async function startNodeForMode(mode) {
  if (mode === "external") {
    return null;
  }

  if (mode === "local") {
    await runCommand(LOCAL_BUILD_COMMAND, { cwd: LOCAL_PROTOCOL_DIR });
    const command = `cargo run -p citizen-node -- ${LOCAL_CONFIG_PATH}`;
    return startBackgroundCommand(command, { cwd: LOCAL_PROTOCOL_DIR });
  }

  if (mode === "command") {
    if (!START_COMMAND) {
      throw new Error("CITIZEN_NODE_START_COMMAND is required when CITIZEN_NODE_MODE=command");
    }

    return startBackgroundCommand(START_COMMAND);
  }

  throw new Error(
    `Unsupported CITIZEN_NODE_MODE \"${mode}\". Use one of: external, local, command.`
  );
}

async function stopNodeForMode(mode, childProcess) {
  if (mode === "command" && STOP_COMMAND) {
    await runCommand(STOP_COMMAND);
    return;
  }

  if (childProcess) {
    childProcess.kill("SIGTERM");
  }
}

async function runSmoke() {
  const client = new CitizenNodeClient({ baseUrl: NODE_URL });
  const signer = new DeterministicStubSigner();

  const submission = await client.submitTransaction({
    namespace: "audit.procurement",
    action: "RECORD_EVENT",
    objectId: "smoke:event:1",
    payload: {
      event: "SDK_SMOKE",
      document_hash: "sha256:smoke"
    },
    signer
  });

  const receiptId = submission?.receipt?.receipt_id;
  if (!receiptId) {
    throw new Error("Missing receipt.receipt_id in submission response");
  }

  console.log(`receipt_id=${receiptId}`);

  const receiptResult = await client.waitForReceipt(receiptId, {
    pollIntervalMs: 500,
    timeoutMs: 15_000,
    isTerminal: (receipt) => {
      const status = receipt?.receipt?.status;
      return status === "Accepted" || status === "Rejected";
    }
  });

  const terminalStatus = receiptResult?.receipt?.status;
  if (terminalStatus !== "Accepted" && terminalStatus !== "Rejected") {
    throw new Error(`Receipt reached non-terminal status: ${terminalStatus ?? "unknown"}`);
  }

  console.log(`terminal_status=${terminalStatus}`);
}

async function main() {
  console.log(`node_mode=${NODE_MODE}`);
  const nodeProcess = await startNodeForMode(NODE_MODE);

  try {
    console.log(`health_timeout_ms=${HEALTH_TIMEOUT_MS}`);
    await waitForHealthyNode();
    await runSmoke();
  } finally {
    await stopNodeForMode(NODE_MODE, nodeProcess);
  }
}

main().catch((error) => {
  console.error("live_node_smoke_failed", error);
  process.exitCode = 1;
});
