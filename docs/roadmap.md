# ferrion-gateway – Roadmap

**Die maßgebliche Roadmap liegt im (nicht öffentlichen) Repository der
ferrion-Plattform**, zusammen mit Spezifikationen, Ideen und Entscheidungen.
Es gibt eine Roadmap für das ganze Produkt, nicht eine je Repository.

Diese Datei listet nur die Schritte, die Arbeit in diesem Repo bedeuten. Status
und Abhängigkeiten stehen ausschließlich in der Roadmap im `ferrion`-Repo.

| ID | Schritt | Anteil im Gateway |
| --- | --- | --- |
| R01 | Signierter Release-Workflow | Abbild in der CI bauen, signieren, in die Registry legen |
| R07 | Geräte-Discovery OPC UA | Befehl `DISCOVER_DEVICES` neben der Befehlsschleife, Subnetz-Sweep, `FindServers` (LDS), `GetEndpoints`, Identität (BuildInfo, NamespaceArray) ohne zweite Sitzung an laufenden Datenquellen; Obergrenze `FG_DISCOVERY_ALLOWED_CIDRS` (Entscheidung 8); kein mDNS (Entscheidung 2); Module unter `src/discovery/` |
| R10 | Lastszenario mit 15 Gateways | Fleet-Konfiguration, Lastlauf zusammen mit der Plattform |
| R22 | Discovery Modbus TCP und MQTT, Signal-Zuordnung, Zusatzmodule für Companion Specs, Konnektor-Konfiguration aus AID/AIMC und Server Datasheet | `src/discovery/tcp-probe.ts` und `scan-request.ts` (aus R07) mitbenutzen, FC 43/14, MQTT-Lauschen; Leser je Spec über TypeDefinition statt fester NodeIds (zuerst DI und Machinery) |
| R34 | Betrieb beim Kunden | Update mit Rückweg, Zustandsmeldung für die Überwachung mehrerer Installationen |
| R27 | Onboarding Dauerbetrieb | Hintergrund-Erkennung, neue Geräte selbst melden |

Das ausführliche Discovery-Konzept liegt im `ferrion`-Repo unter
`docs/roadmap/details/gateway-device-discovery.md`, der Grundsatz zur breiten
Geräteanbindung unter `docs/roadmap/details/device-integration.md`.
