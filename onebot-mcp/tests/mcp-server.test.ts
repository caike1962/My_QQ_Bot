import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config.js";
import { createMcpHttpServer } from "../src/mcp-server.js";
import type { OneBotPayload } from "../src/onebot-client.js";
import type { McpTool } from "../src/tools.js";

function fakeClient() {
  const calls: Array<{ actionName: string; body: OneBotPayload }> = [];
  return {
    calls,
    async action(actionName: string, body: OneBotPayload = {}) {
      calls.push({ actionName, body });
      return { status: "ok", retcode: 0, data: { actionName, body } };
    },
  };
}

type FakeClient = ReturnType<typeof fakeClient>;
type TestContext = { baseUrl: string; client: FakeClient };

async function withServer(
  configOverrides: Partial<AppConfig>,
  callback: (context: TestContext) => Promise<void>,
): Promise<void> {
  const client = fakeClient();
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    mcpToken: "",
    allowedOrigins: [],
    platform: "napcat",
    onebotHttpUrl: "http://onebot.local",
    onebotWsUrl: "",
    onebotToken: "",
    onebotActionTimeoutMs: 10_000,
    maxBodyBytes: 1024 * 1024,
    ...configOverrides,
  };
  const server = createMcpHttpServer({ config, client });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await callback({ baseUrl: `http://127.0.0.1:${port}`, client });
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function postRpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: Record<string, any> | null }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

test("health and meta endpoints expose current platform and tools", async () => {
  await withServer({ platform: "lagrange" }, async ({ baseUrl }) => {
    const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, platform: "lagrange" });

    const meta = (await fetch(`${baseUrl}/meta/tools`).then((response) => response.json())) as {
      platform: string;
      tools: McpTool[];
    };
    assert.equal(meta.platform, "lagrange");
    assert.ok(meta.tools.some((tool) => tool.name === "send_group_message"));
  });
});

test("initialize and tools/list work over HTTP JSON-RPC", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const init = await postRpc(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    assert.equal(init.status, 200);
    assert.equal(init.body!.result.serverInfo.name, "onebot-mcp");
    assert.equal(init.body!.result.capabilities.tools.listChanged, false);

    const tools = await postRpc(baseUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    assert.equal(tools.status, 200);
    const toolNames = (tools.body!.result.tools as McpTool[]).map((tool) => tool.name);
    assert.ok(toolNames.includes("get_group_info"));
    assert.ok(toolNames.includes("get_group_list"));
    assert.ok(toolNames.includes("get_group_member_list"));
  });
});

test("tools/call invokes OneBot action through active platform adapter", async () => {
  await withServer({ platform: "lagrange" }, async ({ baseUrl, client }) => {
    const response = await postRpc(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "set_group_reaction",
        arguments: {
          group_id: 10001,
          message_id: 42,
          emoji_id: 128077,
        },
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body!.result.structuredContent.status, "ok");
    assert.deepEqual(client.calls[0], {
      actionName: "set_group_reaction",
      body: { group_id: 10001, message_id: 42, code: 128077, is_add: true },
    });
  });
});

test("server returns 202 for JSON-RPC notifications", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const response = await postRpc(baseUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    assert.equal(response.status, 202);
    assert.equal(response.body, null);
  });
});

test("optional bearer token protects MCP endpoint", async () => {
  await withServer({ mcpToken: "secret" }, async ({ baseUrl }) => {
    const rejected = await postRpc(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    assert.equal(rejected.status, 401);

    const accepted = await postRpc(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      { authorization: "Bearer secret" },
    );
    assert.equal(accepted.status, 200);
  });
});

test("origin validation rejects browser origins unless explicitly allowed", async () => {
  await withServer({ allowedOrigins: ["https://allowed.example"] }, async ({ baseUrl }) => {
    const rejected = await postRpc(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
      { origin: "https://blocked.example" },
    );
    assert.equal(rejected.status, 403);

    const accepted = await postRpc(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      { origin: "https://allowed.example" },
    );
    assert.equal(accepted.status, 200);
  });
});
