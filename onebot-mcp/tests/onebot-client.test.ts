import assert from "node:assert/strict";
import test from "node:test";
import { OneBotClient, type WebSocketEvent } from "../src/onebot-client.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static onConnection: ((ws: MockWebSocket) => void) | null = null;

  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  onSend?: (data: string) => void;
  private readonly listeners = new Map<string, Array<(event: WebSocketEvent) => void>>();

  constructor(url: string | URL) {
    this.url = url.toString();
    MockWebSocket.instances.push(this);
    MockWebSocket.onConnection?.(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function resetMockWebSocket() {
  MockWebSocket.instances = [];
  MockWebSocket.onConnection = null;
}

test("HTTP action posts to the OneBot action endpoint", async () => {
  const requests: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
  const client = new OneBotClient({
    httpUrl: "http://onebot.local/",
    token: "secret",
    fetchImpl: async (url, init) => {
      requests.push(init === undefined ? { url } : { url, init });
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { ok: true } }), {
        status: 200,
      });
    },
  });

  const result = await client.action("get_group_info", { group_id: 10001 });

  assert.deepEqual(result, { status: "ok", retcode: 0, data: { ok: true } });
  assert.equal(requests[0]!.url, "http://onebot.local/get_group_info");
  assert.equal(requests[0]!.init!.method, "POST");
  assert.equal((requests[0]!.init!.headers as Record<string, string>).authorization, "Bearer secret");
  assert.equal(requests[0]!.init!.body, JSON.stringify({ group_id: 10001 }));
});

test("WebSocket action sends OneBot action request and resolves by echo", async () => {
  resetMockWebSocket();
  MockWebSocket.onConnection = (ws) => {
    ws.onSend = (data) => {
      const request = JSON.parse(data);
      ws.emit("message", {
        data: JSON.stringify({ echo: "unrelated", status: "ok", retcode: 0 }),
      });
      ws.emit("message", {
        data: JSON.stringify({
          echo: request.echo,
          status: "ok",
          retcode: 0,
          data: { group_id: 10001 },
        }),
      });
    };
  };

  const client = new OneBotClient({
    wsUrl: "ws://onebot.local/ws",
    token: "secret",
    WebSocketImpl: MockWebSocket,
  });

  const result = await client.action("get_group_info", { group_id: 10001 });
  const ws = MockWebSocket.instances[0]!;
  const request = JSON.parse(ws.sent[0]!);

  assert.equal(ws.url, "ws://onebot.local/ws?access_token=secret");
  assert.equal(request.action, "get_group_info");
  assert.deepEqual(request.params, { group_id: 10001 });
  assert.equal(typeof request.echo, "string");
  assert.deepEqual(result, {
    echo: request.echo,
    status: "ok",
    retcode: 0,
    data: { group_id: 10001 },
  });
  assert.equal(ws.closed, true);
});

test("WebSocket action does not overwrite an explicit access_token", async () => {
  resetMockWebSocket();
  MockWebSocket.onConnection = (ws) => {
    ws.onSend = (data) => {
      const request = JSON.parse(data);
      ws.emit("message", {
        data: JSON.stringify({ echo: request.echo, status: "ok", retcode: 0 }),
      });
    };
  };

  const client = new OneBotClient({
    wsUrl: "ws://onebot.local/ws?access_token=explicit",
    token: "secret",
    WebSocketImpl: MockWebSocket,
  });

  await client.action("get_group_list", {});

  assert.equal(MockWebSocket.instances[0]!.url, "ws://onebot.local/ws?access_token=explicit");
});

test("WebSocket action times out when no matching echo is received", async () => {
  resetMockWebSocket();
  MockWebSocket.onConnection = (ws) => {
    ws.onSend = () => {
      ws.emit("message", {
        data: JSON.stringify({ echo: "different", status: "ok", retcode: 0 }),
      });
    };
  };

  const client = new OneBotClient({
    wsUrl: "ws://onebot.local/ws",
    WebSocketImpl: MockWebSocket,
    timeoutMs: 5,
  });

  await assert.rejects(() => client.action("get_group_list", {}), /timed out/);
});
