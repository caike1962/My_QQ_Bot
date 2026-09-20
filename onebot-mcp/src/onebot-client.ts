export type OneBotPayload = Record<string, unknown>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSocketLike {
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketConstructorLike = new (url: string | URL) => WebSocketLike;

export interface WebSocketEvent {
  data?: unknown;
  message?: string;
  type?: string;
  code?: number;
  reason?: string;
}

export interface OneBotClientOptions {
  baseUrl?: string;
  httpUrl?: string;
  wsUrl?: string;
  token?: string;
  fetchImpl?: FetchLike;
  WebSocketImpl?: WebSocketConstructorLike;
  timeoutMs?: number;
}

export class OneBotHttpError extends Error {
  statusCode: number;
  body: unknown;

  constructor(message: string, { statusCode, body }: { statusCode: number; body: unknown }) {
    super(message);
    this.name = "OneBotHttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class OneBotWsError extends Error {
  code: number | undefined;
  reason: string | undefined;

  constructor(message: string, { code, reason }: { code?: number | undefined; reason?: string | undefined } = {}) {
    super(message);
    this.name = "OneBotWsError";
    this.code = code;
    this.reason = reason;
  }
}

function parseJsonIfPossible(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let nextEchoId = 0;

function appendAccessToken(wsUrl: string, token: string): string {
  if (!token) return wsUrl;
  const url = new URL(wsUrl);
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  return url.toString();
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

export class OneBotClient {
  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly fetch?: FetchLike;
  private readonly WebSocket?: WebSocketConstructorLike;
  private readonly timeoutMs: number;

  constructor({
    baseUrl,
    httpUrl,
    wsUrl,
    token = "",
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 10_000,
  }: OneBotClientOptions) {
    this.httpUrl = (httpUrl || baseUrl || "").replace(/\/+$/, "");
    this.wsUrl = wsUrl || "";
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.timeoutMs = timeoutMs;

    if (!this.httpUrl && !this.wsUrl) {
      throw new Error("OneBot httpUrl or wsUrl is required");
    }
    if (this.httpUrl && !this.fetch) {
      throw new Error("fetch is required for OneBot HTTP transport");
    }
    if (this.wsUrl && !this.WebSocket) {
      throw new Error("WebSocket is required for OneBot WebSocket transport");
    }
  }

  async action(actionName: string, payload: OneBotPayload = {}): Promise<unknown> {
    if (this.wsUrl) {
      return this.wsAction(actionName, payload);
    }
    return this.httpAction(actionName, payload);
  }

  async httpAction(actionName: string, payload: OneBotPayload = {}): Promise<unknown> {
    if (!this.fetch) {
      throw new Error("fetch is required for OneBot HTTP transport");
    }

    const response = await this.fetch(`${this.httpUrl}/${actionName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const body = parseJsonIfPossible(text);

    if (!response.ok) {
      throw new OneBotHttpError(`OneBot action ${actionName} failed with HTTP ${response.status}`, {
        statusCode: response.status,
        body,
      });
    }

    return body;
  }

  async wsAction(actionName: string, payload: OneBotPayload = {}): Promise<unknown> {
    if (!this.WebSocket) {
      throw new Error("WebSocket is required for OneBot WebSocket transport");
    }

    const echo = `onebot-mcp-${Date.now()}-${nextEchoId++}`;
    const ws = new this.WebSocket(appendAccessToken(this.wsUrl, this.token));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finishReject(new OneBotWsError(`OneBot action ${actionName} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const finishResolve = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeQuietly(ws);
        resolve(value);
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeQuietly(ws);
        reject(error);
      };

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            action: actionName,
            params: payload,
            echo,
          }),
        );
      });

      ws.addEventListener("message", (event) => {
        let message: unknown;
        try {
          message = JSON.parse(messageDataToString(event.data));
        } catch {
          return;
        }
        if ((message as { echo?: unknown }).echo !== echo) return;
        finishResolve(message);
      });

      ws.addEventListener("error", (event) => {
        const reason = event.message || event.type;
        finishReject(
          new OneBotWsError(`OneBot action ${actionName} failed over WebSocket`, {
            reason,
          }),
        );
      });

      ws.addEventListener("close", (event) => {
        if (settled) return;
        finishReject(
          new OneBotWsError(`OneBot WebSocket closed before ${actionName} response`, {
            code: event.code,
            reason: event.reason,
          }),
        );
      });
    });
  }
}

function closeQuietly(ws: WebSocketLike): void {
  try {
    ws.close();
  } catch {
    // Ignore cleanup errors.
  }
}
