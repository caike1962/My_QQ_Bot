FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json README.md LICENSE ./

ENV NODE_ENV=production
ENV ONEBOT_MCP_HOST=0.0.0.0
ENV ONEBOT_MCP_PORT=3000
ENV ONEBOT_MCP_PATH=/mcp

EXPOSE 3000

USER node

CMD ["node", "dist/src/index.js"]
