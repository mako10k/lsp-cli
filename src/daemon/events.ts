export type EventKind = "diagnostics";

export type DaemonEvent = {
  cursor: number;
  kind: EventKind;
  // Raw payload (LSP notification params)
  payload: any;
  ts: number;
};

export class EventQueue {
  private nextCursor = 1;
  private readonly events: DaemonEvent[] = [];

  push(kind: EventKind, payload: any): DaemonEvent {
    const ev: DaemonEvent = { cursor: this.nextCursor++, kind, payload, ts: Date.now() };
    this.events.push(ev);
    return ev;
  }

  get(opts: { kind?: EventKind; since?: number; limit?: number }): { nextCursor: number; events: DaemonEvent[] } {
    const since = typeof opts.since === "number" ? opts.since : 0;
    const kind = opts.kind;
    const limit = typeof opts.limit === "number" ? Math.max(1, Math.min(1000, opts.limit)) : 200;

    const filtered = this.events.filter((e) => e.cursor > since && (!kind || e.kind === kind));
    const slice = filtered.slice(0, limit);
    const nextCursor = slice.length ? slice[slice.length - 1].cursor : since;

    return { nextCursor, events: slice };
  }
}
