/* =============================================================================
   Prueba de navegador: la solicitud viaja con la sesión en la que se
   verificaron el email y el móvil.

   Leonard 18-nov-2026: submitToV2 tiene que mandar trackingId (getTrackingId())
   para que el servidor ate la verificación del email a la sesión. El servidor
   (public-intake → findVerifiedIntakeContacts) sólo manda el acuse y marca el
   contacto como verificado si el código se confirmó con ESE tracking_id.

   Se comprueba:
     1. el intake recibe trackingId y es el mismo con que se confirmó el código;
     2. tras recargar (el borrador vuelve con el email ya verificado) la sesión
        sigue siendo la misma — si no, la pantalla diría "verificado" y el
        servidor no lo aceptaría;
     3. un borrador viejo, sin la sesión guardada, NO da el email por
        verificado: se pide el código otra vez.

   Igual que borrador-y-peso.e2e.cjs: toda la red externa está interceptada y
   los datos son ficticios.

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/sesion-verificacion.e2e.cjs
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

async function newPage(browser, base, captured) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(url => !url.href.startsWith(base), async route => {
    const u = route.request().url();
    const body = () => JSON.parse(route.request().postData() || '{}');
    if (u.includes('/v1/public/email-verify/send')) {
      captured.sendTracking = body().tracking_id;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cooldown_seconds: 60 }) });
    }
    if (u.includes('/v1/public/email-verify/confirm')) {
      captured.confirmTracking = body().tracking_id;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, verified: true }) });
    }
    if (u.includes('/v1/public/intake')) {
      captured.intake = body();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, applicationNumber: 'CFL-PRUEBA' }) });
    }
    if (u.includes('recaptcha') || u.includes('gstatic')) return route.abort();
    return route.fulfill({ status: 503, body: '' });
  });
  return { ctx, page };
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

const emailShownVerified = page => page.evaluate(() => !document.getElementById('emailVerifySuccess').hidden);

// Same shortcut as borrador-y-peso.e2e.cjs: straight to the submit handler.
async function submit(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector('.step[data-step="7"]').classList.add('active');
    document.querySelector('[name="acepta_terminos"]').checked = true;
    // The two consent boxes of their own (r14, Leonard 21-nov-2026): without them the form does not send.
    document.querySelector('[name="consentimiento_salud_aska"]').checked = true;
    document.querySelector('[name="consentimiento_buro"]').checked = true;
    const ta = document.createElement('textarea');
    ta.name = 'g-recaptcha-response'; ta.value = 'token-ficticio'; ta.style.display = 'none';
    document.body.appendChild(ta);
    document.querySelectorAll('[required]').forEach(el => { if (!el.closest('.step[data-step="7"]')) el.required = false; });
    document.getElementById('appForm').requestSubmit();
  });
  await page.waitForSelector('.step[data-step="done"].active', { timeout: 15000 });
}

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    // 1 + 2: verify, reload, submit — one session throughout.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await page.goto(base + '/index.html?lang=es');
      await verifyEmail(page);
      check('el código se pidió y confirmó con la misma sesión',
        !!captured.confirmTracking && captured.sendTracking === captured.confirmTracking, String(captured.confirmTracking));

      await page.reload();
      await page.waitForTimeout(2000);
      check('recarga: el email sigue verificado', await emailShownVerified(page));

      await submit(page);
      const sent = captured.intake && captured.intake.trackingId;
      check('envío: el intake recibe trackingId', typeof sent === 'string' && sent.length > 0, String(sent));
      check('envío: es la sesión en que se confirmó el código (aun tras recargar)',
        sent === captured.confirmTracking, sent + ' vs ' + captured.confirmTracking);
      check('envío: el email que viaja es el verificado', captured.intake && captured.intake.form && captured.intake.form.email === EMAIL);

      const draftAfter = await page.evaluate(() => localStorage.getItem('cfl_aplicacion_v1'));
      check('envío: el borrador (con la sesión) queda borrado', draftAfter === null, String(draftAfter).slice(0, 80));
      await ctx.close();
    }

    // 3: a draft saved before the session was kept.
    {
      const captured = {};
      const { ctx, page } = await newPage(browser, base, captured);
      await page.goto(base + '/index.html?lang=es');
      await page.evaluate(email => {
        localStorage.setItem('cfl_aplicacion_v1', JSON.stringify({
          email: email, _step: 1, _lang: 'es', _emailVerifiedFor: email, _updated: new Date().toISOString(),
        }));
      }, EMAIL);
      await page.reload();
      await page.waitForTimeout(2000);
      const restored = await page.evaluate(() => document.querySelector('[name="email"]').value);
      check('borrador viejo: el email vuelve al campo', restored === EMAIL, restored);
      check('borrador viejo: NO se da por verificado (se pide el código otra vez)', !(await emailShownVerified(page)));
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
