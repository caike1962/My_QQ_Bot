# onebot-mcp

`onebot-mcp` wraps OneBot APIs as HTTP MCP tools so AI agents can interact with
OneBot-compatible QQ bot platforms through an MCP tool interface.

Docker deployment with the published container image is recommended. The
project is implemented in TypeScript and also supports local Docker builds and
local Node.js development.

OneBot v11 does not cover many advanced QQ bot operations. Popular
implementations such as NapCat, LLOneBot, and Lagrange therefore expose their
own extension APIs. This project provides one canonical MCP tool surface and
maps each tool to the configured platform's actual OneBot action.

Only these platforms are in scope:

- `napcat`
- `llonebot`
- `lagrange`

## Runtime Model

`onebot-mcp` is intended to run as an independent process or container.

The platform is selected at startup through `ONEBOT_PLATFORM`. The server only
exposes tools that have an adapter for that platform. Changing the platform
requires restarting the service.

Per-tool access should be controlled by the MCP client or agent configuration.
This server only checks the optional MCP bearer token and does not implement
per-tool allow/deny policy.

## Quick Start

Requirements:

- Docker with Docker Compose.
- A running OneBot v11-compatible service, such as NapCat, LLOneBot, or
  Lagrange.
- The OneBot action endpoint URL and access token.

### Docker With Published Image

Create the runtime config:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
ONEBOT_PLATFORM=napcat
ONEBOT_MCP_IMAGE=ghcr.io/frostbite-time/onebot-mcp:latest
ONEBOT_WS_URL=ws://host.docker.internal:3001
# ONEBOT_HTTP_URL=http://host.docker.internal:3001
ONEBOT_TOKEN=change-me
ONEBOT_MCP_TOKEN=change-me
```

Use `ONEBOT_WS_URL` or `ONEBOT_HTTP_URL` according to your OneBot deployment.
When both are set, WebSocket is used. If OneBot runs directly on the Docker
host, `host.docker.internal` is supported by the included Compose file.

Start the MCP server:

```bash
docker compose up -d
```

Default MCP endpoint:

```text
POST http://127.0.0.1:3000/mcp
```

Health and diagnostic endpoints:

```text
GET http://127.0.0.1:3000/healthz
GET http://127.0.0.1:3000/meta/platform
GET http://127.0.0.1:3000/meta/tools
```

By default, Compose publishes the MCP port only on host `127.0.0.1`. To expose
it on another interface, change `ONEBOT_MCP_BIND_HOST` in `.env` and set a
non-empty `ONEBOT_MCP_TOKEN`.

### Docker With Local Build

Use this when developing the server locally or testing unpublished changes:

```bash
docker build -t onebot-mcp:local .
cp .env.example .env
```

Set this in `.env`:

```dotenv
ONEBOT_MCP_IMAGE=onebot-mcp:local
```

Then start normally:

```bash
docker compose up -d
```

### Local Node.js Start

Docker is recommended for deployment. Local Node.js startup is mainly useful
for development and quick debugging.

Requirements:

- Node.js 24 or newer.

```bash
cp .env.example .env
npm ci
npm run build
npm test
npm start
```

Or run with explicit environment variables:

```bash
npm run build

ONEBOT_PLATFORM=napcat \
ONEBOT_HTTP_URL=http://127.0.0.1:3001 \
ONEBOT_TOKEN=change-me \
npm start
```

For a OneBot WebSocket action endpoint:

```bash
npm run build

ONEBOT_PLATFORM=napcat \
ONEBOT_WS_URL=ws://127.0.0.1:3001 \
ONEBOT_TOKEN=change-me \
npm start
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ONEBOT_PLATFORM` | required | One of `napcat`, `llonebot`, or `lagrange`. |
| `ONEBOT_MCP_IMAGE` | `ghcr.io/frostbite-time/onebot-mcp:latest` | Container image used by `compose.yaml`. Set to `onebot-mcp:local` after a local Docker build. |
| `ONEBOT_HTTP_URL` | empty | HTTP action endpoint root of the OneBot implementation. Required unless `ONEBOT_WS_URL` is set. |
| `ONEBOT_WS_URL` | empty | WebSocket action endpoint of the OneBot implementation. Takes precedence over `ONEBOT_HTTP_URL` when set. |
| `ONEBOT_TOKEN` | empty | OneBot access token. HTTP sends `Authorization: Bearer ...`; WebSocket appends `access_token` when the URL does not already contain one. |
| `ONEBOT_ACTION_TIMEOUT_MS` | `10000` | Timeout for each OneBot action call. |
| `ONEBOT_MCP_HOST` | `127.0.0.1` | HTTP MCP bind host. Use `0.0.0.0` in containers. |
| `ONEBOT_MCP_PORT` | `3000` | HTTP MCP bind port. |
| `ONEBOT_MCP_PATH` | `/mcp` | MCP Streamable HTTP endpoint path. |
| `ONEBOT_MCP_BIND_HOST` | `127.0.0.1` | Docker Compose host interface for port publishing. This is consumed by Compose, not the Node.js process. |
| `ONEBOT_MCP_TOKEN` | empty | Optional bearer token protecting the MCP endpoint. |
| `ONEBOT_MCP_ALLOWED_ORIGINS` | empty | Comma-separated allowed browser origins. Requests without `Origin` are allowed. |
| `ONEBOT_MCP_MAX_BODY_BYTES` | `1048576` | Maximum JSON-RPC request body size. |

## Current Tools

The implemented tool surface covers the first batch of message, group,
moderation, group-file, friend, private-file, profile, reaction, and poke
capabilities selected for this MCP server.

See [docs/api-matrix.md](docs/api-matrix.md) for the full implemented adapter
matrix.

## Troubleshooting

### `upload_group_file` Reports Path Missing Or Rich Media Transfer Failure

`onebot-mcp` does not read or upload local files by itself. For upload tools
such as `upload_group_file`, it forwards the `file` parameter to the configured
OneBot implementation.

This means the file path must be visible to the actual OneBot backend process
that performs the upload. If your OneBot deployment is containerized, mount the
same host directory into:

- the agent/runtime container that creates or selects the file;
- the `onebot-mcp` container, if it needs to inspect or validate the path;
- the OneBot backend container or process that performs the file transfer.

Some OneBot stacks split the API process from the real QQ/NTQQ process. In that
case, the real file-transfer side needs the same mount as well. Group file
download tools such as `get_group_file_url` usually return URLs or metadata and
do not need this shared local directory.

## Tests

```bash
npm test
```

`npm test` runs the TypeScript compiler first and then executes the compiled
tests from `dist/tests`.
