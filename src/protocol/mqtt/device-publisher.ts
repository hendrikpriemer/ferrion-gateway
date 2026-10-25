import { connect, type MqttClient } from "mqtt";

// The simulated device's own side of the connection - a plain publisher,
// exactly like a real AF2 unit (see device-catalog: "device is an MQTT
// publisher, not a broker the gateway connects to directly").
export class MqttDevicePublisher {
  private client: MqttClient | undefined;

  async connect(brokerUrl: string, port: number): Promise<void> {
    if (this.client) return;
    this.client = await new Promise<MqttClient>((resolve, reject) => {
      const client = connect(brokerUrl, { port });
      client.once("connect", () => resolve(client));
      client.once("error", (error) => reject(error));
    });
  }

  publish(topic: string, value: number): void {
    if (!this.client) {
      throw new Error("MqttDevicePublisher.connect() must be called before publish()");
    }
    this.client.publish(topic, String(value));
  }

  // Mirrors the real AF2's "ProcessData Single" format (see
  // gateway-client.ts's MqttConnectionConfig.jsonField doc comment): every
  // metric sharing one topic goes out as fields of a single JSON object,
  // not as separate publishes. `unknown` values (not just number) so this
  // can also stand in for the nested/mixed-type ITA_SDK payload variant
  // (see known-device-templates.ts's "aventics-af2-mqtt" jsonFieldFallbacks)
  // in tests - this is just JSON.stringify underneath, nothing here
  // actually requires flat numbers.
  publishJson(topic: string, payload: Record<string, unknown>): void {
    if (!this.client) {
      throw new Error("MqttDevicePublisher.connect() must be called before publishJson()");
    }
    this.client.publish(topic, JSON.stringify(payload));
  }

  disconnect(): void {
    if (this.client) {
      this.client.end(true);
      this.client = undefined;
    }
  }
}
