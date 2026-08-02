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
node dist/src/main.js --version
```

The command prints `incident-mcp raw 0.1.0`.

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
docker run --rm incident-mcp-raw --version
```

The test stage requires the external behavioral repository as a named build context:

```bash
docker build --target test \
  --build-context conformance=../stateless-mcp-incident-lab-conformance \
  -t incident-mcp-raw-test .
```

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
