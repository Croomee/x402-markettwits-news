# For Glama / Smithery / any container runner. stdio MCP server; secrets come from env at run time.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY openapi.snapshot.json ./
USER node
ENTRYPOINT ["node", "src/index.mjs"]
