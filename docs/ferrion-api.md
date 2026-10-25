# The gateway API of ferrion

Everything the gateway exchanges with ferrion goes through four HTTP endpoints
under `/api/gateway/`. The gateway always initiates: it polls for commands and
data source assignments and pushes readings and command results. ferrion never
opens a connection to a gateway.

The typed client is `src/ferrion-client/gateway-api.ts` with the types in
`src/ferrion-client/types.ts`.

## Authentication

Every request carries the gateway's API key:

```http
Authorization: Bearer gw_…
```

The key is created in ferrion under **Settings → Gateways** and shown once;
ferrion stores only its hash. A key belongs to exactly one gateway, and that
gateway to one site. Requests without a valid key, or with a revoked one, get
`401`. Each authenticated request updates the gateway's "last seen" time, which
ferrion shows as its connection status.

## Poll for commands

```http
GET /api/gateway/commands?capabilities=TEST_CONNECTION,BROWSE_DATA_POINTS,DISCOVER_DEVICES&version=0.1.57&discoveryLimit=10.0.4.0/24
```

Every 3 s per instance. The query reports what the gateway is:

| Parameter | Meaning |
| --- | --- |
| `capabilities` | The command types this gateway can run. ferrion hands out only those; a gateway that sends none is treated as able to run the two original types. |
| `version` | The gateway's version, shown in ferrion's gateway list. |
| `discoveryLimit` | `FG_DISCOVERY_ALLOWED_CIDRS`, normalized. Left out when not set, which means the gateway does not search. |

ferrion stores these only when they change. Response:

```json
{
  "gatewayName": "Gateway Hall 2",
  "commands": [
    { "id": "cmd_…", "type": "TEST_CONNECTION", "payload": { "protocol": "OPC_UA", "connectionValues": { "host": "10.0.4.23", "port": "4840" }, "templateId": "janitza-umg801-opcua" } }
  ]
}
```

Every command returned is marked as picked up and given a deadline: 60 s for a
connection test or a browse, the search budget plus 30 s for a device search.
A command nobody picks up within two minutes, or that gets no result before its
deadline, ends as failed (`not picked up` or `timeout`), so ferrion's wizard
never waits for good.

### Command payloads

`TEST_CONNECTION` and `BROWSE_DATA_POINTS`:

```json
{ "protocol": "OPC_UA" | "MODBUS_TCP" | "MQTT", "connectionValues": { "host": "…", "port": "…", "serialNumber": "…" }, "templateId": "aventics-af2-opcua" }
```

`connectionValues` are the raw values from the wizard's form, as strings.
`templateId` names the catalog template, if one was chosen.

`DISCOVER_DEVICES`:

```json
{
  "protocols": ["OPC_UA"],
  "opcua": { "hosts": ["10.0.4.23"], "sweep": { "cidrs": ["10.0.4.0/24"], "ports": [4840] } },
  "budgetMs": 22000,
  "knownEndpoints": ["10.0.4.23:4840"]
}
```

See [device-discovery.md](device-discovery.md) for its rules and result.

## Report a command's result

```http
POST /api/gateway/commands/{id}/result
Content-Type: application/json

{ "status": "COMPLETED", "result": { "ok": true, "softwareVersion": "1.6.2" } }
```

`status` is `COMPLETED` or `FAILED`; a failure carries `{ "error": "…" }`, which
ferrion shows as it is. Answers:

| Status | When |
| --- | --- |
| `200 {"ok": true}` | Recorded |
| `400` | Body is not JSON (e.g. truncated by a dropped connection) |
| `404` | No such command, or it belongs to another gateway |
| `409` | The command is not waiting for a result: never handed out, already answered, or past its deadline |
| `413` | Result larger than 1 MB |

The gateway retries a failed post with backoff. Every result is written to
ferrion's audit log.

## Fetch the data sources to read

```http
GET /api/gateway/data-sources
```

Every 15 s by the reading loop. Response:

```json
{
  "dataSources": [
    {
      "id": "ds_…",
      "assetId": "asset_…",
      "assetName": "Compressor 3",
      "protocol": "OPC_UA",
      "connectionConfig": { "host": "10.0.4.23", "port": 4840, "namespaceUri": "https://opc.janitza.de/umg801/public", "nodeIdentifier": 19500 },
      "metricKey": "activePowerSum",
      "label": "Active power",
      "unit": "W"
    }
  ]
}
```

Only data sources assigned to this gateway are returned, and none that are
being deleted. `connectionConfig` is already resolved (a serial number is
substituted into the namespace URI, numbers are numbers):

| Protocol | Fields |
| --- | --- |
| `OPC_UA` | `host`, `port`, `namespaceUri`, `namespaceUriFallbacks`, `nodeIdentifier`, optional `username`, `password` |
| `MODBUS_TCP` | `host`, `port`, `register`, `registerCount`, `byteOrder`, `format`, optional `resolutionRegister` |
| `MQTT` | `brokerUrl`, `port`, `topic`, `jsonField`, `jsonFieldFallbacks`, `qos`, optional `username`, `password` |

## Push readings

```http
POST /api/gateway/readings
Content-Type: application/json

{ "readings": [ { "dataSourceId": "ds_…", "timestamp": "2026-10-25T09:12:00.000Z", "value": 4123.5 } ] }
```

Response: `{ "accepted": 1 }`. ferrion keeps a reading only if its data source
belongs to this gateway and is not being deleted, its value is a finite number,
and its timestamp is an ISO 8601 string. Anything else is dropped one by one,
never the whole batch.

| Status | When | What the gateway does |
| --- | --- | --- |
| `413` | More than 25 000 readings or 4 MB in one push | Halves its batch size for the rest of the process |
| `429` | Too many pushes from this gateway | Waits for `Retry-After` |
| other errors, network failures | ferrion unreachable | Keeps the readings in its buffer and backs off, doubling up to a minute |

The gateway sends at most 5 000 readings per push and up to five pushes per
tick; see [resilience.md](resilience.md).

## Compatibility

The contract is versioned by behaviour, not by URL. Both sides tolerate the
other being older:

- A gateway that sends no `capabilities` gets only `TEST_CONNECTION` and
  `BROWSE_DATA_POINTS`.
- An older ferrion ignores query parameters it does not know.
- An older gateway answers a command type it does not know with
  `FAILED: unsupported command`.
