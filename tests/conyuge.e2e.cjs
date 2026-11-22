/* =============================================================================
   Prueba de navegador: el cónyuge (Leonard, 22-nov-2026).

   Se comprueba:
     1. estado.html con spouse = 'data_needed': pide nombre y teléfono del
        cónyuge (en los 4 idiomas, "usted" en es) y el envío va a /spouse con
        el token correcto;
     2. el API responde SPOUSE_PHONE_IS_APPLICANT: se dice en la página;
     3. spouse = 'awaiting_confirmation': "Esperando la confirmación de su
        cónyuge", sin formulario; 'in_review' no dice que se envió nada;
        data_needed por lo declarado no dice "su cédula";
     4. sin `spouse` (respuesta de siempre): nada nuevo en la página;
     5. index.html: el paso 4 no deja seguir con el teléfono del cónyuge igual
        al del solicitante (decisión 2), y sí con otro número.

   El API se intercepta siempre (datos ficticios).

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/conyuge.e2e.cjs
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const FAKE_TOKEN = 'eyJhaWQiOiJ4In0~c2lnbmF0dXJl';
const API = 'https://api.curloans.com/v1/public/application-status/';

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

const BASE_STATUS = {
  applicationNumber: 'CFL-90002', firstName: 'Ana', language: 'es', stage: 'in_analysis',
  missingDocuments: [], canUpload: false, linkExpiresAt: '2026-12-19T00:00:00.000Z',
};

async function statusPage(browser, base, status, postAnswer) {
  const ctx = await browser.newContext({ locale: 'es' });
  const page = await ctx.newPage();
  const posts = [];
  await page.route(url => !url.href.startsWith(base), async route => {
    const req = route.request();
    const u = req.url();
    if (u.startsWith(API) && req.method() === 'POST') {
      posts.push({ url: u, body: JSON.parse(req.postData() || '{}') });
      return route.fulfill(postAnswer || { status: 201, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (u.startsWith(API) && req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(base + 'estado.html#t=' + FAKE_TOKEN);
  await page.waitForSelector('#stMain:not([hidden])');
  return { page, posts, ctx };
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  try {
    // 1. data_needed
    {
      const { page, posts, ctx } = await statusPage(browser, base, { ...BASE_STATUS, spouse: 'data_needed' });
      await page.selectOption('#langSwitch', 'es');
      check('data_needed: se muestra la tarjeta del cónyuge', await page.isVisible('#stSpouse'));
      const txt = await page.textContent('#stSpouse');
      check('es: pide los datos de su cónyuge (usted)', /Necesitamos los datos de su cónyuge/.test(txt) && /indíquenos/.test(txt), txt.slice(0, 80));
      const titles = {};
      for (const l of ['pap', 'es', 'en', 'nl']) {
        await page.selectOption('#langSwitch', l);
        titles[l] = await page.textContent('#stSpouse .st-stage');
      }
      check('los 4 idiomas cambian el texto', new Set(Object.values(titles)).size === 4, JSON.stringify(titles));
      await page.selectOption('#langSwitch', 'es');
      await page.fill('#stSpouse input[name=fullName]', 'TEST Conyuge Ficticio');
      await page.fill('#stSpouse input[name=phone]', '+5999 6333 444');
      await page.click('#stSpouse button');
      await page.waitForFunction(() => /Recibido/.test(document.querySelector('#stSpouse .st-msg').textContent));
      check('el envío va a /spouse del mismo token', posts.length === 1 && posts[0].url === API + encodeURIComponent(FAKE_TOKEN) + '/spouse', posts[0] && posts[0].url);
      check('con nombre y teléfono', posts[0] && posts[0].body.fullName === 'TEST Conyuge Ficticio' && posts[0].body.phone === '+5999 6333 444');
      await ctx.close();
    }
    // 2. The API refuses the applicant's own phone
    {
      const { page, ctx } = await statusPage(browser, base, { ...BASE_STATUS, spouse: 'data_needed' },
        { status: 400, contentType: 'application/json', body: '{"error":{"code":"SPOUSE_PHONE_IS_APPLICANT"}}' });
      await page.selectOption('#langSwitch', 'es');
      await page.fill('#stSpouse input[name=fullName]', 'TEST Conyuge Ficticio');
      await page.fill('#stSpouse input[name=phone]', '+5999 6111 999');
      await page.click('#stSpouse button');
      await page.waitForFunction(() => /no puede ser el mismo/.test(document.querySelector('#stSpouse .st-msg').textContent));
      check('SPOUSE_PHONE_IS_APPLICANT se dice en la página', true);
      await ctx.close();
    }
    // 3. awaiting_confirmation
    {
      const { page, ctx } = await statusPage(browser, base, { ...BASE_STATUS, spouse: 'awaiting_confirmation' });
      await page.selectOption('#langSwitch', 'es');
      check('awaiting: "Esperando la confirmación de su cónyuge"',
        (await page.textContent('#stSpouse .st-stage')) === 'Esperando la confirmación de su cónyuge');
      check('awaiting: sin formulario', (await page.$$('#stSpouse input')).length === 0);
      await ctx.close();
    }
    // 3b. in_review (link not sent / expired): no claim that a link went out
    {
      const { page, ctx } = await statusPage(browser, base, { ...BASE_STATUS, spouse: 'in_review' });
      await page.selectOption('#langSwitch', 'es');
      const txt = await page.textContent('#stSpouse');
      check('in_review: "Estamos revisando la confirmación de su cónyuge"', /Estamos revisando la confirmación de su cónyuge/.test(txt), txt);
      check('in_review: NO dice que se envió un enlace', !/enviamos/i.test(txt), txt);
      await ctx.close();
    }
    // 3c. data_needed because the applicant declared married: no "su cédula indica"
    {
      const { page, ctx } = await statusPage(browser, base, { ...BASE_STATUS, spouse: 'data_needed', spouseNeed: 'declared' });
      await page.selectOption('#langSwitch', 'es');
      const txt = await page.textContent('#stSpouse');
      check('data_needed por lo declarado: "Usted indicó que es casado/a"', /Usted indicó que es casado/.test(txt) && !/Su cédula/.test(txt), txt.slice(0, 120));
      await ctx.close();
    }
    // 4. No spouse key
    {
      const { page, ctx } = await statusPage(browser, base, BASE_STATUS);
      check('sin spouse: nada nuevo', await page.isHidden('#stSpouse'));
      await ctx.close();
    }
    // 5. index.html, step 4 (where both the spouse and the applicant's phone live)
    {
      const ctx = await browser.newContext({ locale: 'es' });
      const page = await ctx.newPage();
      await page.route(url => !url.href.startsWith(base), route => route.fulfill({ status: 204, body: '' }));
      await page.goto(base + 'index.html?lang=es');
      await page.selectOption('[name="proposito_categoria"]', 'vakashon');
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="2"].active');
      await page.selectOption('[name="tipo_empleado"]', 'pensionado');
      // Only this check speaks: nothing else is required on the walk.
      await page.evaluate(() => { document.querySelectorAll('[required]').forEach(el => { el.required = false; }); });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active', { timeout: 5000 });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="4"].active', { timeout: 5000 });
      await page.selectOption('[name="estado_civil"]', 'kasá');
      check('casado: el teléfono del cónyuge es obligatorio', await page.$eval('[name="conyuge_telefono"]', el => el.required));
      await page.fill('[name="telefono_movil"]', '+599 9 512-3456');
      await page.fill('[name="conyuge_nombre"]', 'TEST');
      await page.fill('[name="conyuge_apellido"]', 'Conyuge');
      await page.fill('[name="conyuge_telefono"]', '95123456');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const stepNow = await page.evaluate(() => document.querySelector('.step.active').dataset.step);
      const errs = await page.evaluate(() => document.getElementById('errors').textContent);
      check('mismo número: no avanza del Paso 4', stepNow === '4', 'paso ' + stepNow);
      check('mismo número: "no puede ser el mismo que el suyo"', /no puede ser el mismo que el suyo/.test(errs), errs.slice(0, 200));
      await page.fill('[name="conyuge_telefono"]', '+5999 765 4321');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const errs2 = await page.evaluate(() => document.getElementById('errors').textContent);
      check('otro número: ese aviso ya no aparece', !/no puede ser el mismo que el suyo/.test(errs2), errs2.slice(0, 200));
      // Local trunk 0: "09 5123456" is the applicant's +599 9 512-3456.
      await page.fill('[name="conyuge_telefono"]', '09 5123456');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const errs3 = await page.evaluate(() => document.getElementById('errors').textContent);
      check('0 de troncal: "09 5123456" es el mismo número', /no puede ser el mismo que el suyo/.test(errs3), errs3.slice(0, 120));
      // A shared home landline is fine.
      await page.fill('[name="telefono_casa"]', '7 654 3210');
      await page.fill('[name="conyuge_telefono"]', '7 654 3210');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const errs4 = await page.evaluate(() => document.getElementById('errors').textContent);
      check('el fijo de la casa compartido no choca', !/no puede ser el mismo que el suyo/.test(errs4), errs4.slice(0, 120));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
  process.exit(failures ? 1 : 0);
})();
