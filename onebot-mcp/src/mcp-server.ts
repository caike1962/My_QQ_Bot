import http from "node:http";
import { readFileSync } from "node:fs";
import { callTool, listToolsForPlatform, toolDefinitions, type ToolDefinition } from "./tools.js";
import type { AppConfig } from "./config.js";
import type { OneBotClient } from "./onebot-client.js";

const PROTOCOL_VERSION = "2025-11-25";
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version?: string;
};
const PACKAGE_VERSION = packageJson.version ?? "0.0.0";

type JsonObject = Record<string, unknown>;
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type StatusError = Error & { statusCode?: number };

interface McpServerOptions {
  config: AppConfig;
  client: Pick<OneBotClient, "action">;
  definitions?: readonly ToolDefinition[];
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function emptyResponse(res: http.ServerResponse, statusCode: number, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(statusCode, headers);
  res.end();
}

function errorResponse(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function successResponse(id: unknown, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function hasRequestId(message: JsonObject): boolean {
  return Object.hasOwn(message, "id");
}

function isJsonRpcObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) {
      const error = new Error("Request body is too large") as StatusError;
      error.statusCode = 413;
      throw error;
    }
  }

  if (!body) {
    const error = new Error("Request body is required") as StatusError;
    error.statusCode = 400;
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON") as StatusError;
    error.statusCode = 400;
    throw error;
  }
}

function isAuthorized(req: http.IncomingMessage, config: AppConfig): boolean {
  if (!config.mcpToken) return true;
  return req.headers.authorization === `Bearer ${config.mcpToken}`;
}

function originAllowed(req: http.IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.includes("*")) return true;
  return config.allowedOrigins.includes(origin);
}

function routePath(req: http.IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function createMcpHttpServer({ config, client, definitions = toolDefinitions }: McpServerOptions): http.Server {
  const tools = listToolsForPlatform(config.platform, definitions);
  const toolNames = new Set(tools.map((tool) => tool.name));

  async function handleRpcMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isJsonRpcObject(message) || message.jsonrpc !== "2.0") {
      return errorResponse(null, -32600, "Invalid JSON-RPC request");
    }

    if (!hasRequestId(message)) {
      return null;
    }

    try {
      switch (message.method) {
        case "initialize":
          return successResponse(message.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: "onebot-mcp",
              version: PACKAGE_VERSION,
            },
          });
        case "ping":
          return successResponse(message.id, {});
        case "tools/list":
          return successResponse(message.id, { tools });
        case "tools/call": {
          const params = isJsonRpcObject(message.params) ? message.params : {};
          const name = params.name;
          if (typeof name !== "string" || !name) {
            return errorResponse(message.id, -32602, "tools/call requires params.name");
          }
          if (!toolNames.has(name)) {
            return errorResponse(message.id, -32602, `Tool ${name} is not available on ${config.platform}`);
          }

          try {
            const result = await callTool({
              platform: config.platform,
              name,
              args: params.arguments ?? {},
              client,
              definitions,
            });
            return successResponse(message.id, result);
          } catch (error) {
            return successResponse(message.id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
            });
          }
        }
        default:
          return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return errorResponse(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  return http.createServer(async (req, res) => {
    const path = routePath(req);

    if (req.method === "GET" && path === "/healthz") {
      return jsonResponse(res, 200, { ok: true, platform: config.platform });
    }

    if (req.method === "GET" && path === "/meta/platform") {
      return jsonResponse(res, 200, { platform: config.platform });
    }

    if (req.method === "GET" && path === "/meta/tools") {
      return jsonResponse(res, 200, { platform: config.platform, tools });
    }

    if (path !== config.mcpPath) {
      return jsonResponse(res, 404, { error: "not found" });
    }

    if (!originAllowed(req, config)) {
      return jsonResponse(res, 403, errorResponse(null, -32000, "Forbidden origin"));
    }

    if (!isAuthorized(req, config)) {
      return jsonResponse(res, 401, errorResponse(null, -32001, "Unauthorized"), {
        "www-authenticate": "Bearer",
      });
    }

    if (req.method === "GET") {
      return emptyResponse(res, 405, { allow: "POST" });
    }

    if (req.method !== "POST") {
      return emptyResponse(res, 405, { allow: "POST" });
    }

    let payload;
    try {
      payload = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      const statusError = error as StatusError;
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(res, statusError.statusCode || 400, errorResponse(null, -32700, message));
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await handleRpcMessage(message);
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      return emptyResponse(res, 202);
    }

    return jsonResponse(res, 200, Array.isArray(payload) ? responses : responses[0], {
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
  });
}

export { PROTOCOL_VERSION };
