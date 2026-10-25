# Resource usage

What an instance costs in memory and processes, and how to size a device.


Each instance runs as its own forked Node process (`child_process.fork()`
+ `--import tsx`). Measured 2026-08-16 against the Docker image
(`node:20-alpine`), one instance started at a time, RSS read via
`docker stats`/`ps` immediately after each reached `running`:

| | RSS per instance | Startup time |
|---|---|---|
| Control-plane baseline (0 instances) | ~54 MiB | - |
| AVENTICS DS1, Modbus TCP | ~79 MiB | ~1.5s |
| AVENTICS AF2, MQTT | ~88 MiB | ~1.5s |
| AVENTICS AF2, OPC UA | ~144 MiB | ~2.0-2.5s |

Re-measured 2026-09-15 on the Node 22 image after the review changes
([review-2026-09.md](review-2026-09.md)): the container now starts `node` directly, so
the `npm run` (~63 MiB) and tsx CLI wrapper (~45 MiB) processes that used
to sit in the tree for the container's whole life are gone - the
control-plane process itself is ~87 MiB RSS, plus one ~17 MiB esbuild
service process (tsx's transpiler). With 13 instances running at once
(2× DS1 Modbus, 5× AF2 MQTT, 2× AF2 OPC UA, 1× UMG801, the bridge and
two more) the whole cgroup measured 1.0 GiB; instance processes ranged
94-156 MiB, in line with the per-protocol table above. `docker top`
lists `docker-init` as PID 1 (`init: true` in compose) so an OOM-killed
instance's esbuild child is reaped instead of lingering as a zombie.

**A first pass at this measurement found every protocol costing
~117-144 MiB**, barely different from each other - `node-opcua` alone
turned out to cost ~78 MiB beyond the Node/tsx baseline (~70 MiB) in
isolation, and three separate files (`device-simulator.ts`,
`command-handlers.ts`, `reading-loop.ts`) were each importing all three
protocol modules unconditionally, so *every* instance paid node-opcua's
weight even a pure Modbus/MQTT one that never touched it. Fixed by
switching all three to dynamic `import()`, loading only the protocol a
given instance's template (or a given command's/data source's protocol)
actually needs - cut Modbus by ~37% and MQTT by ~25-30%, with OPC UA
itself unchanged (it can't get lighter than the library it actually
uses). **Lesson: per-process overhead was real, but "which protocol
libraries actually get loaded into that process" mattered far more than
originally assumed** - the opposite of the first pass's conclusion.

Budget roughly `55 + (85 × Modbus/MQTT instances) + (144 × OPC UA
instances)` MiB when sizing a device. On the 2 GB-constrained container
used for the earlier 30-instance scale test (which predates this fix and
saw individual instances OOM-killed past ~18 running), the same budget
now comfortably fits the full "10-30 sensors on one gateway" range for a
Modbus/MQTT-heavy fleet, or roughly 13 instances if entirely OPC UA -
not re-run at full scale here, but a direct consequence of the ~2x lower
per-instance cost for non-OPC-UA protocols. Whichever instance *does*
exceed a device's memory (or crashes for any other reason during
startup) now shows up as `status: "error"` with a real explanation
instead of silently reverting to "stopped" (see `process-manager.ts`'s
`classifyExit()`) - both memory and process count (each instance adds
~10-13 PIDs/threads) still grow linearly with instance count, with no
leak observed across repeated start/stop cycles.
