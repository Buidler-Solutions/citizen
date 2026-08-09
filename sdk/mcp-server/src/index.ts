#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const nodeUrl = process.env.CITIZEN_NODE_URL ?? "http://localhost:7001";
const apiKey = process.env.CITIZEN_API_KEY;

async function main() {
  const server = createServer(nodeUrl, apiKey);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Citizen Protocol MCP server connected to ${nodeUrl}\n`);
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
