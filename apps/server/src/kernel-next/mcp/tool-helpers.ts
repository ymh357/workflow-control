// Shared response helpers for kernel-next MCP tool handlers.

export function jsonResponse(payload: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload),
    }],
  };
}

export function errorResponse(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: false, error: message, ...extra }),
    }],
    isError: true,
  };
}
