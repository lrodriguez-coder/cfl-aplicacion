/* =============================================================================
   Prueba de navegador — ronda 13 del gauntlet (formulario #1, #2, #4, #7, #8).

   Corre el formulario REAL (index.html + app.js) en Chromium headless con toda
   la red externa interceptada: no sale nada a ningún servidor y los datos son
   ficticios.

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/ronda13-formulario.e2e.cjs

   Se comprueba:
     #1  cada intento de la MISMA solicitud lleva el mismo submissionId (aun
         tras recargar), y un envío que no contesta se corta con un mensaje
         claro en vez de quedarse "Enviando..." para siempre;
     #7  un error del servidor nunca muestra su texto crudo: se traduce por
         código al idioma del formulario, y el del captcha no sale dos veces;
     #4  la pantalla final promete el correo sólo si el API dice
         emailVerified=true, y un borrador con la verificación de hace más de
         23 h no la restaura;
     #2  los requisitos se ven en el paso 1, la fecha de ingreso al empleo
         bloquea con menos de 12 meses (no se le pide al pensionado) y la edad
         se revisa apenas el OCR lee la cédula;
     #8  una carta "independiente" no vacía el tipo de empleo ni borra los
         casilleros de payslips.
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const EMAIL = 'cliente.ficticio@example.com';

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
function fakePdf(bytes) {
  const head = Buffer.from('%PDF-1.4\n% prueba ficticia ' + (++pdfSeq) + '\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x20)]);
}

// `opts.intake(body, n)` decides each intake answer; `opts.ocr(docType)` the
// OCR data. Everything else outside the local server is refused.
async function newPage(browser, base, opts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const intakes = [];
  await page.route(url => !url.href.startsWith(base), async route => {
    const u = route.request().url();
    const body = () => JSON.parse(route.request().postData() || '{}');
    if (u.includes('/v1/public/email-verify/send')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cooldown_seconds: 60 }) });
    }
    if (u.includes('/v1/public/email-verify/confirm')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, verified: true }) });
    }
    if (u.includes('/v1/public/ocr')) {
      const b = body();
      const tipo = { cedula: 'cedula', carta: 'employment_letter', payslip: 'payslip', id_adicional: 'paspoort' }[b.docType] || 'otro';
      const extra = (opts.ocr && opts.ocr(b.docType)) || {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: Object.assign({ tipo_detectado: tipo, fecha_vencimiento: '2031-01-01' }, extra) }) });
    }
    if (u.includes('/v1/public/intake')) {
      const b = body();
      intakes.push(b);
      const a = opts.intake ? opts.intake(b, intakes.length) : { status: 201, body: { ok: true, applicationNumber: 'CFL-PRUEBA', emailVerified: true } };
      if (a === 'hang') return; // never answered
      if (a === 'abort') return route.abort('failed');
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (u.includes('recaptcha') || u.includes('gstatic')) return route.abort();
    return route.fulfill({ status: 503, body: '' });
  });
  return { ctx, page, intakes };
}

// Straight to the submit handler, like the other e2e tests.
async function submit(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector('.step[data-step="7"]').classList.add('active');
    document.querySelector('[name="acepta_terminos"]').checked = true;
    if (!document.querySelector('[name="g-recaptcha-response"]')) {
      const ta = document.createElement('textarea');
      ta.name = 'g-recaptcha-response'; ta.value = 'token-ficticio'; ta.style.display = 'none';
      document.body.appendChild(ta);
    }
    document.querySelectorAll('[required]').forEach(el => { if (!el.closest('.step[data-step="7"]')) el.required = false; });
    document.getElementById('appForm').requestSubmit();
  });
}
const errorsText = page => page.evaluate(() => (document.getElementById('errors') || { textContent: '' }).textContent);
async function waitErrors(page) {
  const back = await page.waitForFunction(() => {
    const b = document.querySelector('#btnSubmit');
    return b && !b.disabled;
  }, null, { timeout: 15000 }).then(() => true, () => false);
  // The button never came back: the send is still hanging.
  if (!back) return '(sin respuesta: el botón sigue en "Enviando...")';
  return page.evaluate(() => (document.getElementById('errors') || { textContent: '' }).textContent);
}

async function verifyEmail(page) {
  await page.evaluate(email => {
    const i = document.querySelector('[name="email"]');
    i.value = email;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('emailVerifyBtn').click();
  }, EMAIL);
  await page.waitForFunction(() => !document.getElementById('emailVerifyPanel').hidden, null, { timeout: 5000 });
  await page.evaluate(() => {
    document.getElementById('emailVerifyCode').value = '123456';
    document.getElementById('emailVerifyConfirmBtn').click();
  });
  await page.waitForFunction(() => !document.getElementById('emailVerifySuccess').hidden, null, { timeout: 5000 });
}

async function goToStep2(page, base, lang) {
  await page.goto(base + '/index.html?lang=' + (lang || 'es'));
  await page.selectOption('[name="proposito_categoria"]', 'vakashon');
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="2"].active');
}

function isoMonthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------ #1 + #7
    {
      const dbText = 'invalid input syntax for type date: "x" (violates constraint)';
      const { ctx, page, intakes } = await newPage(browser, base, {
        intake: (_b, n) => n === 1
          ? { status: 500, body: { error: { code: 'INTAKE_FAILED', message: dbText } } }
          : { status: 200, body: { ok: true, applicationNumber: 'CFL-PRUEBA', emailVerified: false } },
      });
      await page.goto(base + '/index.html?lang=es');
      // An e-mail typed (not verified): the last screen must not promise mail
      // the server will not send.
      await page.evaluate(email => { document.querySelector('[name="email"]').value = email; }, EMAIL);
      await submit(page);
      const err1 = await waitErrors(page);
      check('#7 error 500: no se muestra el texto de la base', !/invalid input|violates|syntax/.test(err1), err1.slice(0, 160));
      check('#7 error 500: mensaje claro de que los datos siguen guardados', /siguen guardados/.test(err1), err1.slice(0, 160));
      const id1 = intakes[0] && intakes[0].submissionId;
      check('#1 el intake recibe un submissionId', typeof id1 === 'string' && id1.length >= 8, String(id1));
      const draftId = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cfl_aplicacion_v1') || '{}')._submissionId; } catch (e) { return null; } });
      check('#1 el submissionId queda en el borrador', draftId === id1, String(draftId));

      await page.reload();
      await page.waitForTimeout(1500);
      await page.evaluate(email => { document.querySelector('[name="email"]').value = email; }, EMAIL);
      await submit(page);
      await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 });
      const id2 = intakes[1] && intakes[1].submissionId;
      check('#1 el reintento (tras recargar) lleva el MISMO submissionId', id2 === id1, id1 + ' vs ' + id2);
      const mailHidden = await page.evaluate(() => document.getElementById('doneEmailMsg').hidden);
      check('#4 emailVerified=false: la pantalla final NO promete el correo', mailHidden === true);
      await ctx.close();
    }

    // Network failure → friendly Dutch message (the form language), once.
    {
      const { ctx, page } = await newPage(browser, base, { intake: () => 'abort' });
      await page.goto(base + '/index.html?lang=nl');
      await page.waitForTimeout(800);
      await submit(page);
      const err = await waitErrors(page);
      check('#1/#7 sin red: mensaje en neerlandés, sin el error técnico', /verbinding/i.test(err) && !/Failed to fetch|TypeError/.test(err), err.slice(0, 160));
      await ctx.close();
    }

    // Captcha expired in English: one message, not two, and no voseo.
    {
      const { ctx, page } = await newPage(browser, base, {
        intake: () => ({ status: 401, body: { error: { code: 'CAPTCHA_EXPIRED', message: 'El captcha venció. Marcá de nuevo la casilla' } } }),
      });
      await page.goto(base + '/index.html?lang=en');
      await page.waitForTimeout(800);
      await page.evaluate(() => { window.grecaptcha = { reset: function () {} }; });
      await submit(page);
      const err = await waitErrors(page);
      check('#7 captcha vencido: en inglés, sin voseo', /tick it again/i.test(err) && !/Marcá/.test(err), err.slice(0, 160));
      const items = await page.evaluate(() => document.querySelectorAll('#errors li').length);
      check('#7 captcha vencido: un solo mensaje', items === 1, 'items = ' + items);
      await ctx.close();
    }

    // Timeout: a send that never answers is cut with a clear message.
    {
      const { ctx, page } = await newPage(browser, base, { intake: () => 'hang' });
      await page.clock.install();
      await page.goto(base + '/index.html?lang=es');
      await page.waitForTimeout(800);
      await submit(page);
      await page.waitForTimeout(500);
      await page.clock.fastForward(181 * 1000);
      const err = await waitErrors(page);
      check('#1 sin respuesta: se corta y dice que puede reenviar sin duplicar', /no se duplicará/.test(err), err.slice(0, 160));
      await ctx.close();
    }

    // ------------------------------------------------------------------ #4
    {
      const { ctx, page } = await newPage(browser, base, {});
      await page.goto(base + '/index.html?lang=es');
      await verifyEmail(page);
      await page.reload();
      await page.waitForTimeout(1500);
      check('#4 recién verificado: tras recargar sigue verificado', await page.evaluate(() => !document.getElementById('emailVerifySuccess').hidden));
      // The same draft, as if saved 30 hours ago.
      await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('cfl_aplicacion_v1'));
        d._emailVerifiedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
        localStorage.setItem('cfl_aplicacion_v1', JSON.stringify(d));
      });
      await page.reload();
      await page.waitForTimeout(1500);
      check('#4 verificación de hace 30 h: NO se restaura (pide código otra vez)', await page.evaluate(() => document.getElementById('emailVerifySuccess').hidden));

      await verifyEmail(page);
      await submit(page);
      await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 });
      const mail = await page.evaluate(() => { const m = document.getElementById('doneEmailMsg'); return m.hidden ? '' : m.textContent; });
      check('#4 emailVerified=true: la pantalla final sí promete el correo', mail.includes(EMAIL), mail);
      await ctx.close();
    }

    // ------------------------------------------------------------------ #2
    {
      const { ctx, page } = await newPage(browser, base, {});
      await page.goto(base + '/index.html?lang=es');
      // The page loads in Papiamentu and then applies the language asked for.
      await page.waitForFunction(() => /Requisitos/.test((document.getElementById('requisitosNote') || { textContent: '' }).textContent), null, { timeout: 5000 }).catch(() => {});
      const req = await page.evaluate(() => { const n = document.getElementById('requisitosNote'); return n && n.offsetParent !== null ? n.textContent : ''; });
      check('#2 paso 1 muestra los requisitos (18+ y 1 año o pensión)', /18 años/.test(req) && /1 año/.test(req) && /pensión/.test(req), req.replace(/\s+/g, ' ').slice(0, 160));
      await page.selectOption('[name="proposito_categoria"]', 'vakashon');
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="2"].active');
      await page.selectOption('[name="tipo_empleado"]', 'fijo');
      await page.selectOption('[name="frecuencia_salario"]', 'mensual');
      const visible = await page.evaluate(() => { const f = document.querySelector('[name="fecha_ingreso_empleo"]'); return !!f && f.offsetParent !== null && f.required; });
      check('#2 empleado fijo: se pide la fecha de ingreso (obligatoria)', visible);
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(80 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      if (await page.$('[name="fecha_ingreso_empleo"]')) await page.fill('[name="fecha_ingreso_empleo"]', isoMonthsAgo(8));
      await page.click('#btnNext');
      await page.waitForTimeout(400);
      const stillStep2 = await page.evaluate(() => document.querySelector('.step.active').dataset.step);
      const err = await errorsText(page) || await page.evaluate(() => document.body.innerText);
      check('#2 8 meses de antigüedad: no avanza', stillStep2 === '2', 'paso ' + stillStep2);
      check('#2 8 meses: el mensaje explica el año de empleo', /al menos 1 año con su empleador actual/.test(err));
      if (await page.$('[name="fecha_ingreso_empleo"]')) await page.fill('[name="fecha_ingreso_empleo"]', isoMonthsAgo(26));
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active', { timeout: 5000 }).catch(() => {});
      check('#2 26 meses de antigüedad: avanza', await page.evaluate(() => document.querySelector('.step.active').dataset.step) === '3');
      await page.click('#btnPrev').catch(() => {});
      await page.waitForSelector('.step[data-step="2"].active', { timeout: 5000 }).catch(() => {});
      await page.selectOption('[name="tipo_empleado"]', 'pensionado');
      const pens = await page.evaluate(() => { const f = document.querySelector('[name="fecha_ingreso_empleo"]'); return f ? { exists: true, shown: f.offsetParent !== null, req: f.required } : { exists: false }; });
      check('#2 pensionado: el campo existe pero no se le pide', pens.exists && !pens.shown && !pens.req, JSON.stringify(pens));
      await ctx.close();
    }
    {
      // A cédula that says 16 years old: told on step 2, right after the OCR.
      const born = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 16); return d.toISOString().slice(0, 10); })();
      const { ctx, page } = await newPage(browser, base, { ocr: t => (t === 'cedula' ? { fecha_nacimiento: born, nombre_completo: 'Menor Ficticio' } : {}) });
      await goToStep2(page, base, 'es');
      await page.selectOption('[name="tipo_empleado"]', 'pensionado');
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-menor.pdf', mimeType: 'application/pdf', buffer: fakePdf(80 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="warn"]', { timeout: 10000 }).catch(() => {});
      const st = await page.evaluate(() => { const b = document.querySelector('[data-preview-for="doc_cedula"] .ocr-status'); return b ? b.textContent : ''; });
      check('#2 cédula de menor: avisa apenas vuelve el OCR', /menos de 18 años/.test(st), st);
      await page.click('#btnNext');
      await page.waitForTimeout(400);
      check('#2 cédula de menor: no deja pasar del paso 2', await page.evaluate(() => document.querySelector('.step.active').dataset.step) === '2');
      await ctx.close();
    }

    // ------------------------------------------------------------------ #8
    {
      const { ctx, page } = await newPage(browser, base, { ocr: t => (t === 'carta' ? { tipo_empleo: 'independiente', empleador: 'Empresa Ficticia NV' } : {}) });
      await goToStep2(page, base, 'es');
      await page.selectOption('[name="tipo_empleado"]', 'fijo');
      await page.selectOption('[name="frecuencia_salario"]', 'mensual');
      if (await page.$('[name="fecha_ingreso_empleo"]')) await page.fill('[name="fecha_ingreso_empleo"]', isoMonthsAgo(30));
      await page.setInputFiles('[name="doc_cedula"]', { name: 'cedula-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(80 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active');
      await page.setInputFiles('[name="doc_payslips_1"]', { name: 'payslip-ficticio.pdf', mimeType: 'application/pdf', buffer: fakePdf(60 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_payslips_1"] .ocr-status[data-kind="ok"]', { timeout: 10000 });
      await page.setInputFiles('[name="doc_carta_trabajo"]', { name: 'carta-ficticia.pdf', mimeType: 'application/pdf', buffer: fakePdf(60 * 1024) });
      await page.waitForSelector('[data-preview-for="doc_carta_trabajo"] .ocr-status', { timeout: 10000 });
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => {
        const i = document.querySelector('[name="doc_payslips_1"]');
        return {
          tipo: document.querySelector('[name="tipo_empleado"]').value,
          freq: document.querySelector('[name="frecuencia_salario"]').value,
          payslip: i && i.files && i.files[0] ? i.files[0].name : null,
          warn: (document.querySelector('.tipo-empleo-warn') || { textContent: '' }).textContent,
        };
      });
      check('#8 carta "independiente": el tipo de empleo sigue en "fijo"', after.tipo === 'fijo', after.tipo);
      check('#8 carta "independiente": la frecuencia no se borra', after.freq === 'mensual', after.freq);
      check('#8 carta "independiente": el payslip adjunto sigue ahí', after.payslip === 'payslip-ficticio.pdf', String(after.payslip));
      check('#8 carta "independiente": se avisa que verifique el tipo', /otro tipo de empleo/.test(after.warn), after.warn);
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
