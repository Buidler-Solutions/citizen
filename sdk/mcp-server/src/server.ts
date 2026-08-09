import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

import { CitizenClient } from "./client.js";
import { queryTools, actionTools, builderTools } from "./tools/index.js";
import type { ToolDefinition, ToolContext } from "./tools/index.js";
import { resources } from "./resources/index.js";
import { prompts } from "./prompts/index.js";

const allTools: ToolDefinition[] = [...queryTools, ...actionTools, ...builderTools];

export function createServer(nodeUrl: string, apiKey?: string): Server {
  const client = new CitizenClient({ baseUrl: nodeUrl, apiKey });
  const ctx: ToolContext = { client };

  const server = new Server(
    { name: "citizen-protocol-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = allTools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: "text", text: `Error: Unknown tool "${name}". Available tools: ${allTools.map((t) => t.name).join(", ")}` } satisfies TextContent],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args ?? {}, ctx);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text } satisfies TextContent],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Tool "${name}" failed: ${message}` } satisfies TextContent],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const resource = resources.find((r) => r.uri === uri);

    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.content(),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const prompt = prompts.find((p) => p.name === name);

    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    const message = prompt.handler(args ?? {});
    return {
      messages: [message],
    };
  });

  return server;
}
