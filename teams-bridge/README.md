# teams-bridge

Nimmt Nachrichten aus Microsoft Teams entgegen, prueft sie gegen Microsofts
Schluesselsatz, reicht sie an n8n weiter und schickt Antworten zurueck.

## Warum ein eigener Dienst

Microsoft verlangt fuer jede eingehende Nachricht sieben Pruefungen gegen ein
rotierendes Schluesselset und schreibt ausdruecklich, es duerfe keinen Weg
geben, diese Pruefung abzuschalten. In einem n8n-Code-Baustein laege diese
Logik in einem Textfeld in der Oberflaeche, angewiesen auf freigeschaltete
Zusatzmodule, und ein versehentliches "bei Fehler fortfahren" wuerde den
Endpunkt oeffnen.

## Endpunkte

| Pfad | Wer ruft auf | Zweck |
|---|---|---|
| `POST /messages` | Microsoft Bot Service | Eingang. Prueft, quittiert sofort mit 200, reicht weiter |
| `POST /reply` | n8n | Ausgang. Schickt eine Antwort an die Konversation |
| `GET /health` | Betrieb | Kurzer Zustandsbericht |

`/reply` verlangt den Kopfzeilenwert `X-Bridge-Secret`.

## Umgebungsvariablen

| Name | Bedeutung |
|---|---|
| `MS_APP_ID` | Anwendungs-ID des Bots |
| `MS_APP_PASSWORD` | Geheimnis des Bots |
| `MS_TENANT_ID` | Verzeichnis-ID (Einzelmandant) |
| `N8N_TEAMS_WEBHOOK` | Ziel in n8n, etwa `http://172.17.0.1:5678/webhook/teams-in` |
| `BRIDGE_SECRET` | gemeinsames Geheimnis zwischen n8n und Bruecke |
| `PORT` | Vorgabe 3401 |

## Verhalten, das man kennen sollte

- **Sofortige Quittung.** Teams wiederholt nach 15 Sekunden ohne Antwort. Die
  eigentliche Antwort kommt als eigener Aufruf, deshalb wird jede Nachricht
  ueber ihre `activityId` entdoppelt.
- **Im Kanal nur bei Erwaehnung.** Nachrichten ohne `@Bot` werden verworfen,
  bevor sie n8n erreichen.
- **Nur die eigene Erwaehnung** wird aus dem Text entfernt, Erwaehnungen
  anderer Personen bleiben stehen.
- **Wiederholung** bei den Statuscodes 429, 412, 502 und 504, mit wachsendem
  Abstand und Zufallsanteil.

## Start

```bash
docker run -d --name teams-bridge --restart unless-stopped   -p 127.0.0.1:3401:3401   -p 172.17.0.1:3401:3401   -e MS_APP_ID=... -e MS_APP_PASSWORD=... -e MS_TENANT_ID=...   -e N8N_TEAMS_WEBHOOK=http://172.17.0.1:5678/webhook/teams-in   -e BRIDGE_SECRET=...   teams-bridge:dev
```

**Beide Veroeffentlichungen werden gebraucht**, und das kostet sonst eine
Stunde Fehlersuche: `127.0.0.1` fuer nginx, das auf dem Host laeuft, und
`172.17.0.1` fuer n8n, das im Container laeuft und den Host nur ueber die
Docker-Bruecke erreicht. Fehlt die zweite, kommt jede Nachricht sauber an,
die Antwort laeuft aber in den Zeitablauf.

nginx braucht dazu einen eigenen Ort:

```nginx
location /teams/ {
    proxy_pass http://127.0.0.1:3401/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 60s;
}
```
