# Stateless MCP Incident Lab — Raw TypeScript

Independent raw HTTP/JSON-RPC client and server for the Stateless MCP Incident Lab. It targets Node.js 24 and intentionally does not depend on the official MCP SDK.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The external behavioral suite is resolved from `CONFORMANCE_PATH`, defaulting to `../stateless-mcp-incident-lab-conformance/conformance`.
