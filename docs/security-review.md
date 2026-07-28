# Security- & Best-Practice-Review

Vollständiges Review des Repos (Stand `2c760bd`).
Betrachtet: Docker-Setup, CI/CD-Pipeline, Deploy-/Backup-/Validate-Skripte,
Workflow-Definition, Business-Logik in `lib/`, Doku.

> Das Review entstand gegen `68fe52c`; alle Befunde wurden anschließend gegen
> `2c760bd` nachgeprüft. Sämtliche auditierten **Code**-Dateien
> (`docker-compose.yml`, beide GitHub-Workflows, `scripts/*`, `lib/*`,
> `workflows/*`, `.env.example`, `.gitignore`, `tsconfig.json`) sind zwischen
> beiden Ständen **byte-identisch** — alle Code-Befunde gelten unverändert.
> Neu hinzugekommen sind `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `blueprint/` und
> `.claude/skills/` (auf Secrets geprüft, unauffällig) sowie überarbeitete
> Fassungen von `README.md`, `docs/ci-cd.md` und `docs/manual-setup.md` —
> letztere haben mehrere Doku-Befunde bereits erledigt (siehe N7).

**Gesamtbild:** Die Architektur ist sauber — Repo als Single Source of Truth,
einseitiger Deploy, Secrets nie im Repo (per `git log --all` verifiziert: nur
Variablen-Referenzen, nie ein echter Wert), n8n nur auf Loopback published,
Idempotenz über `contactId` sauber gelöst und unit-getestet (11/11 grün).
Die Probleme liegen fast alle in der **Kette Runner → VPS** und in der
**Härtung des n8n-Containers**, nicht in der Fachlogik.

Keine akut ausgenutzte Lücke gefunden. Drei Punkte sollten aber vor dem
nächsten Deploy adressiert werden (H1–H3).

> **Stand heute:** H1–H3 sind behoben und live; ebenso M4, N2 und N3, sowie
> M1 und M5 teilweise. Details stehen als Status-Block beim jeweiligen Befund.
> Offen sind **M2** (`/api/v1` am Proxy sperren), **M3** (2FA bzw. eine
> vorgelagerte Authentifizierung), **M6**, N1, N4–N7 und I1–I8 — plus der
> Benachrichtigungs-Teil von M5. Die empfohlene Reihenfolge steht am Ende.
>
> M2 und M3 sind die beiden verbliebenen Punkte mit echtem Sicherheitswert, und
> beide liegen **außerhalb dieses Repos** (Reverse-Proxy-Konfiguration bzw.
> n8n-Account). Eine Basic-Auth vor dem gesamten Vhost erschlägt beide auf
> einmal.

---

## Befundübersicht

| # | Schwere | Bereich | Befund |
|---|---------|---------|--------|
| H1 | ~~Hoch~~ **behoben** | Container | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` gibt Code-Nodes Zugriff auf das gesamte Prozess-Env inkl. `N8N_ENCRYPTION_KEY` |
| H2 | ~~Hoch~~ **behoben** | Supply Chain | Kein `package-lock.json`; `npm install` mit Lifecycle-Scripts im Job, der *alle* Prod-Secrets hält |
| H3 | ~~Hoch~~ **behoben** | CI/CD | `ssh-keyscan` ohne Host-Key-Pinning — MITM bekommt `.env` (Encryption Key + API Key) frei Haus |
| M1 | ~~Mittel~~ **teilweise** | CI/CD | Kein `permissions:`-Block, Actions auf mutable Tags gepinnt |
| M2 | Mittel | Exposure | n8n Public API (`/api/v1`) und `/rest` sind öffentlich erreichbar, obwohl nichts sie braucht |
| M3 | Mittel | Betrieb | Owner-Claim-Fenster: Instanz ist online, bevor der Admin-Account existiert |
| M4 | ~~Mittel~~ **behoben** | Workflow | Latenter Fan-out-Bug: `List Contacts` läuft einmal *pro Item* von `List Managed Events` |
| M5 | ~~Mittel~~ **teilweise** | Workflow | Keine Fehlerbehandlung/Retry an den HTTP-Nodes, kein Error-Workflow |
| M6 | Mittel | Datenschutz | Execution-Daten speichern 14 Tage lang alle Kontaktnamen + Geburtsdaten |
| N1 | Niedrig | CI/CD | `.env` auf dem VPS hat ein Permission-Fenster; Secrets landen in Runner-Tempfile |
| N2 | ~~Niedrig~~ **behoben** | Logik | 29.02. mit *bekanntem* Nicht-Schaltjahr erzeugt ungültiges Datum → API-400 |
| N3 | ~~Niedrig~~ **behoben** | Tooling | `validate.ts` meldet `await` als Syntaxfehler, obwohl n8n es erlaubt |
| N4 | Niedrig | Container | Keine Container-Härtung: kein `no-new-privileges`, keine Log-Rotation, kein Digest-Pinning |
| N5 | Niedrig | CI/CD | tar-Deploy löscht entfernte Dateien nie → Drift auf dem VPS |
| N6 | Niedrig | CI/CD | Deploy-Gate ist schwächer als das PR-Gate (`npm test` fehlt); SSH-Tunnel-Cleanup fragil |
| N7 | Niedrig | Doku | `README.md` beschreibt das Secret-Modell falsch; echte `CALENDAR_ID` in `.env.example` |
| I1–I5 | Info | diverse | Kein Volume-Backup, kein `tsc`/Lint in CI, kein Dependabot, TZ-Mix, Command-Injection-Muster |

---

## Hoch

### H1 — Code-Nodes können den Encryption Key lesen

> **Status: behoben.** Der Workflow liest kein `$env` mehr — weder im Code-Node
> noch im URL-Ausdruck von *List Managed Events*. `CALENDAR_ID` und
> `SHOW_BIRTH_YEAR` werden zur Deploy-Zeit von `scripts/deploy.ts` in eine
> `CONFIG:START`/`CONFIG:END`-Region eingesetzt (gleiche Mechanik wie die
> bestehende Lib-Injection), die Kalender-ID zusätzlich URL-encodiert in die
> Request-URL. Damit steht der Container jetzt auf
> `N8N_BLOCK_ENV_ACCESS_IN_NODE: "true"` **und**
> `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES: "true"`; die drei Workflow-Variablen
> wurden aus dem Container-Env entfernt. Ein fehlendes `CALENDAR_ID` bricht den
> Deploy jetzt ab, statt einen Workflow auszuliefern, der um 6 Uhr wirft.
>
> Gegen Rückfall abgesichert: `npm run validate` lehnt jeden Node ab, der `$env`
> erwähnt (Textprüfung über `node.parameters`), und
> `blueprint/context/coding-standards.md` schreibt die neue Konvention fest.
>
> Verifiziert über den echten Code-Pfad: gebauter Workflow enthält 0×&nbsp;`$env`,
> `const CALENDAR_ID = "test+id@group.calendar.google.com"` korrekt als
> JS-String-Literal, URL als `…/calendars/test%2Bid%40group.calendar.google.com/events`;
> leeres `SHOW_BIRTH_YEAR` fällt auf `true` zurück (wie vorher im Container),
> fehlendes `CALENDAR_ID` → Exit 1. `npm run validate` ✓, `npm test` 11/11 ✓.
>
> Offen bleibt die unten genannte Gegenprobe an der Live-Instanz — sie ist jetzt
> aber nur noch Bestätigung, nicht mehr Voraussetzung.

`docker-compose.yml:51` setzt `N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"`, und
`docker-compose.yml:36` legt `N8N_ENCRYPTION_KEY` in dasselbe Prozess-Env.
Damit steht der Key im selben Namensraum, aus dem `$env.CALENDAR_ID` gelesen
wird (`workflow.json`, Node *Plan Operations*).

Konsequenz: Wer einen Workflow anlegen oder ändern kann — also jeder Account in
der n8n-UI, oder jeder, der über M2/M3 hineinkommt — kann mit einer Zeile
(`return [{json:{k: $env.N8N_ENCRYPTION_KEY}}]`) den Key exfiltrieren. Zusammen
mit dem SQLite-Volume entschlüsselt das **das Google-OAuth-Refresh-Token**, also
Vollzugriff auf Contacts und Calendar des Google-Kontos. Das ist der einzige
Befund, der die Vertraulichkeit der eigentlichen Kronjuwelen berührt.

> Ob der Task-Runner (`N8N_RUNNERS_ENABLED=true`) das komplette Env
> weiterreicht, hängt an der n8n-Version — bitte einmal mit genau dem
> Einzeiler oben gegenprüfen. Unabhängig vom Ergebnis ist die Konfiguration
> unnötig permissiv.

**Fix (empfohlen, passt zum bestehenden Design):** Der einzige Grund für den
Env-Zugriff sind zwei *nicht geheime* Werte, `CALENDAR_ID` und
`SHOW_BIRTH_YEAR`. `scripts/deploy.ts` injiziert ohnehin schon Schedule und
Credential-ID zur Deploy-Zeit (`buildWorkflow`, Zeile 77–106). Dieselbe Stelle
kann beide Werte in den Code-Node-Text einsetzen — danach:

```yaml
N8N_BLOCK_ENV_ACCESS_IN_NODE: "true"
N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES: "true"   # schützt zusätzlich ~/.n8n/config
```

Alternative ohne Code-Änderung: n8n *Variables* statt `$env` verwenden.

### H2 — Kein Lockfile, `npm install` im Secret-Job

> **Status: behoben.** `package-lock.json` ist committet, beide Workflows nutzen
> `npm ci --ignore-scripts`, und der Install im `deploy`-Job wurde vor die
> SSH-Konfiguration gezogen — er läuft jetzt ohne step-scoped Secrets und ohne
> offenen Tunnel. Dass `--ignore-scripts` `tsx` nicht bricht, wurde geprüft
> (esbuild bezieht seine Plattform-Binary über `optionalDependencies`):
> `npm ci --ignore-scripts` → `npm run validate` ✓, `npm test` 11/11 ✓.

Es gibt kein `package-lock.json` (verifiziert). `deploy.yml:54` und
`deploy.yml:145` sowie `validate.yml:24` rufen `npm install --no-audit`.

Damit werden `tsx@^4.19.2`, `@types/node@^22.10.0` und deren komplette
transitive Kette bei **jedem Lauf neu aufgelöst** — ohne Integritätsprüfung,
ohne Reproduzierbarkeit, mit aktivierten `preinstall`/`postinstall`-Scripts.
Der `npm install` in Zeile 145 läuft im `deploy`-Job, d. h. zu einem Zeitpunkt,
an dem `VPS_SSH_KEY`, `N8N_ENCRYPTION_KEY` und `N8N_API_KEY` im Env stehen
**und** der SSH-Tunnel zum VPS bereits offen ist. Ein kompromittiertes Paket
irgendwo in der Kette bekommt alles davon in einem Schritt.

`--no-audit` unterdrückt zusätzlich das einzige eingebaute Warnsignal.

**Fix:**
1. `npm install` lokal ausführen, `package-lock.json` committen.
2. In beiden Workflows `npm ci --ignore-scripts` statt `npm install --no-audit`.
3. `actions/setup-node@v4` mit `cache: npm` nutzen (geht erst mit Lockfile).
4. Idealerweise Dependencies im `validate`-Job installieren und als Artefakt in
   den `deploy`-Job reichen, damit im Secret-Job überhaupt kein npm mehr läuft.

### H3 — Kein Host-Key-Pinning für die Deploy-Verbindung

> **Status: behoben.** Der Host-Key wird aus dem neuen Secret
> `VPS_SSH_HOST_KEY` in `~/.ssh/known_hosts` gepinnt, dazu global
> `StrictHostKeyChecking yes`. Fehlt das Secret, bricht der Job mit einer
> erklärenden Meldung ab, statt einen ungeprüften Key zu akzeptieren.
> **Aktion nötig:** Das Secret muss vor dem nächsten Deploy angelegt werden
> (`ssh-keyscan -p <port> <host>`), sonst schlägt die Pipeline fehl.

```yaml
# .github/workflows/deploy.yml:80
ssh-keyscan -p "$VPS_PORT" "$VPS_HOST" >> ~/.ssh/known_hosts 2>/dev/null
```

Das ist Trust-on-First-Use bei *jedem* Lauf — der Runner akzeptiert blind den
Host-Key, den er in diesem Moment bekommt. Wer die Verbindung Runner → VPS
umlenken kann (BGP/DNS, IP-Recycling beim Hoster, kompromittierter
Zwischenhop), bekommt:

- die frisch gerenderte `.env` per `scp` (Zeile 119) — **Encryption Key +
  n8n API Key im Klartext**,
- Shell-Ausführung als Deploy-User (Zeile 126), der laut
  `docs/manual-setup.md:94` in der `docker`-Gruppe ist — also faktisch root auf
  dem VPS.

`2>/dev/null` verschluckt zusätzlich stille Fehler von `ssh-keyscan`.
`docs/ci-cd.md:63` benennt das Problem bereits korrekt, der Code setzt die
Empfehlung aber nicht um.

**Fix:** Host-Key einmalig erfassen und als Secret pinnen:

```bash
ssh-keyscan -p 22 <vps-host>      # Ausgabe als Secret VPS_SSH_HOST_KEY ablegen
```

```yaml
- name: Configure SSH
  env:
    VPS_SSH_KEY:      ${{ secrets.VPS_SSH_KEY }}
    VPS_SSH_HOST_KEY: ${{ secrets.VPS_SSH_HOST_KEY }}
  run: |
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    printf '%s\n' "$VPS_SSH_KEY"      > ~/.ssh/id_deploy && chmod 600 ~/.ssh/id_deploy
    printf '%s\n' "$VPS_SSH_HOST_KEY" > ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts
    printf 'Host *\n  StrictHostKeyChecking yes\n' >> ~/.ssh/config
```

---

## Mittel

### M1 — Workflow-Permissions und Action-Pinning

> **Status: teilweise behoben.** Beide Workflows haben jetzt
> `permissions: contents: read` auf Datei-Ebene sowie `timeout-minutes`
> (10 für die Validate-Jobs, 15 für den Deploy — ein hängender SSH-Call
> blockierte sonst die `deploy-vps`-Concurrency-Gruppe bis zum 6-h-Default).
> **Bewusst nicht gemacht:** SHA-Pinning der Actions — bei First-Party-Actions
> von GitHub steht der Nutzen in keinem Verhältnis zum Wartungsaufwand ohne
> Dependabot. *Required reviewers* auf dem `production`-Environment bleibt
> ebenfalls offen; das ist eine Repo-Einstellung, keine Code-Änderung.

Beide Workflows haben keinen `permissions:`-Block; es gilt die
Repo-Default-Berechtigung des `GITHUB_TOKEN` (je nach Einstellung
read **oder write**). Für Jobs, die nichts ins Repo schreiben, gehört an den
Anfang jeder Datei:

```yaml
permissions:
  contents: read
```

`actions/checkout@v4` und `actions/setup-node@v4` (`deploy.yml:50,51,67,69`,
`validate.yml:17,19`) hängen an verschiebbaren Tags. Für einen Job mit
Produktions-Secrets ist Commit-SHA-Pinning angebracht:
`actions/checkout@<40-hex-sha> # v4.2.2`.

Ergänzend: `environment: production` sollte in den Repo-Settings *Required
reviewers* bekommen, sonst deployt jeder Push auf `main` ungeprüft
(`docs/ci-cd.md:65` empfiehlt das bereits — bitte prüfen, ob es auch
konfiguriert ist); und `timeout-minutes: 15` verhindert, dass ein hängender
SSH-Call stundenlang Runner-Zeit verbrennt.

### M2 — Public API und `/rest` sind öffentlich erreichbar

`docker-compose.yml:39` aktiviert die Public API, und der Reverse Proxy routet
`${DOMAIN}` komplett auf `n8n:5678` (`docs/manual-setup.md:83`). Damit hängen
`/api/v1/*`, `/rest/*` und die Login-Route im offenen Internet.

Nötig ist das nicht mehr: `deploy.ts` läuft seit `68fe52c` über den
SSH-Tunnel gegen `127.0.0.1:5678`, und `backup.ts` nutzt dieselbe Loopback-URL.
Die öffentliche API ist reine Angriffsfläche (Key-Brute-Force, künftige
Auth-Bypass-CVEs) ohne Nutzen.

**Fix:** Am nginx-Proxy `/api/v1` sperren (bzw. auf eine IP-Allowlist
beschränken) und Rate-Limiting auf `/rest/login` legen. Die Editor-UI bleibt
davon unberührt.

### M3 — Owner-Claim-Fenster beim Erstdeploy

Der erste Deploy bringt die Instanz öffentlich hoch
(`docs/ci-cd.md:41` — „first-run bootstrap"), und erst danach legt man laut
`docs/manual-setup.md:178` im Browser den n8n-Owner an. Zwischen beiden
Schritten ist die Setup-Seite offen: Wer sie zuerst aufruft, wird Admin der
Instanz. (Seit H1 behoben ist, bekommt er damit nicht mehr auch noch den
Encryption Key — aber Admin der Instanz zu sein reicht bereits.)

**Fix:** In der Doku als **zeitkritisch** markieren (Owner unmittelbar nach dem
ersten grünen Deploy anlegen), oder den Vhost bis zum Claim mit HTTP-Basic-Auth
am Proxy schützen. Danach unbedingt 2FA im n8n-Account aktivieren.

### M4 — Fan-out: `List Contacts` läuft einmal pro Event-Page

> **Status: behoben, doppelt abgesichert.** *List Contacts* hat
> `"executeOnce": true` — der Fan-out kann nicht mehr entstehen. Zusätzlich
> dedupliziert `normalizeContacts` jetzt über `resourceName`, weil derselbe
> Kontakt auch ohne Fan-out doppelt in der People-API stehen kann und der
> Idempotenz-Check nur gegen den *Kalender* läuft, nicht gegen die Kontaktliste.
> Der zweite Teil ist der eigentlich wertvolle: er ist unit-getestet und hängt
> nicht an der Node-Verdrahtung.

In n8n führt ein HTTP-Request-Node **einmal pro Eingangs-Item** aus. Mit
aktivierter Pagination gibt `List Managed Events`
(`workflows/birthday-sync/workflow.json:38–99`) **ein Item pro Seite** aus.
Sobald das mehr als eine Seite ist, läuft `List Contacts` mehrfach, liefert die
Kontaktseiten n-fach, `normalizeContacts` erzeugt jeden Kontakt n-fach — und
`indexExistingEvents` kann beim Erstlauf nichts dedupen, weil der Kalender noch
leer ist. Ergebnis: **n Duplikate pro Kontakt**, die anschließend dauerhaft als
verwaiste Events liegen bleiben (es gibt keinen Delete-Pfad).

Aktuell latent, weil `maxResults=2500` bei realistischen Kontaktzahlen genau
eine Seite ergibt. Es ist aber exakt der Fall, den
`workflows/birthday-sync/README.md:108` als „handled" ausweist.

**Fix (einzeilig):** Am Node *List Contacts* `"executeOnce": true` setzen.
Sauberer: beide List-Nodes direkt am Trigger parallel hängen, statt sie zu
verketten.

### M5 — Keine Fehlerbehandlung an den HTTP-Nodes

> **Status: teilweise behoben — Retries ja, Benachrichtigung nein.** Alle vier
> HTTP-Nodes haben jetzt `retryOnFail` mit `maxTries: 3` und
> `waitBetweenTries: 5000`. Damit überlebt der Lauf ein einzelnes 429/5xx.
>
> **Bewusst *nicht* umgesetzt: `onError: "continueRegularOutput"`.** Der Fix
> oben empfiehlt es, aber ohne Error-Workflow macht es die Sache schlechter:
> Der Lauf würde grün durchlaufen, während einzelne Events fehlen. So wie es
> jetzt ist, bricht ein Fehler nach 3 Versuchen ab, die Execution steht rot in
> der Liste, und weil der Workflow idempotent ist, holt der nächste Tageslauf
> das Fehlende automatisch nach. Bei den beiden List-Nodes wäre Weiterlaufen
> ohnehin gefährlich — unvollständige Event-Liste heißt Duplikate.
>
> **Weiterhin offen: die Benachrichtigung.** Ein Error-Workflow braucht einen
> Kanal (Mail/Telegram/…), und der ist eine Entscheidung, keine Code-Änderung.
> Bis dahin gilt: rote Executions sieht man nur in der n8n-UI.

Keiner der vier HTTP-Nodes setzt `retryOnFail`, `onError` oder
`alwaysOutputData`. Ein einzelnes 429/403/5xx von Google (Rate-Limit,
abgelaufener Consent, Quota) bricht den gesamten Lauf ab — mitten in der
Create-Schleife, mit teilweise angelegten Events. Es gibt keinen
Error-Workflow, also auch **keine Benachrichtigung**: Ein täglicher Sync kann
monatelang stillschweigend rot laufen.

**Fix:** An *Create Event* / *Update Event*:
`"retryOnFail": true, "maxTries": 3, "waitBetweenTries": 2000` und
`"onError": "continueRegularOutput"`, damit ein einzelner Kontakt nicht den
ganzen Lauf killt. Zusätzlich `settings.errorWorkflow` auf einen kleinen
Notify-Workflow setzen.

### M6 — 14 Tage PII in den Execution-Daten

`docker-compose.yml:47–48` pruned Executions nach 336 h. Bis dahin liegt in der
SQLite-DB der **vollständige I/O jedes Nodes** — also Name und Geburtsdatum
sämtlicher Google-Kontakte, in Klartext, unverschlüsselt (der
`N8N_ENCRYPTION_KEY` schützt nur Credentials, nicht Execution-Daten). Bei einem
täglichen Lauf sind das 14 vollständige Kopien des Adressbuchs. Für
personenbezogene Daten Dritter ist das mehr Aufbewahrung als der Zweck
erfordert.

**Fix:**

```yaml
EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none"   # Erfolgsläufe brauchen keine Payload
EXECUTIONS_DATA_SAVE_ON_ERROR: "all"      # Fehler weiterhin analysierbar
EXECUTIONS_DATA_MAX_AGE: "72"             # 3 Tage reichen zur Fehlersuche
```

Senkt gleichzeitig das Datenbankwachstum auf dem VPS deutlich.

---

## Niedrig

### N1 — Permission-Fenster der `.env` auf dem VPS

`deploy.yml:119–120` kopiert die `.env` per `scp` und setzt `chmod 600` erst im
**nächsten** SSH-Roundtrip. Dazwischen liegt die Datei mit der Umask-Default
(meist `644`) auf der Platte — auf einem Multi-User-VPS für jeden lesbar.

```bash
# statt scp + chmod:
ssh -i ~/.ssh/id_deploy -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" \
    "install -m 600 /dev/stdin '$VPS_APP_DIR/.env'" < "$tmp"
```

Nebenbei: `mktemp` legt die Datei zwar mit `600` an, aber wenn der `scp`-Schritt
fehlschlägt, bricht der Job vor `rm -f` ab und das Tempfile mit Encryption Key
bleibt liegen (auf ephemeren Runnern unkritisch, auf self-hosted nicht).

### N2 — 29.02. mit bekanntem Nicht-Schaltjahr erzeugt ungültiges Datum

> **Status: behoben.** Der Anker wird jetzt auf ein Schaltjahr korrigiert,
> sobald das Zieljahr keins ist — unabhängig davon, ob das Geburtsjahr bekannt
> ist. Das Alter im Titel kommt weiterhin aus dem *echten* Geburtsjahr, nicht
> aus dem Anker. Zusätzlich prüft `normalizeContacts` jetzt `month`/`day` auf
> Plausibilität (`isValidMonthDay`) und überspringt unmögliche Daten wie
> `{month: 13}`, `{month: 4, day: 31}` oder `{month: 2, day: 30}`, statt dem
> Kalender ein ungültiges `start.date` zu schicken. Drei neue Testfälle.

`lib/calendar-upsert.js:138–139` fängt den Schalttag nur ab, wenn **kein**
Geburtsjahr bekannt ist. Verifiziert:

```
Input : {day: 29, month: 2, year: 1991}
Output: start "1991-02-29"  end "1991-03-02"     → Google Calendar API: 400
```

Der 29.02. existiert 1991 nicht; zusätzlich springt das Enddatum über einen Tag.
Zusammen mit M5 reißt ein solcher Kontakt den kompletten Tageslauf mit.

Allgemeiner: `normalizeContacts` (`lib/calendar-upsert.js:50–83`) übernimmt
`month`/`day` **ungeprüft** aus der People-API. `{month: 13, day: 5}` erzeugt
klaglos `"1990-13-05"`. Eine Bereichsprüfung (1–12 / 1–31) plus
Schaltjahr-Normalisierung — Kontakt sonst überspringen statt den Lauf zu
sprengen — gehört in `normalizeContacts`, mitsamt zwei Testfällen.

### N3 — `validate.ts` meldet `await` fälschlich als Syntaxfehler

> **Status: behoben.** Der Syntax-Check kompiliert Code-Node-Bodies jetzt als
> **async** Function (`Object.getPrototypeOf(async function () {}).constructor`).
> Gegengeprüft: `await Promise.resolve(1)` auf oberster Ebene wird akzeptiert,
> während die alte `new Function`-Variante genau daran scheiterte.

```ts
// scripts/validate.ts:152
new Function('$env', '$input', '$', '$json', 'items', codeToCheck);
```

n8n führt Code-Nodes in einem async-Kontext aus, `await` auf oberster Ebene ist
dort erlaubt. `new Function` erzeugt eine **synchrone** Funktion — verifiziert:

```
await is only valid in async functions and the top level bodies of modules
```

Der erste Code-Node mit `await` (z. B. `await this.helpers.httpRequest(...)`)
lässt CI mit einem Phantomfehler rot laufen. Fix:

```ts
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction('$env', '$input', '$', '$json', 'items', codeToCheck);
```

Der Check bleibt sicher — `new Function`/`AsyncFunction` kompilieren nur, sie
führen nichts aus.

### N4 — Container-Härtung fehlt

`docker-compose.yml` — vier kleine Ergänzungen:

```yaml
    security_opt: ["no-new-privileges:true"]
    logging:                       # sonst wachsen json-file-Logs unbegrenzt
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
    deploy:
      resources:
        limits: { memory: 1g, pids: 512 }
```

Das Image ist auf `2.31.4` gepinnt (`docker-compose.yml:17`) — ein Tag ist aber
verschiebbar, und `vps-deploy.sh:24` macht bei jedem Deploy `docker compose
pull`. Für echte Reproduzierbarkeit `image: n8nio/n8n@sha256:...`.
Gegenläufig gilt: ein fest gepinnter Tag **ohne** Update-Automatik bedeutet,
dass die Instanz still auf einer Version mit bekannten CVEs stehen bleibt —
siehe I3.

### N5 — tar-Deploy räumt nicht auf

`deploy.yml:84–88` entpackt über den Bestand, ohne vorher zu löschen. Aus dem
Repo entfernte Dateien bleiben auf dem VPS für immer liegen — insbesondere
gelöschte `workflows/<name>/` (die im n8n dann auch nie deaktiviert werden) und
alte `scripts/`. Entweder `--delete`-Semantik nachbauen (in ein frisches
Verzeichnis entpacken und atomar umschwenken) oder bewusst dokumentieren.

### N6 — Deploy-Gate schwächer als PR-Gate, Tunnel-Cleanup fragil

`validate.yml` fährt `npm run validate` **und** `npm test`; der `validate`-Job in
`deploy.yml:46–55` nur `npm run validate`. Das Gate direkt vor Produktion ist
damit schwächer als das auf PRs — `npm test` dort ergänzen.

`deploy.yml:147` beendet den Tunnel mit
`pkill -f "ssh.*-L 127.0.0.1:5678:127.0.0.1:5678"`. Der Match läuft über die
komplette Kommandozeile aller Prozesse, und bei einem Fehlschlag von
`npm run deploy` bricht der Job vorher ab (`bash -e`), der Cleanup entfällt.
Sauberer: PID mitschreiben oder einen `ControlPath` verwenden und den Cleanup in
einen eigenen `if: always()`-Step legen.

Außerdem fehlt `package.json`/`package-lock.json` im `paths:`-Filter
(`deploy.yml:33–39`) — ein Dependency-Bump löst keinen Deploy aus.

### N7 — Doku- und Beispieldaten

Offen:

- **`README.md:179–180`** behauptet, `deploy.yml` nutze „nur einen SSH-Key — alle
  n8n/Google-Secrets bleiben auf dem VPS, nie in GitHub". Seit `b942411` ist das
  Gegenteil der Fall: `N8N_ENCRYPTION_KEY`, `N8N_API_KEY` und
  `GOOGLE_OAUTH_CRED_ID` liegen als GitHub-Secrets vor und werden bei jedem
  Deploy übertragen (`deploy.yml:98–100`). Der Satz beschreibt das
  Bedrohungsmodell falsch und sollte korrigiert werden — das ist der einzige
  Doku-Punkt mit Sicherheitsrelevanz.
- **`.env.example:42`** enthält eine **echt aussehende** `CALENDAR_ID`
  (`715ae8ec…@group.calendar.google.com`). Kalender-IDs sind keine Credentials,
  identifizieren aber einen konkreten privaten Kalender und laden zu
  Zugriffsversuchen ein. Auf `<your-calendar-id>@group.calendar.google.com`
  ändern. (Die Doku bewirbt den Wert immerhin nicht mehr als Default.)

Durch die Doku-Überarbeitung auf `main` bereits erledigt:

- Die veralteten Caddy-Kommandos (`docker compose logs -f caddy`) sind weg; die
  verbliebenen Caddy-Erwähnungen sind bewusste Abgrenzungen („no Caddy").
- Der Widerspruch bei `N8N_API_URL` (`https://<domain>` vs. `127.0.0.1:5678`)
  besteht nicht mehr.
- Die Troubleshooting-Zeile „Duplicate events — shouldn't happen" ist entfallen
  (sie stand im Widerspruch zu M4).

---

## Info / Hygiene

- **I1 — Kein Volume-Backup.** `backup.ts` exportiert ausschließlich
  Workflow-JSON (bewusst, korrekt dokumentiert). Damit ist aber **nichts**
  gesichert, was den Verlust des Docker-Volumes überlebt: das verschlüsselte
  Google-OAuth-Refresh-Token liegt nur dort. Verlust des Volumes = komplette
  OAuth-Neuautorisierung im Browser. Ein `docker run --rm -v
  automation-hub_n8n_data:/d -v $PWD:/b alpine tar czf /b/n8n-vol.tgz /d`
  im Cron schließt die Lücke — der Restore braucht zusätzlich den
  `N8N_ENCRYPTION_KEY`, der aktuell nur als GitHub-Secret existiert
  (nicht auslesbar!). Zweitkopie in einem Passwortmanager anlegen.
- **I2 — Kein `tsc --noEmit` in CI.** `tsconfig.json` ist mit `strict`,
  `noUnusedLocals`, `noUnusedParameters` sauber konfiguriert, wird aber nie
  ausgeführt — `tsx` transpiliert ohne Typprüfung. `"typecheck": "tsc --noEmit"`
  ins `package.json` und in beide Workflows. Ein Linter (`eslint`) fehlt ganz.
- **I3 — Keine Update-Automatik.** Weder Dependabot noch Renovate. Für
  `github-actions`, `npm` und das gepinnte n8n-Image gehört eine
  `.github/dependabot.yml` ins Repo, sonst altert der Stack unbemerkt.
  Ebenso fehlen `CODEOWNERS` und dokumentierter Branch-Schutz für `main` — und
  `main` ist der Branch, der automatisch nach Produktion deployt.
- **I4 — TZ-Mix.** Der Container läuft auf `Europe/Berlin`
  (`docker-compose.yml:32–33`), `ageOnNextBirthday` rechnet aber mit
  `getUTC*()` auf einem lokalen `new Date()`
  (`lib/calendar-upsert.js:105–113`). Beim Default-Schedule `0 6 * * *`
  harmlos; bei einem Schedule zwischen 00:00 und 02:00 Berliner Zeit wäre das
  „(turning N)" an einem Tag im Jahr um eins daneben. Entweder konsequent UTC
  oder konsequent lokal — und ein Testfall dafür.
- **I5 — Command-Injection-Muster.** `$VPS_APP_DIR` und `$VPS_USER` werden in
  Remote-Shell-Strings interpoliert (`deploy.yml:88,120,126`). Die Werte sind
  eigene Secrets, das Risiko also theoretisch — aber ein einzelnes
  Anführungszeichen im Wert bricht das Quoting auf und führt beliebige Befehle
  auf dem VPS aus. Beim nächsten Anfassen der Datei mit entschärfen.
- **I6 — Placeholder-Credential.** Ist `GOOGLE_OAUTH_CRED_ID` nicht gesetzt,
  schreibt `scripts/deploy.ts:92–97` den String `REPLACE_WITH_CRED_ID` als
  Credential-Referenz nach n8n. Der Workflow bleibt korrekt inaktiv, aber die
  baumelnde Referenz ist irreführend — besser den `credentials`-Block ganz
  entfernen, wenn keine ID vorliegt.
- **I7 — Kein Delete-Pfad.** Bewusste Entscheidung und sauber dokumentiert
  (`workflows/birthday-sync/README.md:111`). Wert zu wissen: In Kombination mit
  M4 heißt „keine Löschung" auch, dass einmal entstandene Duplikate **nur von
  Hand** wieder wegzubekommen sind.
- **I8 — 32-Bit-Signatur.** `hashString` (FNV-1a, 8 Hex-Zeichen) wird
  ausschließlich *pro `contactId`* mit dem eigenen Vorgängerwert verglichen,
  nie global. Kollisionsrisiko damit ~2⁻³² pro Änderung — unkritisch, kein
  Handlungsbedarf. (Nur relevant, falls die Signatur je als globaler
  Dedup-Schlüssel verwendet wird.)

---

## Was gut gelöst ist

Der Vollständigkeit halber, weil es die Bewertung der Befunde einordnet:

- **Keine Secrets in der Historie.** `git log --all` über alle 9 Commits zeigt
  ausschließlich Variablen-*Referenzen*; die `.env` wurde nie committet, die
  `.gitignore` deckt `.env`, `*.sqlite`, `backups/` und `dist/` sauber ab.
- **Netzwerk-Exposure minimal.** Port-Binding auf `127.0.0.1:5678`
  (`docker-compose.yml:21`) umgeht die klassische Docker/ufw-Falle — der Port
  ist auch ohne Firewall-Regel nicht von außen erreichbar.
- **`N8N_PROXY_HOPS: "1"`** ist korrekt gesetzt; ohne das wäre
  Rate-Limiting/IP-Logging hinter dem Proxy wertlos.
- **Telemetrie aus**, Execution-Pruning an, Task-Runner aktiviert — alles
  bewusste, richtige Defaults.
- **Idempotenz-Design.** Match über die stabile People-API `resourceName` statt
  über Titel/Datum ist genau der richtige Schlüssel, und die
  Signatur-Logik hält Updates minimal. 11 Unit-Tests, alle grün, decken die
  interessanten Fälle ab (kein Geburtsjahr, 29.02. ohne Jahr, Rename → Update,
  Skip bei Gleichstand).
- **`lib/`-Single-Source mit Drift-Check in CI** ist eine elegante Lösung für
  das n8n-Code-Node-Problem — inklusive `--fix`-Pfad, damit der Check nicht nur
  meckert.
- **Einseitiger Deploy plus getrenntes `backup.ts`** verhindert genau den
  Klassiker, dass ein UI-Edit still zur Quelle der Wahrheit wird.
- **`concurrency: deploy-vps` mit `cancel-in-progress: false`** — verhindert
  überlappende Deploys, ohne einen laufenden abzuschneiden.

---

## Empfohlene Reihenfolge

| Schritt | Aufwand | Befund |
|---------|---------|--------|
| ~~1~~ | ✅ erledigt | **H3** Host-Key pinnen (`VPS_SSH_HOST_KEY`) |
| ~~2~~ | ✅ erledigt | **H2** `package-lock.json` committen, `npm ci --ignore-scripts` |
| ~~3~~ | ✅ erledigt | **H1** `CALENDAR_ID`/`SHOW_BIRTH_YEAR` deploy-time injizieren, Env-Zugriff blocken |
| 4 | 5 min | **M6** Execution-Retention senken _(M1 erledigt)_ |
| 5 | 15 min | **M2** `/api/v1` am Proxy sperren, **M3** Doku + 2FA |
| ~~6~~ | ✅ erledigt | **M4** `executeOnce`, **M5** Retry, **N2** Datumsvalidierung, **N3** `await` |
| 7 | Rest | N1, N4–N7, I1–I3 + Error-Workflow für M5 |
