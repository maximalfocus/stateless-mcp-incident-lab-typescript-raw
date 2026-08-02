# Stateless MCP Incident Lab — Raw TypeScript

Independent raw HTTP/JSON-RPC implementation of the Stateless MCP Incident Lab for Node.js 24. It implements MCP wire shapes directly and intentionally does not depend on the official MCP SDK.

## Capabilities

- Stateless per-request protocol-version and capability negotiation
- Streamable HTTP JSON responses and SSE diagnostic progress
- Tool, resource, resource-template, and prompt catalogs
- Synthetic incident lifecycle and signed multi-round remediation approval
- Public/private response caching with stale-on-refresh-error behavior
- CLI workflows, structured telemetry, health readiness, and security bounds

All remediation effects are simulated.

## Quick start

```bash
npm ci
npm run build
npm start
```

The server binds to `127.0.0.1:3101` by default and exposes `POST /raw/mcp` plus `GET /raw/healthz`. Override the bind with `HOST` and `PORT`. Production replicas must share an `MCP_REQUEST_STATE_SECRET` of at least 32 bytes and set `DYNAMODB_TABLE` (plus optional `DYNAMODB_ENDPOINT` for DynamoDB Local); development uses process-local ephemeral key and effect storage. In another shell:

```bash
node dist/src/main.js --version
node dist/src/main.js discover http://127.0.0.1:3101/raw/mcp
```

## CLI

The `incident-mcp` binary supports these command families:

```text
incident-mcp discover <url>
incident-mcp tools list|inspect|call <url> [...]
incident-mcp resources list|templates|read <url> [...]
incident-mcp prompts list|get <url> [...]
incident-mcp demo <url> --approve|--decline|--cancel
```

Global diagnostic options include `--wire` with sensitive-value redaction and `--no-cache`.

## Docker

Build and run the minimal runtime image:

```bash
docker build --target runtime -t incident-mcp-raw .
docker run --rm -p 127.0.0.1:3101:3101 \
  -e HOST=0.0.0.0 \
  -e MCP_REQUEST_STATE_SECRET="$(openssl rand -hex 32)" \
  -e EFFECT_STORE=memory \
  incident-mcp-raw
# Or inspect the image version without starting the service:
docker run --rm incident-mcp-raw --version
```

The test stage requires the external behavioral repository as a named build context:

```bash
docker build --target test \
  --build-context conformance=../stateless-mcp-incident-lab-conformance \
  -t incident-mcp-raw-test .
```

## Runtime behavior

The public HTTP/CLI path uses the same application modules exercised by conformance. Incident lifecycle records and conditional remediation claims share the configured DynamoDB table in production; development uses in-memory stores. The CLI applies MCP cache hints in-process, supports explicit bypass, and serves stale entries only after refresh failure with a warning. Diagnostic SSE work is paced and request-scoped, stops on disconnect or deadline, and returns the actual diagnostic result. Live JSON requests enforce a five-second deadline and emit structured, trace-correlated telemetry with bearer-bearing resource names redacted.

## Development and verification

```bash
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm run test:mutation
npm run build
npm run test:conformance
npm audit --audit-level=high
```

The behavioral suite is resolved from `CONFORMANCE_PATH`, defaulting to the sibling `../stateless-mcp-incident-lab-conformance/conformance` directory.

Coverage is enforced at 95% lines, 90% statements, 80% branches, and 95% functions. The remaining lines are defensive malformed-internal-input paths and the direct-process bootstrap. Mutation testing covers incident lifecycle, MRTR, cache, property laws, header/request-state security, and schema validation, with an enforced score of at least 80%.
