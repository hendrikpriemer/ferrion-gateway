# Gateway aktualisieren und ausrollen

Diese Datei beschreibt, wie das Gateway auf einer Ziel-VM installiert und
aktualisiert wird. Sie ist nicht an eine bestimmte Version gebunden — der
Ablauf gilt für jedes Update.

Wer nur wissen will, was eine einzelne Aktualisierung inhaltlich ändert,
liest die Notizen des GitHub-Releases; hier steht das Verfahren.

## Der wichtigste Satz vorweg

**`git pull` allein aktualisiert nichts.** Das Gateway läuft als Container
aus einem Abbild. Der Pull bringt nur Skripte und Doku; das neue Abbild kommt
erst mit `scripts/vm-release-pull.sh` (signiertes Release, Abschnitt 1) bzw.
`--build` (Rückweg ohne Registry) und dem anschließenden `up -d`. Ohne diesen
Schritt läuft nach dem Pull weiterhin das alte Abbild, ohne jede
Fehlermeldung. Das ist die mit Abstand häufigste Fehlbedienung.

## Was ein Update anfasst und was nicht

| Bleibt erhalten | Wird ersetzt |
|---|---|
| `data/instances.json` (angelegte Instanzen) | Der komplette Anwendungscode |
| `data/settings.json` (ferrion-Verbindung, API-Schlüssel) | Das Basis-Image samt Node-Version |
| `data/reading-buffers/` (gepufferte Messwerte) | Alle Abhängigkeiten aus `package-lock.json` |

Die Daten liegen in einem benannten Docker-Volume, das an `/app/data` hängt.
In der Compose-Datei heißt es `ferrion-gateway-data`; auf dem Host trägt es
den Projektnamen davor, also je nach Verzeichnis etwa
`ferrion-gateway_ferrion-gateway-data`. Der Unterschied fällt erst auf, wenn
man es mit `docker volume ls` sucht.

Ein `docker compose up -d` ersetzt den Container, nicht das Volume.
Nur ein ausdrückliches `docker compose down -v` löscht die Daten — dieser
Schalter gehört in kein Update.

## 1. Vor dem Umschalten

### Datenstand sichern

```sh
docker compose cp ferrion-gateway:/app/data ~/gateway-backup-$(date +%Y%m%d-%H%M)
```

Kopiert Instanzen, Einstellungen und Puffer aus dem laufenden Container
heraus.

**Das Ziel liegt bewusst außerhalb des Repositorys.** In `settings.json`
steht der ferrion-API-Schlüssel im Klartext. Eine Sicherung im
Arbeitsverzeichnis würde bei einem beiläufigen `git add -A` in die
Historie eines Repositorys wandern, das auf GitHub liegt — unwiderruflich.
`/data-backup-*/` ist zusätzlich in `.gitignore` eingetragen, aber darauf
sollte sich niemand verlassen müssen.

### Neues Image ziehen und prüfen, ohne es scharf zu schalten

Seit R01 baut die VM das Gateway nicht mehr selbst. Ein Tag `vX.Y.Z` baut es in
der CI (`.github/workflows/release.yml`), signiert es schlüssellos über
Sigstore und legt es mit SBOM in die GitHub Container Registry. Releases
kommen gesammelt, etwa einmal im Monat.

**Einmalig:** `cosign` installieren
(<https://github.com/sigstore/cosign/releases>), bei `ghcr.io` mit einem Token
anmelden, das nur Pakete lesen darf (`read:packages`), und in der Compose-Datei
der VM beim Dienst `ferrion-gateway` statt `build: .` die Zeile
`image: ${GATEWAY_IMAGE:?GATEWAY_IMAGE not set - run scripts/vm-release-pull.sh <tag> first}`
eintragen.

```sh
git pull
scripts/vm-release-pull.sh v<Version>
```

Das zieht das Abbild, löst den Tag in den Digest auf, prüft Signatur und
SBOM-Attestation gegen die Identität des Release-Workflows und trägt erst
dann `GATEWAY_IMAGE=ghcr.io/hendrikpriemer/ferrion-gateway@sha256:…` in `.env`
ein (mit Sicherung `.env.bak-…`). Meldet es **SIGNATURE INVALID**, bleibt `.env`
unverändert: nicht umschalten, sondern melden. Der laufende Container bleibt
davon unberührt und liefert weiter Daten.

Ohne Registry, als Rückweg: `build: .` statt `image:` und `docker compose
build`; das kostet auf der VM Platz und Zeit.

**Beim ersten Wechsel von `build:` auf `image:`** gibt es noch keine
`.env.bak-…` mit einem `GATEWAY_IMAGE`, und das laufende, auf der VM gebaute
Abbild liegt nicht in der Registry. Vor dem Umschalten benennen:

```sh
docker tag "$(docker inspect --format '{{.Image}}' <container>)" ferrion-gateway-rollback:<alte Version>
```

(`<container>` aus `docker compose ps`). Der Rückweg ist dann
`GATEWAY_IMAGE=ferrion-gateway-rollback:<alte Version>` in `.env` und
`docker compose up -d`; ab dem zweiten Release reicht die Sicherung des
Skripts.

### Prüfen, ob der Datenstand die neue Version überlebt

```sh
docker compose run --rm ferrion-gateway node --import tsx scripts/check-data.ts /app/data
```

Das prüft mit dem **neuen** Image, denn `GATEWAY_IMAGE` zeigt schon darauf.
Beim Rückweg über `build:` gehört `--build` dazu, sonst prüft der Befehl
klaglos das **alte** Image.

Das ist der Grund, warum Ziehen und `up` hier getrennt sind. Beide Stores
sind beim Start absichtlich unnachgiebig:

- Eine `instances.json`, die nicht zum Schema passt, wird nach
  `instances.json.invalid-<Zeit>` verschoben. Die Oberfläche kommt dann nur
  noch mit einer frisch angelegten Bridge hoch: Echte Hardware läuft weiter,
  die simulierten Instanzen sind weg.
- Eine unvollständige `settings.json` gilt als „nie konfiguriert", und dann
  startet **keine einzige** Instanz, auch keine mit Autostart.

Der Container meldet in beiden Fällen `healthy`, denn die Control Plane
antwortet ja — sie hat nur nichts mehr zu tun.

Die Prüfung wendet dieselbe Entscheidungslogik an wie der Bootvorgang
(`judgeInstanceFile`/`judgeSettingsFile`), liest aber nur und verschiebt
nichts. Sie endet mit Exit-Code 1, wenn sie etwas findet, lässt sich also
auch in ein Deploy-Skript hängen.

Notiere dir die ausgegebenen Zahlen. Nach dem Update müssen es genau
dieselben sein.

Gibt es einen Befund, ist die Reihenfolge: erst die Ursache in der Datei
beheben (die Sicherung von oben ist die Vorlage), dann umschalten. Nicht
umgekehrt.

## 2. Umschalten

```sh
docker compose up -d
```

(Beim Rückweg über `build:`: `docker compose up -d --build`.)

Der alte Container bekommt bis zu 20 Sekunden zum Beenden
(`stop_grace_period`), weil die Control Plane ihre Instanzen gestaffelt
stoppt: erst trennen, nach 5 Sekunden `SIGTERM`, nach 8 Sekunden
`SIGKILL`, harte Obergrenze 10 Sekunden. Dockers Standardwert von 10
Sekunden würde mitten hinein abschneiden.

Instanzen mit Autostart laufen nach dem Start von selbst wieder an, die
Bridge-Instanz für echte Hardware immer. Vorausgesetzt, die ferrion-
Verbindung ist konfiguriert — siehe oben, warum das genau der Punkt ist,
den die Vorabprüfung abdeckt.

## 3. Nach dem Umschalten prüfen

```sh
# Läuft und ist gesund?
docker compose ps

# Was sagt der Start?
docker compose logs --tail 80 ferrion-gateway

# Antwortet die Control Plane, und kennt sie ihre ferrion-Verbindung?
curl -fsS http://127.0.0.1:4000/api/health
```

Vier Dinge müssen stimmen:

1. **`docker compose ps` zeigt `healthy`.** Der Healthcheck fragt
   `/api/health` ab, das 503 meldet, solange die Bridge-Instanz im Fehler
   steht. Ein bloßes „läuft" hätte nur bewiesen, dass ein HTTP-Port offen
   ist.
2. **`/api/health` meldet `"configured": true`.** Das ist die wichtigste
   Zeile dieser Liste, und sie muss **positiv** geprüft werden. Gilt die
   Verbindung als unkonfiguriert, startet keine einzige Instanz, und der
   Start schreibt dazu **nichts** ins Log: Der Zweig „Datei fehlt oder ist
   leer" loggt gar nicht, nur die Zweige „unlesbar" und „abgelehnt" tun es.
   Ein unkonfiguriertes Gateway meldet außerdem `healthy`. Wer also nur auf
   Fehlerzeilen achtet, bekommt für einen vollständig toten Deploy eine
   grüne Checkliste — etwa wenn das Update versehentlich im falschen
   Compose-Projekt lief und der Container ein frisches, leeres Volume
   bekommen hat.
3. **Die Instanzzahl stimmt mit der Vorabprüfung überein.** Weicht sie ab,
   suche im Log nach `[instance-store]` — dort steht dann, wohin die Datei
   verschoben wurde. Eine Ausnahme ist eingebaut: Enthielt der geprüfte
   Stand keine Bridge, legt der Start selbst eine an, und es ist danach
   genau eine mehr. Die Vorabprüfung sagt das dazu.
4. **Messwerte kommen in ferrion an.** Der Datenfluss ist das eigentliche
   Ziel; alles davor ist Vorbedingung. In der Plattform unter „Datenquellen"
   sichtbar, oder am Gateway über den Verbindungsstatus der Instanzen.

## 4. Zurückrollen

`GATEWAY_IMAGE` aus der Sicherung `.env.bak-…` zurückholen, die
`scripts/vm-release-pull.sh` beim Pinnen angelegt hat, dann:

```sh
docker compose up -d
```

Die Registry hält die letzten 5 Releases. Ohne Registry (Rückweg über
`build:`): `git checkout <vorheriger-commit>` und `docker compose up -d --build`.

Weil das Volume unangetastet bleibt, ist das Zurückrollen sauber: Der alte
Code trifft auf genau die Daten, mit denen er vorher lief. Die einzige
Ausnahme ist eine Datei, die die neue Version bereits umgeschrieben hat —
dafür gibt es die Sicherung aus Schritt 1.

## Mehrere Instanzen auf einer VM

Laufen auf derselben Maschine mehrere Gateways (etwa eines mit
`network_mode: host` und eines über Dockers Port-Veröffentlichung), ist
jedes ein eigenes Compose-Projekt in einem eigenen Verzeichnis mit einem
eigenen Volume. Der Ablauf oben gilt dann **je Instanz**, einschließlich
Sicherung und Vorabprüfung. Eine davon zu vergessen fällt nicht auf: die
andere läuft ja.

## Erreichbarkeit der Control Plane

Die Control Plane ist unauthentifiziert und bindet an Loopback (siehe
README, „Security model"). Sie wird deshalb entweder direkt auf der VM
bedient oder über einen SSH-Tunnel:

```sh
ssh -L 4000:127.0.0.1:4000 <vm>
```

Im Browser dann `http://localhost:4000`.

Seit dem Review 2026-09 lehnt die Control Plane Anfragen mit einem fremden
`Host`-Header mit **421 Misdirected Request** ab — das ist der Schutz gegen
DNS-Rebinding, der das Loopback-Vertrauensmodell überhaupt erst trägt.
Erlaubt sind `localhost`, `127.0.0.1` und `[::1]`. Über einen SSH-Tunnel
passt das von selbst.

Wer die Oberfläche mit `network_mode: host` unter dem eigenen Namen der
Maschine oder ihrer LAN-Adresse öffnet, bekommt sonst 421 und muss diese
Namen freigeben:

```sh
FG_ALLOWED_HOSTS=gateway.werk.local,10.0.0.5
```

Das ist eine bewusste Öffnung, keine Formalie: Sie erweitert die Menge der
Namen, unter denen eine unauthentifizierte API ansprechbar ist. Nur
eintragen, was wirklich gebraucht wird.

## Gerätesuche begrenzen

ferrion kann das Gateway bitten, im Netz nach OPC-UA-Geräten zu suchen (R07).
Wo es suchen darf, entscheidet **der Betreiber vor Ort**, nicht ferrion:

```sh
FG_DISCOVERY_ALLOWED_CIDRS=10.20.30.0/24
```

- IPv4-Netze oder einzelne Adressen, durch Komma getrennt. ferrion kann die
  Suche innerhalb davon nur einschränken, nie erweitern.
- **Nicht gesetzt heißt: keine Suche.** Das ist bewusst der Standard. In einem
  Firmennetz, das andere Standorte erreicht, soll ein Gateway nicht dorthin
  suchen, nur weil es dort hinkommt.
- Je Suche höchstens 1 024 Adressen, ein Netz höchstens /22, höchstens 32
  Verbindungsversuche je Sekunde, höchstens 4 OPC-UA-Abfragen gleichzeitig.
  Geräte, die schon als Datenquelle laufen, bekommen keine zweite Sitzung.
- Ein Sweep sieht für eine Angriffserkennung wie ein Portscan aus. Die IT
  vorher informieren.
- In der Prod-Compose-Datei der VM muss die Variable unter `environment:`
  stehen (wie hier in `docker-compose.yml`), sonst kommt sie im Container
  nicht an. Nach der Änderung `docker compose up -d`, nicht `restart`.
- Ob sie ankam: Das Log der Instanzen meldet beim Start „Device discovery
  allowed within limit“ mit den Netzen bzw. „Device discovery disabled“.
  Ungültige Einträge werden mit einer Warnung übergangen, nicht erweitert.

## Logformat

Im Container (`NODE_ENV=production`) schreibt das Gateway JSON-Zeilen, kein
eingefärbtes Terminalformat. `docker compose logs` liefert damit
maschinenlesbare Ausgaben; für die Ansicht am Stück hilft `jq`:

```sh
docker compose logs --no-log-prefix --tail 200 ferrion-gateway | jq -R 'fromjson? // .'
```

`--no-log-prefix` ist nicht optional: Ohne es stellt Compose jeder Zeile den
Containernamen voran, und `jq` bekommt dann kein gültiges JSON mehr.

Der Detailgrad kommt aus `FG_LOG_LEVEL` (`fatal` bis `trace`, Standard
`info`).

## Erstinstallation

Auf einer neuen Maschine entfallen Sicherung und Vorabprüfung, weil es noch
keine Daten gibt. Mit dem signierten Release (empfohlen; einmalige
Einrichtung wie in Abschnitt 1):

```sh
git clone https://github.com/hendrikpriemer/ferrion-gateway.git && cd ferrion-gateway
# Compose-Datei: beim Dienst ferrion-gateway `build: .` durch die `image:`-Zeile aus Abschnitt 1 ersetzen
scripts/vm-release-pull.sh v<Version>
docker compose up -d
ssh -L 4000:127.0.0.1:4000 <vm>   # von außen, falls nicht lokal bedient
```

Ohne Registry stattdessen `docker compose up -d --build` mit der
unveränderten Compose-Datei.

Danach im Browser unter `http://localhost:4000` die ferrion-Verbindung
eintragen (Basis-URL und API-Schlüssel aus der Plattform) und die Instanzen
anlegen. Erst danach gibt es einen Datenstand, den ein späteres Update
schützen muss.
