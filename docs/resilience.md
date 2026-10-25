# Read cycles, aggregation and resilience

How the gateway reads fast, what reaches ferrion, and how it behaves when a
device or ferrion goes away. The sections keep the findings from live runs
that shaped the code, because each one explains a guard that would otherwise
look unnecessary.

## Defaults

| Setting | Default | Where |
| --- | --- | --- |
| Command poll | 3 s | `polling.commandsIntervalMs` |
| Data source discovery | 15 s | `polling.dataSourcesIntervalMs` |
| Read interval per source | 5 s, down to 1 ms | `polling.readingIntervalMs` |
| Push interval | 5 s | `polling.readingsPushIntervalMs` |
| Aggregation per push | `last` (`avg`, `min`, `max`) | `polling.aggregation` |
| Buffer size | 10 000 readings, at most 25 000 | `resilience.readingBufferMaxSize` |
| HTTP timeout to ferrion | 10 s | `resilience.httpRequestTimeoutMs` |

Read interval, push interval and aggregation can be set per instance in the
web UI's advanced section; the rest only in a configuration file.

## Fast read cycles and aggregation


Some field sensors sample far faster than ferrion needs to see - e.g. a 1ms
cycle time. `polling.readingIntervalMs` can be set down into the
millisecond range - via config file, or via the Web UI's **advanced** ("Erweitert")
section on the add/edit instance form (`readingIntervalMs`/
`readingsPushIntervalMs`/aggregation; the rest of `polling` stays
config-file-only). Node's timers don't guarantee exact 1ms precision
(event-loop jitter, GC pauses), so treat this as "as fast as the
protocol/runtime allows", not a hard real-time guarantee - confirmed live at
an actual 1ms interval against the real simulator (see below). Reads no longer
grow what gets pushed to ferrion 1:1: `gateway/reading-aggregator.ts` sits
between the per-source read ticker and the push ticker, collapsing
everything recorded since the last push into exactly one reading per data
source, using `polling.aggregation` (`"last"` (default) / `"avg"` / `"min"`
/ `"max"`). `gateway/reading-buffer.ts` (outage queue, see below) is
unchanged and now only ever sees these already-aggregated readings.

**OPC UA** uses a real `ClientSubscription`/`ClientMonitoredItem` (server
does the sampling at `readIntervalMs`, pushes changes) instead of issuing a
fresh `ReadRequest` every read tick - the only way a fast cycle time doesn't
also mean hammering the session with one round trip per millisecond. Found
live while wiring this up (`protocol/opcua/gateway-client.ts`): the
installed `node-opcua` (2.176.0) requires `publishingEnabled: true` to be
passed explicitly to `ClientSubscription.create()` - omitting it (its
documented default is "true") silently disables actual DataChange
notifications while the subscription itself still reports as started and
still sends keepalives, so this is easy to miss without a real client↔server
run against the simulator.

**Modbus TCP** has no server-push mechanism, so it stays real polling - a
1ms `readingIntervalMs` there means a genuine Modbus round trip every
millisecond, a real protocol limitation, not a gap in this implementation.
Also found live: `modbus-serial`'s own request timeout defaults to
*disabled*, so a request that never gets a response (e.g. the remote closed
the connection) hung forever instead of erroring - fixed by calling
`setTimeout()` on the client after every connect.

## Device connections

**Sensor↔gateway resilience**: `OpcuaGatewayClient`/`ModbusGatewayClient`
used to leave their connected/session state stuck "true" forever after a
drop, so every read after a real disconnect failed identically and forever;
both now reset that state on error and reconnect on the next call, gated by
`protocol/reconnect-cooldown.ts` (fixed 3s cooldown) so a genuinely
unreachable device at a fast read interval doesn't turn into hundreds of
reconnect attempts per second. `MqttGatewayClient`'s and the OPC UA
subscription's cached last value are both now treated as stale (returned as
"no value" rather than replayed forever) once older than 10s - an honest gap
in the reading rather than a frozen value that still looks live.

A third bug only showed up in an actual end-to-end run at a 10ms
`readingIntervalMs`: all three protocol clients' `connect()` only guarded
against *sequential* re-entry (`if (this.connected) return`) - at a fast
enough read interval, `reading-loop.ts`'s per-source `setInterval` fires the
next read before a slow first connect (real network I/O) resolves, so dozens
of overlapping calls each saw "not connected yet" and opened their own
connection. Against the simulated OPC UA server this exhausted its
connection limit within about a second. First fixed by memoizing the
in-flight connect (and, for OPC UA, subscribe) attempt into a single shared
promise that overlapping callers all await.

That fix alone still had a subtler problem, only visible at an actual **1ms**
`readingIntervalMs`: a *rejecting* shared promise still means every one of
the dozens of overlapping callers awaiting it gets its own copy of the same
rejection - a single real connection failure was still logged once per
overlapping tick (up to hundreds of duplicate log lines per attempt) instead
of once per actual attempt. `protocol/single-flight.ts` generalizes the fix:
only the call that actually triggered an in-flight attempt (the
"originator") sees its real outcome; every call piggybacking on an
already-in-flight attempt resolves to `undefined` instead, whether the
attempt succeeds or fails. Confirmed live: a persistently unreachable OPC UA
data source at 1ms went from ~212 duplicate error log lines in 20s down to
~28 - one per actual reconnect attempt (4 data sources × the 3s cooldown),
not one per overlapping read tick.

## Outages of ferrion

**Gateway↔ferrion resilience**: `ReadingBuffer.requeue()` on a failed push,
`GatewayApi.postCommandResult()`s retry-with-backoff. A running instance
whose pushes are currently failing reports that over IPC (`app.ts` →
`process-manager.ts`'s `pushDegraded`) and shows a distinct "Running (connection to ferrion interrupted)" badge in the Web UI, instead of
looking identical to a healthy instance while the failure sits silently in
its log. Since the 2026-09 review ([review-2026-09.md](review-2026-09.md)): pushes go out
in batches of at most 5 000 readings (up to five per tick), a 413 halves the
batch for the rest of the process, a 429 waits for ferrion's `Retry-After`,
any other failure backs off by doubling from the push interval up to a
minute with jitter - so during an outage the buffer fills more slowly and
covers a longer gap, more coarsely aggregated. The buffer file is written
once per tick (before the push) and at most every 30 s while pushes fail;
a write failure (full disk, read-only volume) is logged once a minute and
never stops the loop. A persistently constant OPC UA node is no longer
mistaken for a dead subscription - liveness is judged by the subscription's
own keepalives, not by how long a value has stayed the same.

## Connection status in the web UI


The "ferrion-Verbindung" panel shows a live status dot next to its
heading - unconfigured (gray), connected (green), or unauthorized/
unreachable (red) - based on a real `GET /api/gateway/commands` call
against the configured base URL/API key (`ferrion-connectivity.ts`,
5s timeout), the same request a real running instance would make.
Rechecked immediately after saving/deleting the connection, and silently
every 15s in the background otherwise. The connection can also be deleted
entirely (`DELETE /api/settings`) to reconfigure from scratch - this does
not affect any instance already running with the connection it started
with, only new starts.
