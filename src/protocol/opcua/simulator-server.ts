import { DataType, OPCUAServer, StatusCodes, Variant } from "node-opcua";
import type { StatusCode } from "node-opcua";
import type { AddressSpace, Namespace, UAVariable } from "node-opcua-address-space";

// AF2's own namespace URI embeds its serial number (see device-catalog's
// namespaceUriTemplate) - this simulator registers exactly one such
// namespace per instance and exposes each metric as a Double variable at
// its real, catalog-documented numeric Node ID, matching what a real AF2
// unit would expose.
export class OpcuaSimulatorServer {
  private server: OPCUAServer | undefined;
  private namespace: Namespace | undefined;
  private readonly variables = new Map<number, UAVariable>();

  // `softwareVersion` stands in for a device's firmware string
  // (BuildInfo.SoftwareVersion), e.g. a Janitza UMG 801 on 1.5.2.
  async start(port: number, namespaceUri: string, host = "127.0.0.1", options: { softwareVersion?: string } = {}): Promise<void> {
    const server = new OPCUAServer({
      port,
      host,
      ...(options.softwareVersion ? { buildInfo: { softwareVersion: options.softwareVersion } } : {}),
    });
    await server.initialize();

    const addressSpace: AddressSpace | null = server.engine.addressSpace;
    if (!addressSpace) {
      throw new Error("OPC UA server initialized without an address space");
    }
    this.namespace = addressSpace.registerNamespace(namespaceUri);

    await server.start();
    this.server = server;
  }

  addVariable(nodeIdentifier: number, browseName: string, initialValue: number): void {
    if (!this.namespace || !this.server) {
      throw new Error("OpcuaSimulatorServer.start() must be called before addVariable()");
    }
    const addressSpace = this.server.engine.addressSpace as AddressSpace;
    const variable = this.namespace.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      browseName,
      // A bare number here resolves against namespace 0, not this
      // namespace's own index - must be spelled out explicitly.
      nodeId: `ns=${this.namespace.index};i=${nodeIdentifier}`,
      dataType: DataType.Double,
    });
    variable.setValueFromSource(new Variant({ dataType: DataType.Double, value: initialValue }));
    this.variables.set(nodeIdentifier, variable);
  }

  setValue(nodeIdentifier: number, value: number): void {
    this.variable(nodeIdentifier).setValueFromSource(new Variant({ dataType: DataType.Double, value }));
  }

  // The two shapes in which a real device says "no good value for this
  // node right now" - both seen on a Janitza UMG 801 in production
  // (2026-10-10/11): a Good notification carrying null, and a bad status
  // code. The gateway client must treat either as the end of the last
  // value, not as "unchanged".
  setNull(nodeIdentifier: number): void {
    this.variable(nodeIdentifier).setValueFromSource(new Variant({ dataType: DataType.Null, value: null }));
  }

  // `value` only exists so a test can provoke a SECOND notification with the
  // same bad status: the default StatusValue filter notifies on a value or
  // status change, and a repeated identical bad sample would stay silent.
  setBadStatus(nodeIdentifier: number, statusCode: StatusCode = StatusCodes.BadSensorFailure, value = 0): void {
    this.variable(nodeIdentifier).setValueFromSource(new Variant({ dataType: DataType.Double, value }), statusCode);
  }

  private variable(nodeIdentifier: number): UAVariable {
    const variable = this.variables.get(nodeIdentifier);
    if (!variable) {
      throw new Error(`No simulated variable registered for Node ID ${nodeIdentifier}`);
    }
    return variable;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.shutdown();
    this.server = undefined;
    this.namespace = undefined;
    this.variables.clear();
  }
}
