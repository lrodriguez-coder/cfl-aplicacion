/* =============================================================================
   Prueba de navegador: borrador con documentos + peso de los documentos.

   Corre el formulario REAL (index.html + app.js) en Chromium headless, con
   toda la red externa interceptada (OCR, cotizador, intake, n8n, reCAPTCHA):
   no sale nada a ningún servidor y no hay datos de clientes (todo es ficticio).

   Requiere Playwright. Este repo no tiene package.json, así que se usa el de
   cualquier otro proyecto vía NODE_PATH, por ejemplo:

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/borrador-y-peso.e2e.cjs

   Sale con código 1 si alguna comprobación falla.
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MB = 1024 * 1024;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// A fake PDF of the requested size (the form only looks at type and size).
// Each call gets distinct content: the form refuses the SAME file in two slots.
let pdfSeq = 0;
function fakePdf(bytes) {
  const head = Buffer.from('%PDF-1.4\n% prueba ficticia ' + (++pdfSeq) + '\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x20)]);
}

// Runs in the page: how many slots the draft keeps in IndexedDB.
function contarRegistros() {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve('sin-indexeddb');
    const req = indexedDB.open('cfl_aplicacion_borrador');
    req.onerror = () => resolve('error');
    req.onupgradeneeded = () => { req.transaction.abort(); resolve(0); };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) { db.close(); return resolve(0); }
      const c = db.transaction('files').objectStore('files').count();
      c.onsuccess = () => { db.close(); resolve(c.result); };
      c.onerror = () => { db.close(); resolve('error'); };
    };
  });
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

async function newPage(browser, base, captured) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(url => !url.href.startsWith(base), async route => {
    const u = route.request().url();
    if (u.includes('/v1/public/ocr')) {
      const body = JSON.parse(route.request().postData() || '{}');
      const tipo = { cedula: 'cedula', carta: 'employment_letter', aqualectra: 'aqualectra', payslip: 'payslip', id_adicional: 'paspoort' }[body.docType] || 'otro';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { tipo_detectado: tipo, fecha_vencimiento: '2031-01-01' } }) });
    }
    if (u.includes('/v1/public/intake')) {
      captured.intakeBytes = (route.request().postData() || '').length;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, applicationNumber: 'CFL-PRUEBA' }) });
    }
    if (u.includes('recaptcha') || u.includes('gstatic')) return route.abort();
    return route.fulfill({ status: 503, body: '' });
  });
  return { ctx, page };
}

async function step(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.step.active');
    return s ? s.dataset.step : null;
  });
}

async function goToStep2(page, base) {
  await page.goto(base + '/index.html?lang=es');
  await page.selectOption('[name="proposito_categoria"]', 'vakashon');
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="2"].active');
  await page.selectOption('[name="tipo_empleado"]', 'fijo');
  await page.selectOption('[name="frecuencia_salario"]', 'mensual');
}

// The stored files are written asynchronously; give the page a moment to
// settle so the reload tests what a real user who switched apps would see.
async function settle(page) {
  await page.waitForTimeout(1500);
}

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    // ---------------------------------------------------------------------
    // Defect 6: reload keeps the step and the documents.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await goToStep2(page, base);
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(200 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active');
      await page.setInputFiles('[name="doc_carta_trabajo"]', { name: 'carta-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(150 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_carta_trabajo"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await settle(page);

      await page.reload();
      await page.waitForTimeout(2500);
      const s = await step(page);
      check('recarga: vuelve al mismo paso (3)', s === '3', 'paso tras recargar = ' + s);
      const files = await page.evaluate(() => ['doc_cedula', 'doc_carta_trabajo'].map(n => {
        const i = document.querySelector('[name="' + n + '"]');
        return i && i.files && i.files[0] ? i.files[0].name + ':' + i.files[0].size : null;
      }));
      check('recarga: la cédula sigue adjunta', files[0] === 'cedula-ficticia.pdf:' + 200 * 1024, String(files[0]));
      check('recarga: la carta sigue adjunta', files[1] === 'carta-ficticia.pdf:' + 150 * 1024, String(files[1]));
      const preview = await page.evaluate(() => {
        const p = document.querySelector('[data-preview-for="doc_carta_trabajo"]');
        return p ? p.textContent : '';
      });
      check('recarga: el casillero muestra el documento', /carta-ficticia\.pdf/.test(preview), preview.slice(0, 120));

      // A payslip in a dynamic slot survives a language switch (the switch
      // re-renders those slots) and a reload.
      await page.setInputFiles('[name="doc_payslips_1"]', { name: 'payslip-ficticio.pdf', mimeType: 'application/pdf', buffer: fakePdf(120 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_payslips_1"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await settle(page);
      await page.selectOption('#langSwitch', 'nl');
      await page.waitForTimeout(2000);
      const trasIdioma = await page.evaluate(() => {
        const i = document.querySelector('[name="doc_payslips_1"]');
        return i && i.files && i.files[0] ? i.files[0].name : null;
      });
      check('cambio de idioma: el payslip sigue adjunto', trasIdioma === 'payslip-ficticio.pdf', String(trasIdioma));
      await page.reload();
      await page.waitForTimeout(2500);
      const trasRecarga = await page.evaluate(() => {
        const i = document.querySelector('[name="doc_payslips_1"]');
        return i && i.files && i.files[0] ? i.files[0].name : null;
      });
      // (The URL carries ?lang=es, which wins over the draft's language on
      // purpose, so the page comes back in Spanish.)
      check('recarga: el payslip sigue adjunto', trasRecarga === 'payslip-ficticio.pdf', String(trasRecarga));
      await ctx.close();
    }

    // ---------------------------------------------------------------------
    // Defect 2a: a large phone photo is shrunk before it is kept.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await goToStep2(page, base);
      // 4000x3000 "photo of a document": paper tone, lines of dark "text" and
      // sensor noise, so it weighs what a real phone photo weighs (several
      // MB) instead of compressing to nothing.
      const b64 = await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 4000; c.height = 3000;
        const g = c.getContext('2d');
        const img = g.createImageData(4000, 3000);
        for (let y = 0; y < 3000; y++) {
          const texto = (y % 60) < 22;
          for (let x = 0; x < 4000; x++) {
            const i = (y * 4000 + x) * 4;
            const tinta = texto && ((x * 13 + y * 7) % 37) < 15;
            const v = (tinta ? 40 : 225) + ((Math.random() * 30) | 0) - 15;
            img.data[i] = v; img.data[i + 1] = v - 5; img.data[i + 2] = v - 18; img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return btoa(s);
      });
      const original = Buffer.from(b64, 'base64');
      await page.setInputFiles('[name="doc_cedula"]', { name: 'foto-ficticia.jpg', mimeType: 'image/jpeg', buffer: original });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status', { timeout: 15000 });
      const kept = await page.evaluate(async () => {
        const f = document.querySelector('[name="doc_cedula"]').files[0];
        const bmp = await createImageBitmap(f);
        return { size: f.size, type: f.type, w: bmp.width, h: bmp.height };
      });
      check('foto: se reduce el lado largo a <= 1600 px', Math.max(kept.w, kept.h) <= 1600, kept.w + 'x' + kept.h);
      check('foto: queda en menos de 1 MB', kept.size < 1 * MB,
        (original.length / MB).toFixed(2) + ' MB -> ' + (kept.size / MB).toFixed(2) + ' MB (' + kept.type + ')');
      await ctx.close();
    }

    // ---------------------------------------------------------------------
    // Defect 2b: oversize single file and an oversize total are refused when
    // they are attached, with a message, instead of a 413 at the last click.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await goToStep2(page, base);
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-enorme.pdf', mimeType: 'application/pdf', buffer: fakePdf(16 * MB) });
      await page.waitForTimeout(800);
      let st = await page.evaluate(() => ({
        n: document.querySelector('[name="doc_cedula"]').files.length,
        err: document.getElementById('errors').textContent
      }));
      check('archivo de 16 MB: se rechaza', st.n === 0, 'archivos en el casillero = ' + st.n);
      check('archivo de 16 MB: mensaje claro', /MB/.test(st.err), JSON.stringify(st.err.slice(0, 160)));

      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-a.pdf', mimeType: 'application/pdf', buffer: fakePdf(9 * MB) });
      await page.waitForTimeout(500);
      await page.setInputFiles('[name="doc_id_adicional"]', { name: 'pasaporte-b.pdf', mimeType: 'application/pdf', buffer: fakePdf(9 * MB) });
      await page.waitForTimeout(500);
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active');
      await page.setInputFiles('[name="doc_carta_trabajo"]', { name: 'carta-c.pdf', mimeType: 'application/pdf', buffer: fakePdf(9 * MB) });
      await page.waitForTimeout(800);
      st = await page.evaluate(() => {
        let total = 0;
        document.querySelectorAll('input[type="file"]').forEach(i => Array.from(i.files || []).forEach(f => { total += f.size; }));
        return { total: total, carta: document.querySelector('[name="doc_carta_trabajo"]').files.length, err: document.getElementById('errors').textContent };
      });
      // What the intake would receive: base64 inflates by 4/3; the API's
      // bodyLimit is 32 MB for the whole JSON.
      const wire = st.total * 4 / 3;
      check('total: los documentos adjuntos caben en el envío (< 32 MB en base64)', wire < 32 * MB,
        'adjuntos ' + (st.total / MB).toFixed(1) + ' MB -> ' + (wire / MB).toFixed(1) + ' MB en el JSON');
      check('total: el tercer PDF de 9 MB se rechaza con mensaje', st.carta === 0 && /MB/.test(st.err), JSON.stringify(st.err.slice(0, 160)));
      await ctx.close();
    }

    // ---------------------------------------------------------------------
    // Defect 6 (cierre): after a successful submit the stored draft is gone.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await goToStep2(page, base);
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(100 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await settle(page);
      const antes = await page.evaluate(contarRegistros);
      check('antes del envío: el documento está en el borrador', antes === 1, 'registros = ' + antes);
      // Jump straight to the submit handler: the earlier steps need e-mail and
      // WhatsApp codes, which this test does not fake. What matters here is
      // that a successful intake wipes what the device kept.
      await page.evaluate(() => {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
        document.querySelector('.step[data-step="7"]').classList.add('active');
        document.querySelector('[name="acepta_terminos"]').checked = true;
        const ta = document.createElement('textarea');
        ta.name = 'g-recaptcha-response'; ta.value = 'token-ficticio'; ta.style.display = 'none';
        document.body.appendChild(ta);
        document.querySelectorAll('[required]').forEach(el => { if (!el.closest('.step[data-step="7"]')) el.required = false; });
        document.getElementById('appForm').requestSubmit();
      });
      await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 });
      await page.waitForTimeout(800);
      const left = await page.evaluate(contarRegistros);
      check('envío OK: el borrador de documentos queda vacío', left === 0, 'registros = ' + left);
      check('envío OK: el intake recibió los documentos', captured.intakeBytes > 100 * 1024, 'bytes = ' + captured.intakeBytes);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures === 0 ? '\nTODO OK' : '\n' + failures + ' comprobación(es) fallaron');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
