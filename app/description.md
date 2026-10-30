# ferrion Gateway

The on-site edge component of **ferrion**, an industrial asset platform. The
gateway sits in the plant network, reads field devices over **OPC UA**,
**Modbus TCP** and **MQTT**, and reports their measurements to a ferrion
installation. It can also search the plant network for OPC UA devices on
request.

- **Outbound only.** The gateway polls ferrion over HTTPS with a per-gateway
  API key; ferrion never connects to the gateway, so no inbound port is
  opened.
- **Configured in ferrion.** Which devices to read, and how, is set up in
  ferrion when a data source is added; the gateway picks its assignments up
  by itself, reads, aggregates and pushes the values, and buffers them
  through a ferrion outage.
- **Read only.** The gateway reads devices; it never writes values or calls
  methods, and the device search opens no session at a device already in use.
- **Simulated devices** (AVENTICS AF2 and DS1, Janitza UMG 801, Keyence FD-G)
  with real protocol servers, for commissioning and demos without hardware.

Setting up: open the local web UI, enter the ferrion base URL and the API key
created under *Settings → Gateways*, then add data sources in ferrion and pick
this gateway. The device search is limited by the *Device search limit*
setting; empty means no search.

Source, documentation and security policy:
<https://github.com/hendrikpriemer/ferrion-gateway>. Licensed under the
Apache License 2.0. The ferrion platform itself is a separate, commercial
product.
