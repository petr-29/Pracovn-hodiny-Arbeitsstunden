/**
 * Cloudflare Worker — Soukromý relay pro vzdálený podpis
 * 
 * Nasazení:
 * 1. Jdi na https://workers.cloudflare.com a vytvoř nový Worker
 * 2. Zkopíruj tento kód
 * 3. V nastavení Workers přidej KV Namespace s názvem "RELAY_KV"
 * 4. V index.html nahraď URL 'https://jsonblob.com/api/jsonBlob' za URL svého Workeru
 *    Příklad: 'https://relay.tvoje-domena.workers.dev'
 * 
 * Kompatibilní API (nahrazuje jsonblob.com):
 *   POST /           - uloží JSON payload, vrátí { id } v těle i jako Location header
 *   GET  /{id}       - vrátí uložený payload
 *   PUT  /{id}       - aktualizuje uložený payload (pro podpis z telefonu)
 * 
 * Data se automaticky smažou po 5 minutách (TTL = 300 sekund).
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const id = url.pathname.slice(1); // odstraní úvodní '/'
        const SESSION_TTL_SECONDS = 300;

        // CORS hlavičky — potřebné pro volání z prohlížeče
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
        };

        // Preflight OPTIONS
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // POST / — uloží nový payload, vrátí ID
        if (request.method === 'POST' && url.pathname === '/') {
            const body = await request.text();
            const newId = crypto.randomUUID();
            
            // TTL 300 sekund = 5 minut
            await env.RELAY_KV.put(newId, body, { expirationTtl: SESSION_TTL_SECONDS });
            
            return new Response(JSON.stringify({ id: newId }), {
                status: 201,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                    // Kompatibilita s jsonblob.com — Location header obsahuje ID
                    'Location': `https://${url.hostname}/${newId}`,
                },
            });
        }

        // GET /{id} — vrátí uložený payload
        if (request.method === 'GET' && id) {
            const value = await env.RELAY_KV.get(id);
            if (!value) {
                return new Response(JSON.stringify({ error: 'Not found or expired' }), {
                    status: 404,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
            return new Response(value, {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // PUT /{id} — aktualizuje payload (telefon odesílá podpis)
        if (request.method === 'PUT' && id) {
            const existing = await env.RELAY_KV.get(id);
            if (!existing) {
                return new Response(JSON.stringify({ error: 'Session not found or expired' }), {
                    status: 404,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
            const body = await request.text();
            // Zachováme TTL — aktualizujeme s 5 minutovým TTL od teď
            await env.RELAY_KV.put(id, body, { expirationTtl: SESSION_TTL_SECONDS });
            return new Response(JSON.stringify({ success: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    },
};
