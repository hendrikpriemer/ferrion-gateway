import { createServer, type Server } from "node:net";
import { Aedes } from "aedes";

// One embedded broker per simulated MQTT instance (not fleet-shared, see
// the plan's risk notes) - the simulated AF2 device publishes into it, and
// the gateway-client subscribes to it exactly as it would to a real
// on-site broker.
export class MqttSimulatorBroker {
  private aedes: Aedes | undefined;
  private server: Server | undefined;

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    const aedes = await Aedes.createBroker();
    const server = createServer(aedes.handle);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.aedes = aedes;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const aedes = this.aedes;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = undefined;
    }
    if (aedes) {
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
      this.aedes = undefined;
    }
  }
}
