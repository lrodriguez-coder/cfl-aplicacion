/* =============================================================================
   Prueba de navegador — ronda 14, decisiones de Leonard del 21-nov-2026
   (formulario #3, #8).

   Corre las páginas REALES (index.html + app.js, estado.html + estado.js) en
   Chromium headless con toda la red externa interceptada: no sale nada a
   ningún servidor y los datos son ficticios.

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/ronda14-decisiones.e2e.cjs

   Se comprueba:
     DECISIÓN 2 (#3)  sin extractos el Paso 3 no avanza; con "Enviaré mis
         estados de cuenta después" sí, y todo lo demás sigue obligatorio; el
         envío lo dice (extractos_pendientes) y la pantalla final lo explica;
         la página de estado pide los extractos mes por mes (una fila por mes)
         y manda el mes con el archivo.
     DECISIÓN 4 (#8)  sin las dos casillas (salud para Aska, buró) no se envía,
         con un mensaje por casilla; con ellas el intake recibe versión, texto
         e idioma de cada una; si el API contesta CONSENT_REQUIRED (una página
         vieja) el mensaje sale en el idioma del formulario.
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STATUS_API = 'https://api.curloans.com/v1/public/application-status/';
const FAKE_TOKEN = 'eyJhaWQiOiJ4In0~c2lnbmF0dXJl';

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

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

let pdfSeq = 0;
function fakePdf(name) {
  const head = Buffer.from('%PDF-1.4\n% prueba ficticia ' + (++pdfSeq) + '\n');
  return { name: name, mimeType: 'application/pdf', buffer: Buffer.concat([head, Buffer.alloc(4000, 0x20)]) };
}

async function newPage(browser, base, opts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const intakes = [];
  await page.route(url => !url.href.startsWith(base), async route => {
    const u = route.request().url();
    const body = () => JSON.parse(route.request().postData() || '{}');
    if (u.includes('/v1/public/ocr')) {
      const b = body();
      const tipo = { cedula: 'cedula', carta: 'employment_letter', payslip: 'payslip' }[b.docType] || 'otro';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { tipo_detectado: tipo, fecha_vencimiento: '2031-01-01', fecha_emision: new Date().toISOString().slice(0, 10) } }) });
    }
    if (u.includes('/v1/public/intake')) {
      const b = body();
      intakes.push(b);
      const a = (opts && opts.intake) ? opts.intake(b) : { status: 201, body: { ok: true, applicationNumber: 'CFL-PRUEBA', emailVerified: false, statusUrl: 'https://aplicacion.example.com/estado.html#t=prueba', bankStatementsPending: b.form && b.form.extractos_pendientes === 'si' } };
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (u.includes('recaptcha') || u.includes('gstatic')) return route.abort();
    return route.fulfill({ status: 503, body: '' });
  });
  return { ctx, page, intakes };
}

// Straight to Step 7 and its submit handler, like the other e2e tests; the
// consent boxes are left to each case.
async function submit(page, opts) {
  await page.evaluate(o => {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector('.step[data-step="7"]').classList.add('active');
    document.querySelector('[name="acepta_terminos"]').checked = true;
    for (const k of ['salud_aska', 'buro']) {
      const cb = document.querySelector('[name="consentimiento_' + k + '"]');
      if (cb.checked !== !!o[k]) cb.click();
    }
    if (!document.querySelector('[name="g-recaptcha-response"]')) {
      const ta = document.createElement('textarea');
      ta.name = 'g-recaptcha-response'; ta.value = 'token-ficticio'; ta.style.display = 'none';
      document.body.appendChild(ta);
    }
    document.querySelectorAll('[required]').forEach(el => { if (!el.closest('.step[data-step="7"]')) el.required = false; });
    document.getElementById('appForm').requestSubmit();
  }, opts || {});
}
const errorsText = page => page.evaluate(() => (document.getElementById('errors') || { textContent: '' }).textContent);
const activeStep = page => page.evaluate(() => document.querySelector('.step.active').dataset.step);

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------ DECISIÓN 2: Paso 3
    {
      const { ctx, page } = await newPage(browser, base);
      await page.goto(base + 'index.html?lang=es');
      await page.selectOption('[name="proposito_categoria"]', 'vakashon');
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="2"].active');
      await page.selectOption('[name="tipo_empleado"]', 'fijo');
      await page.selectOption('[name="frecuencia_salario"]', 'mensual');
      await page.fill('[name="fecha_ingreso_empleo"]', '2020-01-15');
      // Step 2's cédula is not what this case is about.
      await page.evaluate(() => { document.querySelector('[name="doc_cedula"]').required = false; });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active', { timeout: 5000 });

      // Everything but the statements.
      for (const n of ['doc_payslips_1', 'doc_payslips_2', 'doc_payslips_3']) {
        await page.setInputFiles('[name="' + n + '"]', fakePdf(n + '-ficticio.pdf'));
      }
      await page.setInputFiles('[name="doc_carta_trabajo"]', fakePdf('carta-ficticia.pdf'));
      await page.waitForTimeout(800);

      await page.click('#btnNext');
      await page.waitForTimeout(300);
      check('sin extractos y sin la casilla: el Paso 3 no avanza', (await activeStep(page)) === '3', 'paso ' + (await activeStep(page)));
      check('… y dice que faltan los estados de cuenta', /Estados? de cuenta/i.test(await errorsText(page)), (await errorsText(page)).slice(0, 160));

      await page.check('[name="extractos_pendientes"]');
      const req = await page.$$eval('input[name^="doc_bancos_"]', els => els.map(e => e.required));
      check('con la casilla: los 3 casilleros de extractos dejan de ser obligatorios', req.length === 3 && req.every(r => !r), JSON.stringify(req));
      check('con la casilla: se explica que la solicitud espera los extractos', await page.isVisible('#bancosPendientesAviso'));
      const otros = await page.$$eval('input[name^="doc_payslips_"], input[name="doc_carta_trabajo"]', els => els.map(e => e.required));
      check('los demás documentos siguen obligatorios', otros.length === 4 && otros.every(Boolean), JSON.stringify(otros));
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="4"].active', { timeout: 5000 }).catch(() => null);
      check('con la casilla: el Paso 3 avanza al 4', (await activeStep(page)) === '4', 'paso ' + (await activeStep(page)) + ' ' + (await errorsText(page)).slice(0, 120));

      // Control: un-ticked, the statements are required again.
      await page.click('#btnPrev');
      await page.waitForSelector('.step[data-step="3"].active');
      await page.uncheck('[name="extractos_pendientes"]');
      const req2 = await page.$$eval('input[name^="doc_bancos_"]', els => els.map(e => e.required));
      check('control: sin la casilla vuelven a ser obligatorios', req2.every(Boolean), JSON.stringify(req2));
      await ctx.close();
    }

    // ------------------------------------------------ DECISIÓN 4: casillas
    {
      const { ctx, page, intakes } = await newPage(browser, base);
      await page.goto(base + 'index.html?lang=es');
      await page.waitForSelector('[name="consentimiento_buro"]', { state: 'attached' });
      await submit(page, {});
      await page.waitForTimeout(400);
      const e = await errorsText(page);
      check('sin las dos casillas: no se envía nada', intakes.length === 0, 'envíos = ' + intakes.length);
      check('… mensaje de la casilla de salud (Aska)', /información de salud para Aska/.test(e), e.slice(0, 200));
      check('… mensaje de la casilla del buró', /buró de crédito/.test(e), e.slice(0, 200));

      await submit(page, { salud_aska: true });
      await page.waitForTimeout(300);
      check('con una sola casilla tampoco se envía', intakes.length === 0);
      check('… y sólo se pide la que falta', /buró de crédito/.test(await errorsText(page)) && !/información de salud/.test(await errorsText(page)), await errorsText(page));

      await page.evaluate(() => { document.querySelector('[name="extractos_pendientes"]').checked = true; });
      await submit(page, { salud_aska: true, buro: true });
      await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 }).catch(() => null);
      const b = intakes[0] || { form: {} };
      const c = b.form._consents || {};
      check('con las dos: el intake recibe ambos consentimientos', !!(c.salud_aska && c.buro), JSON.stringify(Object.keys(c)));
      check('… salud con su versión', c.salud_aska && c.salud_aska.version === 'salud-aska-2026-11-21', c.salud_aska && c.salud_aska.version);
      check('… buró con su versión', c.buro && c.buro.version === 'buro-2026-11-21', c.buro && c.buro.version);
      check('… con el texto que se vio, en el idioma elegido', c.salud_aska && c.salud_aska.lang === 'es' && /Aska Insurance/.test(c.salud_aska.text) && /buró de crédito/.test(c.buro.text), c.buro && c.buro.text);
      check('… y la hora en que se marcó', c.buro && /^\d{4}-\d{2}-\d{2}T/.test(c.buro.checkedAt || ''), c.buro && c.buro.checkedAt);
      check('los extractos viajan como pendientes', b.form.extractos_pendientes === 'si', b.form.extractos_pendientes);
      const pend = await page.evaluate(() => { const p = document.getElementById('donePendingMsg'); return p && !p.hidden ? p.textContent : ''; });
      check('pantalla final: dice claramente que los extractos están pendientes', /estados de cuenta bancarios están pendientes/.test(pend) && /uno por cada mes/.test(pend), pend);
      await ctx.close();
    }

    // Control: with every statement, the last screen says nothing about it.
    {
      const { ctx, page } = await newPage(browser, base);
      await page.goto(base + 'index.html?lang=es');
      await submit(page, { salud_aska: true, buro: true });
      await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 }).catch(() => null);
      const hidden = await page.evaluate(() => document.getElementById('donePendingMsg').hidden);
      check('control: sin extractos pendientes, la pantalla final no lo menciona', hidden === true);
      await ctx.close();
    }

    // The API refuses (an old copy of the page without the boxes): its code, in the form's language.
    {
      const { ctx, page } = await newPage(browser, base, {
        intake: () => ({ status: 400, body: { error: { code: 'CONSENT_REQUIRED', message: 'Falta el consentimiento: credit_bureau', issues: { missing: ['credit_bureau'] } } } }),
      });
      await page.goto(base + 'index.html?lang=nl');
      await page.waitForFunction(() => document.documentElement.lang === 'nl' || document.querySelector('[data-i18n="step7.consent_buro"]').textContent.includes('machtig'), null, { timeout: 5000 }).catch(() => null);
      await submit(page, { salud_aska: true, buro: true });
      await page.waitForFunction(() => { const b = document.querySelector('#btnSubmit'); return b && !b.disabled; }, null, { timeout: 15000 });
      const e = await errorsText(page);
      check('CONSENT_REQUIRED del API: mensaje en neerlandés, sin el texto del servidor', /toestemming/.test(e) && !/Falta el consentimiento/.test(e), e.slice(0, 200));
      await ctx.close();
    }

    // ------------------------------------------------ DECISIÓN 2: página de estado
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      let status = {
        applicationNumber: 'CFL-90003', firstName: 'Ana', language: 'es', stage: 'action_needed', canUpload: true,
        missingDocuments: [{ documentType: 'bank_statement', reason: 'recent_needed', periods: ['2026-10', '2026-09', '2026-08'] }],
      };
      const posts = [];
      await page.route(url => !url.href.startsWith(base), route => {
        const r = route.request();
        if (r.url().startsWith(STATUS_API) && r.method() === 'POST') {
          const b = JSON.parse(r.postData() || '{}');
          posts.push(b);
          status = { ...status, missingDocuments: [{ ...status.missingDocuments[0], periods: status.missingDocuments[0].periods.filter(p => p !== b.period) }] };
          return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, documentType: b.documentType }) });
        }
        if (r.url().startsWith(STATUS_API)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
        }
        return route.fulfill({ status: 204, body: '' });
      });
      await page.goto(base + 'estado.html#t=' + FAKE_TOKEN);
      await page.waitForSelector('#stMain:not([hidden])');
      await page.selectOption('#langSwitch', 'es');
      const rows = await page.$$eval('.st-doc', els => els.map(e => ({ p: e.getAttribute('data-period'), h: e.querySelector('h3').textContent })));
      check('estado: una fila por mes pedido', rows.length === 3 && rows.map(r => r.p).join(',') === '2026-10,2026-09,2026-08', JSON.stringify(rows));
      check('estado: cada fila nombra su mes', /octubre 2026/.test(rows[0] && rows[0].h) && /agosto 2026/.test(rows[2] && rows[2].h), rows.map(r => r.h).join(' | '));

      await page.setInputFiles('.st-doc[data-period="2026-09"] input[type="file"]', fakePdf('extracto-sep-ficticio.pdf'));
      await page.click('.st-doc[data-period="2026-09"] button');
      await page.waitForFunction(() => document.querySelectorAll('.st-doc').length === 2, null, { timeout: 5000 }).catch(() => null);
      check('estado: el envío lleva el mes de la fila', posts.length === 1 && posts[0].period === '2026-09' && posts[0].documentType === 'bank_statement', JSON.stringify(posts.map(p => p.period)));
      const left = await page.$$eval('.st-doc', els => els.map(e => e.getAttribute('data-period')));
      check('estado: quedan los otros dos meses para mandar', left.join(',') === '2026-10,2026-08', left.join(','));
      const sent = await page.textContent('#stSentMonths');
      check('estado: dice qué mes recibió', /septiembre 2026/.test(sent || ''), sent);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
