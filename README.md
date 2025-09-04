# Javin FileShare

A lightweight, local‑network file sharing tool with a simple PIN/QR workflow. The backend serves HTTPS on your LAN, and the frontend runs in any browser.

## Features
- Send/receive files  on your local network
- Join by scanning a QR code or entering a PIN
- Auto‑detect devices; sender approval flow with manual override
- Pure HTTPS + WebSockets (self‑signed cert auto‑generated locally)

## Project Structure
- `backend/` – Express + Socket.IO server (HTTPS, file uploads, PIN/QR)
- `frontend/` – Static HTML/CSS/JS screens (Host, Send, Receive, PIN)
- `setup.sh` – macOS/Linux helper to install deps, trust local cert, start server, open the app
- `setup.bat` – Windows helper to install deps, import cert (admin), start server, open the app

## Prerequisites
- Node.js 18+
- macOS, Windows, or Linux on the same LAN as your peers

## One‑click Start
download the repo then 
### macOS / Linux
```bash
chmod +x setup.sh
./setup.sh
```
What it does:
- Installs dependencies (backend and root if present)
- Generates a local self‑signed TLS cert if missing
- Trusts the cert in your OS store (prompts for sudo)
- Starts the server on `https://ipaddress:4000` and opens the app

### Windows
- Double‑click `setup.bat` (will request admin to trust the cert)
- It installs deps, imports the cert to Trusted Root (if present), starts the server, and opens `https://localhost:4000`

## Using the App
1) On the Host screen, scan the QR on a phone or open the shown URL on another device, then enter the PIN
2) Click `Send Files`, choose files, and `Request to Send`
3) Receivers will see `Accept / Reject` prompt; on acceptance, transfer begins

## Screens Illustrated
- Connected (host) dashboard with device info and PIN
- Send Files: drag‑and‑drop area, request flow, manual proceed
- Receive Files: accept/reject prompt and live progress

Note: Add your screenshots to the repository’s Releases or wiki if you want them embedded in the README.

## HTTPS and Certificates
- Certs are NOT stored in Git. They are generated locally by the setup scripts
- macOS: trusted via System keychain; Linux: added via `update-ca-certificates`/`update-ca-trust`/`trust`; Windows: added with `certutil`
- If your browser shows a warning on first run, ensure the cert was trusted (rerun the setup script) or manually trust it

## Troubleshooting
- macOS ‘damaged’ warning: right‑click the app (if packaged) → Open, or ad‑hoc sign locally; for browser use, simply trust the cert and open `https://localhost:4000`
- Port in use: change `PORT` in `backend/server.js` (default 4000) and rerun
- Firewall: allow Node.js to listen on your LAN
- Slow transfers: prefer 5GHz Wi‑Fi or ethernet

## Development
Install and run manually:
```bash
cd backend
npm install
node server.js
```
Open `https://ipaddress:4000` in your browser.

## Security Notes
- This is intended for local‑network use
- Self‑signed certs provide transport encryption; trust is local to your machine
- Do not commit private certs or production credentials

## Screenshots
Place images under `docs/screenshots/` and they will render below. Filenames can be anything; updating paths here will show them on GitHub.

<p>
  <img src="docs/screenshots/connected.png" alt="Connected screen" width="700" />
</p>
<p>
  <img src="docs/screenshots/send-files.png" alt="Send Files screen" width="700" />
</p>
<p>
  <img src="docs/screenshots/receive-files.png" alt="Receive Files screen" width="700" />
</p>


## License
MIT
