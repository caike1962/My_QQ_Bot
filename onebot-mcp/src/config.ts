export const SUPPORTED_PLATFORMS = ["napcat", "llonebot", "lagrange"] as const;

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

export interface AppConfig {
  host: string;
  port: number;
  mcpPath: string;
  mcpToken: string;
  allowedOrigins: string[];
  platform: Platform;
  onebotHttpUrl: string;
  onebotWsUrl: string;
  onebotToken: string;
  onebotActionTimeoutMs: number;
  maxBodyBytes: number;
}

type Env = Record<string, string | undefined>;

const SUPPORTED_PLATFORM_SET = new Set<string>(SUPPORTED_PLATFORMS);

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizePath(value: string | undefined): string {
  const path = value || "/mcp";
  return path.startsWith("/") ? path : `/${path}`;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const platform = (env.ONEBOT_PLATFORM || "").trim().toLowerCase();
  if (!isSupportedPlatform(platform)) {
    throw new Error(
      `ONEBOT_PLATFORM must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }

  const onebotHttpUrl = (env.ONEBOT_HTTP_URL || "").trim().replace(/\/+$/, "");
  const onebotWsUrl = (env.ONEBOT_WS_URL || "").trim();
  if (!onebotHttpUrl && !onebotWsUrl) {
    throw new Error("ONEBOT_HTTP_URL or ONEBOT_WS_URL is required");
  }

  return {
    host: env.ONEBOT_MCP_HOST || "127.0.0.1",
    port: parseInteger(env.ONEBOT_MCP_PORT, 3000, "ONEBOT_MCP_PORT"),
    mcpPath: normalizePath(env.ONEBOT_MCP_PATH),
    mcpToken: env.ONEBOT_MCP_TOKEN || "",
    allowedOrigins: parseCsv(env.ONEBOT_MCP_ALLOWED_ORIGINS),
    platform,
    onebotHttpUrl,
    onebotWsUrl,
    onebotToken: env.ONEBOT_TOKEN || "",
    onebotActionTimeoutMs: parseInteger(
      env.ONEBOT_ACTION_TIMEOUT_MS,
      10_000,
      "ONEBOT_ACTION_TIMEOUT_MS",
    ),
    maxBodyBytes: parseInteger(env.ONEBOT_MCP_MAX_BODY_BYTES, 1024 * 1024, "ONEBOT_MCP_MAX_BODY_BYTES"),
  };
}

export function isSupportedPlatform(platform: string): platform is Platform {
  return SUPPORTED_PLATFORM_SET.has(platform);
}

export function supportedPlatforms(): Platform[] {
  return [...SUPPORTED_PLATFORMS];
}
