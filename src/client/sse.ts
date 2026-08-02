export type SseEvent = { event: 'message'; data: Record<string, unknown> }

const META = {
  'io.modelcontextprotocol/serverInfo': {
    name: 'stateless-mcp-incident-lab',
    version: '2026-07-28',
  },
  'io.maximalfocus.stateless-incident-lab/replica': 'raw-local-1',
}

export function diagnosticEvents(id: string | number, progressToken: string | number): SseEvent[] {
  const progress = (value: number): SseEvent => ({
    event: 'message',
    data: {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken, progress: value, total: 100 },
    },
  })
  return [
    progress(0),
    progress(50),
    {
      event: 'message',
      data: {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          content: [{ type: 'text', text: 'Diagnostic complete.' }],
          structuredContent: { diagnostic_id: 'DIAGNOSTIC-001' },
          isError: false,
          _meta: META,
        },
      },
    },
  ]
}
