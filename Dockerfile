# Build stage: the Go toolchain and module cache never reach the published image.
FROM golang:1.22-alpine AS build

WORKDIR /src

# Dependencies are cached separately from source, so a code-only change doesn't
# re-download the module graph.
COPY src/go.mod src/go.sum ./
RUN go mod download

COPY src/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/agent-service .

# Runtime stage: no compiler, no shell-accessible toolchain, ~10 MB instead of ~350 MB.
FROM alpine:3.20

# ca-certificates so outbound HTTPS (should st-gateway ever be fronted by TLS)
# validates rather than failing with an opaque x509 error.
RUN apk add --no-cache ca-certificates

COPY --from=build /out/agent-service /usr/local/bin/agent-service

# The container keeps listening on 80 — the port its deployment already
# publishes. PORT overrides it for anyone running the image directly.
EXPOSE 80
ENTRYPOINT ["agent-service"]
