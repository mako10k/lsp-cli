export type DaemonRequest =
  | { id: string; cmd: "ping" }
  | { id: string; cmd: "daemon/status" }
  | { id: string; cmd: "daemon/log/get" }
  | { id: string; cmd: "daemon/log/set"; mode: "discard" | "file"; path?: string }
  | { id: string; cmd: "events/get"; kind?: "diagnostics"; since?: number; limit?: number }
  | { id: string; cmd: "lsp/request"; method: string; params?: any }
  | { id: string; cmd: "lsp/requestAndApply"; method: string; params?: any }
  | { id: string; cmd: "daemon/stop" }
  | { id: string; cmd: "server/status" }
  | { id: string; cmd: "server/stop" }
  | { id: string; cmd: "server/restart" };

export function newRequestId(prefix = "req"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type DaemonResponse =
  | { id: string; ok: true; result: any }
  | { id: string; ok: false; error: string };

export function parseJsonlLine(line: string): any {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function toJsonl(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
