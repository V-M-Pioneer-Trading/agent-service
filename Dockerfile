# agent-service (TypeScript, meta#103, decision 23). Build context is the
# repository root. CI builds this file for the `image` and `contract` checks and
# deploys it from the tip of main (.github/workflows/container.yml).
#
# `npm ci --ignore-scripts` everywhere: no dependency's install script runs.

# Build: full dependencies, tsoa codegen, tsc.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json tsoa.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Production dependencies only. --omit=optional as well: npm ci --omit=dev still installs devOptional entries, and no runtime
# dependency (mysql2, express, swagger-ui-express, clerk-client) needs an optional one. Then proof there is no compiled code
# in the tree: nothing here is a native addon or WebAssembly, so a compiled file (ELF or WebAssembly magic in any file, *.node, *.so, *.so.*, *.dylib,
# *.dll, *.wasm, binding.gyp) is a dependency that should not be here, and the build fails naming it.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --omit=optional \
 && found="$(find node_modules -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' -o -name '*.wasm' -o -name 'binding.gyp' \))" \
 && elf="$(find node_modules -type f -size +3c -exec sh -c 'for f; do case "$(head -c 4 "$f" | od -An -tx1 | tr -d " \n")" in 7f454c46|0061736d) echo "$f";; esac; done' sh {} +)" \
 && if [ -n "$found$elf" ]; then echo "compiled file in the production tree:" >&2; echo "$found" "$elf" >&2; exit 1; fi

# Runtime: no shell, no package manager. The entrypoint is `node`.
FROM gcr.io/distroless/nodejs24-debian12
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The spec Swagger UI serves (src/swagger.ts reads ../openapi.json relative to dist/).
COPY openapi.json ./
# The container keeps listening on 80, the port its deployment already publishes; PORT overrides it.
EXPOSE 80
CMD ["dist/server.js"]
