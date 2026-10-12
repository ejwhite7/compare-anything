// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), so the
// plugin needs no npm install.
import { createInterface } from "node:readline";
import { tools, callTool } from "./tools.mjs";
import { GateError } from "./engine.mjs";
import { APP } from "./config.mjs";

export async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: APP.id, version: APP.version },
        instructions:
          "Evidence-backed competitive comparison in four gated steps: research, approve framework, freeze baseline, compare & review. Load the compare-anything skill before using these tools.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call":
      try {
        const result = await callTool(params.name, params.arguments);
        return reply({
          content: [
            {
              type: "text",
              text:
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        });
      } catch (e) {
        // Gate failures are expected outcomes Claude must act on.
        if (!(e instanceof GateError)) console.error(e);
        return reply({
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }
    default:
      if (id === undefined) return; // notification
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

export function serveStdio(input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n",
      );
      return;
    }
    const response = await handle(message);
    if (response) output.write(JSON.stringify(response) + "\n");
  });
  return lines;
}
