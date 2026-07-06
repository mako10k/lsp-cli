import test from "node:test";
import assert from "node:assert/strict";

import { EventQueue } from "../daemon/events";

test("EventQueue caps retained events and reports dropped cursors", () => {
  const queue = new EventQueue({ maxEvents: 2 });

  queue.push("log", { message: "one" });
  queue.push("log", { message: "two" });
  queue.push("log", { message: "three" });

  const res = queue.get({ kind: "log", since: 0, limit: 10 });

  assert.equal(res.truncated, true);
  assert.equal(res.droppedBeforeCursor, 2);
  assert.equal(res.oldestCursor, 2);
  assert.equal(res.newestCursor, 3);
  assert.equal(res.retainedCount, 2);
  assert.equal(res.maxEvents, 2);
  assert.equal(res.droppedCount, 1);
  assert.equal(res.nextCursor, 3);
  assert.deepEqual(
    res.events.map((e) => e.payload.message),
    ["two", "three"]
  );
});

test("EventQueue advances old empty reads to the retained boundary", () => {
  const queue = new EventQueue({ maxEvents: 1 });

  queue.push("log", { message: "one" });
  queue.push("message", { message: "two" });

  const res = queue.get({ kind: "diagnostics", since: 0, limit: 10 });

  assert.equal(res.truncated, true);
  assert.equal(res.droppedBeforeCursor, 2);
  assert.equal(res.nextCursor, 1);
  assert.deepEqual(res.events, []);
});
