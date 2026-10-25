import { errorMessage } from "../util/error-message.js";

// Who answers on an open OPC UA port (R07, stage 2). One connection per
// candidate carries all of it:
//   - FindServers: the server names itself; a Local Discovery Server (LDS)
//     also names the servers registered with it, on ports a sweep would not
//     try,
//   - GetEndpoints: application URI, product URI, name and the security
//     modes on offer - no session needed,
//   - and only where an anonymous, unsecured session is offered and the
//     device does not already run as a data source: one short session for
//     the NamespaceArray (which identifies AF2 and UMG 801) and BuildInfo.
//
// Found live (smoke test against node-opcua servers, 24.10.): servers name
// themselves by their own hostname in every URL they report - inside a
// container that is the container id, which nobody else can resolve. The
// address that answered the probe is therefore the address kept; the
// reported URL travels along only as information.

/** One candidate, connection and all, never longer than this. */
export const IDENTIFY_TIMEOUT_MS = 5_000;
/** Identifications at once: embedded servers have few channel and session slots. */
export const IDENTIFY_CONCURRENCY = 4;

// Device-supplied text ends up in ferrion's UI and in a JSON column: bounded
// here, at the source, as well as there.
const MAX_TEXT = 256;
const MAX_NAMESPACES = 64;
const MAX_REGISTERED_SERVERS = 64;

const BUILD_INFO_NODES = {
  productUri: "ns=0;i=2262",
  manufacturerName: "ns=0;i=2263",
  productName: "ns=0;i=2261",
  softwareVersion: "ns=0;i=2264",
} as const;
const NAMESPACE_ARRAY_NODE = "ns=0;i=2255";

export type ApplicationTypeName = "Server" | "Client" | "ClientAndServer" | "DiscoveryServer";
export type SecurityModeName = "None" | "Sign" | "SignAndEncrypt";

export interface RegisteredServer {
  applicationUri: string | null;
  discoveryUrls: string[];
}

export interface Identity {
  applicationUri: string | null;
  productUri: string | null;
  applicationName: string | null;
  applicationType: ApplicationTypeName | null;
  // The URL the server reports for itself; often not reachable (see above).
  advertisedEndpointUrl: string | null;
  securityModes: SecurityModeName[];
  anonymousWithoutSecurity: boolean;
  buildInfo: { productUri: string | null; manufacturerName: string | null; productName: string | null; softwareVersion: string | null } | null;
  namespaceUris: string[] | null;
  // Why no session was opened, when none was.
  sessionSkipped: "known-data-source" | "security-required" | null;
  sessionError: string | null;
  // Other servers an LDS named, not including itself.
  registeredServers: RegisteredServer[];
}

export type IdentifyFn = (host: string, port: number, options: { openSession: boolean; timeoutMs: number }) => Promise<Identity>;

/** Device-supplied text: trimmed, bounded, and null when empty or not a string. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
}

const APPLICATION_TYPES: Record<number, ApplicationTypeName> = { 0: "Server", 1: "Client", 2: "ClientAndServer", 3: "DiscoveryServer" };
const SECURITY_MODES: Record<number, SecurityModeName> = { 1: "None", 2: "Sign", 3: "SignAndEncrypt" };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * An identifier using `pkiFolder` for the client's own certificate, or
 * node-opcua's default folder when not given (as every other client in the
 * gateway does).
 *
 * Found live (24.10.): in a fresh container the client's private key does not
 * exist yet; the first client creates it, and the ones started alongside it
 * fail with "Cannot find private key" - 7 of 8 candidates lost, on exactly
 * the first scan after every gateway update. So the certificate is made once,
 * before the first identification, and every caller waits for it.
 */
export function createOpcuaIdentifier(options: { pkiFolder?: string } = {}): IdentifyFn {
  const prepare = async () => {
    const { OPCUAClient, OPCUACertificateManager } = await import("node-opcua");
    const certificateManager = options.pkiFolder ? new OPCUACertificateManager({ rootFolder: options.pkiFolder }) : undefined;
    const client = OPCUAClient.create(certificateManager ? { clientCertificateManager: certificateManager } : {});
    await (client.clientCertificateManager as InstanceType<typeof OPCUACertificateManager>).initialize();
    await client.createDefaultCertificate();
    return certificateManager;
  };
  let ready: ReturnType<typeof prepare> | undefined;

  return async (host, port, identifyOptions) => {
    // Not fatal when it fails: the connect tries on its own, and the next
    // identification prepares again.
    ready ??= prepare().catch(() => {
      ready = undefined;
      return undefined;
    });
    return identify(host, port, identifyOptions, await ready);
  };
}

async function identify(
  host: string,
  port: number,
  { openSession, timeoutMs }: { openSession: boolean; timeoutMs: number },
  certificateManager: unknown,
): Promise<Identity> {
  // Lazily, like every protocol client: node-opcua alone costs ~78 MiB.
  const { OPCUAClient, AttributeIds, UserTokenType } = await import("node-opcua");
  const client = OPCUAClient.create({
    ...(certificateManager ? { clientCertificateManager: certificateManager as never } : {}),
    endpointMustExist: false,
    // No retry: a scan wants the answer of the moment, and node-opcua's
    // default retries forever (see gateway-client.ts).
    connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
    transportTimeout: timeoutMs,
    requestedSessionTimeout: 30_000,
  });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await withTimeout(client.connect(`opc.tcp://${host}:${port}`), remaining(), "connect");
    const servers = await withTimeout(client.findServers(), remaining(), "FindServers");
    const endpoints = await withTimeout(client.getEndpoints(), remaining(), "GetEndpoints");

    const first = endpoints[0]?.server;
    const self = first?.applicationUri ?? null;
    const securityModes = [
      ...new Set(endpoints.map((endpoint) => SECURITY_MODES[endpoint.securityMode]).filter((mode): mode is SecurityModeName => mode !== undefined)),
    ];
    const anonymousWithoutSecurity = endpoints.some(
      (endpoint) =>
        SECURITY_MODES[endpoint.securityMode] === "None" &&
        (endpoint.userIdentityTokens ?? []).some((token) => token.tokenType === UserTokenType.Anonymous),
    );
    const identity: Identity = {
      applicationUri: text(self),
      productUri: text(first?.productUri),
      applicationName: text(first?.applicationName?.text),
      applicationType: first ? (APPLICATION_TYPES[first.applicationType] ?? null) : null,
      advertisedEndpointUrl: text(endpoints[0]?.endpointUrl),
      securityModes,
      anonymousWithoutSecurity,
      buildInfo: null,
      namespaceUris: null,
      sessionSkipped: null,
      sessionError: null,
      registeredServers: servers
        .filter((server) => server.applicationUri !== self)
        .slice(0, MAX_REGISTERED_SERVERS)
        .map((server) => ({
          applicationUri: text(server.applicationUri),
          discoveryUrls: (server.discoveryUrls ?? []).map(text).filter((url): url is string => url !== null).slice(0, 8),
        })),
    };

    if (!openSession) {
      identity.sessionSkipped = "known-data-source";
    } else if (!anonymousWithoutSecurity) {
      identity.sessionSkipped = "security-required";
    } else {
      try {
        const session = await withTimeout(client.createSession(), remaining(), "CreateSession");
        try {
          const nodes = [NAMESPACE_ARRAY_NODE, ...Object.values(BUILD_INFO_NODES)];
          const values = await withTimeout(
            session.read(nodes.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value }))),
            remaining(),
            "Read",
          );
          const good = (index: number): unknown => (values[index]?.statusCode.isGood() ? values[index]?.value.value : undefined);
          const namespaces = good(0);
          identity.namespaceUris = Array.isArray(namespaces)
            ? namespaces.map(text).filter((uri): uri is string => uri !== null).slice(0, MAX_NAMESPACES)
            : null;
          identity.buildInfo = {
            productUri: text(good(1)),
            manufacturerName: text(good(2)),
            productName: text(good(3)),
            softwareVersion: text(good(4)),
          };
        } finally {
          await session.close().catch(() => {});
        }
      } catch (error) {
        identity.sessionError = errorMessage(error).slice(0, MAX_TEXT);
      }
    }
    return identity;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Identifies the OPC UA server on host:port. Throws only when there is no
 * OPC UA conversation at all (not an OPC UA server, connection refused);
 * everything after that is reported in the identity, `sessionError`
 * included.
 */
export const identifyOpcuaServer: IdentifyFn = createOpcuaIdentifier();
