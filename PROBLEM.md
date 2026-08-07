# Problem Charter

- **Producer:** cdd-implement
- **Generated:** 2026-08-07
- **Source of truth:** `../stateless-mcp-incident-lab-prd/PRD.md` and `PLAN-001-stateless-core.md` at `891bb346f848e163fe1ce83753b323ffc9b18df7`; `../stateless-mcp-incident-lab-conformance/` at `18fa9421c0d0280fdc6bd9d572f7187deaa8ece6`; `../stateless-mcp-incident-lab-architecture/` at `0a15ca93487eef3883a1d34b69926531fc0529cb`; captured MCP `2026-07-28` schema under the PRD repository.

## Problem

Deliver an independent, production-runnable raw Node.js implementation of the Stateless MCP Incident Lab. It must implement the selected MCP `2026-07-28` raw lane at real HTTP and CLI boundaries without depending on the official MCP SDK or process/session affinity.

## Scope

- Raw HTTP/JSON-RPC server and networked CLI, including `/raw/mcp` and `/raw/healthz`.
- Protocol, versioning, transport, discovery, primitives, incident lifecycle, signed MRTR, SSE, caching, CLI, properties, security, observability, architecture, and dependency behavior assigned to the raw lane.
- External conformance consumption, build/package correctness, Docker runtime, and local/container CI.

## Non-goals

- The official-SDK implementation or any code shared with it.
- Four-way family interoperability, the shared Compose matrix, infrastructure, family CI/CD, acceptance, or deployment; those are separately owned lanes.
- Authentication/identity, legacy MCP sessions, real infrastructure access, or real remediation effects.

## Acceptance criteria

- [ ] **AC1 — Raw contract closure.** Exactly the 160 tests assigned to the raw lane pass; all 37 non-raw tests are discovered and explicitly skipped, never silently omitted.
- [ ] **AC2 — Runnable public boundaries.** The built artifact runs a real Node HTTP service exposing `/raw/mcp` and `/raw/healthz`, and the shipped CLI issues requests through the public network boundary rather than only calling in-process conformance adapters.
- [ ] **AC3 — Behavioral implementation.** Protocol, transport, primitive, incident, MRTR, streaming, cache, CLI, security, and observability outcomes are derived from request/state semantics, not spec IDs, fixture paths, seed literals, hidden scenarios, or canned expected responses.
- [ ] **AC4 — Stateless protocol fidelity.** Requests remain self-contained across replicas/retries; MCP version/header/body rules, JSON-RPC errors, signed request state, at-most-once effects, cancellation, cache scope, and telemetry/redaction match the source contract.
- [ ] **AC5 — Architecture fitness.** The runtime has no official MCP SDK dependency; accepted raw-layer dependency and public-boundary rules pass; the implementation-owned TypeScript import scanner recognizes all relevant static import/export/type/require forms and fails closed on unresolvable dynamic module edges.
- [ ] **AC6 — Runner trust.** The custom conformance runner strictly validates fixture structure, dispatch identities, assertions, placeholders/directives, exact observations, and expected test counts; malformed or unsupported contract input fails closed.
- [ ] **AC7 — Adjacent-input correctness.** Valid sibling and boundary inputs not individually enumerated by goldens follow the PRD rule rather than implementation shortcuts; malformed inputs do not throw, leak secrets, or bypass bounds.
- [ ] **AC8 — Shipped artifact honesty.** Package paths, generated JavaScript/declarations, CLI help, README instructions, and Docker defaults expose only behavior that actually runs; the runtime image is non-root and production-dependency-only.
- [ ] **AC9 — Quality gates.** Formatting, lint, typecheck, build, unit coverage, mutation, conformance, stub scan, dependency audit, host runtime smoke, Docker test/runtime, and tracking-branch CI pass at their committed thresholds.

## Verification

Run from this repository with the three sibling source repositories at the pinned revisions above. The gate uses the existing package cache and Docker daemon, writes build/test artifacts inside the repository plus scratch output under `/tmp`, binds localhost port `3101` for the runtime smoke, and `npm audit` contacts the npm registry.

```sh
set -eu
export CONFORMANCE_PATH="${CONFORMANCE_PATH:-$PWD/../stateless-mcp-incident-lab-conformance/conformance}"
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm run test:mutation
npm run build
npm run test:conformance
npx tsx scripts/verify-architecture.ts --self-test
node /Users/focus/personal/cdd-skills/tools/impl-stub-scan.ts .
python3 ../stateless-mcp-incident-lab-conformance/scripts/validate-suite.py
python3 -m unittest discover -s ../stateless-mcp-incident-lab-conformance/scripts -p 'test_*.py'
npm audit --audit-level=high

test "$(find "$CONFORMANCE_PATH" -name test.json | wc -l | tr -d ' ')" = 197

test ! -e /tmp/incident-mcp-peerreview.pid
if curl -fsS http://127.0.0.1:3101/raw/healthz >/dev/null 2>&1; then
  echo 'port 3101 already has a listener' >&2
  exit 1
fi
npm start >/tmp/incident-mcp-peerreview.log 2>&1 &
server_pid=$!
echo "$server_pid" >/tmp/incident-mcp-peerreview.pid
cleanup() { kill "$server_pid" 2>/dev/null || true; rm -f /tmp/incident-mcp-peerreview.pid; }
trap cleanup EXIT INT TERM
ready=0
for _ in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:3101/raw/healthz >/tmp/incident-mcp-health.json; then ready=1; break; fi
  kill -0 "$server_pid"
  sleep 1
done
test "$ready" = 1
kill -0 "$server_pid"
test "$(cat /tmp/incident-mcp-health.json)" = '{"status":"ok"}'
cleanup
trap - EXIT INT TERM

docker build --target test --build-context conformance=../stateless-mcp-incident-lab-conformance -t incident-mcp-raw-peerreview-test .
docker build --target runtime -t incident-mcp-raw-peerreview .
docker run --rm incident-mcp-raw-peerreview --version | grep -Fx 'incident-mcp raw 0.1.0'
git diff --check
```

The reviewer also confirms the tracking-branch GitHub Actions run is green and independently red-probes every supported TypeScript import form, malformed-golden class, and fixture-count invariant rather than trusting the implementation-owned scanners.

## Residuals & assumptions

- The conformance repository is degraded-converged; its preferred cross-vendor sign-off remains owed and is not silently converted into implementation confidence. Its pinned SEC-009, CLI wire (transcript format and declared exit-code kinds), MRTR status/assurance (input-declared observations and seeds lacking `remediation_id`), and observability/005 fixtures conflict with or cannot be reproduced by live public-boundary outputs, so narrowly isolated fixture adapters preserve AC1 while live HTTP/CLI behavior follows the advertised schemas; the sibling oracle conflicts—including the observability/005 request/golden mismatch and primitives/020 domain-failure semantics—require conformance-repo reconciliation.
- The PRD's disclosed unauthenticated elicitation identity-binding exception is inherited. The lab remains synthetic, ephemeral, rate-limited at deployment, and does not claim production authorization safety.
- SDK, integration, infrastructure, CI/CD, acceptance, and deployment behavior remains outside this repository and review.
