export type EventKind = "diagnostics" | "log" | "message" | "progress";

export type DaemonEvent = {
  cursor: number;
  kind: EventKind;
  // Raw payload (LSP notification params)
  payload: any;
  ts: number;
};

export const DEFAULT_EVENT_QUEUE_MAX_EVENTS = 1000;

export type EventQueueResult = {
  nextCursor: number;
  events: DaemonEvent[];
  oldestCursor: number | null;
  newestCursor: number | null;
  retainedCount: number;
  maxEvents: number;
  droppedCount: number;
  truncated: boolean;
  droppedBeforeCursor?: number;
};

export class EventQueue {
  private nextCursor = 1;
  private readonly events: DaemonEvent[] = [];
  private readonly maxEvents: number;
  private droppedCount = 0;

  constructor(opts: { maxEvents?: number } = {}) {
    const maxEvents = opts.maxEvents ?? DEFAULT_EVENT_QUEUE_MAX_EVENTS;
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new Error(`event queue maxEvents must be a positive integer: ${maxEvents}`);
    }
    this.maxEvents = maxEvents;
  }

  push(kind: EventKind, payload: any): DaemonEvent {
    const ev: DaemonEvent = { cursor: this.nextCursor++, kind, payload, ts: Date.now() };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) {
      const drop = this.events.length - this.maxEvents;
      this.events.splice(0, drop);
      this.droppedCount += drop;
    }
    return ev;
  }

  get(opts: { kind?: EventKind; since?: number; limit?: number }): EventQueueResult {
    const since = typeof opts.since === "number" && Number.isFinite(opts.since) ? Math.max(0, Math.trunc(opts.since)) : 0;
    const kind = opts.kind;
    const limit = typeof opts.limit === "number" ? Math.max(1, Math.min(1000, opts.limit)) : 200;
    const oldestCursor = this.events.length ? this.events[0].cursor : null;
    const newestCursor = this.nextCursor > 1 ? this.nextCursor - 1 : null;
    const truncated = oldestCursor != null && since < oldestCursor - 1;

    const filtered = this.events.filter((e) => e.cursor > since && (!kind || e.kind === kind));
    const slice = filtered.slice(0, limit);
    const nextCursor = slice.length ? slice[slice.length - 1].cursor : truncated && oldestCursor != null ? oldestCursor - 1 : since;

    return {
      nextCursor,
      events: slice,
      oldestCursor,
      newestCursor,
      retainedCount: this.events.length,
      maxEvents: this.maxEvents,
      droppedCount: this.droppedCount,
      truncated,
      ...(truncated && oldestCursor != null ? { droppedBeforeCursor: oldestCursor } : {})
    };
  }
}
