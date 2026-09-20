import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, supportedPlatforms } from "../src/config.js";

test("loads HTTP OneBot config", () => {
  const config = loadConfig({
    ONEBOT_PLATFORM: "napcat",
    ONEBOT_HTTP_URL: "http://127.0.0.1:3001/",
    ONEBOT_TOKEN: "token",
  });

  assert.equal(config.platform, "napcat");
  assert.equal(config.onebotHttpUrl, "http://127.0.0.1:3001");
  assert.equal(config.onebotWsUrl, "");
  assert.equal(config.onebotToken, "token");
  assert.equal(config.onebotActionTimeoutMs, 10000);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.mcpPath, "/mcp");
});

test("loads WebSocket OneBot config", () => {
  const config = loadConfig({
    ONEBOT_PLATFORM: "napcat",
    ONEBOT_WS_URL: "ws://127.0.0.1:3001",
    ONEBOT_TOKEN: "token",
    ONEBOT_ACTION_TIMEOUT_MS: "2500",
  });

  assert.equal(config.onebotHttpUrl, "");
  assert.equal(config.onebotWsUrl, "ws://127.0.0.1:3001");
  assert.equal(config.onebotActionTimeoutMs, 2500);
});

test("rejects missing OneBot endpoint", () => {
  assert.throws(
    () =>
      loadConfig({
        ONEBOT_PLATFORM: "napcat",
      }),
    /ONEBOT_HTTP_URL or ONEBOT_WS_URL/,
  );
});

test("rejects unsupported platform", () => {
  assert.throws(
    () =>
      loadConfig({
        ONEBOT_PLATFORM: "go-cqhttp",
        ONEBOT_HTTP_URL: "http://127.0.0.1:3001",
      }),
    /ONEBOT_PLATFORM/,
  );
});

test("supported platforms are intentionally limited", () => {
  assert.deepEqual(supportedPlatforms(), ["napcat", "llonebot", "lagrange"]);
});
