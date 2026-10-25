import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MessageSecurityMode, OPCUACertificateManager, OPCUAServer, SecurityPolicy } from "node-opcua";
// Not declared in package.json on purpose: node-opcua depends on this exact
// version and does not re-export it; declaring it would let a separate
// Dependabot bump pull it apart from the node-opcua it belongs to.
import { OPCUADiscoveryServer } from "node-opcua-server-discovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpcuaSimulatorServer } from "../protocol/opcua/simulator-server.js";
import { createOpcuaIdentifier, identifyOpcuaServer, text } from "./opcua-identify.js";

// Against real node-opcua servers, as found live in the smoke test: a
// simulated AF2, a server that only offers secured endpoints, and a Local
// Discovery Server with a server registered at it (by hostname, as real
// registered servers report themselves).
const AF2_PORT = 26841;
const SECURED_PORT = 26842;
const LDS_PORT = 26843;
const REGISTERED_PORT = 26844;
const REGISTERED_URI = "urn:ferrion-gateway-test:registered";
const CROWDED_PORT = 26845;
const OPTIONS = { openSession: true, timeoutMs: 5_000 };

const af2 = new OpcuaSimulatorServer();
let secured: OPCUAServer;
let crowded: OPCUAServer;
let lds: OPCUADiscoveryServer;
let plainTcp: net.Server;
let plainTcpPort: number;

beforeAll(async () => {
  await af2.start(AF2_PORT, "urn:AVENTICS:AF2:10000123", "127.0.0.1", { softwareVersion: "4.2.1" });

  secured = new OPCUAServer({
    port: SECURED_PORT,
    host: "127.0.0.1",
    securityModes: [MessageSecurityMode.Sign],
    securityPolicies: [SecurityPolicy.Basic256Sha256],
    allowAnonymous: false,
  });
  await secured.start();

  // More namespaces than the gateway passes on.
  crowded = new OPCUAServer({ port: CROWDED_PORT, host: "127.0.0.1" });
  await crowded.initialize();
  for (let index = 0; index < 70; index += 1) crowded.engine.addressSpace?.registerNamespace(`urn:ferrion-gateway-test:ns:${index}`);
  await crowded.start();

  // Its own PKI folder, not the user's default one.
  const certificateManager = new OPCUACertificateManager({ rootFolder: path.join(os.tmpdir(), `ferrion-gateway-lds-test-${process.pid}`) });
  await certificateManager.initialize();
  lds = new OPCUADiscoveryServer({ port: LDS_PORT, serverCertificateManager: certificateManager });
  await lds.start();
  // Entered directly rather than through a real RegisterServer: that goes
  // over a secured channel with certificate trust, and under parallel test
  // files it registered late or not at all (1 in 3 runs). What is under test
  // is how the gateway reads FindServers, which this gives exactly.
  lds.registeredServers.set(REGISTERED_URI, {
    serverUri: REGISTERED_URI,
    productUri: "urn:ferrion-gateway-test:product",
    serverNames: [{ text: "Registered" }],
    serverType: 0,
    gatewayServerUri: null,
    discoveryUrls: [`opc.tcp://plant-pc:${REGISTERED_PORT}`],
    semaphoreFilePath: null,
    isOnline: true,
    serverInfo: {
      applicationUri: REGISTERED_URI,
      productUri: "urn:ferrion-gateway-test:product",
      applicationName: { text: "Registered" },
      applicationType: 0,
      discoveryUrls: [`opc.tcp://plant-pc:${REGISTERED_PORT}`],
    },
  } as unknown as Parameters<typeof lds.registeredServers.set>[1]);

  // Answers like a web server and hangs up fully; a half-closed socket kept
  // server.close() waiting.
  plainTcp = net.createServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => socket.destroy()));
  await new Promise<void>((resolve) => plainTcp.listen(0, "127.0.0.1", resolve));
  plainTcpPort = (plainTcp.address() as net.AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await Promise.all([
    af2.stop(),
    secured?.shutdown(0),
    crowded?.shutdown(0),
    // Removed first: the LDS would try to take it offline like a real one.
    Promise.resolve(lds?.registeredServers.delete(REGISTERED_URI)).then(() => lds?.shutdown()),
    new Promise((resolve) => plainTcp?.close(resolve)),
  ]);
});

describe("identifyOpcuaServer", () => {
  it("reads identity, namespaces and BuildInfo of an anonymous server", async () => {
    const identity = await identifyOpcuaServer("127.0.0.1", AF2_PORT, OPTIONS);

    expect(identity.applicationType).toBe("Server");
    expect(identity.applicationUri).toMatch(/^urn:/);
    expect(identity.securityModes).toContain("None");
    expect(identity.anonymousWithoutSecurity).toBe(true);
    expect(identity.namespaceUris).toContain("urn:AVENTICS:AF2:10000123");
    expect(identity.buildInfo?.softwareVersion).toBe("4.2.1");
    expect(identity.sessionSkipped).toBeNull();
    expect(identity.sessionError).toBeNull();
    // The server names itself by hostname; the caller keeps the probed address.
    expect(identity.advertisedEndpointUrl).toMatch(/^opc\.tcp:\/\//);
    expect(identity.registeredServers).toEqual([]);
  });

  it("opens no session for a device that already runs as a data source", async () => {
    const identity = await identifyOpcuaServer("127.0.0.1", AF2_PORT, { ...OPTIONS, openSession: false });

    expect(identity.sessionSkipped).toBe("known-data-source");
    expect(identity.namespaceUris).toBeNull();
    expect(identity.buildInfo).toBeNull();
    // Endpoints still come without a session.
    expect(identity.applicationUri).toMatch(/^urn:/);
  });

  it("only flags a server that requires security, without trying a session", async () => {
    const identity = await identifyOpcuaServer("127.0.0.1", SECURED_PORT, OPTIONS);

    expect(identity.anonymousWithoutSecurity).toBe(false);
    expect(identity.securityModes).toEqual(["Sign"]);
    expect(identity.sessionSkipped).toBe("security-required");
    expect(identity.sessionError).toBeNull();
  });

  it("names the servers registered at a Local Discovery Server, and itself as one", async () => {
    const identity = await identifyOpcuaServer("127.0.0.1", LDS_PORT, OPTIONS);

    expect(identity.applicationType).toBe("DiscoveryServer");
    expect(identity.registeredServers).toEqual([
      { applicationUri: REGISTERED_URI, discoveryUrls: [`opc.tcp://plant-pc:${REGISTERED_PORT}`] },
    ]);
  });

  it("passes on at most 64 namespaces", async () => {
    const identity = await identifyOpcuaServer("127.0.0.1", CROWDED_PORT, OPTIONS);

    expect(identity.namespaceUris).toHaveLength(64);
  });

  it("passes on at most 64 registered servers with 8 URLs each", async () => {
    const extra = Array.from({ length: 70 }, (_, index) => `urn:ferrion-gateway-test:crowd:${index}`);
    for (const uri of extra) {
      const urls = Array.from({ length: 10 }, (_, port) => `opc.tcp://plant-pc:${50000 + port}`);
      lds.registeredServers.set(uri, {
        serverUri: uri,
        isOnline: true,
        serverInfo: { applicationUri: uri, applicationName: { text: uri }, applicationType: 0, discoveryUrls: urls },
      } as unknown as Parameters<typeof lds.registeredServers.set>[1]);
    }
    try {
      const identity = await identifyOpcuaServer("127.0.0.1", LDS_PORT, OPTIONS);

      expect(identity.registeredServers).toHaveLength(64);
      expect(identity.registeredServers.at(-1)?.discoveryUrls).toHaveLength(8);
    } finally {
      for (const uri of extra) lds.registeredServers.delete(uri);
    }
  });

  it("throws for a port that does not speak OPC UA", async () => {
    await expect(identifyOpcuaServer("127.0.0.1", plainTcpPort, { ...OPTIONS, timeoutMs: 2_000 })).rejects.toThrow();
  });

  it("gives up after its timeout on an address that never answers", async () => {
    const started = Date.now();
    await expect(identifyOpcuaServer("192.0.2.1", 4840, { ...OPTIONS, timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("text", () => {
  it("bounds what a device says at 256 characters and trims it", () => {
    expect(text(`  ${"x".repeat(300)}  `)).toBe("x".repeat(256));
    expect(text(" UMG 801 ")).toBe("UMG 801");
  });

  it("is null for nothing, blanks and non-strings", () => {
    expect(text("   ")).toBeNull();
    expect(text(undefined)).toBeNull();
    expect(text(42)).toBeNull();
  });
});

describe("createOpcuaIdentifier", () => {
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "ferrion-gateway-identify-pki-"));

  it("identifies in parallel from a cold start, with no client key yet", async () => {
    // Found live: in a fresh container the first client creates the private
    // key and the ones started alongside it fail - 7 of 8 candidates lost.
    const identify = createOpcuaIdentifier({ pkiFolder: path.join(fresh(), "pki") });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => identify("127.0.0.1", AF2_PORT, OPTIONS)));

    expect(results.map((result) => result.status)).toEqual(Array(6).fill("fulfilled"));
  });

  it("prepares again after a failed attempt", async () => {
    // A file where the folder should be: the first preparation fails.
    const blocker = path.join(fresh(), "blocked");
    fs.writeFileSync(blocker, "");
    const pkiFolder = path.join(blocker, "pki");
    const identify = createOpcuaIdentifier({ pkiFolder });

    // Still identifies, with node-opcua's default certificate.
    await expect(identify("127.0.0.1", AF2_PORT, OPTIONS)).resolves.toMatchObject({ applicationType: "Server" });

    fs.rmSync(blocker);
    await identify("127.0.0.1", AF2_PORT, OPTIONS);
    expect(fs.existsSync(path.join(pkiFolder, "own", "certs", "client_certificate.pem"))).toBe(true);
  });
});
