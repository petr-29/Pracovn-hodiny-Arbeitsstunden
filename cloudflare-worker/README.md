# Cloudflare Worker — Soukromý relay pro vzdálený podpis

Tento Worker nahrazuje závislost na `jsonblob.com` (veřejné API třetí strany) vlastním
soukromým relayem, který provozuješ ty. Data podpisů a synchronizace **neopouštějí tvoji
Cloudflare infrastrukturu**.

## Rychlé nasazení (zdarma)

1. Přihlas se na [https://dash.cloudflare.com](https://dash.cloudflare.com) (účet je zdarma)
2. Jdi na **Workers & Pages** → **Create application** → **Create Worker**
3. Zkopíruj obsah `relay.js` do editoru a klikni **Deploy**
4. Jdi do nastavení Workeru → **KV** → **Add binding**
   - Variable name: `RELAY_KV`
   - Vytvoř nový KV namespace (např. `pracovni-hodiny-relay`)
5. Zkopíruj URL svého Workeru (např. `https://relay.tvoje-domena.workers.dev`)

## Úprava index.html

Nahraď v `index.html` všechny výskyty `https://jsonblob.com/api/jsonBlob` za URL svého Workeru.

### Pro generateSignaturePhoneLink:
```javascript
// Místo:
let res = await fetch('https://jsonblob.com/api/jsonBlob', { ... });
let blobId = res.headers.get('Location').split('/').pop();

// Použij:
let res = await fetch('https://tvuj-worker.workers.dev', { ... });
let data = await res.json();
let blobId = data.id; // Worker vrací { id } v těle, nejen v Location headeru
```

### Pro startPollingSignature:
```javascript
// Místo:
let res = await fetch(`https://jsonblob.com/api/jsonBlob/${blobId}`);

// Použij:
let res = await fetch(`https://tvuj-worker.workers.dev/${blobId}`);
```

## Limity zdarma

| Limit | Hodnota |
|---|---|
| Počet požadavků/den | 100 000 |
| KV operací/den | 100 000 čtení, 1 000 zápisů |
| TTL dat | 5 minut (auto-mazání) |

Pro osobní použití jsou tyto limity více než dostatečné.
