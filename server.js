const express = require('express');
const app = express();
const http = require('http').createServer(app);
const cors = require('cors');
const path = require('path');

// CORS a JSON middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Úložiště pro relace podpisu
let signatureSessions = {};
let pollingIntervals = {};

// === API ENDPOINTY ===

/**
 * POST /api/signature-session
 * Vytvoří novou relaci pro podpis
 * Body: { target: 'kunde' | 'ich', pcId: string }
 */
app.post('/api/signature-session', (req, res) => {
  const { target, pcId } = req.body;
  const sessionId = Date.now().toString();
  
  signatureSessions[sessionId] = {
    id: sessionId,
    signature: null,
    target: target || 'kunde',
    pcId: pcId,
    created: new Date(),
    status: 'waiting'
  };
  
  console.log(`✓ Nová relace podpisu: ${sessionId} (${target})`);
  
  res.json({ 
    sessionId: sessionId,
    target: target,
    created: new Date()
  });
});

/**
 * GET /api/signature/:sessionId
 * Zjistí stav podpisu - vrací podpis pokud je připraven
 */
app.get('/api/signature/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = signatureSessions[sessionId];
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  if (session.signature) {
    console.log(`✓ Podpis přijat pro relaci: ${sessionId}`);
    res.json({ 
      signature: session.signature,
      target: session.target,
      status: 'completed'
    });
    
    // Smazat relaci po 5 minutách
    setTimeout(() => {
      delete signatureSessions[sessionId];
      if (pollingIntervals[sessionId]) {
        clearInterval(pollingIntervals[sessionId]);
        delete pollingIntervals[sessionId];
      }
    }, 5 * 60 * 1000);
  } else {
    res.json({ 
      signature: null,
      target: session.target,
      status: 'waiting'
    });
  }
});

/**
 * POST /api/signature/:sessionId/upload
 * Telefon odešle podpis
 */
app.post('/api/signature/:sessionId/upload', (req, res) => {
  const { sessionId } = req.params;
  const { signature } = req.body;
  
  if (!sessionId || !signature) {
    return res.status(400).json({ error: 'Missing sessionId or signature' });
  }
  
  const session = signatureSessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  session.signature = signature;
  session.status = 'completed';
  session.uploadedAt = new Date();
  
  console.log(`✓ Podpis uložen: ${sessionId}`);
  
  res.json({ 
    success: true,
    message: 'Signature received',
    sessionId: sessionId
  });
});

/**
 * GET /sign
 * Zobrazit podpisové plátno na základě parametrů
 */
app.get('/sign', (req, res) => {
  const { sessionId, target, lang } = req.query;
  
  if (!sessionId) {
    return res.status(400).send('Missing sessionId parameter');
  }
  
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

/**
 * GET /health
 * Kontrola stavu serveru
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'online',
    timestamp: new Date(),
    activeSessions: Object.keys(signatureSessions).length
  });
});

// === ERRO HANDLING ===
app.use((err, req, res, next) => {
  console.error('Chyba serveru:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// === START SERVERU ===
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Podpisový server běží na portu ${PORT}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📱 Přístupný na: http://localhost:${PORT}`);
  console.log(`✓ API: /api/signature-session [POST]`);
  console.log(`✓ Podpis: /sign?sessionId=XXX&target=kunde&lang=cs`);
  console.log(`${'='.repeat(50)}\n`);
});

module.exports = http;