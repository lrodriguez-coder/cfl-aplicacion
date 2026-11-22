/* =============================================================================
   Prueba de navegador: la cédula y el correo del cónyuge (Leonard, 22-nov-2026).

   Se comprueba, en index.html (Paso 4, donde vive el bloque del cónyuge):
     1. casado: la foto de la cédula del cónyuge es obligatoria y sin ella no
        avanza; soltero: el casillero se oculta y deja de ser obligatorio;
     2. la lectura de esa cédula llena nombre, apellido y número del cónyuge
        (y la Referencia 1), sin tocar los datos del solicitante;
     3. si la "cédula del cónyuge" es la del propio solicitante, se dice y no
        avanza;
     4. el correo del cónyuge: el mismo que el del solicitante no se acepta;
        otro pide el código con `para: 'conyuge'` en la misma sesión y queda
        "verificado" al confirmarlo;
     5. pasar de casado a soltero vacía el casillero, la lectura y el correo;
     6. el envío lleva el documento como `spouse_cedula`, lo leído como
        ocr.doc_cedula_conyuge y el correo del cónyuge.
   No hay campo de dirección del cónyuge: es la del solicitante.

   La red se intercepta siempre (datos ficticios).

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/conyuge-cedula.e2e.cjs
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
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

// Fictitious cards. The applicant's says married.
const CEDULA_SOLICITANTE = {
  tipo_detectado: 'cedula', nombre_completo: 'PRUEBA FICTICIA SOLICITANTE', numero_id: '1980020200',
  fecha_nacimiento: '1980-02-02', fecha_vencimiento: '2031-02-02', estado_civil: 'kasá',
};
const CEDULA_CONYUGE = {
  tipo_detectado: 'cedula', nombre_completo: 'ANA MARIA DE PRUEBA ROSA', numero_id: '1990010100',
  fecha_nacimiento: '1990-01-01', fecha_vencimiento: '2030-01-01',
};

async function newPage(browser, base) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const st = { nextCedula: CEDULA_SOLICITANTE, sends: [], confirms: [], intakes: [] };
  await page.route(url => !url.href.startsWith(base), async route => {
    const u = route.request().url();
    const body = () => JSON.parse(route.request().postData() || '{}');
    if (u.includes('/v1/public/ocr')) {
      const b = body();
      const data = b.docType === 'cedula' ? st.nextCedula : { tipo_detectado: { carta: 'employment_letter', payslip: 'payslip' }[b.docType] || 'otro' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: data }) });
    }
    if (u.includes('/v1/public/email-verify/send')) {
      st.sends.push(body());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cooldown_seconds: 60 }) });
    }
    if (u.includes('/v1/public/email-verify/confirm')) {
      st.confirms.push(body());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, verified: true }) });
    }
    if (u.includes('/v1/public/intake')) {
      st.intakes.push(body());
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, applicationNumber: 'CFL-PRUEBA', emailVerified: false }) });
    }
    if (u.includes('recaptcha') || u.includes('gstatic')) return route.abort();
    return route.fulfill({ status: 204, body: '' });
  });
  return { ctx, page, st };
}

const activeStep = page => page.evaluate(() => document.querySelector('.step.active').dataset.step);
const errorsText = page => page.evaluate(() => (document.getElementById('errors') || { textContent: '' }).textContent);
const val = (page, n) => page.$eval('[name="' + n + '"]', el => el.value);

// To Step 4 with the applicant's card read in Step 2; nothing else is
// required on the way (it is not what this test is about).
async function hastaPaso4(page, base) {
  await page.goto(base + 'index.html?lang=es');
  await page.selectOption('[name="proposito_categoria"]', 'vakashon');
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="2"].active');
  await page.selectOption('[name="tipo_empleado"]', 'pensionado');
  await page.setInputFiles('[name="doc_cedula"]', fakePdf('cedula-solicitante-ficticia.pdf'));
  await page.waitForSelector('[data-preview-for="doc_cedula"] .ocr-status', { timeout: 10000 });
  await page.evaluate(() => { document.querySelectorAll('[required]').forEach(el => { el.required = false; }); });
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="3"].active', { timeout: 5000 });
  await page.click('#btnNext');
  await page.waitForSelector('.step[data-step="4"].active', { timeout: 5000 });
}

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  try {
    // 1–5 on one page.
    {
      const { ctx, page, st } = await newPage(browser, base);
      await hastaPaso4(page, base);
      check('no hay campo de dirección del cónyuge', (await page.$$('#conyugeBlock [name*="direccion"]')).length === 0);

      await page.selectOption('[name="estado_civil"]', 'kasá');
      check('casado: el bloque del cónyuge se ve', await page.isVisible('#conyugeBlock'));
      check('casado: la foto de la cédula del cónyuge es obligatoria',
        await page.$eval('[name="doc_cedula_conyuge"]', el => el.required));
      check('casado: el correo del cónyuge es opcional', !(await page.$eval('[name="conyuge_email"]', el => el.required)));

      await page.fill('[name="telefono_movil"]', '+5999 111 2222');
      await page.fill('[name="conyuge_telefono"]', '+5999 333 4444');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      check('sin la foto no avanza del Paso 4', (await activeStep(page)) === '4');
      check('sin la foto: el aviso nombra la cédula del cónyuge', /Cédula de su cónyuge/.test(await errorsText(page)), (await errorsText(page)).slice(0, 160));

      // 3. The applicant's own card in the spouse slot.
      st.nextCedula = CEDULA_SOLICITANTE;
      await page.setInputFiles('[name="doc_cedula_conyuge"]', fakePdf('otra-vez-la-del-solicitante.pdf'));
      await page.waitForSelector('[data-preview-for="doc_cedula_conyuge"] .ocr-status', { timeout: 10000 });
      await page.waitForTimeout(300);
      const aviso = await page.$eval('[data-preview-for="doc_cedula_conyuge"] .ocr-status', el => el.textContent);
      check('cédula propia: lo dice en el casillero', /es la suya/.test(aviso), aviso.slice(0, 120));
      check('cédula propia: no llena el nombre del cónyuge', (await val(page, 'conyuge_nombre')) === '');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      check('cédula propia: no avanza', (await activeStep(page)) === '4');
      check('cédula propia: el error lo explica', /es la suya/.test(await errorsText(page)), (await errorsText(page)).slice(0, 160));

      // 2. The spouse's card.
      st.nextCedula = CEDULA_CONYUGE;
      await page.setInputFiles('[name="doc_cedula_conyuge"]', fakePdf('cedula-conyuge-ficticia.pdf'));
      await page.waitForFunction(() => document.querySelector('[name="conyuge_numero_id"]').value !== '', null, { timeout: 10000 });
      check('lectura: nombre del cónyuge', (await val(page, 'conyuge_nombre')) === 'ANA', await val(page, 'conyuge_nombre'));
      check('lectura: apellido del cónyuge', (await val(page, 'conyuge_apellido')) === 'MARIA DE PRUEBA ROSA', await val(page, 'conyuge_apellido'));
      check('lectura: número del cónyuge', (await val(page, 'conyuge_numero_id')) === '1990010100');
      check('lectura: la Referencia 1 se copia del cónyuge', (await val(page, 'ref1_nombre')) === 'ANA MARIA DE PRUEBA ROSA', await val(page, 'ref1_nombre'));
      const leida = await page.$eval('[data-preview-for="doc_cedula_conyuge"]', el => el.textContent);
      check('lectura: dice qué leyó', /Cédula de su cónyuge leída: ANA MARIA DE PRUEBA ROSA/.test(leida), leida.slice(0, 160));
      const solicitante = await page.evaluate(() => (document.querySelector('[name="nombre_completo"]') || {}).value || '');
      check('lectura: el nombre del solicitante no cambia', !/ANA MARIA/.test(solicitante), solicitante);

      // 4. The spouse's e-mail.
      await page.fill('[name="email"]', 'solicitante.prueba@example.com');
      await page.fill('[name="conyuge_email"]', 'Solicitante.Prueba@example.com');
      await page.click('#conyugeEmailVerifyBtn');
      await page.waitForTimeout(200);
      const s1 = await page.$eval('#conyugeEmailVerifyStatus', el => el.textContent);
      check('correo propio: no se manda código', st.sends.length === 0 && /no puede ser el mismo/.test(s1), s1);
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      check('correo propio: no avanza', /no puede ser el mismo que el suyo/.test(await errorsText(page)));

      await page.fill('[name="conyuge_email"]', 'conyuge.prueba@example.com');
      const pendiente = await page.$eval('#conyugeEmailVerifyStatus', el => el.textContent);
      check('correo escrito sin verificar: lo dice', /Sin verificar/.test(pendiente), pendiente);
      await page.click('#conyugeEmailVerifyBtn');
      await page.waitForSelector('#conyugeEmailVerifyPanel:not([hidden])', { timeout: 5000 });
      const send = st.sends[0] || {};
      check('código: para el cónyuge, a su correo, en la sesión del formulario',
        send.para === 'conyuge' && send.email === 'conyuge.prueba@example.com' && !!send.tracking_id, JSON.stringify(send));
      await page.fill('#conyugeEmailVerifyCode', '123456');
      await page.click('#conyugeEmailVerifyConfirmBtn');
      await page.waitForSelector('#conyugeEmailVerifySuccess:not([hidden])', { timeout: 5000 });
      check('código: confirmado en la misma sesión', (st.confirms[0] || {}).tracking_id === send.tracking_id);
      check('correo verificado: el campo queda fijo', await page.$eval('[name="conyuge_email"]', el => el.readOnly));

      // 5. Married → single.
      await page.selectOption('[name="estado_civil"]', 'soltero');
      check('soltero: el bloque se oculta', !(await page.isVisible('#conyugeBlock')));
      check('soltero: la foto deja de ser obligatoria', !(await page.$eval('[name="doc_cedula_conyuge"]', el => el.required)));
      check('soltero: el casillero queda vacío', (await page.$eval('[name="doc_cedula_conyuge"]', el => el.files.length)) === 0);
      check('soltero: el correo del cónyuge se borra y deja de estar verificado',
        (await val(page, 'conyuge_email')) === '' && (await page.isHidden('#conyugeEmailVerifySuccess')));
      await ctx.close();
    }

    // 6. What the send carries.
    {
      const { ctx, page, st } = await newPage(browser, base);
      await hastaPaso4(page, base);
      await page.selectOption('[name="estado_civil"]', 'kasá');
      await page.fill('[name="conyuge_telefono"]', '+5999 333 4444');
      st.nextCedula = CEDULA_CONYUGE;
      await page.setInputFiles('[name="doc_cedula_conyuge"]', fakePdf('cedula-conyuge-ficticia.pdf'));
      await page.waitForFunction(() => document.querySelector('[name="conyuge_numero_id"]').value !== '', null, { timeout: 10000 });
      await page.fill('[name="conyuge_email"]', 'conyuge.envio@example.com');
      await page.evaluate(() => {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
        document.querySelector('.step[data-step="7"]').classList.add('active');
        document.querySelector('[name="acepta_terminos"]').checked = true;
        for (const k of ['salud_aska', 'buro']) {
          const cb = document.querySelector('[name="consentimiento_' + k + '"]');
          if (!cb.checked) cb.click();
        }
        const ta = document.createElement('textarea');
        ta.name = 'g-recaptcha-response'; ta.value = 'token-ficticio'; ta.style.display = 'none';
        document.body.appendChild(ta);
        document.querySelectorAll('[required]').forEach(el => { if (!el.closest('.step[data-step="7"]')) el.required = false; });
        document.getElementById('appForm').requestSubmit();
      });
      await page.waitForFunction(() => document.querySelector('.step[data-step="done"].active'), null, { timeout: 15000 }).catch(() => null);
      const b = st.intakes[0] || {};
      const tipos = (b.documents || []).map(d => d.documentType);
      check('envío: la foto va como spouse_cedula', tipos.includes('spouse_cedula'), tipos.join(','));
      check('envío: la cédula del solicitante sigue como cedula_front', tipos.filter(t => t === 'cedula_front').length === 1, tipos.join(','));
      check('envío: lo leído va como ocr.doc_cedula_conyuge',
        !!(b.ocr && b.ocr.doc_cedula_conyuge && b.ocr.doc_cedula_conyuge.numero_id === '1990010100'));
      check('envío: el correo del cónyuge va en el formulario', b.form && b.form.conyuge_email === 'conyuge.envio@example.com');
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? failures + ' FAIL' : 'TODO OK');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
