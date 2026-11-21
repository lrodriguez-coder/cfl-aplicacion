/* =============================================================================
   Prueba de navegador — ronda 14 del gauntlet (formulario #7 y #9).

   Corre las páginas REALES (index.html + app.js, estado.html + estado.js) en
   Chromium headless con toda la red externa interceptada: no sale nada a
   ningún servidor y los datos son ficticios.

     NODE_PATH=C:/Dev/cfl-platform-v2/node_modules/.pnpm/playwright@1.61.1/node_modules \
       node tests/ronda14-formulario.e2e.cjs

   Se comprueba:
     #9  el celular igual a la cédula se frena en el Paso 4 (antes el control
         estaba en el camino de n8n, que ya no corre) y con un celular
         distinto ese aviso no aparece;
     #7  la página de estado nombra el mes que falta ("octubre 2026") en los
         4 idiomas cuando el API lo manda, y sin meses sigue diciendo "el más
         reciente".
============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const API = 'https://api.curloans.com/v1/public/application-status/';
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

async function main() {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------ #9
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route(url => !url.href.startsWith(base), route => route.fulfill({ status: 204, body: '' }));
      await page.goto(base + 'index.html?lang=es');
      await page.selectOption('[name="proposito_categoria"]', 'vakashon');
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="2"].active');
      // A pensioner (no payslips, no work letter) and nothing else required,
      // so the walk reaches Step 4 and only Step 4's own checks speak.
      await page.selectOption('[name="tipo_empleado"]', 'pensionado');
      await page.evaluate(() => {
        document.querySelectorAll('[required]').forEach(el => { el.required = false; });
      });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="3"].active', { timeout: 5000 });
      await page.click('#btnNext');
      await page.waitForSelector('.step[data-step="4"].active', { timeout: 5000 });

      await page.fill('[name="numero_id"]', '1985050512');
      await page.fill('[name="telefono_movil"]', '1985050512');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const step = await page.evaluate(() => document.querySelector('.step.active').dataset.step);
      const errs = await page.evaluate(() => document.getElementById('errors').textContent);
      check('#9 celular igual a la cédula: no avanza del Paso 4', step === '4', 'paso ' + step);
      check('#9 celular igual a la cédula: lo dice', /no puede ser igual a su número de cédula/.test(errs), errs.slice(0, 200));

      await page.fill('[name="telefono_movil"]', '+5999 555 0101');
      await page.click('#btnNext');
      await page.waitForTimeout(300);
      const errs2 = await page.evaluate(() => document.getElementById('errors').textContent);
      check('#9 celular distinto: ese aviso ya no aparece', !/igual a su número de cédula/.test(errs2), errs2.slice(0, 200));
      await ctx.close();
    }

    // ------------------------------------------------------------------ #7
    for (const variant of ['periods', 'none']) {
      const ctx = await browser.newContext({ locale: 'es' });
      const page = await ctx.newPage();
      const status = {
        applicationNumber: 'CFL-90002', firstName: 'Ana', language: 'es', stage: 'action_needed', canUpload: true,
        missingDocuments: [variant === 'periods'
          ? { documentType: 'bank_statement', reason: 'recent_needed', periods: ['2026-10', '2026-09'] }
          : { documentType: 'bank_statement', reason: 'recent_needed' }],
        linkExpiresAt: '2026-12-19T00:00:00.000Z',
      };
      await page.route(url => !url.href.startsWith(base), route => {
        const u = route.request().url();
        if (u.startsWith(API) && route.request().method() === 'GET') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
        }
        return route.fulfill({ status: 204, body: '' });
      });
      await page.goto(base + 'estado.html#t=' + FAKE_TOKEN);
      await page.waitForSelector('#stMain:not([hidden])');
      const seen = {};
      for (const l of ['pap', 'es', 'en', 'nl']) {
        await page.selectOption('#langSwitch', l);
        seen[l] = await page.textContent('.st-doc .field-hint');
      }
      if (variant === 'periods') {
        check('#7 es: nombra los meses', /octubre 2026, septiembre 2026/.test(seen.es), seen.es);
        check('#7 en: nombra los meses', /October 2026, September 2026/.test(seen.en), seen.en);
        check('#7 nl: nombra los meses', /oktober 2026, september 2026/.test(seen.nl), seen.nl);
        check('#7 pap: nombra los meses', /òktober 2026, sèptèmber 2026/.test(seen.pap), seen.pap);
        check('#7 los 4 idiomas distintos', new Set(Object.values(seen)).size === 4, JSON.stringify(seen));
      } else {
        check('#7 sin meses: sigue diciendo "el más reciente"', /el más reciente/.test(seen.es), seen.es);
      }
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
