export class OneBotWsClient {
  constructor({ url, token = "", onEvent, onLog = console.error }) {
    this.url = url;
    this.token = token;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.ws = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.closedByUser = false;
    this.reconnectDelayMs = 1000;
  }

  buildUrl() {
    const u = new URL(this.url);
    if (this.token && !u.searchParams.has("access_token")) {
      u.searchParams.set("access_token", this.token);
    }
    return u.toString();
  }

  connect() {
    this.closedByUser = false;
    const ws = new WebSocket(this.buildUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.onLog("[onebot] 已连接 " + this.url);
      this.reconnectDelayMs = 1000;
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }

      if (data.echo !== undefined) {
        const entry = this.pending.get(data.echo);
        if (entry) {
          this.pending.delete(data.echo);
          clearTimeout(entry.timer);
          entry.resolve(data);
        }
        return;
      }

      if (data.post_type) {
        try {
          this.onEvent(data);
        } catch (error) {
          this.onLog("[onebot] 事件处理异常: " + error.message);
        }
      }
    };

    ws.onerror = (event) => {
      this.onLog("[onebot] 连接错误: " + (event.message || event.type || "unknown"));
    };

    ws.onclose = (event) => {
      this.onLog(`[onebot] 连接关闭 code=${event.code}`);
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("WebSocket 已关闭"));
      }
      this.pending.clear();

      if (!this.closedByUser) {
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(delay * 2, 30000);
        this.onLog(`[onebot] ${delay}ms 后重连`);
        setTimeout(() => {
          if (!this.closedByUser) this.connect();
        }, delay);
      }
    };
  }

  action(action, params = {}, timeoutMs = 30000) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error("WebSocket 未连接，无法执行 " + action));
    }

    const echo = `qq-bot-${Date.now()}-${this.echoSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`动作 ${action} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }
}
