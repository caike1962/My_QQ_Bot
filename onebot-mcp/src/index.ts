import { loadConfig } from "./config.js";
import { createMcpHttpServer } from "./mcp-server.js";
import { OneBotClient } from "./onebot-client.js";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = loadConfig();
const client = new OneBotClient({
  httpUrl: config.onebotHttpUrl,
  wsUrl: config.onebotWsUrl,
  token: config.onebotToken,
  timeoutMs: config.onebotActionTimeoutMs,
});

const server = createMcpHttpServer({ config, client });

server.listen(config.port, config.host, () => {
  const onebotTransport = config.onebotWsUrl ? "websocket" : "http";
  console.error(
    `onebot-mcp listening on http://${config.host}:${config.port}${config.mcpPath} for platform ${config.platform} using OneBot ${onebotTransport}`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  console.error(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
