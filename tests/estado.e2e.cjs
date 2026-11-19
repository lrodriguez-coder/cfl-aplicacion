/* =============================================================================
   Prueba de navegador: estado.html (Ronda 13, formulario#0).

   Después de enviar, la persona abre estado.html#t=<token> y ve la etapa de su
   solicitud; si la frena un documento, lo manda desde ahí.

   Se comprueba:
     1. sin token / token malo: pantalla "el enlace no es válido", sin pedir nada;
     2. enlace vencido (410): "el enlace venció";
     3. con un documento pedido: el nombre, el número, la etapa "falta un
        documento" y un selector de archivo que acepta PDF y NO fuerza la cámara;
     4. el envío manda el tipo pedido con el archivo en base64 al token correcto;
     5. los 4 idiomas (pap, es, en, nl) cambian todo el texto, y el idioma de la
        solicitud ("es") se usa por defecto;
     6. la pantalla final de index.html tiene el enlace, traducido en los 4.

   Con STATUS_TOKEN (y el API local en :3090 sobre una copia descartable) el GET
   va al API real; sin él, se intercepta con una respuesta ficticia. El POST se
   intercepta siempre (en local no hay S3). Datos ficticios.

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       [STATUS_TOKEN=… STATUS_API=http://localhost:3090] node tests/estado.e2e.cjs
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const LIVE_TOKEN = process.env.STATUS_TOKEN || '';
const LIVE_API = process.env.STATUS_API || 'http://localhost:3090';
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

const FAKE_STATUS = {
  applicationNumber: 'CFL-90001', firstName: 'Ana', language: 'es', stage: 'action_needed',
  missingDocuments: [{ documentType: 'bank_statement', reason: 'recent_needed' }], canUpload: true,
  linkExpiresAt: '2026-12-19T00:00:00.000Z',
};

async function newPage(browser, base, opts) {
  const ctx = await browser.newContext({ locale: 'pap' });
  const page = await ctx.newPage();
  const posts = [];
  await page.route(url => !url.href.startsWith(base), async route => {
    const req = route.request();
    const u = req.url();
    if (u.startsWith(API) && req.method() === 'POST') {
      posts.push({ url: u, body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (u.startsWith(API) && req.method() === 'GET') {
      if (opts.status === 'live') {
        const r = await fetch(LIVE_API + '/v1/public/application-status/' + u.slice(API.length));
        return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
      }
      if (opts.status === 410) return route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":{"code":"LINK_EXPIRED"}}' });
      if (opts.status === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"LINK_INVALID"}}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.status) });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  return { page, posts, ctx };
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  try {
    // 1. No token
    {
      const { page, ctx } = await newPage(browser, base, { status: 404 });
      await page.goto(base + 'estado.html');
      await page.waitForSelector('#stError:not([hidden])');
      check('sin token: pantalla de enlace no válido', /no ta bálido/.test(await page.textContent('#stErrorTitle')));
      check('sin token: no se muestra estado', await page.isHidden('#stMain'));
      await ctx.close();
    }
    // 1b. Bad token answered 404
    {
      const { page, ctx } = await newPage(browser, base, { status: 404 });
      await page.goto(base + 'estado.html#t=' + FAKE_TOKEN);
      await page.waitForSelector('#stError:not([hidden])');
      check('token malo (404): enlace no válido', /no ta bálido/.test(await page.textContent('#stErrorTitle')));
      await ctx.close();
    }
    // 2. Expired
    {
      const { page, ctx } = await newPage(browser, base, { status: 410 });
      await page.goto(base + 'estado.html#t=' + FAKE_TOKEN);
      await page.waitForSelector('#stError:not([hidden])');
      check('vencido (410): "e link a vense"', /a vense/.test(await page.textContent('#stErrorTitle')));
      await ctx.close();
    }
    // 3-5. A document is asked for
    {
      const live = !!LIVE_TOKEN;
      const token = live ? LIVE_TOKEN : FAKE_TOKEN;
      const { page, posts, ctx } = await newPage(browser, base, { status: live ? 'live' : FAKE_STATUS });
      await page.goto(base + 'estado.html#t=' + token);
      await page.waitForSelector('#stMain:not([hidden])');
      const number = await page.textContent('#stNumber');
      check('muestra el número de solicitud' + (live ? ' (API real)' : ''), /^CFL-\d+$/.test(number), number);
      const lang = await page.$eval('html', el => el.lang);
      // The demo client has no stored language: the browser locale (pap) stays.
      check('idioma por defecto: el de la solicitud, o el del navegador', live ? lang === 'pap' : lang === 'es', lang);
      await page.selectOption('#langSwitch', 'es');
      check('es: etapa "Falta un documento"', (await page.textContent('#stStage')) === 'Falta un documento');
      check('es: saludo con el primer nombre', /^Hola \S+,$/.test(await page.textContent('#stHello')));
      check('es: documento pedido "Estado de cuenta bancario"', (await page.textContent('.st-doc h3')) === 'Estado de cuenta bancario');
      check('es: trato de usted', /Envíe|necesitamos/i.test(await page.textContent('#stDocList')));
      const acc = await page.$eval('.st-doc input[type=file]', el => ({ accept: el.accept, capture: el.hasAttribute('capture') }));
      check('el selector acepta PDF e imágenes y NO fuerza la cámara', acc.accept.includes('application/pdf') && !acc.capture, JSON.stringify(acc));
      const texts = {};
      for (const l of ['pap', 'es', 'en', 'nl']) {
        await page.selectOption('#langSwitch', l);
        texts[l] = (await page.textContent('#stStage')) + '|' + (await page.textContent('.st-doc h3')) + '|' + (await page.textContent('#stNumberLabel'));
      }
      check('los 4 idiomas cambian el texto', new Set(Object.values(texts)).size === 4, JSON.stringify(texts));
      check('nl: "u"', /\bu\b|Uw /.test(await page.textContent('#stMain')));

      // Upload
      await page.selectOption('#langSwitch', 'es');
      await page.click('.st-doc .btn');
      check('sin archivo: pide elegir uno', /elija un archivo/.test(await page.textContent('.st-msg')));
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500, 0x20), Buffer.from('%%EOF')]);
      await page.setInputFiles('.st-doc input[type=file]', { name: 'extracto-octubre.pdf', mimeType: 'application/pdf', buffer: pdf });
      await page.click('.st-doc .btn');
      await page.waitForFunction(() => /Recibido/.test(document.querySelector('.st-msg')?.textContent || ''));
      check('envío: un POST', posts.length === 1);
      const p = posts[0] || { body: {}, url: '' };
      check('envío: al token correcto', p.url === API + encodeURIComponent(token) + '/documents');
      check('envío: el tipo pedido', p.body.documentType === 'bank_statement');
      check('envío: el archivo en base64 (PDF intacto)', Buffer.from(p.body.fileBase64 || '', 'base64').equals(pdf));
      await ctx.close();
    }
    // 6. The final screen of index.html carries the link, translated
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route(url => !url.href.startsWith(base), route => route.fulfill({ status: 204, body: '' }));
      await page.goto(base + 'index.html');
      const exists = await page.$('#doneStatusBox[hidden] a#doneStatusLink[target=_blank]');
      check('index.html: el enlace está en la pantalla final (oculto hasta tener statusUrl)', !!exists);
      const seen = {};
      for (const l of ['pap', 'es', 'en', 'nl']) {
        await page.selectOption('#langSwitch', l);
        await page.waitForTimeout(150);
        seen[l] = await page.textContent('#doneStatusLink');
      }
      check('index.html: el enlace traducido en los 4 idiomas', new Set(Object.values(seen)).size === 4 && /Consulte/.test(seen.es), JSON.stringify(seen));
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
