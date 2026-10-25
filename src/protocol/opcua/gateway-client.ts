import { AttributeIds, ClientSubscription, OPCUAClient, TimestampsToReturn } from "node-opcua";
import type { ClientSession } from "node-opcua-client";
import { NodeNotFoundError } from "../node-not-found-error.js";
import { ReconnectCooldown } from "../reconnect-cooldown.js";
import { SingleFlight } from "../single-flight.js";
import type { Logger } from "../../logging/logger.js";

function connectionKey(connection: OpcuaConnectionConfig): string {
  return `${connection.host}:${connection.port}:${connection.namespaceUri}`;
}

function targetKey(target: OpcuaReadTarget): string {
  return `${target.namespaceUri}:${target.nodeIdentifier}`;
}

export interface OpcuaConnectionConfig {
  host: string;
  port: number;
  // The namespace this device's own data lives in - resolved to a live
  // index on connect, never assumed to be a fixed ns=1 (see the plan's
  // hard rule: AF2's namespace URI embeds its serial number, so its index
  // depends on what else the server has registered).
  namespaceUri: string;
  // Tried in order after `namespaceUri`, only if it isn't found on the
  // server - the same catalog entry ("AVENTICS AF2 (OPC UA)") covers units
  // shipped under two different namespace URI schemes: the AVENTICS-branded
  // firmware's serial-templated `urn:AVENTICS:AF2:{serialNumber}`, and a
  // newer Emerson-branded firmware's fixed `http://emerson.com/Flowmeter/AF2/Instance/`
  // (no serial embedded at all) - found live, same numeric Node IDs under
  // both. See known-device-templates.ts's namespaceUriFallbacks.
  namespaceUriFallbacks?: string[];
}

export interface OpcuaReadTarget {
  namespaceUri: string;
  namespaceUriFallbacks?: string[];
  nodeIdentifier: number;
}

// Thrown only by resolveNamespaceIndexForNode() once every namespace
// candidate has been tried and none serves the target node - an
// application-level "this specific node doesn't exist on this device"
// signal, distinct from every other error this file can throw (a dropped
// connection, a session-level failure, ...). performEnsureSubscribed()
// uses this distinction to avoid tearing down the whole shared
// client/session over one target's bad node id - see its own catch block.
export class OpcuaNodeNotFoundError extends NodeNotFoundError {}

// A subscription that has sent neither a notification nor a keepalive for
// this long is dead, whatever node-opcua's own state says - it can
// recreate its subscription/secure-channel internally (visible in the logs
// as "reconnection... We need to recreate entirely the subscription")
// without that ever throwing back up through this wrapper. Lower bound
// only: the real threshold is derived from the keepalive period the
// subscription was created with (see performEnsureSubscribed()), which is
// what the server actually promised.
const MIN_SUBSCRIPTION_DEAD_AFTER_MS = 30_000;
const KEEPALIVE_MISSES_BEFORE_DEAD = 3;

// A node the device says it does not have is retried this often, not on
// every read tick: the node is not going to appear between two 1 ms ticks,
// and each attempt is one or two real reads per namespace candidate plus
// an error line (review 2026-09, M-7).
const NODE_NOT_FOUND_RETRY_MS = 60_000;

interface MonitoredTargetState {
  latestValue: number | undefined;
  latestValueAt: number | undefined;
  // The subscription this target's monitored item was created on. A reset
  // replaces this.subscription with a new object; an item created on the old
  // one is dead and will never fire "changed" again, so a state whose
  // subscription !== this.subscription must be re-subscribed, not trusted.
  subscription: ClientSubscription;
  // When monitor() returned for this target - for the no-first-value
  // watchdog below.
  subscribedAt: number;
}

// A target whose monitored item is on the current, live subscription but has
// delivered no value for this long since subscribing is re-subscribed: the
// server sends an initial value on monitored-item creation, so "nothing after
// this long" means the item was never really created (found live 2026-10-11:
// 8 UMG 801 sources stayed silent after creation until a gateway restart).
// Floored so a fast samplingInterval does not turn this into a resubscribe
// storm.
const NO_FIRST_VALUE_RESUBSCRIBE_FLOOR_MS = 10_000;

export function noFirstValueResubscribeMs(samplingIntervalMs: number): number {
  return Math.max(NO_FIRST_VALUE_RESUBSCRIBE_FLOOR_MS, samplingIntervalMs * 50);
}

/**
 * Whether a target that already has a cached-state entry must be
 * re-subscribed instead of trusted. Pure so the three cases are unit-tested
 * without a live server (the live tests cover the happy path and recovery).
 */
export function shouldResubscribeTarget(args: {
  // state.subscription === this.subscription
  sameSubscription: boolean;
  subscriptionAlive: boolean;
  hasValue: boolean;
  msSinceSubscribed: number;
  noFirstValueMs: number;
}): boolean {
  // The whole shared subscription stopped proving it is alive - every target
  // on it has to go through a reconnect.
  if (!args.subscriptionAlive) return true;
  // The item is on a subscription that has since been replaced; it is dead
  // even though a newer subscription is alive. This is the 2026-10-11 bug:
  // a reset between this target's monitor() and another's left the entry
  // registered against the old subscription, and the alive-check on the new
  // one made ensureSubscribed believe it was fine.
  if (!args.sameSubscription) return true;
  // Current and alive, but never delivered - the item was not really created.
  if (!args.hasValue && args.msSinceSubscribed >= args.noFirstValueMs) return true;
  return false;
}

// Protocol-generic: knows how to talk OPC UA, nothing about which device or
// metric it's reading - the caller supplies host/port/namespaceUri and a
// read target (see gateway/command-handlers.ts and gateway/reading-loop.ts).
export class OpcuaGatewayClient {
  private readonly connection: OpcuaConnectionConfig;
  private readonly cooldown = new ReconnectCooldown();
  private client: OPCUAClient | undefined;
  private session: ClientSession | undefined;
  private subscription: ClientSubscription | undefined;
  // Liveness of the shared subscription: bumped by every keepalive,
  // notification batch and value change. This - not the age of a cached
  // value - decides whether a value is still current. OPC UA monitored
  // items report *changes* only (the default StatusValue filter), so a
  // legitimately constant node (a counter at no load, a setpoint, a status
  // register) sends one notification and then nothing; judging it by value
  // age declared it stale after 10 s and, worse, tore the whole shared
  // session down every ~33 s for every target on the device (review
  // 2026-09, M-6). While the subscription is alive, "no change" means
  // "same value" - the server guarantees it.
  private subscriptionAliveAt: number | undefined;
  private subscriptionDeadAfterMs = MIN_SUBSCRIPTION_DEAD_AFTER_MS;
  // Fetched once per connect() and matched case-insensitively in
  // resolveNamespaceIndex() - node-opcua's own session.getNamespaceIndex()
  // does an exact match, which broke against a real AF2 unit reporting
  // "urn:Aventics:AF2:10000123" (mixed case) against our catalog's
  // "urn:AVENTICS:AF2:..." (all caps) candidate - same device family,
  // same Node IDs, just an inconsistently-cased namespace URI across
  // firmware builds.
  private namespaceArray: readonly string[] | undefined;
  // Keyed by targetKey() - one shared session/subscription per
  // OpcuaGatewayClient (see acquireOpcuaGatewayClient()), but a device can
  // expose several metrics (nodes) that all need their own monitored item
  // and their own cached last-value. Found live against a real AF2 unit
  // (the local simulator never surfaced this): a separate client+session
  // per data source exhausted the device's own session limit
  // (BadTooManySessions) as soon as more than a couple of metrics were
  // configured on the same physical sensor.
  private readonly monitoredTargets = new Map<string, MonitoredTargetState>();
  // In-flight guards, not just the already-connected checks below: at a
  // fast readIntervalMs (down to 1ms), reading-loop.ts's setInterval fires
  // the next read before a slow first connect+subscribe (real network I/O)
  // has resolved, and `if (this.session) return` only blocks *sequential*
  // re-entry - dozens of overlapping calls would otherwise each see "not
  // connected yet" and open their own connection. Found live: the simulated
  // OPC UA server's connection limit was exhausted within ~1s at a 10ms
  // read interval before this existed. SingleFlight (not just a shared
  // promise) additionally matters for a *failing* attempt: also found live,
  // at a real 1ms interval a single rejected connect used to be re-thrown to
  // every one of the dozens of overlapping callers awaiting it, logging the
  // same failure that many times per attempt instead of once.
  private readonly connectGate = new SingleFlight<void>();
  // One gate per target, not one shared gate for the whole client - a
  // shared SingleFlight would coalesce a concurrent ensureSubscribed() for
  // metric B into metric A's already-in-flight attempt, silently never
  // subscribing B (SingleFlight only runs the *originator*'s callback).
  private readonly subscribeGates = new Map<string, SingleFlight<void>>();
  // Per-target retry pacing for OpcuaNodeNotFoundError - see
  // NODE_NOT_FOUND_RETRY_MS. Separate from `cooldown`, which is about the
  // connection as a whole.
  private readonly nodeNotFoundCooldowns = new Map<string, ReconnectCooldown>();
  // Targets whose values were rejected as non-numeric/non-finite, so that
  // is logged once per target, not once per notification. Cleared again by
  // the next good value, so a recurrence is logged again.
  private readonly nonNumericReported = new Set<string>();
  // Targets currently reporting a bad status code, keyed by target with the
  // status they last reported - logged once per target and status, not once
  // per notification (a device in trouble can repeat it every sample).
  private readonly badStatusReported = new Map<string, string>();
  private readonly logger: Logger | undefined;

  constructor(connection: OpcuaConnectionConfig, logger?: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  private get endpointUrl(): string {
    return `opc.tcp://${this.connection.host}:${this.connection.port}`;
  }

  async connect(): Promise<void> {
    if (this.session) return;
    return this.connectGate.run(() => this.performConnect());
  }

  private async performConnect(): Promise<void> {
    // node-opcua's own default is maxRetry: -1 (retry forever, silently,
    // on any connect failure) - client.connect() would then never resolve
    // *or* reject, hanging the whole command/reading loop indefinitely
    // instead of surfacing a real error. Found live: a TEST_CONNECTION
    // command stayed stuck IN_PROGRESS forever with no error logged.
    //
    // requestedSessionTimeout: node-opcua's own default (60_000ms) is
    // shorter than requestedMaxKeepAliveCount(20) * a 5s publishingInterval
    // (the reading-loop's own default readIntervalMs) = 100_000ms -
    // ClientSubscription.create() then throws
    // "[NODE-OPCUA-W09] The subscription parameters are not compatible with
    // the session timeout" instead of just warning about it. Found live
    // against a real AF2 unit (never against the local simulator). A
    // generous fixed timeout, not a per-config-tuned keepalive, so this
    // stays correct regardless of whatever readIntervalMs an instance is
    // configured with - node-opcua's own suggested fix in that same warning
    // message.
    const client = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 1 },
      requestedSessionTimeout: 600_000,
    });
    await client.connect(this.endpointUrl);
    // A connected client whose session creation then fails (the device's
    // BadTooManySessions is exactly the case) must be torn down here: it
    // was never assigned to `this.client`, so resetConnection() cannot see
    // it, and it would otherwise keep its secure channel, socket and
    // token-renewal timers alive unreferenced - one more per attempt, 1200
    // an hour at the 3 s cooldown (review 2026-09, H-3).
    let session: ClientSession;
    try {
      session = await client.createSession();
      this.namespaceArray = await session.readNamespaceArray();
    } catch (error) {
      await client.disconnect().catch(() => {});
      throw error;
    }
    this.client = client;
    this.session = session;
  }

  async disconnect(): Promise<void> {
    if (this.subscription) {
      await this.subscription.terminate().catch(() => {});
      this.subscription = undefined;
    }
    this.subscriptionAliveAt = undefined;
    if (this.session) {
      await this.session.close();
      this.session = undefined;
    }
    if (this.client) {
      await this.client.disconnect();
      this.client = undefined;
    }
    this.monitoredTargets.clear();
    this.namespaceArray = undefined;
  }

  // A dropped connection otherwise leaves `session`/`client` truthy forever
  // (connect()'s `if (this.session) return;` would then never reconnect) -
  // every subsequent read would fail the same way indefinitely. Clearing
  // monitoredTargets means every metric's own next ensureSubscribed()
  // re-attempts and re-populates it independently once the connection
  // recovers - see performEnsureSubscribed().
  //
  // Best-effort session close, not just a local reference reset: a failure
  // *after* createSession() (e.g. a bad namespace URI, or `monitor()`
  // rejecting) otherwise leaves a live, still-open session on the server
  // that nothing ever closes - each occupying one slot against the
  // *server's own* session limit until it eventually times out on its own.
  // Found live against a real AF2 unit: a string of failed subscribe
  // attempts (from before shared sessions existed, see
  // acquireOpcuaGatewayClient()) parked enough zombie sessions server-side
  // to make even a single new connection attempt fail with
  // BadTooManySessions for up to a minute afterwards, though nothing here
  // was still retrying that fast. Swallowing close/disconnect errors
  // matches disconnect()'s own best-effort spirit - the connection is
  // presumed already unhealthy, so a failure while tearing it down isn't
  // worth surfacing over the original error that triggered this reset.
  private async resetConnection(): Promise<void> {
    const session = this.session;
    const client = this.client;
    this.subscription = undefined;
    this.subscriptionAliveAt = undefined;
    this.session = undefined;
    this.client = undefined;
    this.monitoredTargets.clear();
    this.namespaceArray = undefined;
    this.cooldown.recordFailure();
    if (session) await session.close().catch(() => {});
    if (client) await client.disconnect().catch(() => {});
  }

  private subscriptionAlive(now: number): boolean {
    return (
      this.subscription !== undefined &&
      this.subscriptionAliveAt !== undefined &&
      now - this.subscriptionAliveAt <= this.subscriptionDeadAfterMs
    );
  }

  private markSubscriptionAlive(): void {
    this.subscriptionAliveAt = Date.now();
  }

  // Tries `namespaceUri` first, then each of `fallbacks` in order, matched
  // case-insensitively against the server's own namespace array (not
  // session.getNamespaceIndex(), which is an exact match - see
  // namespaceArray's doc comment on why that broke against a real device).
  // Only checks that the URI is *registered*, not that it actually serves
  // the metric node the caller wants - see resolveNamespaceIndexForNode()
  // for that stronger check, needed for reading real data.
  private resolveNamespaceIndex(namespaceUri: string, fallbacks: string[] = []): number {
    if (!this.namespaceArray) {
      throw new Error("Not connected");
    }
    const candidates = [namespaceUri, ...fallbacks];
    for (const candidate of candidates) {
      const index = this.namespaceArray.findIndex((entry) => entry.toLowerCase() === candidate.toLowerCase());
      if (index >= 0) return index;
    }
    throw new Error(`Namespace URI not found on server: ${candidates.join(" | ")}`);
  }

  // Like resolveNamespaceIndex(), but for actually reading a specific node:
  // a candidate URI being *registered* doesn't mean the target node lives
  // under it - found live against a real AF2 unit that registers two
  // near-identical namespace URIs (differing only by an extra ":", e.g.
  // "urn:Aventics:AF2:10000123" vs "urn:Aventics:AF2::10000123"), where the
  // *first* one (matching our primary candidate, case-insensitively) turned
  // out to be an empty/unused namespace and the real ProcessData subtree
  // sat under the second. Each candidate is verified with a real read of
  // the target node, not just a namespace-array lookup, and rejected
  // (moving to the next candidate) on BadNodeIdUnknown.
  private async resolveNamespaceIndexForNode(
    namespaceUri: string,
    fallbacks: string[] | undefined,
    nodeIdentifier: number,
  ): Promise<number> {
    if (!this.namespaceArray || !this.session) {
      throw new Error("Not connected");
    }
    const session = this.session;
    const candidates = [namespaceUri, ...(fallbacks ?? [])];
    const attempts: string[] = [];
    for (const candidate of candidates) {
      const index = this.namespaceArray.findIndex((entry) => entry.toLowerCase() === candidate.toLowerCase());
      if (index < 0) {
        attempts.push(`${candidate} (not registered)`);
        continue;
      }
      const dataValue = await session.read({ nodeId: `ns=${index};i=${nodeIdentifier}`, attributeId: AttributeIds.Value });
      if (dataValue.statusCode.isGood()) return index;
      attempts.push(`${candidate} (ns=${index}, node i=${nodeIdentifier}: ${dataValue.statusCode.toString()})`);
    }
    throw new OpcuaNodeNotFoundError(`No namespace candidate serves node i=${nodeIdentifier}: ${attempts.join(" | ")}`);
  }

  // Adds one monitored item per distinct target (metric) to a single shared
  // subscription - the server does the actual sampling at
  // `samplingIntervalMs` and pushes changes; the caller (reading-loop.ts)
  // then just polls readCachedValue(target) on its own, possibly much
  // faster, ticker instead of issuing a fresh ReadRequest every cycle. Safe
  // to call repeatedly, including with a different target each time: a
  // no-op only once *that specific target* is already monitored on a live
  // subscription.
  async ensureSubscribed(target: OpcuaReadTarget, samplingIntervalMs: number): Promise<void> {
    const key = targetKey(target);
    const now = Date.now();
    const existing = this.monitoredTargets.get(key);
    if (
      existing &&
      !shouldResubscribeTarget({
        sameSubscription: existing.subscription === this.subscription,
        subscriptionAlive: this.subscriptionAlive(now),
        hasValue: existing.latestValue !== undefined,
        msSinceSubscribed: now - existing.subscribedAt,
        noFirstValueMs: noFirstValueResubscribeMs(samplingIntervalMs),
      })
    ) {
      return;
    }
    // Silently no-op during the post-failure cooldown instead of throwing -
    // the caller (reading-loop.ts) calls this on every read tick, and
    // without this a persistently unreachable device would log a fresh
    // error every single tick down to every 1ms instead of once per
    // cooldown window. readCachedValue() correctly reports "no value" for
    // as long as this keeps no-op'ing.
    if (!this.cooldown.canAttempt()) return;
    if (!(this.nodeNotFoundCooldowns.get(key)?.canAttempt() ?? true)) return;
    if (existing) {
      if (!this.subscriptionAlive(now)) {
        // The subscription stopped sending keepalives - nothing threw, so
        // nothing else would ever notice. resetConnection() tears down the
        // whole shared client (every target on this physical device, not
        // just this one key) - correct, since a dead session is dead for all
        // of them; each target's own next ensureSubscribed() call
        // independently re-subscribes once the cooldown clears.
        this.logger?.warn({ target: key }, "OPC UA subscription went silent, forcing reconnect");
        await this.resetConnection();
      } else {
        // The shared subscription is alive, but this one target's monitored
        // item is stale: created on a since-replaced subscription, or it
        // never delivered its initial value. Drop just this entry and
        // re-monitor it on the current subscription - the session and every
        // other target on it stay up. Found live 2026-10-11: 8 UMG 801
        // sources never delivered after creation until a restart.
        this.logger?.warn({ target: key }, "OPC UA monitored item stale or silent, re-subscribing this target");
        this.monitoredTargets.delete(key);
      }
    }
    let gate = this.subscribeGates.get(key);
    if (!gate) {
      gate = new SingleFlight<void>();
      this.subscribeGates.set(key, gate);
    }
    return gate.run(() => this.performEnsureSubscribed(target, samplingIntervalMs, key));
  }

  private async performEnsureSubscribed(target: OpcuaReadTarget, samplingIntervalMs: number, key: string): Promise<void> {
    try {
      await this.connect();
      const session = this.session as ClientSession;
      const namespaceIndex = await this.resolveNamespaceIndexForNode(
        target.namespaceUri,
        target.namespaceUriFallbacks,
        target.nodeIdentifier,
      );
      // Reuse the client's one subscription across every target instead of
      // creating a new one per metric - see the class-level comment on why
      // (BadTooManySessions against a real device).
      if (!this.subscription) {
        // maxKeepAliveCount derived from the *actual* session.timeout the
        // server granted (session.timeout, not our own requestedSessionTimeout
        // in performConnect()) rather than a fixed 20 - some real AF2 units
        // ignore/clamp that request and grant a far shorter session timeout
        // of their own (found live: 25_000ms against a 600_000ms request). A
        // fixed maxKeepAliveCount(20) * publishingInterval(often 5000ms) =
        // 100_000ms then exceeded even that short session, so
        // ClientSubscription.create() kept throwing "[NODE-OPCUA-W09] The
        // subscription parameters are not compatible with the session
        // timeout" forever. Targeting a third of whatever was actually
        // granted keeps this "largely greater than" per that same warning's
        // own guidance, regardless of what any given device's server grants.
        const keepAliveWindowMs = session.timeout / 3;
        const maxKeepAliveCount = Math.max(1, Math.floor(keepAliveWindowMs / samplingIntervalMs));
        const subscription = ClientSubscription.create(session, {
          requestedPublishingInterval: samplingIntervalMs,
          requestedMaxKeepAliveCount: maxKeepAliveCount,
          // Found live (see the plan's note on verifying wire-protocol APIs
          // against the installed version, not just its types/docs):
          // node-opcua 2.176.0's ClientSubscriptionImpl constructor runs
          // `options.publishingEnabled = !!options.publishingEnabled` BEFORE
          // its own "default to true when undefined" check ever sees
          // `undefined` - so omitting this silently disables publishing.
          // Subscribed + "started" fires either way; only actual DataChange
          // notifications go missing, so this is easy to miss without a real
          // live run.
          publishingEnabled: true,
        });
        // node-opcua can fail subscription creation asynchronously, after
        // create() already returned, by emitting a plain EventEmitter
        // "error" event rather than rejecting a promise (found live
        // 2026-09-04: "createSubscription has failed => no session", raised
        // when a concurrent resetConnection() tears down this session while
        // creation is still in flight - a real race, not hypothetical). An
        // "error" event with no listener throws and crashes the whole
        // process; listening here converts that into a normal, recoverable
        // failure. Clearing `this.subscription` (only if it's still this
        // exact instance - a later successful recreate must not be
        // clobbered by a stale event) makes the next ensureSubscribed()
        // rebuild fresh instead of reusing a dead subscription forever, and
        // resetConnection() clears the (likely also-stale) session/client
        // alongside it.
        subscription.on("error", (err: unknown) => {
          this.logger?.error({ err }, "OPC UA subscription emitted an error event");
          if (this.subscription === subscription) {
            this.subscription = undefined;
            void this.resetConnection();
          }
        });
        // Liveness: a keepalive arrives every maxKeepAliveCount publishing
        // intervals when nothing changed; a notification batch whenever
        // something did. Three missed keepalives (never less than the
        // 30 s floor) and the subscription counts as dead.
        subscription.on("keepalive", () => this.markSubscriptionAlive());
        subscription.on("received_notifications", () => this.markSubscriptionAlive());
        this.subscriptionDeadAfterMs = Math.max(
          MIN_SUBSCRIPTION_DEAD_AFTER_MS,
          KEEPALIVE_MISSES_BEFORE_DEAD * maxKeepAliveCount * samplingIntervalMs,
        );
        this.subscription = subscription;
        this.markSubscriptionAlive();
      }
      // The exact subscription this item is created on, captured before the
      // await: if a reset replaces this.subscription while monitor() is in
      // flight, the item belongs to the old one and ensureSubscribed must
      // re-subscribe it (shouldResubscribeTarget's sameSubscription check).
      const subscription = this.subscription;
      const state: MonitoredTargetState = {
        latestValue: undefined,
        latestValueAt: undefined,
        subscription,
        subscribedAt: Date.now(),
      };
      const monitoredItem = await subscription.monitor(
        { nodeId: `ns=${namespaceIndex};i=${target.nodeIdentifier}`, attributeId: AttributeIds.Value },
        { samplingInterval: samplingIntervalMs, queueSize: 1, discardOldest: true },
        TimestampsToReturn.Neither,
      );
      monitoredItem.on("changed", (dataValue) => {
        this.markSubscriptionAlive();
        // A bad status or a null is the device saying "I have no good value
        // for this node right now" - it is a change, and the cached value
        // must go with it. Until 2026-10-11 both branches only returned and
        // left `latestValue` standing, and readCachedValue() kept handing it
        // out as current for as long as the subscription stayed alive: on a
        // Janitza UMG 801 the power factors L1-L3 read a constant 0.98294925
        // for 32 hours while the compressor stood still and the device
        // reported null - noticed only because a gateway restart cleared the
        // cache (found on the production instance 2026-10-10). No
        // value is an honest gap; a frozen value is a wrong reading.
        if (!dataValue.statusCode.isGood()) {
          state.latestValue = undefined;
          state.latestValueAt = undefined;
          const status = dataValue.statusCode.toString();
          if (this.badStatusReported.get(key) !== status) {
            this.badStatusReported.set(key, status);
            this.logger?.warn({ target: key, status }, "OPC UA node reports a bad status - its last value is dropped until a good one arrives");
          }
          return;
        }
        const value: unknown = dataValue.value.value;
        // A node of any other data type (String, Boolean, a struct) would
        // otherwise be cached as-is and aggregated into NaN; the platform
        // drops non-finite readings per entry, so locally it must not
        // count as a live value either (review 2026-09, M-11). null (the
        // UMG 801 case above) lands here too.
        if (typeof value !== "number" || !Number.isFinite(value)) {
          state.latestValue = undefined;
          state.latestValueAt = undefined;
          if (!this.nonNumericReported.has(key)) {
            this.nonNumericReported.add(key);
            this.logger?.warn({ target: key, value }, "OPC UA node delivered a non-numeric or non-finite value - its last value is dropped until a good one arrives");
          }
          return;
        }
        const wasBad = this.badStatusReported.delete(key);
        const wasNonNumeric = this.nonNumericReported.delete(key);
        if (wasBad || wasNonNumeric) {
          this.logger?.info({ target: key, value }, "OPC UA node delivers good values again");
        }
        state.latestValue = value;
        state.latestValueAt = Date.now();
      });
      this.monitoredTargets.set(key, state);
      this.cooldown.reset();
      this.nodeNotFoundCooldowns.delete(key);
    } catch (error) {
      // A node that genuinely doesn't exist on this device (wrong module
      // count, etc.) must not tear down the whole shared client - every
      // *other* target on the same physical device (session, subscription,
      // its own monitored items) would otherwise get reset right along with
      // it, on every single failed retry of just this one bad target. Found
      // live 2026-09-04: 7 non-existent module nodes on one Janitza UMG801
      // kept resetting the connection every ~13s, so the other 35 real
      // metrics on that same device never held a subscription long enough
      // to ever receive a value. Every other failure here (a dropped
      // connection, a session-level error, ...) still resets as before.
      if (error instanceof OpcuaNodeNotFoundError) {
        let pacing = this.nodeNotFoundCooldowns.get(key);
        if (!pacing) {
          pacing = new ReconnectCooldown({ cooldownMs: NODE_NOT_FOUND_RETRY_MS });
          this.nodeNotFoundCooldowns.set(key, pacing);
        }
        pacing.recordFailure();
      } else {
        await this.resetConnection();
      }
      throw error;
    }
  }

  // undefined while no value has arrived yet, after the node's last
  // notification was a bad status or a null (see the "changed" handler),
  // and once the subscription stopped proving it is alive (see
  // subscriptionAliveAt) - not merely because the value has not changed
  // for a while. A frozen device shows up as missing keepalives, an honest
  // gap; an unchanged value on a live subscription is exactly that,
  // unchanged.
  readCachedValue(target: OpcuaReadTarget): number | undefined {
    const state = this.monitoredTargets.get(targetKey(target));
    if (!state || state.latestValue === undefined) return undefined;
    return this.subscriptionAlive(Date.now()) ? state.latestValue : undefined;
  }

  // A real connect + namespace resolution + a read of the server's own
  // well-known CurrentTime node (ns=0;i=2258) as a liveness check - no
  // device-specific Node ID knowledge needed.
  async testConnection(): Promise<void> {
    await this.connect();
    const session = this.session as ClientSession;
    this.resolveNamespaceIndex(this.connection.namespaceUri, this.connection.namespaceUriFallbacks);
    const dataValue = await session.read({ nodeId: "ns=0;i=2258", attributeId: AttributeIds.Value });
    if (!dataValue.statusCode.isGood()) {
      throw new Error(`OPC UA liveness read failed with status ${dataValue.statusCode.toString()}`);
    }
  }

  // The server's own firmware/software version (BuildInfo.SoftwareVersion,
  // ns=0;i=2264, part of every OPC UA server's standard address space).
  // ferrion needs it for the Janitza UMG 801: Janitza renumbered its node ids
  // between firmware 1.5.x and 1.6.x, and the catalogue uses the 1.6 ones -
  // on a 1.5.2 device every source stayed silent (ferrion#902). null
  // when the server does not say; never fails the caller's test.
  async readSoftwareVersion(): Promise<string | null> {
    await this.connect();
    const session = this.session as ClientSession;
    const dataValue = await session.read({ nodeId: "ns=0;i=2264", attributeId: AttributeIds.Value });
    const value: unknown = dataValue.value?.value;
    return dataValue.statusCode.isGood() && typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  async browse(): Promise<Array<{ nodeId: string; browseName: string }>> {
    await this.connect();
    const session = this.session as ClientSession;
    const result = await session.browse("ObjectsFolder");
    return (result.references ?? []).map((reference) => ({
      nodeId: reference.nodeId.toString(),
      browseName: reference.browseName.toString(),
    }));
  }

  // Browses a device-specific "modules" folder node and returns the module
  // indices actually found as its children (see known-device-templates.ts's
  // DeviceTemplate.moduleProbe) - used right after a successful
  // testConnection() to narrow the wizard's data-point picker to modules
  // that are really fitted, instead of every one the catalog statically
  // allows for. Only the primary connection.namespaceUri (+ fallbacks) is
  // tried, same as testConnection() - a device needing this feature is
  // already known live (not templated per serial number like the AF2), so
  // there's no per-node fallback resolution to do here.
  async browseModules(modulesFolderNodeId: number): Promise<number[]> {
    await this.connect();
    const session = this.session as ClientSession;
    const namespaceIndex = this.resolveNamespaceIndex(this.connection.namespaceUri, this.connection.namespaceUriFallbacks);
    const result = await session.browse(`ns=${namespaceIndex};i=${modulesFolderNodeId}`);
    return (result.references ?? [])
      .map((reference) => parseModuleIndexFromBrowseName(reference.browseName.toString()))
      .filter((index): index is number => index !== null)
      .sort((a, b) => a - b);
  }
}

// browseName.toString() renders as "<namespaceIndex>:<name>" (e.g.
// "2:Module3", confirmed live 2026-09-04 against a real Janitza UMG801) -
// matched by suffix rather than assuming a fixed namespace index prefix.
export function parseModuleIndexFromBrowseName(browseName: string): number | null {
  const match = browseName.match(/:Module(\d+)$/);
  return match ? Number(match[1]) : null;
}

// Reference-counted registry so every data source reading from the same
// physical OPC UA endpoint (same host+port+namespaceUri, e.g. several
// metrics on one AF2 unit) shares a single OpcuaGatewayClient/session
// instead of reading-loop.ts's per-data-source createDataSourceReader()
// each opening its own - see the class-level comment on why a real device's
// own session limit makes that necessary. Module-level, not per-ReadingLoop:
// each `ferrion-gateway` instance already runs as its own process (see
// control-plane/process-manager.ts), so there's only ever one reading loop
// per module instance anyway.
const sharedClients = new Map<string, { client: OpcuaGatewayClient; refCount: number }>();

// `logger` only takes effect for the first caller that acquires a given
// connection (later callers just get the already-constructed shared
// client) - acceptable since every data source on one gateway instance
// shares the same logger anyway.
export function acquireOpcuaGatewayClient(connection: OpcuaConnectionConfig, logger?: Logger): OpcuaGatewayClient {
  const key = connectionKey(connection);
  const existing = sharedClients.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.client;
  }
  const client = new OpcuaGatewayClient(connection, logger);
  sharedClients.set(key, { client, refCount: 1 });
  return client;
}

// Only actually disconnects once every data source sharing this client has
// released it - releasing before that would drop the other data sources'
// subscription out from under them.
export async function releaseOpcuaGatewayClient(connection: OpcuaConnectionConfig): Promise<void> {
  const key = connectionKey(connection);
  const entry = sharedClients.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  sharedClients.delete(key);
  await entry.client.disconnect();
}
