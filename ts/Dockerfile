# TypeScript agent-service (meta#103, decision 23). Build context is this
# directory. Nothing deploys from this file until the cutover (agent-service#38):
# the Dockerfile at the repository root still builds the Go image.
#
# `npm ci --ignore-scripts` everywhere: no dependency's install script runs.

# Build: full dependencies, tsoa codegen, tsc.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json tsoa.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Production dependencies only.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# Runtime: no shell, no package manager. The entrypoint is `node`.
FROM gcr.io/distroless/nodejs24-debian12
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The spec Swagger UI serves (src/swagger.ts reads ../openapi.json relative to dist/).
COPY openapi.json ./
# The container keeps listening on 80 like the Go image; PORT overrides it.
EXPOSE 80
CMD ["dist/server.js"]
