# 🅿️ ParkingPro Label Generator

Mobile Web-App die Buchungen aus dem ParkingPro Dashboard scrapt und thermische Labels für Check-in/Check-out generiert.

## Features

- **Automatischer Datenabruf** aus dem ParkingPro Dashboard via Puppeteer
- **Label-Generator** optimiert für 60×40mm Thermodrucker (NIIMBOT, Phomemo)
- **Team-Zugang** mit einfachem Passwortschutz
- **Mobile-First** — als PWA auf dem Handy nutzbar
- **Teilen/Drucken** — Label als PNG speichern oder direkt an Drucker-App teilen

## Deployment auf Render

### 1. GitHub Repository erstellen

```bash
cd parkingpro-label
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/DEIN-USER/parkingpro-label.git
git push -u origin main
```

### 2. Auf Render deployen

1. Gehe zu [render.com](https://render.com) → **New** → **Web Service**
2. Verbinde dein GitHub Repo
3. Wähle **Docker** als Runtime
4. Setze die **Environment Variables**:

| Variable | Wert |
|---|---|
| `PARKINGPRO_URL` | `https://parkdirect24.parkingpro.de/` |
| `PARKINGPRO_EMAIL` | Deine ParkingPro E-Mail |
| `PARKINGPRO_PASSWORD` | Dein ParkingPro Passwort |
| `APP_PASSWORD` | Passwort für dein Team (z.B. `meinTeam2024`) |

5. Klicke **Deploy**

### 3. Fertig!

- Öffne die Render-URL auf dem Handy
- Logge dich mit dem Team-Passwort ein
- Buchungen werden automatisch geladen
- Tippe auf eine Buchung → Label erstellen → Bild speichern → in Drucker-App drucken

## Hinweise zum Scraping

Der Scraper muss die CSS-Selektoren für die ParkingPro Tabelle kennen. Die aktuelle Version versucht die Tabelle automatisch zu erkennen. Falls sich das Dashboard-Layout ändert, muss `src/server.js` angepasst werden.

**Tipp:** Falls der Login nicht automatisch klappt, schicke mir einen Screenshot der Login-Seite und ich passe die Selektoren an.

## Lokale Entwicklung

```bash
cp .env.example .env
# .env mit deinen Daten füllen
npm install
npm run dev
```
