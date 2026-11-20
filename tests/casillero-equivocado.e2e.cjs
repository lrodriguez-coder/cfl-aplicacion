/* =============================================================================
   Prueba de navegador: un documento en el casillero equivocado.

   Caso CFL-10127 (18-nov-2026): el cliente subió sus estados de cuenta en los
   casilleros de recibos. El OCR lo dijo, pero el control de tipo buscaba el
   casillero numerado (doc_payslips_1) en una tabla que sólo tiene doc_payslips
   y nunca marcaba «no coincide». Leonard, 20-nov-2026: «eso no lo debería
   aceptar».

   Todo ficticio y con la red interceptada. Correr con:
     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules        node tests/casillero-equivocado.e2e.cjs
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
      const tipo = { cedula: 'cedula', carta: 'employment_letter', aqualectra: 'aqualectra', payslip: captured.payslipSlotSees || 'payslip', id_adicional: 'paspoort' }[body.docType] || 'otro';
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
  // Required for an employee since ronda 13 (one year with the employer).
  await page.fill('[name="fecha_ingreso_empleo"]', '2020-01-15');
}

// The stored files are written asynchronously; give the page a moment to
// settle so the reload tests what a real user who switched apps would see.
async function settle(page) {
  await page.waitForTimeout(1500);
}

async function hastaRecibos(page, base) {
  await goToStep2(page, base);
  await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(200 * 1024) });
  await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="3"].active');
  await page.setInputFiles('[name="doc_carta_trabajo"]', { name: 'carta-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(150 * 1024) });
  await page.waitForSelector('[data-preview-for="doc_carta_trabajo"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
  await page.setInputFiles('[name="doc_payslips_1"]', { name: 'archivo-ficticio.pdf', mimeType: 'application/pdf', buffer: fakePdf(120 * 1024) });
  await page.waitForSelector('[data-preview-for="doc_payslips_1"] .ocr-status', { timeout: 10000 });
  await page.waitForTimeout(800);
}

const errorDelCasillero = (page) => page.evaluate(() => {
  const i = document.querySelector('[name="doc_payslips_1"]');
  const box = i && (i.closest('.upload-block') || i.closest('.field') || i.parentElement);
  const e = box && box.querySelector(':scope > .field-error');
  return e ? e.textContent : '';
});

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    // Control: un recibo en el casillero de recibos no recibe ese error.
    {
      const captured = { payslipSlotSees: 'payslip' };
      const { ctx, page } = await newPage(browser, base, captured);
      await hastaRecibos(page, base);
      await page.click('#btnNext');
      await page.waitForTimeout(500);
      const err = await errorDelCasillero(page);
      check('control: recibo en su casillero → sin «parece»', !/parece/i.test(err), err.slice(0, 120));
      await ctx.close();
    }
    // CFL-10127: el OCR ve un estado de cuenta en el casillero de recibos.
    {
      const captured = { payslipSlotSees: 'bank_statement' };
      const { ctx, page } = await newPage(browser, base, captured);
      await hastaRecibos(page, base);
      const aviso = await page.evaluate(() => {
        const b = document.querySelector('[data-preview-for="doc_payslips_1"] .ocr-status');
        return b ? (b.dataset.kind + ' | ' + b.textContent) : '';
      });
      check('al subir: el casillero avisa que el tipo no coincide', /⚠️/.test(aviso), aviso.slice(0, 140));
      await page.click('#btnNext');
      await page.waitForTimeout(500);
      const s = await step(page);
      const err = await errorDelCasillero(page);
      check('no deja avanzar', s === '3', 'paso = ' + s);
      check('dice qué es el archivo', /parece/i.test(err), err.slice(0, 140));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  if (failures > 0) { console.log(failures + ' comprobación(es) fallaron'); process.exit(1); }
  console.log('TODO OK');
}

main().catch(err => { console.error(err); process.exit(1); });
