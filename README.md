# Pracovní hodiny / Arbeitsstunden

Web application for tracking working hours and generating invoices with remote signature support.

## Architecture

| Part | Host | Runtime |
|------|------|---------|
| Frontend (`index.html`) | GitHub Pages | Static HTML/JS only |
| Backend (`server.js`) | Any Node.js host (Render, Railway, Fly.io, VPS…) | Node.js 18+ |
| Signature page (`public/sign.html`) | Served by the backend | Served as static file by Express |

GitHub Pages hosts **static files only** – Node.js does not run there.
The Express backend must be deployed separately so the `/api/…` and `/sign` endpoints are reachable.

---

## Variant A – GitHub Pages frontend + separate Node backend

### 1. Deploy the Node backend

Choose any platform that supports Node.js (examples below – no provider lock-in required).

#### Render (free tier)
1. Push this repository (or a fork) to GitHub.
2. Create a new **Web Service** on [render.com](https://render.com), point it at the repository.
3. Build command: *(leave empty)*
4. Start command: `node server.js`
5. Add the environment variables listed in §3 below.
6. Note the deployed URL, e.g. `https://arbeitsstunden-api.onrender.com`.

#### Railway / Fly.io / VPS
Follow the platform's Node.js deployment guide.  
The only requirement is that `node server.js` runs and the `PORT` environment variable is respected.

### 2. Configure backend environment variables

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `PORT` | no | `3000` | Port the server listens on (default: 3000) |
| `PUBLIC_URL` | **yes (cross-origin)** | `https://arbeitsstunden-api.onrender.com` | Absolute public URL of the backend. Used to build the absolute `/sign?…` URL returned to the frontend and embedded in the QR code. Must not end with `/`. Required when the frontend is on a different origin (GitHub Pages). Not needed for single-host local development. |
| `ALLOWED_ORIGIN` | no | `https://example.github.io` | Additional exact frontend origin to allow in CORS. `https://petr-29.github.io` is always allowed. |

### 3. Set the frontend API base URL

The frontend reads `window.__API_BASE_URL__` at runtime.  
For GitHub Pages (static hosting) set this by adding a small `<script>` block **before** the closing `</body>` tag of `index.html`, or by hosting a separate `config.js` that is loaded first:

```html
<!-- index.html – just before </body> -->
<script>
  window.__API_BASE_URL__ = 'https://arbeitsstunden-api.onrender.com';
</script>
```

Replace the URL with your actual backend URL.

> **Local development** – leave `window.__API_BASE_URL__` unset (or set it to `''`).  
> The app will fall back to the built-in jsonblob.com relay, so signatures work without a running backend.

### 4. Commit and push → GitHub Pages auto-deploys

GitHub Pages rebuilds automatically on every push to the configured branch.  
Verify the Pages deployment is live before testing.

---

## Signature flow comparison

### With `window.__API_BASE_URL__` set (Node backend)

```
PC (index.html)
  → POST {API_BASE_URL}/api/signature-session
  ← { sessionId, signUrl: "{PUBLIC_URL}/sign?sessionId=…&token=…" }
  → QR code encodes signUrl

Phone opens signUrl → sign.html (served by backend)
  → POST /api/signature/{sessionId}/upload   (same-origin, relative URL)

PC polls {API_BASE_URL}/api/signature/{sessionId}
  ← { status: 'completed', signature: '…' }
```

### Without `window.__API_BASE_URL__` (jsonblob.com relay, default)

```
PC → POST https://jsonblob.com/api/jsonBlob  (creates blob)
   → QR code encodes {pages_url}?remoteSig=…&blobId=…

Phone opens pages URL → shows signature canvas in index.html
  → PUT https://jsonblob.com/api/jsonBlob/{blobId}

PC polls jsonblob every 2 s
```

---

## CORS policy

The backend allows the following request origins:

- `https://petr-29.github.io` (always allowed)
- Any value set in the `ALLOWED_ORIGIN` environment variable (exact match only)
- `localhost`, `127.0.0.1`, `::1`, hostnames ending in `.local`
- Private LAN ranges: `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`

Wildcard origins (`*`) are **not** used.

---

## Quick verification checklist

After deploying:

- [ ] `curl https://<your-backend>/health` returns `{"status":"online",…}`
- [ ] `curl -I -H "Origin: https://petr-29.github.io" https://<your-backend>/api/signature-session` responds with `Access-Control-Allow-Origin: https://petr-29.github.io`
- [ ] Open `https://petr-29.github.io/Pracovn-hodiny-Arbeitsstunden/` → DevTools Console shows no CORS errors
- [ ] Open DevTools → Network → POST to `/api/signature-session` returns HTTP 200
- [ ] QR code appears in the signature modal; scanning it on a phone opens the `/sign` page
- [ ] After signing on the phone, the signature appears in the invoice on the PC

---

## Local development

```bash
npm install
npm start          # or: npm run dev   (nodemon auto-reload)
# Open http://localhost:3000
```

No environment variables are required for local development.  
The backend serves `index.html` and `public/sign.html` directly, so all relative API calls work out of the box.
