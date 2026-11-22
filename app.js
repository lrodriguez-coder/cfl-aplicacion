/* =============================================================================
   CFL - Aplicación de Préstamo Web
   Lógica: multi-step navigation + auto-save + uploads + i18n + submit
============================================================================= */

(function () {
  'use strict';

  // ===== CONFIG =====
  const TOTAL_STEPS = 7;
  const STORAGE_KEY = 'cfl_aplicacion_v1';
  const WEBHOOK_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-submit';
  // OCR en v2. Antes era el webhook de n8n `web-aplicacion-ocr`, que empezó a
  // responder HTTP 500: el formulario dejó de prellenar y nadie lo veía,
  // porque runOcr se traga el fallo en un avisito y el cliente sólo encontraba
  // los campos vacíos y tecleaba todo a mano. El extractor de v2 sí funciona
  // (es el que usan los oficiales; 0 errores de n8n en 90 días y 43 de 49
  // documentos leídos), así que el formulario ahora habla con ése.
  const OCR_URL = 'https://api.curloans.com/v1/public/ocr';
  const TRACK_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/aplicacion-web-track';
  const UPLOAD_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-upload';
  const LINK_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-vincular';
  // 7-oct-2026: migrado de n8n a v2 (el workflow de n8n se cayó el 3-oct). Ahora
  // v2 genera/verifica el código y lo manda por SES. Mismo contrato de respuesta.
  const EMAIL_VERIFY_SEND_URL = 'https://api.curloans.com/v1/public/email-verify/send';
  const EMAIL_VERIFY_CONFIRM_URL = 'https://api.curloans.com/v1/public/email-verify/confirm';
  // 7-oct: verificación del móvil por WhatsApp (v2). Mismo contrato que el email.
  const PHONE_VERIFY_SEND_URL = 'https://api.curloans.com/v1/public/phone-verify/send';
  const PHONE_VERIFY_CONFIRM_URL = 'https://api.curloans.com/v1/public/phone-verify/confirm';

  // ===== v2 DIRECT INTAKE (feed the v2 API instead of n8n) =====
  // When USE_V2_INTAKE is true, the form posts the whole application straight to
  // the v2 API (client + application + documents-as-base64 + OCR results) and
  // skips the n8n submit/upload/vincular path. OCR still runs via n8n on attach
  // (fills ocrResults). Flip to true only once the v2 endpoint is enabled
  // (INTAKE_ENABLED=true) and V2_INTAKE_SECRET matches App Runner's INTAKE_SECRET.
  const USE_V2_INTAKE = true;
  const V2_INTAKE_URL = 'https://api.curloans.com/v1/public/intake';
  // No shared secret needed — reCAPTCHA is the anti-bot gate server-side.
  const V2_INTAKE_SECRET = '';
  // ===== DOCUMENT WEIGHT =====
  // Every document travels as base64 inside ONE JSON to the intake, and the
  // API refuses that request above 32 MB (bodyLimit of /v1/public/intake).
  // Base64 inflates by 4/3, so 32 MB on the wire is ~24 MB of files; 22 MB
  // leaves room for the form fields and the OCR results. Without a check here
  // the customer only learned it at the very last click, as "HTTP 413", after
  // 20-30 minutes of work (gauntlet round 12).
  const MB = 1024 * 1024;
  const MAX_TOTAL_DOC_BYTES = 22 * MB;
  // Per document: the OCR endpoint reads up to 15 MB (MAX_DECODED_BYTES in
  // public-ocr.routes.ts) and the intake drops anything over 20 MB WITHOUT
  // telling anyone. 15 MB keeps every document inside both.
  const MAX_FILE_BYTES = 15 * MB;
  // Phone photos (2-5 MB, 4000 px) are shrunk before they are kept. 1600 px
  // on the long side still reads a cédula or a payslip, and it brings a photo
  // down to a few hundred KB, which is what makes 10-13 documents fit.
  const IMAGE_MAX_SIDE_PX = 1600;
  const IMAGE_JPEG_QUALITY = 0.85;
  // Below this an image that is already small enough is left untouched.
  const IMAGE_COMPRESS_MIN_BYTES = 400 * 1024;

  // ===== DRAFT DOCUMENTS (IndexedDB) =====
  // The form asks for bank statements "downloaded from internet banking": on a
  // phone that means switching apps, and iOS/Android often discard the tab in
  // the meantime. The text answers already survived in localStorage, but the
  // files did not, so the customer came back to Step 1 and had to attach
  // 10-13 documents again. The files (and what the OCR said about them) now
  // live in IndexedDB too, and a reload resumes at the same step.
  // They stay on the device only: nothing reaches the server before Submit.
  // Because a phone or a computer can be shared, they expire after this many
  // hours and are erased as soon as the application is submitted.
  const DRAFT_DB_NAME = 'cfl_aplicacion_borrador';
  const DRAFT_DOCS_TTL_HOURS = 72;

  // Maps the form's file-input base names to the v2 document_type enum.
  function mapDocTypeToV2(inputName) {
    const base = String(inputName || '').replace(/_\d+$/, '');
    switch (base) {
      case 'doc_cedula': return 'cedula_front';
      case 'doc_payslips': return 'payslip';
      case 'doc_bancos': return 'bank_statement';
      case 'doc_carta_trabajo': return 'work_letter';
      case 'doc_aqualectra': return 'aqualectra';
      // The passport or driving licence. It was filed as 'other' until
      // 2026-09-11, which is why the Aska packet never carried one: the
      // insurer takes it as the second photo ID and nothing could tell it
      // apart from any other stray upload.
      case 'doc_id_adicional': return 'id_secondary';
      // The SPOUSE's cedula (Leonard, 22-nov-2026). Its own type: the server
      // takes every `cedula_front` as the applicant's identity.
      case 'doc_cedula_conyuge': return 'spouse_cedula';
      default: return 'other';
    }
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () {
        // strip the "data:<mime>;base64," prefix — v2 expects raw base64
        const s = String(r.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = function () { reject(r.error || new Error('read failed')); };
      r.readAsDataURL(file);
    });
  }
  // ===== CONSENTIMIENTOS (salud para Aska, consulta al buro) =====
  // Leonard, 21-nov-2026 (DECISION 4): "two separate consent checkboxes in the
  // form — health information for the insurer (Aska) and the credit bureau
  // consultation — each recorded on the application with timestamp and text
  // version; the intake refuses (clear message in the form language) if either
  // is missing; T&C text unchanged". Before, both were paragraphs read on the
  // way to the Terms box. The version names the wording: change the text ->
  // new version, added to the API (intake-consents.ts) BEFORE this page.
  const CONSENT_VERSIONS = { salud_aska: 'salud-aska-2026-11-21', buro: 'buro-2026-11-21' };
  const consentCheckedAt = {};
  function consentBox(key) { return $('[name="consentimiento_' + key + '"]'); }
  function consentPayload() {
    const out = {};
    Object.keys(CONSENT_VERSIONS).forEach(function (key) {
      const cb = consentBox(key);
      if (!cb || !cb.checked) return;
      const label = cb.closest('label');
      const span = label && label.querySelector('span');
      out[key] = {
        accepted: true,
        version: CONSENT_VERSIONS[key],
        lang: currentLang,
        text: span ? span.textContent.trim() : '',
        checkedAt: consentCheckedAt[key] || new Date().toISOString()
      };
    });
    return out;
  }
  function missingConsentMessages() {
    const msgs = [];
    if (!(consentBox('salud_aska') || {}).checked) {
      msgs.push(t('error.consent_health') || 'Marque la casilla de la información de salud para Aska Insurance para poder enviar la solicitud.');
    }
    if (!(consentBox('buro') || {}).checked) {
      msgs.push(t('error.consent_buro') || 'Marque la casilla de la consulta al buró de crédito para poder enviar la solicitud.');
    }
    return msgs;
  }

  // Gather + POST the full application to the v2 intake endpoint.
  async function submitToV2() {
    const form = {};
    new FormData($form).forEach(function (val, key) {
      if (!(val instanceof File)) form[key] = val;
    });
    form._lang = currentLang;
    form._submitted_at = new Date().toISOString();
    // What the applicant agreed to, box by box, in the words shown to them
    // (DECISION 4, 21-nov-2026). The API records it on the application with
    // its own timestamp and refuses the send without both.
    form._consents = consentPayload();

    const documents = [];
    const fileInputs = $$('input[type="file"]');
    for (const input of fileInputs) {
      const files = input.files ? Array.from(input.files) : [];
      for (const file of files) {
        try {
          const b64 = await fileToBase64(file);
          documents.push({
            documentType: mapDocTypeToV2(input.name),
            fileBase64: b64,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream'
          });
        } catch (err) { console.warn('base64 fallo:', input.name, err); }
      }
    }

    // Google reCAPTCHA v2 token. When the widget is on the page the client must
    // solve it before we submit (server enforces it when RECAPTCHA_SECRET is set).
    const rcEl = $('[name="g-recaptcha-response"]');
    const captchaToken = rcEl && rcEl.value ? rcEl.value : undefined;
    if ($('.g-recaptcha') && !captchaToken) {
      throw new Error(t('error.captcha') || 'Por favor konfirmá ku bo no ta un robot.');
    }

    // submissionId: generated ONCE per draft and kept in it, so every attempt
    // of this application carries the same id. When the answer to a send is
    // lost (phone network, proxy timeout) after the server already created the
    // application, the retry gets that same application back instead of a
    // duplicate (gauntlet r13, formulario#1). Saved BEFORE sending, so a
    // reload between attempts keeps it.
    const submissionId = getSubmissionId();
    saveDraft();

    // A send with ~20 MB of documents from a phone can hang for ever on a bad
    // connection; without a limit the button just said "Sending..." with no
    // way out. On timeout the customer gets a clear message and can retry —
    // safely, thanks to the submissionId.
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, INTAKE_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(V2_INTAKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-intake-secret': V2_INTAKE_SECRET },
        // trackingId: the same session id the e-mail and mobile codes were
        // confirmed under (/email-verify, /phone-verify). The server only mails
        // the acknowledgement to, and only marks as verified, a contact whose
        // code was confirmed in THIS session; without it any confirmed code for
        // that address counted (Leonard 18-nov-2026).
        body: JSON.stringify({ form: form, ocr: ocrResults, documents: documents, captchaToken: captchaToken, trackingId: getTrackingId(), submissionId: submissionId }),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      throw intakeError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      if (timer) clearTimeout(timer);
    }
    const result = await res.json().catch(function () { return {}; });
    if (!res.ok || !result.ok) {
      // Only the stable CODE is used. The server's message is for developers
      // and used to reach the screen as-is: Postgres text, or a Spanish
      // sentence in voseo whatever the language (gauntlet r13, formulario#7).
      let code = (result.error && result.error.code) || '';
      if (!code && res.status === 413) code = 'TOO_LARGE';
      if (!code && res.status === 429) code = 'RATE_LIMITED';
      throw intakeError(code || 'INTAKE_FAILED');
    }
    return result; // { ok, applicationNumber, emailVerified }
  }

  // How long a send may take before the customer is told and can retry.
  // Generous on purpose: up to ~22 MB of base64 from a phone.
  const INTAKE_TIMEOUT_MS = 180 * 1000;

  function intakeError(code) {
    const e = new Error(code);
    e.intakeCode = code;
    return e;
  }

  // Codes the API answers (error.code) and the ones the form itself raises,
  // mapped to the customer's language. Anything unknown falls back to the
  // generic "could not register" message — never a raw server text.
  const INTAKE_ERROR_KEYS = {
    CAPTCHA_REQUIRED: 'error.code.captcha',
    CAPTCHA_EXPIRED: 'error.code.captcha',
    CAPTCHA_FAILED: 'error.code.captcha',
    UNDERAGE: 'error.menor_edad',
    AMOUNT_OUT_OF_RANGE: 'error.code.monto_fuera',
    TERM_OUT_OF_RANGE: 'error.code.plazo_fuera',
    VALIDATION_FAILED: 'error.code.validation',
    TOO_LARGE: 'error.code.too_large',
    RATE_LIMITED: 'error.code.rate_limited',
    TIMEOUT: 'error.code.timeout',
    NETWORK: 'error.code.network',
    INTAKE_DISABLED: 'error.code.unavailable',
    UNAUTHORIZED: 'error.code.unavailable',
    INTAKE_FAILED: 'error.code.failed',
    // The spouse's phone is the applicant's (decision 2, 22-nov-2026): the
    // API's guard, said in the applicant's language.
    SPOUSE_PHONE_IS_APPLICANT: 'error.conyuge_mismo_telefono',
    // The two consents of their own (DECISION 4, 21-nov-2026): the server
    // refuses without them. The form checks first; this covers an old page.
    CONSENT_REQUIRED: 'error.code.consent',
  };
  function intakeErrorMessage(err) {
    const code = err && err.intakeCode;
    if (!code) {
      // Raised by the form itself before sending (e.g. the captcha box):
      // already worded for the customer.
      return (err && err.message) || t('error.code.failed') || t('error.submit');
    }
    const key = INTAKE_ERROR_KEYS[code] || 'error.code.failed';
    return t(key, { edad: EDAD_MINIMA }) || t('error.code.failed') || t('error.submit') ||
      'No pudimos registrar su solicitud; sus datos siguen guardados. Intente de nuevo o llame al +5999 526 8480.';
  }

  // Master switch: si está en false la verificación de email se vuelve
  // opcional (el cliente puede enviar sin verificar). Útil para apagar
  // rápido si el workflow n8n tiene un problema.
  const EMAIL_VERIFY_REQUIRED = true;
  // Igual para el móvil (WhatsApp). Si la plantilla Meta aún no está aprobada,
  // poné esto en false para no bloquear el envío del formulario.
  const PHONE_VERIFY_REQUIRED = true;

  // Bypass total de validación entre pasos (solo para revisar UI sin que
  // bloquee). En producción siempre false.
  const BYPASS_STEP_VALIDATION = false;

  // doc field name → OCR doc_type
  // NOTA: doc_bancos NO se OCR-ea en el form (consume mucho API ~$0.40/banco).
  // Se guarda el archivo igual via submit. El analista o un workflow async procesa
  // la extracción completa cuando se abra la aplicación.
  const OCR_TYPES = {
    doc_cedula: 'cedula',
    // Same reader, same prompt; runOcr fills the SPOUSE fields with it.
    doc_cedula_conyuge: 'cedula',
    doc_id_adicional: 'id_adicional',
    doc_payslips: 'payslip',
    doc_carta_trabajo: 'carta',
    doc_aqualectra: 'aqualectra',
  };

  // OCR result → form field auto-fill mapping (only filled if field is empty)
  // Keys son los que devuelve el workflow OCR (prompts WhatsApp)
  const OCR_FIELD_MAP = {
    cedula: {
      nombre_completo: 'nombre_completo',
      numero_id: 'numero_id',
      fecha_nacimiento: 'fecha_nacimiento',
      sexo: 'sexo',
      estado_civil: 'estado_civil',
      nacionalidad: 'nacionalidad',
      pais_nacimiento: 'pais_nacimiento',
      fecha_vencimiento: 'fecha_venc_id1',
    },
    // El pasaporte ahora devuelve tambien el PAIS de nacimiento (deducido de la
    // ciudad cuando el documento solo trae la ciudad — Leonard, 18-sep). Solo
    // llena si el campo esta vacio, asi que la cedula sigue mandando cuando ya
    // lo lleno; el pasaporte cubre el caso de que la cedula no lo traiga.
    // OJO: pais_emisor NO se mapea aca a proposito — es el pais que emitio el
    // documento, no donde nacio la persona.
    id_adicional: {
      pais_nacimiento: 'pais_nacimiento',
    },
    payslip: {
      empleador: 'empleador',
      cargo: 'cargo',
      salario_neto_total: 'salario_neto',
      // La cuenta donde le cae el sueldo es la cuenta de debito del
      // cliente. El OCR la trae y hasta hoy habia que teclearla a mano.
      numero_cuenta_destino: 'cuenta_bancaria_debito',
    },
    carta: {
      empleador: 'empleador',
      cargo: 'cargo',
      // OJO: la carta NO devuelve salario_neto (devuelve salario_bruto),
      // asi que esta linea no dispara nunca. Se deja porque mapear el
      // bruto al campo de neto falsearia el ingreso en el scoring; el
      // neto correcto sale del payslip (salario_neto_total).
      salario_neto: 'salario_neto',
      tipo_empleo: 'tipo_empleado',
      // La carta trae los dos y el formulario tiene ambos campos.
      telefono_empleador: 'telefono_empleador',
      direccion_empleador: 'direccion_empleador',
    },
    banco: {
      direccion_titular: 'direccion',
    },
    aqualectra: {
      direccion: 'direccion',
    },
  };

  // Tipo de documento esperado por slot. El OCR devuelve `tipo_detectado`
  // (qué documento ve Claude realmente); si no coincide, se bloquea el avance.
  const EXPECTED_TIPO = {
    doc_cedula: ['cedula'],
    doc_cedula_conyuge: ['cedula'],
    doc_id_adicional: ['paspoort', 'rijbewijs'],
    doc_payslips: ['payslip'],
    doc_bancos: ['bank_statement'],
    doc_carta_trabajo: ['employment_letter'],
    // El casillero de comprobante de domicilio acepta cualquier documento que
    // traiga la direccion: Aqualectra, factura de telefono, uittreksel de
    // Kranshi o permiso de residencia (Leonard, 2026-09-18). Si esta lista no
    // incluye el permiso, el formulario le bloquea el avance a quien sube
    // justo lo que la etiqueta le invito a subir.
    doc_aqualectra: ['aqualectra', 'verblijfsvergunning'],
  };
  // Slots cuya vigencia se verifica (el OCR devuelve fecha_vencimiento).
  // The spouse's card too, but only as a warning (see validateStep): the
  // spouse shows a valid ID at the signing, and an expired one is no reason
  // to lose the application.
  const EXPIRY_DOCS = ['doc_cedula', 'doc_id_adicional', 'doc_cedula_conyuge'];
  // La carta de trabajo confirma empleo ACTUAL: debe ser reciente. Si la fecha
  // de emisión tiene más de estos días, se rechaza (Leonard 2026-08-01, caso
  // Raylian: carta de feb-2026 usada en ago-2026 = ~6 meses).
  const MAX_WORK_LETTER_AGE_DAYS = 30;

  // ===== STATE =====
  let currentStep = 1;
  let i18nTexts = {};
  let currentLang = 'pap';
  let i18nReady = false;
  const LANGS = ['pap', 'es', 'en', 'nl'];

  // OCR results per doc_type, indexed por input.name (e.g., doc_cedula → {nombre_completo, ...})
  // Para payslips/bancos guardamos array (1 por archivo subido)
  const ocrResults = {
    doc_cedula: null,
    // What the cedula reader saw on the SPOUSE's card. Sent as
    // ocr.doc_cedula_conyuge; the server takes the name / ID / date of birth
    // from it.
    doc_cedula_conyuge: null,
    doc_id_adicional: null,
    doc_payslips: [],
    doc_bancos: [],
    doc_carta_trabajo: null,
    doc_aqualectra: null,
  };

  // Resultado de validación por slot: { tipo:'ok'|'mismatch'|'unknown',
  // expired:bool, detected:string, vence:string }. Se rehace en cada subida.
  const docCheck = {};

  // Rango de cada extracto bancario subido, por slot: [{account,from,to}].
  // Vive SOLO en el navegador: no se manda al backend. ocrResults.doc_bancos
  // se deja como esta a proposito, porque el analisis lo lee como si fuera
  // la extraccion completa y aqui solo tenemos la clasificacion liviana.
  const bancoRangos = {};

  // SHA-256 (hex) por archivo subido, indexado por input.name → [hash, ...].
  // Detecta el MISMO archivo subido en dos slots (contenido idéntico, aunque
  // el nombre difiera). Caso Raylian 2026-08-01: subió el bill de Aqualectra
  // también en el slot de bank_statement_3 → el OCR procesó una factura de luz
  // como estado de banco. Se aceptan documentos DISTINTOS (aqualectra, flow,
  // uittreksel), pero no repetir el mismo archivo.
  const fileHashes = {};

  // Slots whose current file already went through OCR / classification. A
  // restored draft only re-analyses the ones that were still in flight when
  // the tab died, so a reload does not pay the OCR again for every document.
  const docAnalizado = {};
  // init() restores the draft's documents once; only after that does a
  // re-render of the dynamic slots put their files back by itself.
  let restauracionInicialHecha = false;

  // ===== DOM REFS =====
  const $form = document.getElementById('appForm');
  const $btnPrev = document.getElementById('btnPrev');
  const $btnNext = document.getElementById('btnNext');
  const $btnSubmit = document.getElementById('btnSubmit');
  const $progressFill = document.getElementById('progressFill');
  const $progressLabel = document.getElementById('progressLabel');
  const $errors = document.getElementById('errors');
  const $langSwitch = document.getElementById('langSwitch');

  // ===== UTILITIES =====
  function $$(selector, ctx) { return Array.from((ctx || document).querySelectorAll(selector)); }
  function $(selector, ctx) { return (ctx || document).querySelector(selector); }

  function showStep(n) {
    $$('.step').forEach(s => s.classList.remove('active'));
    const target = $('.step[data-step="' + n + '"]');
    if (target) target.classList.add('active');
    currentStep = n;
    updateProgress();
    updateNavButtons();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateProgress() {
    if (currentStep === 'done') {
      $progressFill.style.width = '100%';
      $progressLabel.style.display = 'none';
      return;
    }
    const pct = (currentStep / TOTAL_STEPS) * 100;
    $progressFill.style.width = pct + '%';
    $progressLabel.style.display = '';
    const label = t('progress.label', { current: currentStep, total: TOTAL_STEPS })
      || 'Paso ' + currentStep + ' di ' + TOTAL_STEPS;
    $progressLabel.textContent = label;
  }

  function updateNavButtons() {
    if (currentStep === 'done') {
      $btnPrev.style.display = 'none';
      $btnNext.style.display = 'none';
      $btnSubmit.style.display = 'none';
      return;
    }
    $btnPrev.style.display = currentStep === 1 ? 'none' : '';
    $btnNext.style.display = currentStep === TOTAL_STEPS ? 'none' : '';
    $btnSubmit.style.display = currentStep === TOTAL_STEPS ? '' : 'none';
  }

  // Etiqueta legible de cada documento, para los mensajes de validación.
  const DOC_LABEL_I18N = {
    doc_cedula: 'step1.cedula',
    doc_cedula_conyuge: 'step3.conyuge_cedula',
    doc_id_adicional: 'step1.id_adicional',
    doc_payslips: 'step2.payslips',
    doc_bancos: 'step2.bancos',
    doc_carta_trabajo: 'step2.carta',
    // Apunta al rotulo NUEVO del casillero. 'step2.aqualectra' es el viejo
    // ("Resibo Aqualectra") y quedo sin uso: nombraba solo uno de los cuatro
    // documentos que el casillero acepta, asi que los avisos contradecian a
    // la etiqueta que la persona acababa de leer.
    doc_aqualectra: 'step2.comprobante_domicilio'
  };
  // Nombre base de un slot dinámico (doc_payslips_1 → doc_payslips). Permite
  // que toda la lógica de OCR / EXPECTED_TIPO / DOC_LABEL_I18N siga
  // funcionando con sufijos numéricos.
  function baseDocName(name) {
    if (!name) return name;
    return name.replace(/_\d+$/, '');
  }
  function docLabelFor(f) {
    // Si el input tiene data-period-label (slot dinámico), usar ese como
    // sufijo para que el mensaje de error diga "Payslip — Mei 2026".
    const periodLbl = f.dataset && f.dataset.periodLabel;
    const base = baseDocName(f.name);
    const key = DOC_LABEL_I18N[base];
    const label = (key && t(key)) || base;
    const main = String(label).replace(/\*/g, '').replace(/^[^0-9A-Za-zÀ-ÿ]+/, '').trim();
    return periodLbl ? main + ' — ' + periodLbl : main;
  }

  // Etiqueta visible (ya traducida) de un campo, para los mensajes de error.
  // Antes los avisos decían "telefono_casa: formato inválido": el nombre
  // interno del campo, que el cliente nunca vio (revisión 15-nov-2026).
  function fieldLabel(f) {
    if (f.type === 'file') return docLabelFor(f);
    let lbl = null;
    if (f.id) lbl = document.querySelector('label[for="' + f.id + '"]');
    if (!lbl && f.type === 'radio') {
      const g = f.closest('[role="radiogroup"]');
      const id = g && g.getAttribute('aria-labelledby');
      lbl = id ? document.getElementById(id) : null;
    }
    if (!lbl) {
      const fld = f.closest('.field');
      lbl = fld ? fld.querySelector('label') : null;
    }
    let txt = lbl ? lbl.textContent : '';
    txt = txt.replace(/\*/g, '').replace(/^\s*\d+\/\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
    if (txt.length > 80) txt = txt.slice(0, 77) + '…';
    return txt || f.name;
  }

  // Marca el campo y deja el mensaje JUNTO a él (no sólo en la lista de abajo).
  function markFieldError(f, msg) {
    if (!f) return;
    f.classList.add('invalid');
    f.setAttribute('aria-invalid', 'true');
    const box = f.closest('.upload-block') || f.closest('.field') || f.parentElement;
    if (!box) return;
    let p = box.querySelector(':scope > .field-error');
    if (!p) {
      p = document.createElement('p');
      p.className = 'field-error';
      p.id = 'err_' + (f.name || f.id || Math.random().toString(36).slice(2));
      box.appendChild(p);
    }
    p.textContent = msg;
    const desc = (f.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (desc.indexOf(p.id) === -1) { desc.push(p.id); f.setAttribute('aria-describedby', desc.join(' ')); }
  }

  function clearFieldError(f) {
    if (!f) return;
    f.classList.remove('invalid');
    f.removeAttribute('aria-invalid');
    const box = f.closest('.upload-block') || f.closest('.field');
    const p = box && box.querySelector(':scope > .field-error');
    if (p) p.remove();
  }

  function clearFieldErrors(scope) {
    $$('.field-error', scope).forEach(p => p.remove());
    $$('[aria-invalid="true"]', scope).forEach(f => f.removeAttribute('aria-invalid'));
  }

  // ===== EDAD MÍNIMA (18 años, regla de CFL) =====
  // "Hoy" es hoy en Curaçao, no en el reloj del teléfono: a las 22:00 en
  // Willemstad ya es mañana en UTC, y nadie puede cumplir 18 antes de tiempo.
  // El API hace el mismo control (segunda red); éste tiene que valer solo.
  const EDAD_MINIMA = 18;
  function hoyEnCuracao() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Curacao' }).format(new Date());
    } catch (e) {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  }
  // La fecha de nacimiento más reciente que ya tiene 18 años hoy. Un 29 de
  // febrero en año no bisiesto pasa a 28: el nacido el 29 cumple el 1 de marzo.
  function fechaNacimientoMaxima() {
    const [y, m, d] = hoyEnCuracao().split('-');
    const yy = Number(y) - EDAD_MINIMA;
    const bisiesto = (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
    const dd = (m === '02' && d === '29' && !bisiesto) ? '28' : d;
    return String(yy).padStart(4, '0') + '-' + m + '-' + dd;
  }
  function esMenorDeEdad(fechaIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaIso || '')) return false;
    return fechaIso > fechaNacimientoMaxima();
  }
  function aplicarMaxNacimiento() {
    const el = $('[name="fecha_nacimiento"]');
    if (el) el.max = fechaNacimientoMaxima();
  }
  function msgMenorDeEdad() {
    return t('error.menor_edad', { edad: EDAD_MINIMA }) ||
      'Debe tener 18 años o más para solicitar un préstamo. Revise su fecha de nacimiento.';
  }

  // La fecha de nacimiento que leyó el OCR de la cédula (ISO), o ''. Se mira
  // apenas vuelve el OCR, en el paso 2: antes la edad se revisaba recién en el
  // paso 4, después de subir unos 13 documentos (gauntlet r13, formulario#2).
  // El API rechaza igual si CUALQUIERA de las dos fechas (escrita o de la
  // cédula) dice menor, así que bloquear aquí no es más estricto que el servidor.
  function fechaNacimientoCedula() {
    let d = ocrResults.doc_cedula;
    if (Array.isArray(d)) d = d[0];
    const f = d && typeof d === 'object' ? String(d.fecha_nacimiento || '').trim() : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : '';
  }
  function msgMenorSegunCedula() {
    return t('error.menor_edad_cedula', { edad: EDAD_MINIMA }) ||
      ('Según su cédula, usted tiene menos de ' + EDAD_MINIMA + ' años. Para solicitar un préstamo debe tener ' + EDAD_MINIMA + ' años o más.');
  }

  // ===== ANTIGÜEDAD MÍNIMA (1 año con el empleador actual) =====
  // Requisito de los Términos (cláusula 3): al menos un año de empleo con
  // contrato fijo o temporal, o una pensión vigente (Leonard 19-nov-2026:
  // los pensionados SÍ son elegibles). El formulario nunca preguntaba la
  // antigüedad, así que alguien con 8 meses subía todos sus documentos para
  // recibir días después un rechazo previsible (gauntlet r13, formulario#2).
  // Los pensionados no tienen empleador: el campo no se les pide.
  const ANTIGUEDAD_MINIMA_MESES = 12;
  // La fecha de ingreso más reciente que ya cumple la antigüedad hoy (en
  // Curaçao). Un día que no existe en el mes de destino (31 → 30, 29-feb)
  // pasa al último día de ese mes.
  function fechaIngresoMaxima() {
    const [y, m, d] = hoyEnCuracao().split('-').map(Number);
    const total = y * 12 + (m - 1) - ANTIGUEDAD_MINIMA_MESES;
    const yy = Math.floor(total / 12);
    const mm = total % 12 + 1;
    const ultimo = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const dd = Math.min(d, ultimo);
    return String(yy).padStart(4, '0') + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }
  function antiguedadInsuficiente(fechaIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaIso || '')) return false;
    return fechaIso > fechaIngresoMaxima();
  }
  function msgAntiguedad() {
    return t('error.antiguedad', { meses: ANTIGUEDAD_MINIMA_MESES }) ||
      'Para solicitar un préstamo necesita al menos 1 año con su empleador actual (o una pensión vigente). Revise la fecha de ingreso a su empleo.';
  }

  // Leonard, 22-nov-2026 (decision 2): the spouse's phone is the spouse's own.
  // The confirmation link goes there; the applicant's own mobile confirms
  // nothing (a shared home landline is fine). Same rule as the API
  // (spouse-verification-rules.ts samePhone): a Curaçao number by its national
  // part (+599 / 00599 / the local trunk 0 removed); the old 7-digit form
  // matches the 8-digit one only between Curaçao numbers.
  function canonTelefono(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length < 7) return null;
    if (d.indexOf('00') === 0) d = d.slice(2);
    else if (d.charAt(0) === '0' && d.length >= 8 && d.length <= 9) d = d.slice(1);
    if (d.indexOf('5999') === 0 && d.length === 11) return { cw: true, n: d.slice(3) };
    if ((d.length === 8 && d.charAt(0) === '9') || d.length === 7) return { cw: true, n: d };
    return { cw: false, n: d };
  }
  function mismoTelefono(a, b) {
    var x = canonTelefono(a);
    var y = canonTelefono(b);
    if (!x || !y) return false;
    if (x.n === y.n) return true;
    if (!x.cw || !y.cw) return false;
    var short = x.n.length <= y.n.length ? x.n : y.n;
    var long = x.n.length <= y.n.length ? y.n : x.n;
    return short.length === 7 && long.length === 8 && long.slice(-7) === short;
  }

  function validateStep(n) {
    // TEMPORAL: bypass total mientras Leonard revisa el form.
    if (BYPASS_STEP_VALIDATION) {
      clearErrors();
      return true;
    }
    const step = $('.step[data-step="' + n + '"]');
    if (!step) return true;
    clearFieldErrors(step);
    // 1) Required fields - check todo: presencia + pattern + type
    const requiredFields = $$('input[required]:not([type="file"]), select[required], textarea[required]', step);
    // 2) Optional fields con pattern - validar SOLO si tienen valor (para no rechazar vacío)
    const patternFields = $$('input[pattern]:not([required])', step);
    const errs = [];
    const errMsgs = [];
    const errEls = [];
    // Un error = el nombre (para saber si hubo), el texto (lista de abajo) y
    // el campo (mensaje al lado + foco en el primero).
    function fail(el, msg, name) {
      errs.push(name || (el && el.name) || '?');
      errMsgs.push(msg);
      if (el) { errEls.push(el); markFieldError(el, msg); }
    }
    function formatMsg(f) {
      const hintKey = f.dataset && f.dataset.i18nTitle;
      const hint = hintKey ? t(hintKey) : null;
      return fieldLabel(f) + ': ' + (hint || t('error.format') || 'formato inválido');
    }
    const radiosSeen = {};
    requiredFields.forEach(f => {
      f.classList.remove('invalid');
      if (f.type === 'radio') {
        if (radiosSeen[f.name]) return;
        radiosSeen[f.name] = true;
      }
      if (!f.checkValidity()) {
        // Pasarse del `max` de la fecha de nacimiento = menor de edad: lo dice
        // el control de abajo con su propio mensaje, no "fuera de rango".
        if (f.name === 'fecha_nacimiento' && f.validity.rangeOverflow && !f.validity.valueMissing) return;
        // Mensaje específico según el tipo de error
        let msg;
        if (f.validity.patternMismatch) {
          msg = formatMsg(f);
        } else if (f.validity.typeMismatch && f.type === 'email') {
          msg = fieldLabel(f) + ': ' + (t('error.email') || 'email inválido');
        } else if (f.validity.valueMissing) {
          msg = fieldLabel(f) + ': ' + (t('error.required') || 'requerido');
        } else if (f.validity.rangeUnderflow || f.validity.rangeOverflow) {
          msg = fieldLabel(f) + ': ' + (t('error.range_vars', { min: f.min, max: f.max }) || t('error.range') || 'valor fuera de rango');
        } else if (f.validity.stepMismatch) {
          msg = fieldLabel(f) + ': ' + (t('error.step', { step: f.step }) || t('error.invalid') || 'inválido');
        } else if (f.validity.tooShort) {
          msg = fieldLabel(f) + ': ' + (t('error.too_short', { n: f.minLength }) || t('error.invalid') || 'inválido');
        } else {
          msg = fieldLabel(f) + ': ' + (t('error.invalid') || 'inválido');
        }
        fail(f, msg);
      }
    });
    patternFields.forEach(f => {
      f.classList.remove('invalid');
      if (f.value && f.value.trim() !== '' && !f.checkValidity()) {
        fail(f, formatMsg(f));
      }
    });
    // The spouse's card may not be the applicant's own card a second time
    // (the server would take nothing from it), nor the spouse's e-mail the
    // applicant's own (22-nov-2026).
    const conyugeCed = step.querySelector('input[type="file"][name="doc_cedula_conyuge"]');
    if (conyugeCed && conyugeCed.required && conyugeCed.files && conyugeCed.files.length > 0 && cedulaConyugeEsPropia()) {
      fail(conyugeCed, t('error.conyuge_cedula_propia')
        || 'La cédula que subió como la de su cónyuge es la suya. Suba la cédula de su cónyuge.');
    }
    const conyugeMail = step.querySelector('[name="conyuge_email"]');
    const propioMail = $('[name="email"]');
    if (conyugeMail && conyugeMail.value.trim() && propioMail &&
        conyugeMail.value.trim().toLowerCase() === propioMail.value.trim().toLowerCase()) {
      fail(conyugeMail, t('error.conyuge_email_propio')
        || 'El correo de su cónyuge no puede ser el mismo que el suyo.');
    }
    // The spouse's phone may not be one of the applicant's (decision 2). The
    // API refuses it too (SPOUSE_PHONE_IS_APPLICANT); this says it here, on
    // the field, before the applicant reaches the end.
    const conyugeTel = step.querySelector('[name="conyuge_telefono"]');
    if (conyugeTel && conyugeTel.required && conyugeTel.value.trim()) {
      const propios = ['telefono_movil']
        .map((name) => (($('[name="' + name + '"]') || {}).value || ''));
      if (propios.some((v) => mismoTelefono(v, conyugeTel.value))) {
        fail(conyugeTel, t('error.conyuge_mismo_telefono')
          || 'El teléfono del cónyuge no puede ser el mismo que el suyo.');
      }
    }
    // Documentos obligatorios: no dejar avanzar si falta alguno (respeta modo pensionado)
    $$('input[type="file"][required]', step).forEach(f => {
      const lbl = f.closest('.upload-label');
      f.classList.remove('invalid');
      if (lbl) lbl.classList.remove('invalid');
      if (!f.files || f.files.length === 0) {
        if (lbl) lbl.classList.add('invalid');
        fail(f, (t('error.doc_required') || 'Falta subir un documento obligatorio') + ': ' + docLabelFor(f));
      }
    });
    // Guard explícito para payslips (Paso 3): si el cliente no es pensionado
    // debe haber al menos 1 payslip subido. Sin este check el bug era: si
    // el cliente no seleccionó frecuencia_salario, los slots de payslip no
    // se generaban y el submit pasaba sin payslips (caso Odalys Erica
    // Faneyte 2026-07-10 — empleada de gobierno tipo=fijo, 0 payslips en
    // S3, aplicación entró incompleta a Access).
    if (n === 3) {
      const tipo = ($('[name="tipo_empleado"]') || {}).value || '';
      const requiresPayslips = tipo && tipo !== 'pensionado';
      if (requiresPayslips) {
        const payslipInputs = $$('input[type="file"][name^="doc_payslips"]', step);
        const anyUploaded = payslipInputs.some(f => f.files && f.files.length > 0);
        if (payslipInputs.length === 0 || !anyUploaded) {
          fail(payslipInputs[0] || null,
            t('error.payslips_required')
            || 'Faltan recibos de salario. Suba al menos uno. Si no ve los casilleros, vuelva al Paso 2 y elija la frecuencia de salario.',
            'doc_payslips');
        }
        // Además del "al menos 1", el período del payslip debe coincidir con
        // el casillero (últimos meses completos). Regla Leonard 2026-07-11:
        // "que cumpla los períodos de los últimos 3 meses".
        payslipInputs.forEach(f => {
          if (!f.files || f.files.length === 0) return;
          const c = docCheck[f.name];
          if (c && c.periodMatch === false) {
            const lbl = f.closest('.upload-label');
            if (lbl) lbl.classList.add('invalid');
            const detected = c.periodDetail || '?';
            const expY = f.dataset.expectedYear || '?';
            const expM = f.dataset.expectedMonth || '?';
            const expectedStr = expY + '-' + String(expM).padStart(2, '0');
            fail(f,
              t('error.payslip_period_mismatch', { doc: docLabelFor(f), detected: detected, expected: expectedStr })
              || (docLabelFor(f) + ': período incorrecto (detectado ' + detected + ', se esperaba ' + expectedStr + '). Suba el recibo del período correcto.'));
          }
        });
      }

      // Cobertura de los extractos: que entre todos cubran ~3 meses seguidos
      // en alguna cuenta. AVISA, no bloquea — para bloquear, llamar a fail()
      // como hacen los payslips justo arriba.
      const rangosBanco = [];
      Object.keys(bancoRangos).forEach(function (k) {
        (bancoRangos[k] || []).forEach(function (r) {
          if (r && r.from && r.to) rangosBanco.push(r);
        });
      });
      const inputBanco = $('[name="doc_bancos"]');
      const montaje = inputBanco && inputBanco.closest('.upload-label');
      if (montaje) {
        const viejo = montaje.querySelector('.coverage-warn');
        if (viejo) viejo.remove();
        if (rangosBanco.length > 0) {
          const cob = evaluarCobertura(rangosBanco, 85, 3);
          if (!cob.completa && cob.motivo) {
            const aviso = document.createElement('div');
            aviso.className = 'coverage-warn period-mismatch-warn';
            aviso.textContent = '⚠️ ' + cob.motivo;
            montaje.appendChild(aviso);
          }
        }
      }
    }
    // Tipo de documento incorrecto / documento vencido (aplica a TODOS los file inputs con archivo)
    $$('input[type="file"]', step).forEach(f => {
      if (!f.files || f.files.length === 0) return;
      const lbl = f.closest('.upload-label');
      f.classList.remove('invalid');
      if (lbl) lbl.classList.remove('invalid');
      const c = docCheck[f.name];
      if (!c) return;
      if (c.tipo === 'mismatch') {
        // Un casillero OPCIONAL no puede trancar la solicitud por traer el
        // documento equivocado: el documento no hacia falta. Se avisa (el
        // aviso ambar ya esta en el preview) y se deja pasar, con el boton
        // Quitar a la vista. Los obligatorios —cedula, payslips, bancos,
        // carta— siguen bloqueando: ahi el control existe por el caso
        // Raylian, que fue real (Leonard, 2026-09-18).
        // A statement slot made optional by "send them later" is still a
        // statement slot: a payslip in it is refused as before (DECISION 2).
        if (!f.required && !/^doc_bancos_/.test(f.name)) return;
        if (lbl) lbl.classList.add('invalid');
        fail(f, t('error.doc_tipo_incorrecto', { doc: docLabelFor(f), detected: tipoLabel(c.detected) })
          || (docLabelFor(f) + ': documento incorrecto'));
      } else if (c.expired && f.name !== 'doc_cedula_conyuge') {
        if (lbl) lbl.classList.add('invalid');
        fail(f, t('error.doc_vencido', { doc: docLabelFor(f), date: c.vence })
          || (docLabelFor(f) + ': documento vencido'));
      } else if (c.stale) {
        if (lbl) lbl.classList.add('invalid');
        fail(f, t('error.carta_vieja', { doc: docLabelFor(f), date: c.issueDate, dias: c.ageDays })
          || (docLabelFor(f) + ': la carta de trabajo tiene ' + c.ageDays + ' días (emitida ' + c.issueDate +
              '). Debe ser de los últimos ' + MAX_WORK_LETTER_AGE_DAYS + ' días — pida una carta actualizada.'));
      }
    });
    // Documento repetido: el MISMO archivo subido en dos slots (contenido
    // idéntico). Se aceptan documentos DISTINTOS como comprobante de domicilio
    // extra (Aqualectra, flow, uittreksel), pero no repetir el mismo archivo
    // — p.ej. subir el bill de Aqualectra también como bank_statement_3.
    // Solo corre en pasos que tienen inputs de archivo.
    if ($$('input[type="file"]', step).length > 0) {
      findDuplicateDocs().forEach(d => {
        const inpA = $('input[type="file"][name="' + d.first + '"]');
        const inpB = $('input[type="file"][name="' + d.second + '"]');
        [inpA, inpB].forEach(inp => {
          if (!inp) return;
          inp.classList.add('invalid');
          const lbl = inp.closest('.upload-label');
          if (lbl) lbl.classList.add('invalid');
        });
        const a = inpA ? docLabelFor(inpA) : d.first;
        const b = inpB ? docLabelFor(inpB) : d.second;
        fail(inpB || null,
          t('error.doc_duplicado', { a: a, b: b })
          || ('Subió el mismo archivo en dos lugares: "' + a + '" y "' + b +
              '". Cada documento debe ser distinto.'),
          d.second);
      });
    }
    // Conditional required fields (e.g., dolencia_detalle solo si dolencia_salud=true)
    $$('.conditional.visible', step).forEach(c => {
      if (c.value === '' || c.value === null) {
        fail(c, fieldLabel(c) + ': ' + (t('error.detail_required') || t('error.required') || 'requerido'));
      }
    });
    // Email verificado: en el Paso 4 exigimos que el email esté confirmado por
    // código antes de seguir. Bypass si EMAIL_VERIFY_REQUIRED=false.
    if (n === 4 && EMAIL_VERIFY_REQUIRED) {
      const emailInput = step.querySelector('[name="email"]');
      if (emailInput && emailInput.value && !isEmailVerified()) {
        fail(emailInput, t('step3.email_verify_required') ||
          'Verifique su email antes de continuar (clic en "Verificar").');
      }
    }
    // Móvil verificado por WhatsApp. Bypass si PHONE_VERIFY_REQUIRED=false.
    if (n === 4 && PHONE_VERIFY_REQUIRED) {
      const phoneInput = step.querySelector('[name="telefono_movil"]');
      if (phoneInput && phoneInput.value && !isPhoneVerified()) {
        fail(phoneInput, t('step3.phone_verify_required') ||
          'Verifique su celular antes de continuar (clic en "Verificar").');
      }
    }
    // Celular igual a la cédula: el caso típico de pegar la cédula en el campo
    // del celular. Este control vivía en el envío por n8n, después del
    // `return` del camino v2 (USE_V2_INTAKE = true), así que nunca corría
    // (gauntlet r14, formulario#9). Acá corre en el Paso 4, junto al campo.
    if (n === 4) {
      const telEl = step.querySelector('[name="telefono_movil"]');
      const idEl = step.querySelector('[name="numero_id"]');
      const telVal = telEl ? String(telEl.value || '').replace(/[\s\-+]/g, '') : '';
      const idVal = idEl ? String(idEl.value || '').replace(/[\s\-]/g, '') : '';
      if (telVal && idVal && telVal === idVal) {
        fail(telEl, t('error.tel_eq_id') ||
          'El número celular no puede ser igual a su número de cédula. Revise el campo del número celular.');
      }
    }
    // Antigüedad: menos de 12 meses con el empleador actual no avanza.
    const ingresoEl = step.querySelector('[name="fecha_ingreso_empleo"]');
    if (ingresoEl) {
      ingresoEl.max = hoyEnCuracao();
      const tipoIngreso = ($('[name="tipo_empleado"]') || {}).value || '';
      if (tipoIngreso && tipoIngreso !== 'pensionado' && ingresoEl.value &&
          antiguedadInsuficiente(ingresoEl.value)) {
        fail(ingresoEl, msgAntiguedad());
      }
    }
    // Menor según la cédula: se sabe apenas vuelve el OCR (paso 2).
    const cedulaInput = step.querySelector('input[type="file"][name="doc_cedula"]');
    if (cedulaInput) {
      const nacCed = fechaNacimientoCedula();
      if (nacCed && esMenorDeEdad(nacCed)) fail(cedulaInput, msgMenorSegunCedula(), 'doc_cedula_edad');
    }
    // Menor de edad: no se avanza. Se recalcula el `max` por si la página
    // quedó abierta desde ayer.
    const nacEl = step.querySelector('[name="fecha_nacimiento"]');
    if (nacEl) {
      aplicarMaxNacimiento();
      if (nacEl.value && esMenorDeEdad(nacEl.value)) fail(nacEl, msgMenorDeEdad());
    }
    // Sanity peso/altura: la altura en cm de una persona siempre supera el peso en kg.
    // Si peso >= altura el usuario casi seguro invirtió los dos campos.
    if (n === 5) {
      const pesoEl = step.querySelector('[name="peso_kg"]');
      const alturaEl = step.querySelector('[name="altura_cm"]');
      if (pesoEl && alturaEl && pesoEl.value && alturaEl.value &&
          Number(pesoEl.value) >= Number(alturaEl.value)) {
        alturaEl.classList.add('invalid');
        fail(pesoEl, t('error.peso_altura') ||
          'Revise peso y altura: la altura (cm) debe ser mayor que el peso (kg). ¿Los puso al revés?');
      }
    }
    // Paso 1 (préstamo): ya NO se bloquea por la cuota. Si el cotizador no
    // responde, la persona puede seguir; la cuota real sale en la oferta.
    if (errs.length > 0) {
      showErrors(errMsgs.length > 0 ? errMsgs : [t('error.fill_required') || 'Por favor complete todos los campos requeridos.']);
      // Foco y scroll al PRIMER campo con error, para que no tenga que buscarlo.
      const first = errEls.find(el => el && el.offsetParent !== null) || errEls[0];
      if (first) {
        const target = first.type === 'file' ? (first.closest('.upload-block') || first) : first;
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        try { first.focus({ preventScroll: true }); } catch (e) {}
      }
      return false;
    }
    clearErrors();
    return true;
  }

  function showErrors(messages) {
    const ul = document.createElement('ul');
    messages.forEach(m => { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
    $errors.innerHTML = '';
    $errors.appendChild(ul);
    $errors.classList.add('show');
  }
  function clearErrors() {
    $errors.innerHTML = '';
    $errors.classList.remove('show');
  }

  // ===== AUTO-SAVE =====
  // El borrador vive en el localStorage del dispositivo: en un teléfono o una
  // computadora compartida lo ve el siguiente que abra la página. Por eso NO
  // se guardan las respuestas de salud (paso marcado data-no-draft) ni la
  // cuenta bancaria (campo marcado data-no-draft): se vuelven a pedir.
  function noDraftNames() {
    const out = {};
    $$('[data-no-draft] [name], [name][data-no-draft]').forEach(el => { out[el.name] = true; });
    return out;
  }
  function saveDraft() {
    const data = {};
    const skip = noDraftNames();
    new FormData($form).forEach((val, key) => {
      if (val instanceof File) return; // Files not auto-saved
      if (skip[key]) return;            // salud / cuenta bancaria: nunca al disco
      if (data[key] !== undefined) {
        if (!Array.isArray(data[key])) data[key] = [data[key]];
        data[key].push(val);
      } else {
        data[key] = val;
      }
    });
    data._step = currentStep;
    data._lang = currentLang;
    data._updated = new Date().toISOString();
    // Which e-mail / mobile already passed their code. Without this a reload
    // past Step 4 always sent the customer back there to ask for new codes,
    // and "resume at the same step" would only work up to Step 4. It is the
    // same value that is already in the draft, plus the fact that it was
    // confirmed; isEmailVerified still compares it with the field.
    data._emailVerifiedFor = emailVerifiedFor || undefined;
    data._phoneVerifiedFor = phoneVerifiedFor || undefined;
    // And WHEN: the server only accepts a code confirmed in the last 24 h
    // (VERIFICATION_VALID_HOURS), so a draft resumed after that must ask for
    // a new code instead of showing "verified" (gauntlet r13, formulario#4).
    data._emailVerifiedAt = emailVerifiedFor && emailVerifiedAt ? emailVerifiedAt : undefined;
    data._conyugeEmailVerifiedFor = conyugeEmailVerifiedFor || undefined;
    data._conyugeEmailVerifiedAt = conyugeEmailVerifiedFor && conyugeEmailVerifiedAt ? conyugeEmailVerifiedAt : undefined;
    data._phoneVerifiedAt = phoneVerifiedFor && phoneVerifiedAt ? phoneVerifiedAt : undefined;
    // Kept only once a send was attempted (getSubmissionId): see submitToV2.
    data._submissionId = _submissionIdMemo || undefined;
    // The session id goes with the draft: the codes above were confirmed under
    // it, and the intake now checks that the verification belongs to the
    // session that submits. A reload that drew a fresh id would keep the
    // contacts "verified" on screen while the server refused them.
    data._trackingId = getTrackingId();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* localStorage full or disabled */ }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      // Borradores viejos (antes del 15-nov-2026) sí guardaban salud y cuenta:
      // se descartan al leerlos y el borrador se reescribe limpio.
      const skip = noDraftNames();
      let sucio = false;
      Object.keys(draft || {}).forEach(k => { if (skip[k]) { delete draft[k]; sucio = true; } });
      if (sucio) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch (e) {} }
      return draft;
    } catch (e) { return null; }
  }

  function restoreDraft() {
    const draft = loadDraft();
    if (!draft) return;
    Object.keys(draft).forEach(key => {
      if (key.startsWith('_')) return;
      const elements = $$('[name="' + key + '"]');
      elements.forEach(el => {
        if (el.type === 'radio' || el.type === 'checkbox') {
          el.checked = String(el.value) === String(draft[key]);
        } else if (el.type !== 'file') {
          el.value = draft[key];
        }
      });
    });
    // Trigger conditional updates
    updateConditionals();
    syncSliders();
    updateQuote();
  }

  function clearDraft() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    // A new application on this device is a new session, and a new submission.
    _trackingIdMemo = '';
    _submissionIdMemo = '';
    // The documents go with the answers: after Submit nothing of the
    // application should be left on the device.
    borradorCerrado = true;
    return limpiarBorradorDocs();
  }

  // ===== DRAFT DOCUMENTS (IndexedDB) =====
  // Two stores: `files` keeps the File objects of each slot (key = input
  // name) and `meta` keeps what the form learnt about them (OCR, checks,
  // hashes) under the key 'estado'. Every call degrades to "no draft" when
  // IndexedDB is missing or refuses (private mode, quota): the form must keep
  // working exactly as before, only without the resume.
  let borradorDbPromise = null;
  // Set once the application is submitted: a late write from an OCR that was
  // still running must not put the documents back on the device.
  let borradorCerrado = false;
  function abrirBorradorDb() {
    if (borradorDbPromise) return borradorDbPromise;
    borradorDbPromise = new Promise(resolve => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = indexedDB.open(DRAFT_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return borradorDbPromise;
  }
  // One request in one transaction; resolves with its result, or null on any
  // failure (never rejects: the draft is a convenience, not a requirement).
  async function idb(store, mode, fn) {
    const db = await abrirBorradorDb();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        let out = null;
        if (req) req.onsuccess = () => { out = req.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  // The slot's expected period travels with its files: dynamic slots are
  // renumbered when the month turns or the salary frequency changes, and a
  // payslip restored into a slot for ANOTHER month would carry a period check
  // that no longer applies.
  function periodoDeSlot(input) {
    const d = input.dataset || {};
    return [d.expectedYear || '', d.expectedMonth || '', d.expectedQ || ''].join('-');
  }

  function guardarArchivosBorrador(input) {
    if (borradorCerrado || !input || !input.name) return Promise.resolve(null);
    const files = Array.from(input.files || []);
    if (files.length === 0) return idb('files', 'readwrite', s => s.delete(input.name));
    const rec = {
      savedAt: Date.now(),
      periodo: periodoDeSlot(input),
      files: files.map(f => ({ blob: f, name: f.name, type: f.type, lastModified: f.lastModified }))
    };
    return idb('files', 'readwrite', s => s.put(rec, input.name));
  }

  let estadoDocsTimer = null;
  function guardarEstadoDocs() {
    if (borradorCerrado) return;
    clearTimeout(estadoDocsTimer);
    estadoDocsTimer = setTimeout(() => {
      if (borradorCerrado) return;
      let estado;
      try {
        // A JSON round-trip keeps it to plain data (no DOM, no functions), so
        // the structured clone of IndexedDB can never throw on it.
        estado = JSON.parse(JSON.stringify({
          savedAt: Date.now(),
          ocrResults: ocrResults,
          docCheck: docCheck,
          bancoRangos: bancoRangos,
          fileHashes: fileHashes,
          docAnalizado: docAnalizado
        }));
      } catch (e) { return; }
      void idb('meta', 'readwrite', s => s.put(estado, 'estado'));
    }, 300);
  }

  function limpiarBorradorDocs() {
    clearTimeout(estadoDocsTimer);
    return Promise.all([
      idb('files', 'readwrite', s => s.clear()),
      idb('meta', 'readwrite', s => s.clear())
    ]);
  }

  // Puts a list of File objects into an <input type=file>. The browser only
  // allows it through a DataTransfer; where that is missing (very old
  // Safari) the caller keeps what the input already had.
  function ponerArchivos(input, files) {
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      input.files = dt.files;
      return input.files && input.files.length === files.length;
    } catch (e) { return false; }
  }

  // Brings back the documents of the draft. With `bases`, only the slots of
  // those base names (the dynamic payslip / bank slots after a re-render).
  // Slots that are restored but were never analysed go through the normal
  // change handler again; the rest are painted from the saved state.
  async function restaurarDocumentos(bases) {
    const estado = await idb('meta', 'readonly', s => s.get('estado'));
    const ttlMs = DRAFT_DOCS_TTL_HOURS * 3600 * 1000;
    if (!estado || !estado.savedAt || Date.now() - estado.savedAt > ttlMs) {
      if (!bases) await limpiarBorradorDocs();
      return;
    }
    const claves = await idb('files', 'readonly', s => s.getAllKeys());
    const registros = await idb('files', 'readonly', s => s.getAll());
    if (!claves || !registros) return;
    if (!bases) {
      // First restore of the page: the in-memory state starts from the
      // saved one. (After a re-render the in-memory state is the newer one.)
      [[ocrResults, estado.ocrResults], [docCheck, estado.docCheck], [bancoRangos, estado.bancoRangos],
        [fileHashes, estado.fileHashes], [docAnalizado, estado.docAnalizado]].forEach(([dst, src]) => {
        Object.keys(src || {}).forEach(k => { dst[k] = src[k]; });
      });
    }
    const restaurados = {};
    claves.forEach((nombre, i) => {
      const rec = registros[i];
      if (bases && bases.indexOf(baseDocName(nombre)) === -1) return;
      const input = $('input[type="file"][name="' + nombre + '"]');
      const vigente = rec && rec.savedAt && Date.now() - rec.savedAt <= ttlMs;
      if (!input || !vigente || rec.periodo !== periodoDeSlot(input) || !Array.isArray(rec.files)) {
        void idb('files', 'readwrite', s => s.delete(nombre));
        return;
      }
      if (input.files && input.files.length > 0) return; // the customer already chose another one
      const files = rec.files.map(f => new File([f.blob], f.name, { type: f.type, lastModified: f.lastModified }));
      if (!ponerArchivos(input, files)) return;
      restaurados[nombre] = true;
      if (docAnalizado[nombre]) pintarRestaurado(input);
      else input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Whatever the saved state says about a slot that came back empty is
    // stale (file dropped, slot renumbered): forget it, as "Quitar" does.
    $$('input[type="file"]').forEach(input => {
      if (bases && bases.indexOf(baseDocName(input.name)) === -1) return;
      if (!restaurados[input.name] && !(input.files && input.files.length)) limpiarEstadoDe(input);
    });
    if (!bases) {
      if (restaurados.doc_cedula) renderCedulaPreview(ocrResults.doc_cedula);
      if (restaurados.doc_id_adicional) renderIdAdicionalPreview(ocrResults.doc_id_adicional);
    }
    updateUploadCounter();
    guardarEstadoDocs();
  }

  // The preview of a slot whose file came back from the draft: the same
  // thumbnail / name and "Quitar" button as when it was attached, and a badge
  // that repeats what the analysis had found, so a reload does not hide a
  // wrong or expired document behind a green tick.
  function pintarRestaurado(input) {
    const preview = $('[data-preview-for="' + input.name + '"]');
    if (!preview) return;
    preview.innerHTML = '';
    const label = input.closest('.upload-label');
    if (label) label.classList.add('has-file');
    pintarArchivos(preview, Array.from(input.files || []));
    preview.appendChild(botonQuitar(input));
    const c = docCheck[input.name] || {};
    if (c.tipo === 'mismatch') {
      setOcrStatus(preview, '⚠️ ' + (t('ocr.tipo_mismatch', { detected: tipoLabel(c.detected), expected: expectedTipoLabel(input.name) })
        || 'Tipo de documento incorrecto'), 'warn');
    } else if (c.expired) {
      setOcrStatus(preview, '⚠️ ' + (t('ocr.expired', { date: c.vence }) || 'Documento vencido'), 'warn');
    } else {
      setOcrStatus(preview, '✓ ' + (t('upload.restored') || 'Documento guardado en este dispositivo — no hace falta volver a subirlo'), 'ok');
    }
    if (c.periodMatch === false) showPeriodMismatchWarning(preview, input.name, c.periodDetail);
    const cedula = ocrResults.doc_cedula;
    if (c.nameMatch === false && c.docHolderName && cedula && cedula.nombre_completo) {
      pintarAvisoNombre(preview, c.docHolderName, cedula.nombre_completo);
    }
  }

  // Where to resume after a reload: the saved step, unless an earlier step no
  // longer passes (health answers are never stored, a code expired, a document
  // was dropped). Then the customer lands on that step, with the reason on
  // screen, instead of on a later step whose Submit would fail.
  function pasoParaRetomar(guardado) {
    const n = Number(guardado);
    if (!Number.isInteger(n) || n < 2 || n > TOTAL_STEPS) return 1;
    for (let i = 1; i < n; i++) {
      if (!validateStep(i)) return i;
    }
    return n;
  }

  // ===== CONDITIONAL FIELDS (e.g., detalle dolencia si dolencia_salud=true) =====
  function updateConditionals() {
    $$('.conditional[data-show-when]').forEach(el => {
      const condition = el.dataset.showWhen; // e.g., "dolencia_salud=true"
      const [name, expected] = condition.split('=');
      const source = document.querySelector('[name="' + name + '"]:checked');
      const shouldShow = source && source.value === expected;
      el.classList.toggle('visible', shouldShow);
      if (!shouldShow) el.value = '';
    });
    // Conditional fields que se muestran según valor de un <select>.
    $$('.conditional[data-show-when-select]').forEach(el => {
      const [name, expected] = el.dataset.showWhenSelect.split('=');
      const source = document.querySelector('select[name="' + name + '"]');
      const shouldShow = source && source.value === expected;
      el.classList.toggle('visible', shouldShow);
      if (!shouldShow) el.value = '';
    });
    updatePensionadoMode();
  }

  // ===== Modo pensionado: ajusta labels y required de payslips =====
  function updatePensionadoMode() {
    const tipoSel = $('[name="tipo_empleado"]');
    if (!tipoSel) return;
    const isPensionado = tipoSel.value === 'pensionado';

    // Toggle labels: tienen data-i18n (default) y data-i18n-pensionado (alt)
    $$('[data-i18n-pensionado]').forEach(el => {
      const key = isPensionado ? el.dataset.i18nPensionado : el.dataset.i18n;
      if (!key) return;
      const text = t(key);
      if (text) {
        if (/<\w+[^>]*>/.test(text)) el.innerHTML = text;
        else el.textContent = text;
      }
    });

    // Pensionado: carta de trabajo NO es obligatoria (no tiene empleo).
    const cartaInput = $('[name="doc_carta_trabajo"]');
    if (cartaInput) {
      if (isPensionado) cartaInput.removeAttribute('required');
      else cartaInput.setAttribute('required', '');
    }

    // Ocultar/mostrar el selector de frecuencia salarial.
    // Cuando es visible es OBLIGATORIO — sin frecuencia los slots de payslip
    // no se generan y el cliente puede submitear sin subirlos (bug hallado
    // 2026-07-11 con Odalys Erica Faneyte: tipo=fijo pero frecuencia vacía →
    // 0 payslips uploaded, aplicación entró incompleta).
    const freqField = $('#frecuenciaSalarioField');
    if (freqField) {
      const showFreq = tipoSel.value === 'fijo' || tipoSel.value === 'contrato';
      freqField.style.display = showFreq ? '' : 'none';
      const freqSel = freqField.querySelector('[name="frecuencia_salario"]');
      if (freqSel) {
        if (showFreq) {
          freqSel.setAttribute('required', '');
        } else {
          freqSel.removeAttribute('required');
          freqSel.value = ''; // no contaminar submit
        }
      }
    }

    // Fecha de ingreso al empleo: sólo para quien tiene empleador (fijo o
    // contrato). Un pensionado no la tiene; sin tipo elegido todavía, tampoco
    // se pide (el tipo ya es obligatorio).
    const ingresoField = $('#fechaIngresoField');
    if (ingresoField) {
      const conEmpleador = tipoSel.value === 'fijo' || tipoSel.value === 'contrato';
      ingresoField.style.display = conEmpleador ? '' : 'none';
      const ingresoEl = ingresoField.querySelector('[name="fecha_ingreso_empleo"]');
      if (ingresoEl) {
        if (conEmpleador) ingresoEl.setAttribute('required', '');
        else ingresoEl.removeAttribute('required');
      }
    }

    // Re-renderizar los slots dinámicos de Step 2 según tipo + frecuencia.
    renderDynamicSlots();
  }

  // ===== SLOTS DINÁMICOS (Step 2 — payslips + bancos) =====
  // Nombres de meses por idioma. Index 0 = enero.
  const MONTH_NAMES = {
    pap: ['Yanüari', 'Febrüari', 'Mart', 'Aprel', 'Mei', 'Yüni',
          'Yüli', 'Ougùstùs', 'Sèptèmber', 'Òktober', 'Novèmber', 'Desèmber'],
    es:  ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
    en:  ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'],
    nl:  ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
          'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
  };

  function monthLabel(year, monthIdx0) {
    const arr = MONTH_NAMES[currentLang] || MONTH_NAMES.pap;
    return arr[monthIdx0] + ' ' + year;
  }

  // yyyy-mm-dd → "15 de noviembre de 2008" / "15 November 2008" en el idioma
  // activo. Lo que no sea una fecha se devuelve tal cual.
  function fmtFecha(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    const arr = MONTH_NAMES[currentLang] || MONTH_NAMES.pap;
    const dia = String(Number(m[3]));
    const mes = arr[Number(m[2]) - 1];
    if (!mes) return iso;
    if (currentLang === 'es') return dia + ' de ' + mes.toLowerCase() + ' de ' + m[1];
    return dia + ' ' + mes + ' ' + m[1];
  }

  // Retorna los últimos N meses completos (más reciente primero).
  // Hoy 19-jun-2026 con n=3 → [{y:2026,m:4},{y:2026,m:3},{y:2026,m:2}] = may, apr, mar.
  function lastCompleteMonths(today, n) {
    const out = [];
    let y = today.getFullYear();
    let m = today.getMonth() - 1; // mes anterior (índice 0)
    for (let i = 0; i < n; i++) {
      if (m < 0) { m = 11; y -= 1; }
      out.push({ year: y, month: m });
      m -= 1;
    }
    return out;
  }

  // Última quincena del mes (16-fin) — devuelve el día final correcto.
  function lastDayOfMonth(year, monthIdx0) {
    return new Date(year, monthIdx0 + 1, 0).getDate();
  }

  // 6 últimas quincenas completas a partir de los últimos 3 meses (más reciente primero).
  // Cada quincena: { year, month, q:1|2, label }.
  function lastBiweeklyPeriods(today, monthsBack) {
    const months = lastCompleteMonths(today, monthsBack);
    const out = [];
    // Para cada mes, agregar Q2 (16-fin) primero, luego Q1 (1-15) — orden más reciente primero
    months.forEach(({ year, month }) => {
      const end = lastDayOfMonth(year, month);
      out.push({ year, year2: year, month, q: 2,
        label: '16-' + end + ' ' + monthLabel(year, month) });
      out.push({ year, year2: year, month, q: 1,
        label: '1-15 ' + monthLabel(year, month) });
    });
    return out;
  }

  // Calcula los períodos requeridos según tipo_empleado + frecuencia_salario.
  // Devuelve { payslips, bancos } donde cada slot trae { key, label, year, month, q? }.
  function computePeriods(today) {
    const tipo = ($('[name="tipo_empleado"]') || {}).value || '';
    const freq = ($('[name="frecuencia_salario"]') || {}).value || '';
    const bancos = lastCompleteMonths(today, 3).map(p => ({
      key: p.year + '_' + (p.month + 1),
      label: monthLabel(p.year, p.month),
      year: p.year,
      month: p.month + 1 // 1-12
    }));
    let payslips = [];
    if (tipo === 'pensionado') {
      // 1 slot: carta de pensión actual (no tiene período fijo).
      payslips = [{ key: 'pension', label: t('step2.pension_doc_label') || 'Karta di penshon' }];
    } else if (tipo === 'fijo' || tipo === 'contrato') {
      if (freq === 'mensual') {
        payslips = bancos.map(p => ({
          key: p.key, label: p.label, year: p.year, month: p.month
        }));
      } else if (freq === 'quincenal') {
        payslips = lastBiweeklyPeriods(today, 3).map(p => ({
          key: p.year + '_' + (p.month + 1) + '_q' + p.q,
          label: p.label,
          year: p.year,
          month: p.month + 1,
          q: p.q
        }));
      }
    }
    return { payslips, bancos };
  }

  // Genera un upload-block HTML para un slot dinámico.
  // periodSpec = {label, year?, month?, q?} — year/month embebidos en data
  // attributes para validación posterior contra el OCR.
  function buildSlotHTML(basename, idx, periodSpec, isRequired) {
    const name = basename + '_' + idx;
    const periodLabel = periodSpec.label || periodSpec; // backward compat
    const expectedYear = periodSpec.year || '';
    const expectedMonth = periodSpec.month || '';
    const expectedQ = periodSpec.q || '';
    const reqStar = isRequired ? ' *' : '';
    const reqAttr = isRequired ? ' required' : '';
    // Cada slot lleva en el título el TIPO + el período, así el cliente sabe
    // exactamente qué subir aunque navegue por los slots sin leer el header.
    // Bank statements: SOLO PDF (lo que el banco genera del internet banking).
    // Payslips: PDF o foto.
    let icon, typeLabel, accept, pdfOnlyHint;
    if (basename === 'doc_bancos') {
      icon = '🏦';
      typeLabel = t('step2.slot_banco') || 'Bank statement';
      accept = 'application/pdf';
      pdfOnlyHint = '<p class="slot-hint">' +
        (t('step2.banco_pdf_only') || 'Solo PDF — descárguelo del internet banking de su banco.') + '</p>';
    } else if (basename === 'doc_payslips') {
      icon = '💰';
      typeLabel = t('step2.slot_payslip') || 'Payslip';
      accept = 'image/*,application/pdf';
      pdfOnlyHint = '';
    } else {
      icon = '📄';
      typeLabel = '';
      accept = 'image/*,application/pdf';
      pdfOnlyHint = '';
    }
    const fullLabel = typeLabel ? (typeLabel + ' — ' + periodLabel) : periodLabel;
    const dataAttrs =
      ' data-period-label="' + periodLabel + '"' +
      (expectedYear ? ' data-expected-year="' + expectedYear + '"' : '') +
      (expectedMonth ? ' data-expected-month="' + expectedMonth + '"' : '') +
      (expectedQ ? ' data-expected-q="' + expectedQ + '"' : '');
    return '<div class="upload-block dynamic-slot">' +
      '<label class="upload-label">' +
        '<span class="upload-title">' + icon + ' ' + fullLabel + reqStar + '</span>' +
        '<input type="file" name="' + name + '"' + dataAttrs +
          ' accept="' + accept + '"' + reqAttr + '>' +
        '<div class="upload-preview" data-preview-for="' + name + '"></div>' +
      '</label>' +
      pdfOnlyHint +
    '</div>';
  }

  // Re-renderiza el Step 2 según tipo_empleado + frecuencia_salario actuales.
  // CRÍTICO: solo re-renderiza si la config cambió. Si la misma combinación
  // tipo+frec se vuelve a calcular, NO toca el DOM — así no perdemos los
  // archivos ya cargados cuando el cliente vuelve al Paso 2 después de
  // navegar a Paso 1/3/etc.
  let lastDynamicSlotsSignature = null;
  function renderDynamicSlots() {
    const payslipsContainer = $('#payslipsSlots');
    const bancosContainer = $('#bancosSlots');
    if (!payslipsContainer || !bancosContainer) return;
    const today = new Date();
    const { payslips, bancos } = computePeriods(today);
    const tipo = ($('[name="tipo_empleado"]') || {}).value || '';
    const freq = ($('[name="frecuencia_salario"]') || {}).value || '';

    // Signature: tipo + freq + idioma + año-mes del primer slot (para que
    // si pasa de mes mientras el cliente está aplicando, se actualice).
    const sig = [
      tipo, freq, currentLang,
      payslips.map(p => p.key).join(','),
      bancos.map(p => p.key).join(',')
    ].join('|');
    if (sig === lastDynamicSlotsSignature) {
      applyBancosPendientes();
      return;
    }
    lastDynamicSlotsSignature = sig;

    if (payslips.length === 0) {
      payslipsContainer.innerHTML = '<p class="hint">' +
        (t('step2.choose_tipo_first') || 'Primero elija el tipo de empleo y (si aplica) la frecuencia de salario en el Paso 2.') +
        '</p>';
    } else {
      payslipsContainer.innerHTML = payslips
        .map((p, i) => buildSlotHTML('doc_payslips', i + 1, p, tipo !== 'pensionado'))
        .join('');
    }
    bancosContainer.innerHTML = bancos
      .map((p, i) => buildSlotHTML('doc_bancos', i + 1, p, true))
      .join('');

    // Re-rendering replaces the <input>s, and with them the files the
    // customer had attached (a language switch did exactly that). The draft
    // puts back every file whose slot still asks for the same period. Before
    // the first restore of the page this is left to init().
    if (restauracionInicialHecha) void restaurarDocumentos(['doc_payslips', 'doc_bancos']);

    applyBancosPendientes();
  }

  // ===== EXTRACTOS PENDIENTES =====
  // Leonard, 21-nov-2026 (DECISION 2): "keep asking for all documents, but the
  // applicant can SEND the application with the 3 bank statements PENDING
  // (all other required documents still required); the application is
  // created, the gate holds it for the statements, and the status page asks
  // for them month by month". The statements are the one document that means
  // leaving the form for the bank's website on a phone; with this box ticked
  // their slots stop being required (a file attached anyway still goes, and
  // still has to BE a statement). Everything else stays required.
  function bancosPendientes() {
    const cb = $('[name="extractos_pendientes"]');
    return !!(cb && cb.checked);
  }
  function applyBancosPendientes() {
    const pendientes = bancosPendientes();
    $$('input[type="file"][name^="doc_bancos_"]').forEach(function (inp) {
      inp.required = !pendientes;
      const lbl = inp.closest('.upload-label');
      const title = lbl && lbl.querySelector('.upload-title');
      if (title) title.textContent = title.textContent.replace(/ \*$/, '') + (pendientes ? '' : ' *');
    });
    const aviso = $('#bancosPendientesAviso');
    if (aviso) aviso.hidden = !pendientes;
    updateUploadCounter();
  }

  // Cuenta documentos required cargados / total y muestra en #uploadCounter.
  function updateUploadCounter() {
    // Documentos financieros = Paso 3 desde que el préstamo pasó al Paso 1.
    const step2 = $('.step[data-step="3"]');
    if (!step2) return;
    const counter = $('#uploadCounter');
    if (!counter) return;
    const requiredInputs = $$('input[type="file"][required]', step2);
    const total = requiredInputs.length;
    const done = requiredInputs.filter(i => i.files && i.files.length > 0).length;
    const $done = $('#uploadCounterDone');
    const $total = $('#uploadCounterTotal');
    if ($done) $done.textContent = done;
    if ($total) $total.textContent = total;
    counter.classList.toggle('complete', done === total && total > 0);
  }

  // ===== SLIDERS (sync number input ↔ range slider) =====
  function syncSliders() {
    $$('[data-sync]').forEach(slider => {
      const targetName = slider.dataset.sync;
      const number = $('[name="' + targetName + '"]');
      if (!number) return;
      slider.value = number.value;
      slider.addEventListener('input', () => {
        number.value = slider.value;
        if (targetName === 'monto_solicitado' || targetName === 'plazo_meses') updateQuote();
      });
      number.addEventListener('input', () => {
        slider.value = number.value;
        if (targetName === 'monto_solicitado' || targetName === 'plazo_meses') updateQuote();
      });
    });
  }

  // ===== COTIZACIÓN (Paso 1) =====
  // La cuota sale del motor REAL de v2 (`POST /v1/public/quote`): el mismo
  // que arma la oferta, con TAE. Reemplaza a la tabla de promedios
  // CFL_CUOTA_TABLE, que era incoherente (18 meses salía más caro que 24).
  //
  // - Debounce de 400 ms al mover monto/plazo, y sólo vale la ÚLTIMA
  //   respuesta (un número viejo que llega tarde no pisa al nuevo).
  // - Si el endpoint falla, se dice "No pudimos calcular la cuota ahora" y la
  //   solicitud sigue: la cuota es información, no una condición.
  // - Los topes de monto y plazo vienen en `limits` del mismo endpoint.
  const QUOTE_URL = 'https://api.curloans.com/v1/public/quote';
  const QUOTE_PRODUCT = 'MicroLoan';           // el mismo producto del intake
  const QUOTE_DEBOUNCE_MS = 400;
  const MONTO_STEP = 500;                       // "múltiplo de 500"
  const PLAZO_OPCIONES = [6, 12, 18, 24, 36, 48, 60];
  let quoteTimer = null;
  let quoteSeq = 0;
  let quoteLimits = null;
  // Misma combinación = misma respuesta: no se vuelve a pedir (el endpoint
  // tiene límite de 60 pedidos cada 10 minutos por IP).
  const quoteCache = {};

  // Montos en el formato del idioma activo: es/nl/pap escriben 2.000,00 y en
  // 2,000.00. A mano y no con toLocaleString('es'), que no agrupa los miles
  // de un número de 4 cifras ("2000,00") y depende del navegador.
  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const en = currentLang === 'en';
    const [ent, dec] = Math.abs(v).toFixed(2).split('.');
    const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, en ? ',' : '.');
    return (v < 0 ? '-' : '') + miles + (en ? '.' : ',') + dec;
  }

  // TAE con la coma o el punto del idioma activo.
  function fmtPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(2).replace('.', currentLang === 'en' ? '.' : ',') + '%';
  }

  // El plan de ahorro NO lo elige el cliente: es obligatorio a 24 meses o más
  // y no se ofrece por debajo (Leonard, 15-nov-2026). La cuota que devuelve el
  // API ya lo incluye cuando corresponde, así que la cotización sólo depende
  // de monto y plazo.
  function quoteKey(monto, plazo) {
    return monto + '|' + plazo;
  }

  function setQuoteState(state) {
    const box = $('#quoteBox');
    if (box) box.dataset.state = state;
    const err = $('#qError');
    if (err) err.hidden = state !== 'error';
  }

  // Aplica los topes del producto a los controles (una sola vez por cambio).
  function applyQuoteLimits(limits) {
    if (!limits) return;
    const minA = Number(limits.minAmount), maxA = Number(limits.maxAmount);
    const minT = Number(limits.minTermMonths), maxT = Number(limits.maxTermMonths);
    const sig = [minA, maxA, minT, maxT].join('|');
    if (quoteLimits && quoteLimits.sig === sig) return;
    quoteLimits = { minA, maxA, minT, maxT, sig };

    const monto = $('[name="monto_solicitado"]');
    const range = $('#montoRange');
    if (minA > 0 && maxA >= minA) {
      // Redondea a múltiplos de 500 dentro del tope.
      const lo = Math.ceil(minA / MONTO_STEP) * MONTO_STEP;
      const hi = Math.floor(maxA / MONTO_STEP) * MONTO_STEP;
      [monto, range].forEach(el => { if (el) { el.min = lo; el.max = hi; } });
      const marks = $('#montoMarks');
      if (marks) {
        const n = 4, out = [];
        for (let i = 0; i <= n; i++) out.push(Math.round((lo + (hi - lo) * i / n) / MONTO_STEP) * MONTO_STEP);
        marks.innerHTML = out.filter((v, i, a) => a.indexOf(v) === i).map(v => '<span>' + v + '</span>').join('');
      }
      const hint = $('#montoHint');
      if (hint) {
        hint.dataset.i18nVars = JSON.stringify({ min: String(lo), max: String(hi) });
        const txt = t('step6.monto_hint', { min: lo, max: hi });
        if (txt) hint.textContent = txt;
      }
    }
    const plazo = $('[name="plazo_meses"]');
    if (plazo && minT > 0 && maxT >= minT) {
      const actual = plazo.value;
      const ops = PLAZO_OPCIONES.filter(m => m >= minT && m <= maxT);
      if (ops.length) {
        plazo.innerHTML = '<option value="">—</option>' +
          ops.map(m => '<option value="' + m + '">' + m + '</option>').join('');
        plazo.value = ops.indexOf(Number(actual)) !== -1 ? actual : (ops.indexOf(12) !== -1 ? '12' : String(ops[0]));
      }
    }
  }

  function renderQuoteInputs(monto, plazo) {
    const $qMonto = $('#qMonto');
    const $qPlazo = $('#qPlazo');
    if ($qMonto) $qMonto.textContent = 'XCG ' + fmtMoney(monto || 0);
    if ($qPlazo) $qPlazo.textContent = (plazo || '—') + ' ' + (t('step6.q_meses') || '');
  }

  function renderQuoteResult(q) {
    const cur = q.currency || 'XCG';
    const money = (n) => cur + ' ' + fmtMoney(n);
    const cuota = Number(q.cuota);
    const tot = q.totals || {};
    const total = Number(tot.toPay);
    const apr = Number(q.aprAnnualPct);
    $('#qCuota').textContent = money(cuota);
    // Costo del crédito = lo que el cliente paga y NO vuelve: interés + seguro
    // (+ comisiones, si el producto las tuviera). El ahorro va aparte, porque
    // se le devuelve; sumarlo al costo lo hacía parecer más caro.
    const interes = Number(tot.interest) || 0;
    const seguro = Number(tot.insurance) || 0;
    const fees = Number(tot.fees) || 0;
    $('#qCosto').textContent = money(interes + seguro + fees);
    const $costoLbl = $('#qCostoLabel');
    if ($costoLbl) {
      const key = fees > 0 ? 'step6.q_costo_fees' : 'step6.q_costo';
      $costoLbl.dataset.i18n = key;
      const txt = t(key);
      if (txt) $costoLbl.textContent = txt;
    }
    const sav = Number(tot.savings) || 0;
    const $ahRow = $('#qAhorroRow');
    if ($ahRow) $ahRow.hidden = !(sav > 0);
    const $ah = $('#qAhorro');
    if ($ah) $ah.textContent = money(sav);
    $('#qTotal').textContent = Number.isFinite(total) ? money(total) : '—';
    $('#qTae').textContent = fmtPct(apr);
    const $pol = $('#qPolicyNote');
    if ($pol) $pol.hidden = q.withinPolicy !== false;
  }

  function quoteFailed() {
    ['#qCuota', '#qCosto', '#qTotal', '#qTae'].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
    const $ah = $('#qAhorroRow'); if ($ah) $ah.hidden = true;
    const $pol = $('#qPolicyNote'); if ($pol) $pol.hidden = true;
    setQuoteState('error');
  }

  async function fetchQuote(monto, plazo, seq) {
    let res;
    try {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const to = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 12000) : null;
      res = await fetch(QUOTE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `savings: true` es lo que se mandó siempre (no hay casilla). El API
        // lo ignora y aplica la regla por plazo; se deja para que una versión
        // anterior del API cotice igual que hoy.
        body: JSON.stringify({ productCode: QUOTE_PRODUCT, amount: monto, termMonths: plazo, savings: true }),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (to) clearTimeout(to);
    } catch (e) {
      if (seq === quoteSeq) quoteFailed();
      return;
    }
    if (seq !== quoteSeq) return;                 // llegó tarde: hay una más nueva
    const data = await res.json().catch(() => null);
    if (seq !== quoteSeq) return;
    if (!res.ok || !data || !Number.isFinite(Number(data.cuota))) {
      // Aun con error (p. ej. fuera de tope) los límites pueden venir: se usan.
      if (data && data.limits) applyQuoteLimits(data.limits);
      quoteFailed();
      return;
    }
    if (data.limits) applyQuoteLimits(data.limits);
    quoteCache[quoteKey(monto, plazo)] = data;
    renderQuoteResult(data);
    setQuoteState('ok');
  }

  // Pide la cuota (con debounce). `inmediato` = sin esperar (al cargar).
  function updateQuote(inmediato) {
    const montoEl = $('[name="monto_solicitado"]');
    const plazoEl = $('[name="plazo_meses"]');
    if (!montoEl || !plazoEl) return;
    const monto = parseFloat(montoEl.value) || 0;
    const plazo = parseInt(plazoEl.value, 10) || 0;
    renderQuoteInputs(monto, plazo);
    clearTimeout(quoteTimer);
    const seq = ++quoteSeq;
    if (!monto || !plazo) {
      ['#qCuota', '#qCosto', '#qTotal', '#qTae'].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
      setQuoteState('idle');
      return;
    }
    const cached = quoteCache[quoteKey(monto, plazo)];
    if (cached) { renderQuoteResult(cached); setQuoteState('ok'); return; }
    setQuoteState('loading');
    const run = () => { if (seq === quoteSeq) fetchQuote(monto, plazo, seq); };
    if (inmediato === true) run();
    else quoteTimer = setTimeout(run, QUOTE_DEBOUNCE_MS);
  }

  // ===== DEDUP DE DOCUMENTOS (mismo archivo en dos slots) =====
  // Hash del contenido, no del nombre: dos slots con el mismo archivo tienen
  // el mismo SHA-256 aunque se llamen distinto.
  async function sha256Hex(file) {
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      // Fallback (contexto no seguro / sin SubtleCrypto): firma conservadora
      // por tamaño+nombre para no dar falsos positivos.
      return 'sz:' + file.size + ':' + (file.name || '');
    }
  }

  async function registerFileHashes(input) {
    const files = Array.from(input.files || []);
    if (files.length === 0) { delete fileHashes[input.name]; return; }
    try {
      fileHashes[input.name] = await Promise.all(files.map(sha256Hex));
      guardarEstadoDocs();
    } catch (_) { /* si falla, validateStep simplemente no bloquea por dup */ }
  }

  // Pares de slots con contenido idéntico entre TODOS los file inputs del form.
  function findDuplicateDocs() {
    const byHash = {};
    const dups = [];
    $$('input[type="file"]').forEach(inp => {
      const hashes = fileHashes[inp.name];
      if (!hashes) return;
      hashes.forEach(h => {
        if (!h) return;
        if (byHash[h] && byHash[h] !== inp.name) {
          dups.push({ first: byHash[h], second: inp.name });
        } else if (!byHash[h]) {
          byHash[h] = inp.name;
        }
      });
    });
    return dups;
  }

  // ===== FILE UPLOADS (preview + OCR auto-fill) =====

  // Vaciar un casillero. Sin esto un documento equivocado no tiene salida:
  // el input ya tiene fichero y el navegador no ofrece "quitar", asi que la
  // unica via era elegir otro archivo — y en un casillero OPCIONAL eso
  // dejaba la solicitud trancada por algo que no hacia falta (Leonard,
  // 2026-09-18). Limpia tambien lo que quedo colgando del archivo viejo:
  // la validacion, el hash antiduplicados y el resultado de OCR.
  // Un casillero dinamico (doc_payslips_2) guarda su OCR bajo el nombre BASE
  // con indice, no bajo su propio nombre. quitarArchivo y storeOcrResult
  // tienen que derivar ese indice de la MISMA forma: si se separan, quitar un
  // archivo lo saca de la pantalla y le deja los datos adentro.
  function indiceDeSlot(inputName, fallback) {
    const m = /_(\d+)$/.exec(inputName);
    return m ? Number(m[1]) - 1 : fallback;
  }

  // What the form remembers about a slot's file (checks, hash, bank range,
  // OCR). Shared by "Quitar", a refused selection and a draft slot that did
  // not come back, so all three forget exactly the same things.
  function limpiarEstadoDe(input) {
    docCheck[input.name] = undefined;
    delete fileHashes[input.name];
    delete docAnalizado[input.name];
    // El rango del extracto se guarda por nombre de casillero y alimenta la
    // cobertura de meses. Sin borrarlo, la solicitud sigue creyendo que un mes
    // esta cubierto por un documento que el cliente ya quito.
    delete bancoRangos[input.name];
    const base = baseDocName(input.name);
    if (Array.isArray(ocrResults[base])) {
      // Dinamico: se vacia SOLO su indice, los hermanos siguen cargados.
      // Fijo con varios archivos en un mismo input: se vacia todo.
      if (/_\d+$/.test(input.name)) ocrResults[base][indiceDeSlot(input.name, 0)] = null;
      else ocrResults[base] = [];
    } else if (base in ocrResults) {
      ocrResults[base] = null;
    }
  }

  function quitarArchivo(input) {
    input.value = '';
    // An OCR still running for the removed file must not mark the empty slot
    // as analysed (see marcarAnalizado).
    input._cflSelSeq = (input._cflSelSeq || 0) + 1;
    limpiarEstadoDe(input);
    void guardarArchivosBorrador(input);
    guardarEstadoDocs();
    const preview = $('[data-preview-for="' + input.name + '"]');
    if (preview) preview.innerHTML = '';
    const label = input.closest('.upload-label');
    if (label) { label.classList.remove('has-file'); label.classList.remove('invalid'); }
    input.classList.remove('invalid');
    // El mensaje rojo tiene que irse con el archivo: si se queda, la
    // pantalla sigue diciendo que falta algo que ya no esta.
    clearErrors();
    // El contador de "documentos cargados" lo actualiza el manejador de
    // cambios, que aqui no se dispara: sin esto quedaria contando el que
    // acabamos de quitar.
    updateUploadCounter();
    saveDraft();
  }

  // El boton vive DENTRO del <label>, que abre el dialogo de archivos al
  // hacer click. Sin frenar el evento, "Quitar" volveria a pedir un fichero.
  function botonQuitar(input) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-remove';
    btn.textContent = '✕ ' + (t('upload.remove') || 'Quitar');
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      quitarArchivo(input);
    });
    return btn;
  }

  // Thumbnail for an image, name + size for anything else.
  function pintarArchivos(preview, files) {
    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.alt = file.name;
        preview.appendChild(img);
      } else {
        const div = document.createElement('div');
        div.className = 'file-name';
        div.textContent = '📎 ' + file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';
        preview.appendChild(div);
      }
    });
  }

  // ===== DOCUMENT WEIGHT (compress + limits) =====
  // Re-encodes a photo as JPEG with its long side at IMAGE_MAX_SIDE_PX. The
  // browser applies the EXIF orientation when it decodes into an <img>, so
  // the result is upright. Anything it cannot decode (HEIC on a desktop, a
  // broken file) and any result that is not smaller is left as it was: this
  // only ever makes the upload lighter, never refuses it.
  async function comprimirImagen(file) {
    if (!file || !/^image\//i.test(file.type) || /svg/i.test(file.type)) return file;
    let url = null;
    try {
      url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('decode'));
        i.src = url;
      });
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return file;
      const scale = Math.min(1, IMAGE_MAX_SIDE_PX / Math.max(w, h));
      // Already within size: a JPEG is left alone (re-encoding would only
      // lose detail), and so is any small file.
      if (scale === 1 && (/jpe?g/i.test(file.type) || file.size <= IMAGE_COMPRESS_MIN_BYTES)) return file;
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const g = canvas.getContext('2d');
      // JPEG has no transparency: a PNG screenshot would turn black behind
      // the text without a white background.
      g.fillStyle = '#fff';
      g.fillRect(0, 0, cw, ch);
      g.drawImage(img, 0, 0, cw, ch);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', IMAGE_JPEG_QUALITY));
      if (!blob || blob.size >= file.size) return file;
      const name = String(file.name || 'foto').replace(/\.[^.]*$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
    } catch (e) {
      return file;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  // Bytes of every attached document, optionally leaving one slot out (the
  // one whose selection is being replaced).
  function totalDocBytes(exceptName) {
    let total = 0;
    $$('input[type="file"]').forEach(inp => {
      if (inp.name === exceptName) return;
      Array.from(inp.files || []).forEach(f => { total += f.size || 0; });
    });
    return total;
  }

  function fmtMb(bytes) {
    return (Math.round(bytes / MB * 10) / 10).toFixed(1);
  }

  // Runs first on every new selection: shrinks the photos, then refuses the
  // selection if one file or the whole application would not fit through the
  // intake. Refusing HERE, with the document's name and the numbers, is the
  // point: the customer can still pick a lighter file, instead of losing the
  // application to a 413 at Submit. Returns the files to go on with, or null
  // when the selection was refused or replaced by a newer one meanwhile.
  async function prepararSeleccion(input, preview) {
    const seq = (input._cflSelSeq = (input._cflSelSeq || 0) + 1);
    const original = Array.from(input.files || []);
    if (original.length === 0) { void guardarArchivosBorrador(input); return []; }
    setOcrStatus(preview, '⏳ ' + (t('upload.preparing') || 'Preparando el documento…'), 'loading');
    const listos = [];
    for (const f of original) listos.push(await comprimirImagen(f));
    if (seq !== input._cflSelSeq) return null;
    if (listos.some((f, i) => f !== original[i])) ponerArchivos(input, listos);
    const files = Array.from(input.files || []);
    const doc = docLabelFor(input);
    const grande = files.find(f => f.size > MAX_FILE_BYTES);
    let msg = null;
    if (grande) {
      msg = t('error.file_too_big', { doc: doc, mb: fmtMb(grande.size), max: fmtMb(MAX_FILE_BYTES) }) ||
        (doc + ': el archivo pesa ' + fmtMb(grande.size) + ' MB y el máximo es ' + fmtMb(MAX_FILE_BYTES) + ' MB por documento.');
    } else {
      const total = totalDocBytes(input.name) + files.reduce((a, f) => a + (f.size || 0), 0);
      if (total > MAX_TOTAL_DOC_BYTES) {
        msg = t('error.total_too_big', { doc: doc, mb: fmtMb(total), max: fmtMb(MAX_TOTAL_DOC_BYTES) }) ||
          (doc + ': con este archivo los documentos sumarían ' + fmtMb(total) + ' MB y el máximo por solicitud es ' + fmtMb(MAX_TOTAL_DOC_BYTES) + ' MB.');
      }
    }
    if (msg) {
      quitarArchivo(input);
      const label = input.closest('.upload-label');
      if (label) label.classList.add('invalid');
      showErrors([msg]);
      return null;
    }
    preview.innerHTML = '';
    void guardarArchivosBorrador(input);
    return files;
  }

  function setupUploads() {
    $$('input[type="file"]').forEach(input => {
      input.addEventListener('change', async e => {
        const preview = $('[data-preview-for="' + input.name + '"]');
        if (!preview) return;
        preview.innerHTML = '';
        docCheck[input.name] = undefined; // re-validar tipo/vigencia en cada nueva selección
        delete docAnalizado[input.name];
        const files = await prepararSeleccion(input, preview);
        if (!files) return;
        const seq = input._cflSelSeq;
        void registerFileHashes(input);   // recomputar hash para detectar doc repetido (sobre el archivo ya comprimido)
        if (files.length === 0) return;
        const label = input.closest('.upload-label');
        if (label) label.classList.add('has-file');
        // Sube cada documento a S3 al adjuntarlo (en paralelo con el OCR).
        // Aplica a TODOS los tipos, incluidos los estados de banco.
        files.forEach((file, fidx) => uploadDoc(file, input.name, fidx));
        pintarArchivos(preview, files);

        // Siempre una salida: cualquier casillero con archivo se puede vaciar.
        preview.appendChild(botonQuitar(input));

        // doc_bancos: NO se hace OCR completo en el form (consume mucho API),
        // pero SÍ se hace una clasificación liviana para validar que el archivo
        // sea realmente un estado de banco. La extracción completa va al backend.
        if (baseDocName(input.name) === 'doc_bancos') {
          setOcrStatus(preview, '🔎 ' + (t('ocr.checking_type') || 'Verificando tipo de documento…'), 'loading');
          (async () => {
            for (let i = 0; i < files.length; i++) {
              await classifyDoc(files[i], input.name, i, preview);
            }
            const c = docCheck[input.name];
            if (c && c.tipo === 'mismatch') {
              setOcrStatus(
                preview,
                '⚠️ ' + (t('ocr.tipo_mismatch', { detected: tipoLabel(c.detected), expected: expectedTipoLabel(input.name) })
                  || 'Tipo de documento incorrecto'),
                'warn'
              );
            } else {
              setOcrStatus(
                preview,
                '📥 ' + (t('ocr.banco_received') || 'Estado di banko risibí — análisis se hará al procesar'),
                'ok'
              );
            }
            if (c && c.periodMatch === false) {
              showPeriodMismatchWarning(preview, input.name, c.periodDetail);
            }
            marcarAnalizado(input, seq);
          })();
          return;
        }

        // OCR auto-fill + store results para submit (igual que pipeline WhatsApp)
        const ocrType = OCR_TYPES[baseDocName(input.name)];
        if (ocrType && files.length > 0) {
          // Para slots dinámicos NO reseteamos el array completo (cada slot
          // guarda en su propio índice via storeOcrResult). Para slots
          // legacy (cedula, carta, aqualectra), sí reseteamos.
          const isDynamic = /_\d+$/.test(input.name);
          if (!isDynamic) {
            if (Array.isArray(ocrResults[input.name])) {
              ocrResults[input.name] = [];
            } else {
              ocrResults[input.name] = null;
            }
          }
          // Procesar TODOS los archivos (no solo el primero) en serie
          (async () => {
            for (let i = 0; i < files.length; i++) {
              await runOcr(files[i], ocrType, preview, input.name, i);
            }
            marcarAnalizado(input, seq);
          })();
        } else {
          marcarAnalizado(input, seq);
        }
      });
    });

    // Event delegation para slots dinámicos generados después de init.
    // Replicamos un subset mínimo del listener directo de arriba:
    // preview + uploadDoc + (clasificación o OCR según base name).
    document.addEventListener('change', async e => {
      const input = e.target;
      if (!input || input.type !== 'file') return;
      if (!input.name) return;
      const base = baseDocName(input.name);
      // Solo nos interesan los slots dinámicos (sufijo numérico).
      if (!/_\d+$/.test(input.name)) return;
      const preview = $('[data-preview-for="' + input.name + '"]');
      if (!preview) return;
      preview.innerHTML = '';
      docCheck[input.name] = undefined;
      delete docAnalizado[input.name];
      const files = await prepararSeleccion(input, preview);
      if (!files) return;
      const seq = input._cflSelSeq;
      void registerFileHashes(input);   // recomputar hash para detectar doc repetido (sobre el archivo ya comprimido)
      if (files.length === 0) {
        updateUploadCounter();
        return;
      }
      const label = input.closest('.upload-label');
      if (label) label.classList.add('has-file');
      files.forEach((file, fidx) => uploadDoc(file, input.name, fidx));
      pintarArchivos(preview, files);

      // Siempre una salida, igual que en los casilleros fijos. Estos son los
      // de "Payslip 2" / "Extracto 3": los crea el JS despues de cargar la
      // pagina, pasan por este manejador delegado y por eso #16 los dejo sin
      // boton — un documento equivocado ahi no se podia quitar, solo
      // reemplazar (Leonard, 2026-09-18).
      preview.appendChild(botonQuitar(input));

      if (base === 'doc_bancos') {
        setOcrStatus(preview, '🔎 ' + (t('ocr.checking_type') || 'Verificando tipo de documento…'), 'loading');
        (async () => {
          for (let i = 0; i < files.length; i++) {
            await classifyDoc(files[i], input.name, i, preview);
          }
          const c = docCheck[input.name];
          if (c && c.tipo === 'mismatch') {
            setOcrStatus(preview,
              '⚠️ ' + (t('ocr.tipo_mismatch', { detected: tipoLabel(c.detected), expected: expectedTipoLabel(input.name) })
                || 'Tipo di dokumento inkorekto'), 'warn');
          } else {
            setOcrStatus(preview,
              '📥 ' + (t('ocr.banco_received') || 'Estado di banko risibí — análisis se hará al procesar'), 'ok');
          }
          // Warning de período si NO coincide (informativo).
          if (c && c.periodMatch === false) {
            showPeriodMismatchWarning(preview, input.name, c.periodDetail);
          }
          marcarAnalizado(input, seq);
          updateUploadCounter();
        })();
        return;
      }
      const ocrType = OCR_TYPES[base];
      if (ocrType) {
        (async () => {
          for (let i = 0; i < files.length; i++) {
            await runOcr(files[i], ocrType, preview, input.name, i);
          }
          marcarAnalizado(input, seq);
          updateUploadCounter();
        })();
      } else {
        marcarAnalizado(input, seq);
        updateUploadCounter();
      }
    });
  }

  // The analysis of a selection finished: remember it (so a reload paints the
  // result instead of paying the OCR again) unless a newer selection replaced
  // it in the meantime.
  function marcarAnalizado(input, seq) {
    if (input._cflSelSeq !== seq) return;
    docAnalizado[input.name] = true;
    guardarEstadoDocs();
  }

  // ===== OCR =====
  function setOcrStatus(container, message, kind) {
    let badge = container.querySelector('.ocr-status');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'ocr-status';
      container.appendChild(badge);
    }
    badge.dataset.kind = kind || 'info';
    badge.textContent = message;
  }

  function storeOcrResult(inputName, idx, data) {
    const base = baseDocName(inputName);
    // Para slots dinámicos (doc_payslips_2 → base doc_payslips), el índice
    // viene del sufijo del nombre, no del idx pasado por la iteración.
    // Misma derivación que usa quitarArchivo, a propósito.
    const realIdx = indiceDeSlot(inputName, idx);
    if (Array.isArray(ocrResults[base])) {
      ocrResults[base][realIdx] = data;
    } else {
      ocrResults[base] = data;
    }
  }

  // ===== VALIDACIÓN DE DOCUMENTOS (tipo + vigencia) =====
  // Vencido si fecha_vencimiento (YYYY-MM-DD) es anterior a hoy.
  function isExpired(vence) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(vence || '').trim());
    if (!m) return false;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d < today;
  }

  // Días transcurridos desde una fecha (YYYY-MM-DD o dd/mm/yyyy). null si no parsea.
  function daysSinceDate(dateStr) {
    const s = String(dateStr || '').trim();
    let d = null;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
    if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    else if (dmy) d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    if (!d || isNaN(d.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.floor((today - d) / 86400000);
  }

  // Un token de reCAPTCHA v2 sirve UNA vez y vive unos dos minutos. Sin esto,
  // despues de un envio fallido el casillero sigue tildado con el token ya
  // gastado y CADA reintento manda el mismo token muerto: la persona ve el
  // mismo error para siempre y la unica salida es recargar, que le borra la
  // verificacion de email. Leonard, 18-sep, con un cliente delante.
  function resetCaptcha() {
    try {
      if (typeof grecaptcha !== 'undefined' && grecaptcha && typeof grecaptcha.reset === 'function') {
        grecaptcha.reset();
        return true;
      }
    } catch (e) { /* el script de Google no cargo: no hay nada que resetear */ }
    return false;
  }

  function tipoLabel(tipo) {
    return (tipo && t('tipo.' + tipo)) || t('tipo.unknown') || 'un documento';
  }
  function expectedTipoLabel(inputName) {
    const KEY = {
      doc_cedula: 'cedula',
      doc_cedula_conyuge: 'cedula',
      doc_id_adicional: 'id_adicional',
      doc_payslips: 'payslip',
      doc_bancos: 'bank_statement',
      doc_carta_trabajo: 'employment_letter',
      // Nombra los CUATRO documentos que el casillero acepta, no solo uno.
      // Mismo patron que doc_id_adicional ("un paspoort of rijbewijs").
      doc_aqualectra: 'comprobante_domicilio',
    };
    return tipoLabel(KEY[baseDocName(inputName)]);
  }

  // Evalúa un resultado OCR/clasificación de UN archivo: detecta tipo y vigencia,
  // y actualiza el agregado docCheck[inputName]. Devuelve el detalle de este archivo.
  function evaluateDoc(inputName, data, idx) {
    // Por el nombre BASE: los recibos y extractos viven en casilleros
    // numerados (doc_payslips_1…) y la tabla usa doc_payslips. Con el nombre
    // completo no encontraba nada, el tipo quedaba «desconocido» y un extracto
    // en el casillero de recibos (o al revés) pasaba sin aviso — caso
    // CFL-10127, 18-nov-2026 (Leonard: «eso no lo debería aceptar»).
    const expected = EXPECTED_TIPO[baseDocName(inputName)];
    const cur = docCheck[inputName] || { tipo: 'unknown', expired: false };
    let detected = (data && data.tipo_detectado) ? String(data.tipo_detectado).toLowerCase() : null;
    // banco/aqualectra devuelven un error explícito cuando el doc no es del tipo
    if (!detected && data && (data.error === 'no_bank_statement' || data.error === 'no_aqualectra')) {
      detected = 'otro';
    }
    let tipoStatus = 'unknown';
    if (expected && detected) tipoStatus = (expected.indexOf(detected) !== -1) ? 'ok' : 'mismatch';
    if (tipoStatus === 'mismatch') cur.tipo = 'mismatch';
    else if (cur.tipo !== 'mismatch' && tipoStatus === 'ok') cur.tipo = 'ok';
    if (detected) cur.detected = detected;
    // Vigencia (solo cédula / ID adicional)
    let expired = false, vence = null;
    if (EXPIRY_DOCS.indexOf(inputName) !== -1) {
      vence = data && data.fecha_vencimiento;
      expired = isExpired(vence);
      if (expired) { cur.expired = true; cur.vence = vence; }
    }
    // Frescura de la carta de trabajo: debe confirmar empleo ACTUAL → reciente.
    if (baseDocName(inputName) === 'doc_carta_trabajo') {
      const issued = data && (data.fecha_emision_karta || data.fecha_emision ||
        data.fecha_carta || data.issue_date || data.fecha);
      const ageDays = daysSinceDate(issued);
      if (ageDays !== null && ageDays > MAX_WORK_LETTER_AGE_DAYS) {
        cur.stale = true; cur.issueDate = String(issued); cur.ageDays = ageDays;
      } else {
        cur.stale = false;
      }
    }
    docCheck[inputName] = cur;
    return { tipoStatus: tipoStatus, expired: expired, detected: detected, vence: vence };
  }

  // Clasificación liviana para el estado de banco (no pasa por OCR completo):
  // solo pide el tipo de documento. No bloquea si la clasificación falla.
  // Para bank statements usamos el modo 'banco_liviano' que ADEMÁS del tipo
  // extrae el periodo (desde/hasta) sin las transacciones — barato y rápido.
  // ===== COBERTURA DE EXTRACTOS =====
  // Mide los dias como UNION de los rangos, no como suma: asi el mismo mes
  // subido tres veces cuenta 30 dias y no 90, y el duplicado sale de la
  // aritmetica sin necesitar una regla aparte.
  //
  // Pasa si ALGUNA cuenta cubre el tramo pedido. Exigirselo a todas fallaria
  // a quien tiene una cuenta de ahorro que solo llega a dos meses.
  function evaluarCobertura(rangos, requiredDays, toleranceDays) {
    const DIA = 86400000;
    const porCuenta = {};
    rangos.forEach(function (r) {
      const desde = Date.parse(r.from);
      const hasta = Date.parse(r.to);
      if (isNaN(desde) || isNaN(hasta) || hasta < desde) return;
      const k = (r.account || '').toString().trim() || 'sin-cuenta';
      if (!porCuenta[k]) porCuenta[k] = [];
      porCuenta[k].push([desde, hasta]);
    });

    const cuentas = [];
    Object.keys(porCuenta).forEach(function (k) {
      const ord = porCuenta[k].slice().sort(function (a, b) { return a[0] - b[0]; });
      const unidos = [];
      let repetidos = 0;
      ord.forEach(function (par) {
        const ultimo = unidos[unidos.length - 1];
        if (!ultimo) { unidos.push([par[0], par[1]]); return; }
        if ((par[0] - ultimo[1]) / DIA <= toleranceDays) {
          if (par[0] < ultimo[1]) repetidos += Math.min(ultimo[1], par[1]) - par[0];
          ultimo[1] = Math.max(ultimo[1], par[1]);
        } else {
          unidos.push([par[0], par[1]]);
        }
      });
      const huecos = [];
      for (let i = 1; i < unidos.length; i++) {
        huecos.push({
          desde: new Date(unidos[i - 1][1]).toISOString().slice(0, 10),
          hasta: new Date(unidos[i][0]).toISOString().slice(0, 10),
          dias: Math.round((unidos[i][0] - unidos[i - 1][1]) / DIA)
        });
      }
      let mayor = 0;
      unidos.forEach(function (u) { mayor = Math.max(mayor, Math.round((u[1] - u[0]) / DIA)); });
      cuentas.push({
        cuenta: k, dias: mayor, repetidos: Math.round(repetidos / DIA),
        huecos: huecos, completa: mayor >= requiredDays
      });
    });

    cuentas.sort(function (a, b) { return b.dias - a.dias; });
    let mejor = null;
    for (let i = 0; i < cuentas.length; i++) { if (cuentas[i].completa) { mejor = cuentas[i]; break; } }
    if (!mejor) mejor = cuentas[0] || null;
    const completa = !!(mejor && mejor.completa);

    let motivo = null;
    if (!completa) {
      if (!mejor) {
        motivo = t('error.extractos_sin_periodo') || 'No pudimos leer el período de los extractos.';
      } else if (mejor.huecos.length > 0) {
        const h = mejor.huecos[0];
        motivo = t('error.extractos_hueco', { desde: h.desde, hasta: h.hasta, dias: h.dias })
          || ('Falta el período del ' + h.desde + ' al ' + h.hasta + ' (' + h.dias + ' días sin cubrir).');
      } else {
        motivo = t('error.extractos_cortos', { dias: mejor.dias, faltan: requiredDays - mejor.dias })
          || ('Los extractos cubren ' + mejor.dias + ' días seguidos y hacen falta ' + requiredDays + '.');
        if (mejor.repetidos > 0) {
          motivo += ' ' + (t('error.extractos_repetidos', { dias: mejor.repetidos })
            || ('Hay ' + mejor.repetidos + ' días repetidos: revise si subió el mismo mes más de una vez.'));
        }
      }
    }
    return { completa: completa, motivo: motivo, cuentas: cuentas };
  }

  // El OCR de v2 recibe el archivo como base64 dentro de un JSON. El webhook
  // de n8n recibía multipart, pero v2 no tiene @fastify/multipart instalado y
  // agregarlo sería un plugin nuevo en el arranque del servidor para no ganar
  // nada: `fileToBase64` ya está acá arriba y el intake v2 la usa desde
  // septiembre. La respuesta es la MISMA forma de siempre ({ok, data} con
  // data.tipo_detectado), así que de acá para abajo nada cambia.
  async function ocrRequest(file, docType) {
    const fileBase64 = await fileToBase64(file);
    return fetch(OCR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docType: docType,
        fileBase64: fileBase64,
        // undefined se cae del JSON; el endpoint los valida como opcionales
        // y recupera el tipo real por extensión o magic bytes si no van.
        mimeType: file.type || undefined,
        filename: file.name || undefined
      })
    });
  }

  async function classifyDoc(file, inputName, idx, container) {
    try {
      const base = baseDocName(inputName);
      const mode = (base === 'doc_bancos') ? 'banco_liviano' : 'clasificar';
      const res = await ocrRequest(file, mode);
      if (!res.ok) return;
      const result = await res.json();
      const data = (result && result.data) || null;
      if (data) {
        evaluateDoc(inputName, data, idx);
        // Para bank statements: validar período expected vs detected.
        const periodCheck = validatePeriodForInput(inputName, data);
        if (periodCheck) docCheck[inputName] = Object.assign(docCheck[inputName] || {}, periodCheck);
        // banco_liviano devuelve `titular` → validar contra la cédula.
        if (container) checkNameMatch(container, inputName, data);
        // Y guardamos el rango para medir la cobertura al enviar. idx === 0
        // limpia: cada tanda de subida empieza de cero, asi una
        // re-seleccion con menos ficheros no deja rangos viejos.
        if (base === 'doc_bancos') {
          if (idx === 0 || !bancoRangos[inputName]) bancoRangos[inputName] = [];
          bancoRangos[inputName][idx] = {
            account: data.numero_cuenta || null,
            from: data.periodo_desde || null,
            to: data.periodo_hasta || null
          };
        }
      }
    } catch (e) { /* clasificación opcional: no bloquea */ }
  }

  // Compara el período expected del slot (data-expected-year/month) contra
  // lo que el OCR devolvió. Devuelve { periodMatch:bool, periodDetail:string }
  // o null si no se puede validar. NO BLOQUEA: solo informativo.
  //
  // Un extracto de banco cubre un RANGO, y los bancos de acá lo cortan donde
  // les queda cómodo: el de agosto suele arrancar el 31-jul. Mirando solo
  // `periodo_desde` ese extracto se leía como julio y el cliente veía que su
  // documento correcto estaba mal (caso reportado por teléfono 2026-09-08).
  // Un extracto matchea el slot si el mes esperado CAE DENTRO del rango.
  function ym(str) {
    const m = /^(\d{4})-(\d{2})/.exec(String(str || ''));
    return m ? { y: parseInt(m[1], 10), m: parseInt(m[2], 10) } : null;
  }
  function ymIndex(y, m) { return y * 12 + (m - 1); }
  function ymLabel(p) { return p.y + '-' + String(p.m).padStart(2, '0'); }

  function validatePeriodForInput(inputName, ocrData) {
    const input = $('[name="' + inputName + '"]');
    if (!input) return null;
    const expY = parseInt(input.dataset.expectedYear, 10);
    const expM = parseInt(input.dataset.expectedMonth, 10);
    if (!expY || !expM) return null;
    const base = baseDocName(inputName);
    const want = ymIndex(expY, expM);

    if (base === 'doc_payslips') {
      const detY = parseInt(ocrData.periodo_anio, 10);
      const detM = parseInt(ocrData.periodo_mes, 10);
      if (!detY || !detM) return null;
      return {
        periodMatch: ymIndex(detY, detM) === want,
        periodDetail: detY + '-' + String(detM).padStart(2, '0')
      };
    }

    if (base === 'doc_bancos') {
      const desde = ym(ocrData.periodo_desde);
      const hasta = ym(ocrData.periodo_hasta);
      if (!desde && !hasta) return null;
      const from = desde || hasta;
      const to = hasta || desde;
      const lo = Math.min(ymIndex(from.y, from.m), ymIndex(to.y, to.m));
      const hi = Math.max(ymIndex(from.y, from.m), ymIndex(to.y, to.m));
      return {
        periodMatch: want >= lo && want <= hi,
        periodDetail: ymLabel(from) === ymLabel(to)
          ? ymLabel(from)
          : ymLabel(from) + ' → ' + ymLabel(to)
      };
    }
    return null;
  }

  // Renderiza el warning amber del período DEBAJO del status existente.
  function showPeriodMismatchWarning(container, inputName, periodDetail) {
    const input = $('[name="' + inputName + '"]');
    if (!input) return;
    const expY = input.dataset.expectedYear;
    const expM = input.dataset.expectedMonth;
    const expectedStr = expY + '-' + String(expM).padStart(2, '0');
    let warn = container.querySelector('.period-mismatch-warn');
    if (!warn) {
      warn = document.createElement('div');
      warn.className = 'period-mismatch-warn';
      container.appendChild(warn);
    }
    warn.textContent = '⚠️ ' +
      (t('ocr.period_mismatch', { expected: expectedStr, detected: periodDetail }) ||
        ('Período detectado: ' + periodDetail + '. Se esperaba ' + expectedStr +
         '. Verifique que el archivo correcto esté en este casillero.'));
  }

  // ===== VALIDACIÓN DE NOMBRE (doc vs cédula) =====
  // Solo ADVIERTE (no bloquea). Compara el titular del payslip / bank
  // statement / carta de trabajo contra el nombre de la cédula, por
  // apellido + nombre con tolerancia (los OCR devuelven el orden y la
  // puntuación distinta: "Mendez Contreras, Douglas J" vs
  // "Douglas Jose Mendez Contreras").

  // Normaliza a tokens comparables: minúsculas, sin acentos, sin
  // puntuación, descarta iniciales sueltas y palabras muy cortas.
  function nameTokens(str) {
    if (!str) return [];
    return String(str)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // saca acentos
      .replace(/[^a-z\s]/g, ' ')                          // saca dígitos/puntuación
      .split(/\s+/)
      .filter(function (w) { return w.length >= 3; });     // descarta "j", "e/v", "de", etc.
  }

  // De qué campo del OCR sale el nombre del titular según el tipo.
  function holderNameFromDoc(base, data) {
    if (!data) return null;
    if (base === 'doc_payslips') return data.nombre_empleado || null;
    if (base === 'doc_bancos') return data.titular || null;
    if (base === 'doc_carta_trabajo') return data.nombre_empleado || null;
    if (base === 'doc_aqualectra') return data.titular || null;
    return null;
  }

  // ¿Coinciden? Requiere al menos 2 tokens compartidos (típicamente un
  // nombre + un apellido). Con nombres largos de Curaçao esto tolera
  // reordenamientos y nombres/apellidos faltantes sin ser laxo.
  function namesMatch(cedulaName, docName) {
    var a = nameTokens(cedulaName);
    var b = nameTokens(docName);
    if (a.length === 0 || b.length === 0) return { ok: true, shared: 0 };  // sin datos → no molestar
    var setB = {};
    b.forEach(function (w) { setB[w] = true; });
    var shared = a.filter(function (w) { return setB[w]; });
    // Normalmente pedimos 2 tokens compartidos (nombre + apellido). Pero
    // cuando el documento sólo trae iniciales + apellido ("A.R. Bakker" →
    // 1 token usable), alcanza con que ese apellido coincida — si no,
    // marcaríamos como sospechoso a un titular legítimo.
    // Un documento puede traer las iniciales pegadas en lugar de los nombres,
    // y delante el apellido del conyuge: "MBM Vanderheyden - Visser" es
    // Marinus Benjamin Martin Visser. Comparten un solo token (el apellido),
    // asi que la regla de 2 lo marcaba como sospechoso siendo el titular.
    // Si el apellido coincide y alguno de los tokens restantes son sus
    // iniciales EN ORDEN, es la misma persona.
    function inicialesDe(blob, nombres) {
      var ini = nombres.map(function (n) { return n[0]; });
      var i = 0;
      for (var k = 0; k < blob.length; k++) {
        var hit = false;
        while (i < ini.length) { if (ini[i] === blob[k]) { hit = true; i++; break; } i++; }
        if (!hit) return false;
      }
      return true;
    }
    var ok = shared.length >= 2 || (b.length === 1 && shared.length >= 1);
    if (!ok && shared.length >= 1) {
      var enComun = {};
      shared.forEach(function (w) { enComun[w] = true; });
      var restoDoc = b.filter(function (w) { return !enComun[w]; });
      var restoCed = a.filter(function (w) { return !enComun[w]; });
      ok = restoDoc.some(function (blob) {
        return blob.length >= 2 && blob.length <= 4 && inicialesDe(blob, restoCed);
      });
    }
    return { ok: ok, shared: shared.length, sharedTokens: shared };
  }

  // Corre el check para un doc recién OCR-eado y muestra/oculta el warning.
  function checkNameMatch(container, inputName, data) {
    var base = baseDocName(inputName);
    var cedula = ocrResults.doc_cedula;
    var cedulaName = cedula && cedula.nombre_completo;
    if (!cedulaName) return;                        // todavía no hay cédula → nada que comparar
    var docName = holderNameFromDoc(base, data);
    if (!docName) return;                           // el doc no trae titular → nada que comparar
    var res = namesMatch(cedulaName, docName);
    docCheck[inputName] = Object.assign(docCheck[inputName] || {}, {
      nameMatch: res.ok, docHolderName: docName,
    });
    if (res.ok) {
      var ok = container.querySelector('.name-mismatch-warn');
      if (ok) ok.remove();
      return;
    }
    pintarAvisoNombre(container, docName, cedulaName);
  }

  // Shared with the restored draft, which has the two names but not the OCR.
  function pintarAvisoNombre(container, docName, cedulaName) {
    var warn = container.querySelector('.name-mismatch-warn');
    if (!warn) {
      warn = document.createElement('div');
      warn.className = 'name-mismatch-warn period-mismatch-warn';  // reusa el estilo amber
      container.appendChild(warn);
    }
    warn.textContent = '⚠️ ' +
      (t('ocr.name_mismatch', { doc: docName, cedula: cedulaName }) ||
        ('El titular de este documento ("' + docName + '") no coincide con el nombre de la cédula ("' +
         cedulaName + '"). Verifique que el documento sea del mismo solicitante.'));
  }

  async function runOcr(file, docType, container, inputName, idx) {
    const suffix = (Array.isArray(ocrResults[inputName])) ? ' (' + (idx + 1) + ')' : '';
    setOcrStatus(container, '🔎 ' + (t('ocr.analyzing') || 'Analizando documento…') + suffix, 'loading');
    try {
      const res = await ocrRequest(file, docType);
      if (!res.ok) {
        // 504 / 408 = timeout del servidor. Para documentos grandes el análisis
        // completo lo hace el backend al procesar la aplicación. (El 524 era de
        // Cloudflare cuando el OCR pasaba por n8n; se deja porque no cuesta nada
        // y el formulario viejo puede seguir cacheado en algún teléfono.)
        if (res.status === 524 || res.status === 504 || res.status === 408) {
          storeOcrResult(inputName, idx, { _timeout: true });
          setOcrStatus(
            container,
            '📥 ' + (t('ocr.received_async') || 'Documento recibido — se analizará al enviar la solicitud'),
            'ok'
          );
          return;
        }
        throw new Error('HTTP ' + res.status);
      }
      const result = await res.json();
      if (!result.ok || !result.data) {
        storeOcrResult(inputName, idx, null);
        setOcrStatus(container, '⚠️ ' + (t('ocr.no_data') || 'No se pudo leer el documento'), 'warn');
        return;
      }
      storeOcrResult(inputName, idx, result.data);
      // Validar tipo de documento (y vigencia) antes de auto-rellenar.
      const chk = evaluateDoc(inputName, result.data, idx);
      // Validar período (slot dinámico vs OCR). Solo informativo, no bloquea.
      const periodCheck = validatePeriodForInput(inputName, result.data);
      if (periodCheck) {
        docCheck[inputName] = Object.assign(docCheck[inputName] || {}, periodCheck);
        if (!periodCheck.periodMatch) {
          showPeriodMismatchWarning(container, inputName, periodCheck.periodDetail);
        }
      }
      // Validar que el titular del doc coincida con el nombre de la cédula.
      // Solo advierte, no bloquea.
      // The spouse's card is not the applicant's: comparing its name with
      // the applicant's would warn on every married applicant.
      const esConyuge = baseDocName(inputName) === 'doc_cedula_conyuge';
      if (!esConyuge) checkNameMatch(container, inputName, result.data);
      if (chk.tipoStatus === 'mismatch') {
        // No auto-rellenar desde un documento del tipo equivocado.
        setOcrStatus(
          container,
          '⚠️ ' + (t('ocr.tipo_mismatch', { detected: tipoLabel(chk.detected), expected: expectedTipoLabel(inputName) })
            || 'Tipo de documento incorrecto') + suffix,
          'warn'
        );
        return;
      }
      // Auto-fill solo desde el PRIMER archivo (los demás se mandan al backend)
      const filled = (idx === 0)
        ? (esConyuge ? aplicarCedulaConyuge(container, result.data) : applyOcrAutoFill(docType, result.data))
        : [];
      // The applicant's own card in the spouse slot: its warning stays (the
      // "document read" line below would replace it).
      if (esConyuge && idx === 0 && cedulaConyugeEsPropia()) {
        saveDraft();
        return;
      }
      // Cédula de un menor: se dice YA, no en el paso 4 (formulario#2).
      if (docType === 'cedula' && idx === 0 && !esConyuge) {
        const nacCed = fechaNacimientoCedula();
        if (nacCed && esMenorDeEdad(nacCed)) {
          setOcrStatus(container, '⚠️ ' + msgMenorSegunCedula(), 'warn');
          showErrors([msgMenorSegunCedula()]);
          saveDraft();
          return;
        }
      }
      if (idx === 0 && tipoEmpleoNoReconocido) {
        const aviso = container.querySelector('.tipo-empleo-warn') || document.createElement('div');
        aviso.className = 'tipo-empleo-warn period-mismatch-warn';
        aviso.textContent = '⚠️ ' + (t('ocr.tipo_empleo_otro') ||
          'Su carta de trabajo indica otro tipo de empleo. Verifique el tipo de empleo que eligió en el paso 2.');
        if (!aviso.parentNode) container.appendChild(aviso);
      }
      if (chk.expired) {
        setOcrStatus(
          container,
          '⚠️ ' + (t('ocr.expired', { date: chk.vence }) || 'Documento vencido') + suffix,
          'warn'
        );
        saveDraft();
      } else if (filled.length === 0) {
        setOcrStatus(container, '✓ ' + (t('ocr.read_ok') || 'Documento leído') + suffix, 'ok');
      } else {
        setOcrStatus(
          container,
          '✓ ' + (t('ocr.filled') || 'Auto-completados') + ': ' + filled.map(n => {
            const el = $('[name="' + n + '"]');
            return el ? fieldLabel(el) : n;
          }).join(', '),
          'ok'
        );
        saveDraft();
      }
    } catch (err) {
      console.warn('OCR error:', err);
      storeOcrResult(inputName, idx, null);
      setOcrStatus(container, '⚠️ ' + (t('ocr.error') || 'No fue posible analizar el documento'), 'warn');
    }
  }

  // The spouse's own cedula (Leonard, 22-nov-2026). Fills the spouse's
  // fields that are still empty (what the applicant typed is not overwritten
  // here; the server takes the card's name and number anyway), and says so
  // when the card is the applicant's own. Returns the field names it filled.
  function mismoNumeroId(a, b) {
    const n = function (v) { return String(v || '').replace(/[^0-9a-z]/gi, '').toLowerCase(); };
    return !!n(a) && n(a) === n(b);
  }
  function cedulaConyugeEsPropia() {
    const c = ocrResults.doc_cedula_conyuge;
    const propia = ocrResults.doc_cedula;
    return !!(c && propia && mismoNumeroId(c.numero_id, propia.numero_id));
  }
  function aplicarCedulaConyuge(container, data) {
    if (cedulaConyugeEsPropia()) {
      setOcrStatus(container, '⚠️ ' + (t('error.conyuge_cedula_propia') ||
        'La cédula que subió como la de su cónyuge es la suya.'), 'warn');
      return [];
    }
    const filled = [];
    const poner = function (name, value) {
      const el = $('[name="' + name + '"]');
      if (!el || !value || el.value.trim()) return;
      el.value = String(value).trim().slice(0, el.maxLength > 0 ? el.maxLength : 120);
      // Referencia 1 is copied from these fields on `input`.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      filled.push(name);
    };
    const nombre = String(data.nombre_completo || '').trim().replace(/\s+/g, ' ');
    if (nombre && !$('[name="conyuge_nombre"]').value.trim() && !$('[name="conyuge_apellido"]').value.trim()) {
      // The card prints given names first. The first word as the name and
      // the rest as the surname is only a guess for the screen; the server
      // stores the card's full name as it is.
      const partes = nombre.split(' ');
      poner('conyuge_nombre', partes[0]);
      poner('conyuge_apellido', partes.slice(1).join(' '));
    }
    poner('conyuge_numero_id', data.numero_id);
    if (nombre) {
      const info = container.querySelector('.conyuge-leida') || document.createElement('div');
      info.className = 'conyuge-leida field-hint';
      info.textContent = '✓ ' + (t('ocr.conyuge_leida', { name: nombre }) || ('Cédula de su cónyuge leída: ' + nombre));
      if (!info.parentNode) container.appendChild(info);
    }
    saveDraft();
    return filled;
  }

  // La carta dijo un tipo de empleo que el formulario no ofrece
  // (independiente / otro): se avisa en vez de vaciar el campo.
  let tipoEmpleoNoReconocido = false;
  function applyOcrAutoFill(docType, data) {
    // id_adicional no llena form fields, solo muestra preview readonly
    if (docType === 'id_adicional') {
      renderIdAdicionalPreview(data);
      return ['preview'];
    }
    // cedula: además del auto-fill, muestra preview con todos los datos extraídos
    if (docType === 'cedula') {
      renderCedulaPreview(data);
    }
    const map = OCR_FIELD_MAP[docType] || {};
    const filledLabels = [];
    tipoEmpleoNoReconocido = false;
    Object.keys(map).forEach(srcKey => {
      const targetName = map[srcKey];
      let val = data[srcKey];
      if (val === null || val === undefined || val === '') return;
      const field = $('[name="' + targetName + '"]');
      if (!field) return;
      // Mapeo especial para tipo_empleado: la carta devuelve
      // fijo|temporal|independiente|otro y el select sólo tiene
      // fijo|contrato|pensionado. Antes 'independiente'/'otro' se mapeaba a
      // 'otro', que no existe en el select: el campo quedaba en blanco y
      // updatePensionadoMode borraba la frecuencia y los casilleros de
      // payslips ya adjuntados (gauntlet r13, formulario#8). Ahora, si la
      // carta no dice algo que el select tenga, NO se toca el campo y se avisa.
      if (targetName === 'tipo_empleado') {
        const lower = String(val).toLowerCase();
        let mapped = null;
        if (lower.includes('pension') || lower.includes('jubilad') || lower.includes('penshon')) mapped = 'pensionado';
        else if (lower.includes('fij') || lower.includes('perman') || lower.includes('indefin')) mapped = 'fijo';
        else if (lower.includes('tempor') || lower.includes('contrat')) mapped = 'contrato';
        if (!mapped || !field.querySelector('option[value="' + mapped + '"]')) {
          tipoEmpleoNoReconocido = true;
          return;
        }
        // Ya es lo que eligió la persona: nada que cambiar (y sin volver a
        // dibujar los casilleros).
        if (field.value === mapped) return;
        val = mapped;
      }
      // Cuando se sube un doc nuevo, OCR siempre sobrescribe (el usuario espera ver
      // los datos del documento que acaba de subir). Si quiere corregir, lo hace después.
      field.value = String(val);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.classList.add('ocr-filled');
      filledLabels.push(targetName);
    });
    // Si OCR llenó tipo_empleado, actualizar el modo pensionado (labels + required)
    if (filledLabels.includes('tipo_empleado')) {
      updatePensionadoMode();
    }
    return filledLabels;
  }

  function renderCedulaPreview(data) {
    const box = document.querySelector('[data-ocr-info-for="doc_cedula"]');
    if (!box) return;
    if (!data || data.error) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const rows = [];
    const L = (k, fb) => t('ocr.' + k) || fb;
    if (data.nombre_completo) rows.push([L('lbl_nombre', 'Nombre'), data.nombre_completo]);
    if (data.numero_id) rows.push([L('lbl_numero', 'Número'), data.numero_id]);
    if (data.fecha_nacimiento) rows.push([L('lbl_nacimiento', 'Nacimiento'), data.fecha_nacimiento]);
    if (data.fecha_vencimiento) rows.push([L('lbl_vence', 'Vence'), data.fecha_vencimiento]);
    if (data.nacionalidad) rows.push([L('lbl_nacionalidad', 'Nacionalidad'), data.nacionalidad]);
    if (data.pais_nacimiento) rows.push([L('lbl_pais_nac', 'País de nacimiento'), data.pais_nacimiento]);
    if (data.sexo) rows.push([L('lbl_sexo', 'Sexo'), data.sexo]);
    if (data.estado_civil) rows.push([L('lbl_estado_civil', 'Estado civil'), data.estado_civil]);
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML = '<div class="ocr-info-header">📋 ' + escapeHtml(L('cedula_header', 'Datos de la cédula (detectados automáticamente)')) + '</div>' +
      '<dl class="ocr-info-list">' +
      rows.map(([k, v]) => '<dt>' + k + ':</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') +
      '</dl>';
    box.hidden = false;
  }

  function renderIdAdicionalPreview(data) {
    const box = document.querySelector('[data-ocr-info-for="doc_id_adicional"]');
    if (!box) return;
    if (!data || data.error) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const tipo = (data.tipo_documento || '').toLowerCase();
    const L = (k, fb) => t('ocr.' + k) || fb;
    const tipoLabel = tipo === 'paspoort' ? (t('tipo_doc.paspoort') || 'Paspoort')
                    : tipo === 'rijbewijs' ? (t('tipo_doc.rijbewijs') || 'Rijbewijs')
                    : (t('tipo_doc.otro') || 'Documento');
    const rows = [];
    if (data.numero) rows.push([L('lbl_numero', 'Número'), data.numero]);
    if (data.nombre_completo) rows.push([L('lbl_nombre', 'Nombre'), data.nombre_completo]);
    if (data.fecha_vencimiento) rows.push([L('lbl_vence', 'Vence'), data.fecha_vencimiento]);
    if (data.pais_emisor) rows.push([L('lbl_pais_emisor', 'País emisor'), data.pais_emisor]);
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML = '<div class="ocr-info-header">📄 ' + escapeHtml(tipoLabel + ' (' + L('auto_detected', 'detectado automáticamente') + ')') + '</div>' +
      '<dl class="ocr-info-list">' +
      rows.map(([k, v]) => '<dt>' + k + ':</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') +
      '</dl>';
    box.hidden = false;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ===== SUMMARY (Step 7) =====
  function buildSummary() {
    const $summary = $('#summary');
    if (!$summary) return;
    const data = new FormData($form);
    const get = (name) => data.get(name);
    const has = (name) => {
      const v = data.get(name);
      return v !== null && v !== undefined && String(v).trim() !== '';
    };
    const valBool = (name) => {
      const v = data.get(name);
      return v === 'true'
        ? '✓ ' + (t('common.yes') || 'Sí')
        : '✗ ' + (t('common.no') || 'No');
    };
    const fileCount = (name) => {
      const inp = $('[name="' + name + '"]');
      return (inp && inp.files) ? inp.files.length : 0;
    };
    // Los payslips y extractos viven en casilleros numerados (doc_payslips_1…):
    // contar sólo "doc_payslips" daba siempre 0.
    const slotCount = (base) => {
      const inputs = $$('input[type="file"][name^="' + base + '_"]');
      return inputs.filter(i => i.files && i.files.length > 0).length + '/' + inputs.length;
    };
    // Texto visible (traducido) de la opción elegida en un <select>.
    const optText = (name) => {
      const sel = $('select[name="' + name + '"]');
      const opt = sel && sel.selectedIndex > 0 ? sel.options[sel.selectedIndex] : null;
      return opt ? opt.textContent.trim() : (get(name) || '');
    };
    const L = (key, fallback) => String(t(key) || fallback).replace(/\*/g, '').replace(/^[^0-9A-Za-zÀ-ÿ¿]+/, '').trim();
    // Construye <dt>/<dd> solo si hay valor
    const row = (label, value) => (value === null || value === undefined || value === '' || value === '—')
      ? ''
      : '<dt>' + label + ':</dt><dd>' + value + '</dd>';
    const rowAlways = (label, value) =>
      '<dt>' + label + ':</dt><dd>' + (value || '—') + '</dd>';
    // Pregunta Si/No con detalle opcional cuando es Sí
    const yesNoDetail = (label, boolName, detailName, suffix) => {
      const isYes = get(boolName) === 'true';
      let val = isYes ? '✓ ' + (t('common.yes') || 'Sí') : '✗ ' + (t('common.no') || 'No');
      if (isYes && has(detailName)) {
        val += ' — ' + get(detailName) + (suffix || '');
      }
      return '<dt>' + label + ':</dt><dd>' + val + '</dd>';
    };

    // ===== Datos OCR del pasaporte / rijbewijs =====
    const idAdic = ocrResults.doc_id_adicional;
    let idAdicRows = '';
    if (idAdic && !idAdic.error && !idAdic._timeout) {
      const tipo = (idAdic.tipo_documento || '').toLowerCase();
      const tipoLabel = tipo === 'paspoort' ? L('tipo_doc.paspoort', 'Paspoort')
                      : tipo === 'rijbewijs' ? L('tipo_doc.rijbewijs', 'Rijbewijs')
                      : L('tipo_doc.otro', 'Documento');
      idAdicRows = row(tipoLabel, idAdic.numero)
                 + row(L('ocr.lbl_vence', 'Vence'), idAdic.fecha_vencimiento)
                 + row(L('ocr.lbl_pais_emisor', 'País emisor'), idAdic.pais_emisor);
    }

    // ===== Datos OCR del aqualectra (extra info útil para verificación de domicilio) =====
    const aqua = ocrResults.doc_aqualectra;
    let aquaRows = '';
    if (aqua && !aqua.error && !aqua._timeout) {
      aquaRows = row(L('summary.aqua_titular', 'Titular Aqualectra'), aqua.titular)
               + row(L('summary.aqua_cliente', 'Cliente Aqualectra'), aqua.numero_cliente);
    }

    // La cotización que ya se pidió para este monto y plazo (paso 1).
    const montoN = parseFloat(get('monto_solicitado')) || 0;
    const plazoN = parseInt(get('plazo_meses'), 10) || 0;
    const cotRaw = quoteCache[quoteKey(montoN, plazoN)];
    const cot = cotRaw && Number.isFinite(Number(cotRaw.cuota)) ? cotRaw : null;
    const moneda = ((cot && cot.currency) || 'XCG') + ' ';
    const sinDosPuntos = (txt) => String(txt).replace(/\s*:\s*$/, '');

    $summary.innerHTML =
      '<h4>' + (t('summary.personal') || 'Datos Personales') + '</h4>' +
      '<dl>' +
        rowAlways(t('step3.nombre') || 'Nòmber kompleto', get('nombre_completo')) +
        rowAlways(t('step3.cedula_num') || 'Number sédula', get('numero_id')) +
        idAdicRows +
        rowAlways(t('step3.fecha_nac') || 'Nasementu', fmtFecha(get('fecha_nacimiento'))) +
        rowAlways(t('step3.tipo_empleado') || 'Tipo empleo',
                  (t('step3.tipo_empleado_' + (get('tipo_empleado') || 'otro')) || get('tipo_empleado') || '—')) +
        (get('tipo_empleado') === 'pensionado' ? '' :
          rowAlways(t('step1.fecha_ingreso') ? t('step1.fecha_ingreso').replace(/\s*\*\s*$/, '') : 'Fecha di drenta',
                    fmtFecha(get('fecha_ingreso_empleo')))) +
        rowAlways(t('step3.profesion') || 'Profesión', get('profesion')) +
        rowAlways(
          (get('tipo_empleado') === 'pensionado'
            ? (t('step3.empleador_pensionado') || 'Pagador di penshon')
            : (t('step3.empleador') || 'Empleador')),
          get('empleador')) +
        rowAlways(t('step3.cargo') || 'Kargo', get('cargo')) +
        rowAlways(
          (get('tipo_empleado') === 'pensionado'
            ? (t('step3.salario_pensionado') || 'Penshon neto')
            : (t('step3.salario') || 'Salario neto')),
          'XCG ' + (get('salario_neto') || '0')) +
        rowAlways(t('step3.banco') || 'Banko', get('banco_debito')) +
        // Lo que declaró sobre el inhouden va en el resumen: es lo que más
        // pesa en la decisión y lo único que el cliente afirma sobre un
        // tercero, así que tiene que verlo antes de mandar.
        (get('inhouden_posible')
          ? rowAlways(
              t('step3.inhouden') || 'Inhouden',
              get('inhouden_posible') === 'si'
                ? (t('step3.inhouden_si') || 'Sí')
                : get('inhouden_posible') === 'no'
                  ? (t('step3.inhouden_no') || 'No')
                  : (t('step3.inhouden_no_se') || 'No preguntó'))
          : '') +
        // E kasá ta bai den e resúmen: ta un persona ku mester bin na e sita i
        // firma, pues e kliente mester mira e promé ku e manda.
        (get('estado_civil') === 'kasá' && (get('conyuge_nombre') || get('conyuge_apellido'))
          ? rowAlways(
              t('step3.conyuge') || 'Kasá',
              [get('conyuge_nombre'), get('conyuge_apellido')].filter(Boolean).join(' ') +
              (get('conyuge_telefono') ? ' — ' + get('conyuge_telefono') : '') +
              (get('conyuge_numero_id') ? ' — ' + get('conyuge_numero_id') : '') +
              (get('conyuge_email') ? ' — ' + get('conyuge_email') +
                (conyugeEmailVerifiedFor ? ' ✓' : '') : ''))
          : '') +
        rowAlways(t('step3.cuenta_bancaria') || 'Number di kuenta', get('cuenta_bancaria_debito')) +
        rowAlways(t('step3.email') || 'Email', get('email')) +
        rowAlways(t('step3.direccion') || 'Direkshon', get('direccion')) +
      '</dl>' +

      '<h4>' + (t('summary.prestamo') || 'Fiansa') + '</h4>' +
      '<dl>' +
        rowAlways(t('step6.monto') || 'Monto', moneda + fmtMoney(get('monto_solicitado') || 0)) +
        rowAlways(t('step6.plazo') || 'Plazo', (get('plazo_meses') || '0') + ' ' + (t('step6.q_meses') || 'meses')) +
        // Lo mismo que vio en la cotización del paso 1 (no se recalcula acá).
        rowAlways(sinDosPuntos(t('step6.q_cuota') || 'Cuota mensual'), cot ? moneda + fmtMoney(cot.cuota) : '—') +
        rowAlways(sinDosPuntos(t('step6.q_total') || 'Total a pagar'),
                  cot && cot.totals && Number.isFinite(Number(cot.totals.toPay)) ? moneda + fmtMoney(cot.totals.toPay) : '—') +
        rowAlways(sinDosPuntos(t('step6.q_tae') || 'TAE'), cot ? fmtPct(cot.aprAnnualPct) : '—') +
        rowAlways(t('step6.proposito') || 'Propósito',
                  [optText('proposito_categoria'), get('proposito')].filter(Boolean).join(' — ')) +
      '</dl>' +
      '<p class="quote-disclaimer">' + (cot ? (t('step6.q_disclaimer') || '') : (t('step6.q_error') || '')) + '</p>' +

      '<h4>' + (t('summary.contacto') || 'Kontakto') + '</h4>' +
      '<dl>' +
        rowAlways(t('step3.telefono_movil') || 'Selular', get('telefono_movil')) +
        row(t('step3.telefono_casa') || 'Tel kas', get('telefono_casa')) +
        rowAlways(t('step5.ref1') || 'Ref 1',
                  (get('ref1_nombre') || '—') + ' (' + (optText('ref1_relacion') || '—') + ') — ' + (get('ref1_telefono') || '—')) +
        (has('ref2_nombre')
          ? rowAlways(t('step5.ref2') || 'Ref 2',
                      get('ref2_nombre') + ' (' + (optText('ref2_relacion') || '—') + ') — ' + (get('ref2_telefono') || '—'))
          : '') +
      '</dl>' +

      '<h4>' + (t('summary.salud') || 'Salud') + '</h4>' +
      '<dl>' +
        rowAlways((t('step4.peso') || 'Peso') + ' / ' + (t('step4.talla') || 'Altura'),
                  (get('peso_kg') || '0') + ' kg / ' + (get('altura_cm') || '0') + ' cm') +
        rowAlways(L('summary.medico', 'Médico de cabecera'), get('medico_cabecera')) +
        yesNoDetail(t('step4.q1') || '1/6 Keho serio', 'dolencia_salud', 'dolencia_detalle') +
        yesNoDetail(t('step4.q2') || '2/6 Operashon 5a', 'operacion_5_anos', 'operacion_5_anos_detalle') +
        yesNoDetail(t('step4.q3') || '3/6 Malesa/Diskpasidat', 'otra_enfermedad', 'otra_enfermedad_detalle') +
        yesNoDetail(t('step4.q4') || '4/6 Medikamentu', 'medicamentos_receta', 'medicamentos_detalle') +
        yesNoDetail(t('step4.q5') || '5/6 HIV', 'hiv', 'hiv_detalle') +
        yesNoDetail(t('step4.q7') || '6/6 Otro', 'circunstancias_salud', 'circunstancias_detalle') +
      '</dl>' +

      '<h4>' + (t('summary.docs') || 'Dokumentonan') + '</h4>' +
      '<dl>' +
        rowAlways(L('step1.cedula', 'Cédula'), fileCount('doc_cedula') > 0 ? '✓' : '—') +
        (get('estado_civil') === 'kasá'
          ? rowAlways(L('step3.conyuge_cedula', 'Cédula del cónyuge'), fileCount('doc_cedula_conyuge') > 0 ? '✓' : '—')
          : '') +
        rowAlways(L('step1.id_adicional', 'ID adicional'), fileCount('doc_id_adicional') > 0 ? '✓' : '—') +
        rowAlways(L('step2.payslips_header', 'Payslips'), slotCount('doc_payslips')) +
        rowAlways(L('step2.bancos_header', 'Estados de cuenta'), slotCount('doc_bancos') + (bancosPendientes() ? ' — ' + (t('summary.bancos_pendientes') || 'pendientes: los enviará después') : '')) +
        rowAlways(L('step2.carta', 'Carta de trabajo'), fileCount('doc_carta_trabajo') > 0 ? '✓' : '—') +
        rowAlways(L('summary.comprobante', 'Comprobante de domicilio'), fileCount('doc_aqualectra') > 0 ? '✓' : '—') +
        aquaRows +
      '</dl>';
  }

  // ===== I18N =====
  function t(key, vars) {
    const parts = key.split('.');
    let result = i18nTexts;
    for (const p of parts) {
      if (result && typeof result === 'object' && p in result) result = result[p];
      else return null;
    }
    if (typeof result !== 'string') return null;
    if (vars) {
      Object.keys(vars).forEach(k => {
        result = result.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return result;
  }

  // El asterisco de obligatorio sale del atributo `required`, no del texto de
  // la traducción: las traducciones lo habían perdido en 15 campos, y uno
  // opcional lo tenía. Se recalcula al cambiar el idioma y con cada cambio del
  // formulario (casado, tipo de empleo y frecuencia encienden y apagan
  // obligatorios). Sólo etiquetas de texto plano de campos que no son casilla.
  function markRequiredLabels() {
    $$('label[for]').forEach(lbl => {
      if (lbl.childElementCount > 0) return;
      const ctl = document.getElementById(lbl.htmlFor);
      if (!ctl || ctl.type === 'checkbox' || ctl.type === 'radio' || ctl.type === 'file') return;
      const base = lbl.textContent.replace(/\s*\*\s*$/, '');
      const txt = ctl.required ? base + ' *' : base;
      if (txt !== lbl.textContent) lbl.textContent = txt;
    });
  }

  function applyI18n() {
    // Atributos que también salen del archivo de idioma: antes los
    // placeholders, los avisos `title` y el "Sédula" fijo quedaban en
    // papiamento o en español aunque la página estuviera en otro idioma.
    [['i18nPlaceholder', 'placeholder'], ['i18nTitle', 'title'], ['i18nValue', 'value'], ['i18nAria', 'aria-label']].forEach(([ds, attr]) => {
      const sel = '[data-' + ds.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ']';
      $$(sel).forEach(el => {
        const txt = t(el.dataset[ds]);
        if (!txt) return;
        if (attr === 'value') el.value = txt; else el.setAttribute(attr, txt);
      });
    });
    $$('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const vars = el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : null;
      const text = t(key, vars);
      if (!text) return;
      // Si el string de traducción contiene HTML (ej: links de términos),
      // se renderiza como HTML; si no, como texto plano (más seguro).
      if (/<\w+[^>]*>/.test(text)) {
        el.innerHTML = text;
      } else {
        el.textContent = text;
      }
    });
    markRequiredLabels();
  }

  async function loadI18n(lang) {
    try {
      const res = await fetch('i18n/' + lang + '.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('lang not found');
      i18nTexts = await res.json();
      currentLang = lang;
      document.documentElement.lang = lang;
      document.documentElement.dataset.lang = lang;
      $langSwitch.value = lang;
      applyI18n();
      updateProgress();
      // Etiquetas de la cuota (meses, montos) en el idioma nuevo.
      if (i18nReady) { try { updateQuote(true); } catch (err) {} }
      i18nReady = true;
      // Los slots dinámicos usan el nombre de mes del idioma actual, re-renderizar.
      try { renderDynamicSlots(); } catch (err) {}
    } catch (e) {
      // fallback: don't break the form
      console.warn('No se pudo cargar idioma ' + lang + ':', e.message);
    }
  }

  // ===== SUBMIT =====
  // When each consent box was ticked (sent as checkedAt), and the statement
  // slots following the "send them later" box.
  document.addEventListener('change', function (ev) {
    const el = ev.target;
    if (!el || !el.name) return;
    const m = /^consentimiento_(.+)$/.exec(el.name);
    if (m) consentCheckedAt[m[1]] = el.checked ? new Date().toISOString() : undefined;
    if (el.name === 'extractos_pendientes') applyBancosPendientes();
  });

  async function submitForm(e) {
    e.preventDefault();
    if (!validateStep(7)) return;
    // Un borrador viejo pudo traer una fecha que no pasó por el paso 4.
    const nacSubmit = $('[name="fecha_nacimiento"]');
    if (nacSubmit && esMenorDeEdad(nacSubmit.value)) {
      showErrors([msgMenorDeEdad()]);
      return;
    }
    if (!$('[name="acepta_terminos"]').checked) {
      showErrors([t('error.terms') || 'Debes aseptá e términos i kondishon.']);
      return;
    }
    const faltanConsentimientos = missingConsentMessages();
    if (faltanConsentimientos.length) {
      showErrors(faltanConsentimientos);
      return;
    }
    // A verification that aged out while the page stayed open: ask for a new
    // code rather than send a contact the server will not count as verified.
    const emailSubmit = $('[name="email"]');
    const phoneSubmit = $('[name="telefono_movil"]');
    const emailVencido = EMAIL_VERIFY_REQUIRED && emailSubmit && emailSubmit.value && emailVerifiedFor && !isEmailVerified();
    const phoneVencido = PHONE_VERIFY_REQUIRED && phoneSubmit && phoneSubmit.value && phoneVerifiedFor && !isPhoneVerified();
    if (emailVencido || phoneVencido) {
      if (emailVencido) resetEmailVerification();
      if (phoneVencido) resetPhoneVerification();
      showErrors([t('error.verify_expired') ||
        'La verificación de su email o celular venció. Vuelva al paso 4 y pida un código nuevo.']);
      return;
    }

    // Last guard on the weight (each selection is already checked when it is
    // attached; this covers anything that slipped past, e.g. an old draft).
    const pesoTotal = totalDocBytes();
    if (pesoTotal > MAX_TOTAL_DOC_BYTES) {
      showErrors([t('error.total_too_big_submit', { mb: fmtMb(pesoTotal), max: fmtMb(MAX_TOTAL_DOC_BYTES) }) ||
        ('Los documentos suman ' + fmtMb(pesoTotal) + ' MB y el máximo por solicitud es ' + fmtMb(MAX_TOTAL_DOC_BYTES) + ' MB.')]);
      return;
    }

    $btnSubmit.disabled = true;
    $btnSubmit.textContent = t('nav.submitting') || 'Mandando...';
    clearErrors();

    // ---- v2 direct path: post everything (fields + OCR + docs base64) to the
    // v2 API and skip the n8n submit/upload/vincular flow entirely. ----
    if (USE_V2_INTAKE) {
      try {
        const result = await submitToV2();
        track(7, 'enviado');
        // Read before the draft goes: the last screen says plainly that the
        // statements are pending and how they are sent (DECISION 2).
        const conExtractosPendientes = bancosPendientes() || result.bankStatementsPending === true;
        clearDraft();
        // El número que conoce la persona (CFL-…); el UUID sólo si el API no
        // lo devolviera.
        const ref = result.applicationNumber || result.applicationId;
        if (ref) {
          $('#aplicacionIdMsg').textContent = result.applicationNumber ? ref : '#' + ref;
          const box = $('#doneIdBox'); if (box) box.hidden = false;
        }
        // El API manda el acuse SÓLO si el email quedó verificado en esta
        // sesión (dentro de su ventana de 24 h), y ahora lo dice en la
        // respuesta. La pantalla promete el correo únicamente en ese caso:
        // antes lo prometía siempre, y un borrador retomado al otro día no
        // recibía nada (gauntlet r13, formulario#4).
        const emailEl = $('[name="email"]');
        const email = emailEl && emailEl.value ? emailEl.value.trim() : '';
        const $mail = $('#doneEmailMsg');
        if ($mail && email && result.emailVerified === true) {
          $mail.textContent = t('done.email_sent', { email: email }) ||
            ('Le enviaremos una confirmación a ' + email + '.');
          $mail.hidden = false;
        }
        // Ronda 13: el enlace firmado para ver el estado y mandar el documento que falte (estado.html).
        const $st = $('#doneStatusBox'), $stA = $('#doneStatusLink');
        if ($st && $stA && /^https:\/\//.test(result.statusUrl || '')) { $stA.href = result.statusUrl; $st.hidden = false; }
        const $pend = $('#donePendingMsg');
        if ($pend) {
          const conEnlace = $st && !$st.hidden;
          $pend.textContent = conEnlace
            ? (t('done.bancos_pendientes') || 'Sus estados de cuenta bancarios están pendientes. Su solicitud queda en espera hasta que los recibamos: envíe uno por cada mes desde el enlace de abajo.')
            : (t('done.bancos_pendientes_sin_enlace') || 'Sus estados de cuenta bancarios están pendientes. Su solicitud queda en espera hasta que los recibamos. Llámenos al +5999 526 8480 y le indicaremos cómo enviarlos.');
          $pend.hidden = !conExtractosPendientes;
        }
        showStep('done');
      } catch (err) {
        console.error('v2 intake error:', err);
        // El token del captcha ya se consumio en el intento fallido. Se pide
        // uno nuevo ANTES de devolverle el boton, para que el reintento no
        // vuelva a fallar por la misma razon.
        const seReseteo = resetCaptcha();
        const avisos = [intakeErrorMessage(err)];
        // El mensaje del captcha ya pide marcar la casilla: no repetirlo.
        const esCaptcha = err && /^CAPTCHA_/.test(err.intakeCode || '');
        if (seReseteo && !esCaptcha) {
          avisos.push(t('error.captcha_retry') ||
            'Marque de nuevo la casilla "No soy un robot" antes de volver a enviar.');
        }
        showErrors(avisos);
        $btnSubmit.disabled = false;
        $btnSubmit.textContent = t('nav.submit') || 'Entregá aplikashon';
      }
      return;
    }

    // Antes de entregar, esperar a que TODAS las subidas de documentos terminen.
    // Si alguna falló (tras reintentos), abortar y pedir al cliente que reintente.
    $btnSubmit.textContent = t('nav.waiting_uploads') || 'Esperando documentos...';
    const upRes = await waitForUploads();
    if (!upRes.ok) {
      const lista = upRes.fallidos.map(function (f) {
        return docLabelFor({ name: f.docType }) + (f.idx > 0 ? ' #' + (f.idx + 1) : '');
      }).join(', ');
      showErrors([
        (t('error.uploads_failed') || 'No se pudo subir estos documentos al servidor:') + ' ' + lista,
        t('error.uploads_retry') || 'Por favor adjúntelos de nuevo y vuelva a Enviar.'
      ]);
      $btnSubmit.disabled = false;
      $btnSubmit.textContent = t('nav.submit') || 'Entregá aplikashon';
      return;
    }
    $btnSubmit.textContent = t('nav.submitting') || 'Mandando...';

    try {
      // Solo campos de texto. Los documentos ya los procesó el OCR al subirlos;
      // reenviar los binarios infla el POST y puede pasar el límite del webhook (causa de 500).
      const fd = new FormData();
      new FormData($form).forEach((val, key) => {
        if (val instanceof File) return;
        fd.append(key, val);
      });
      fd.append('_lang', currentLang);
      fd.append('_submitted_at', new Date().toISOString());

      // Si el OCR no llenó los datos del cédula (sexo/estado_civil/etc), usar
      // los valores del formulario como respaldo. El backend lee ocr.doc_cedula.
      const cedulaOcr = Object.assign({}, ocrResults.doc_cedula || {});
      const fGet = function (n) { const el = $('[name="' + n + '"]'); return el ? String(el.value || '').trim() : ''; };
      const overlay = {
        sexo: fGet('sexo'),
        estado_civil: fGet('estado_civil'),
        nacionalidad: fGet('nacionalidad'),
        pais_nacimiento: fGet('pais_nacimiento'),
        fecha_vencimiento: fGet('fecha_venc_id1')
      };
      for (const k in overlay) { if (overlay[k]) cedulaOcr[k] = overlay[k]; }
      ocrResults.doc_cedula = cedulaOcr;

      // Sanitizar OCR extractions antes de enviar. Access rechaza numero_id2 > ~10 chars
      // (bug hallado con Denise Gustina — OCR devolvió 32 chars de basura del rijbewijs
      // y el import a Tbl_NewApps fallaba silencioso). Si el OCR devuelve algo demasiado
      // largo o vacío, mejor no mandarlo y que Leonard lo pida después por WhatsApp.
      const MAX_ID_LEN = 15;
      if (ocrResults.doc_id_adicional && ocrResults.doc_id_adicional.numero) {
        const num = String(ocrResults.doc_id_adicional.numero).trim();
        if (num.length > MAX_ID_LEN || num.length < 5) {
          console.warn('OCR doc_id_adicional.numero inválido, nullificado:', num.length, 'chars');
          ocrResults.doc_id_adicional.numero = null;
        }
      }
      if (ocrResults.doc_cedula && ocrResults.doc_cedula.numero) {
        const num = String(ocrResults.doc_cedula.numero).trim();
        if (num.length > MAX_ID_LEN) {
          console.warn('OCR doc_cedula.numero > MAX_ID_LEN, truncando:', num.length);
          ocrResults.doc_cedula.numero = num.slice(0, MAX_ID_LEN);
        }
      }

      // (El control "celular igual a la cédula" corre ahora en validateStep(4).)

      // Resultados OCR (para que el backend los use igual que pipeline WhatsApp)
      fd.append('_ocr_results', JSON.stringify(ocrResults));

      // The last request of the whole flow, and it used to be the only one
      // without a retry: every document upload gets three attempts and a 45s
      // timeout, while the submit that actually files the application got one
      // shot. A customer on LTE hit "Load failed" here today with everything
      // already filled in and uploaded — one dropped packet away from losing
      // the lot.
      //
      // Retried three times with a growing pause. Only network failures and 5xx
      // are retried: a 4xx means the server understood and refused, and sending
      // it again would just file the same application twice.
      const response = await postWithRetry(WEBHOOK_URL, fd);

      if (!response.ok) throw new Error('Server returned ' + response.status);
      const result = await response.json();

      if (result.ok || result.aplicacion_id) {
        track(7, 'enviado');
        clearDraft();
        if (result.aplicacion_id) {
          $('#aplicacionIdMsg').textContent = '#' + result.aplicacion_id;
          const box = $('#doneIdBox'); if (box) box.hidden = false;
          vincularDocumentos(result.aplicacion_id);
        }
        showStep('done');
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (err) {
      console.error('Submit error:', err);
      showErrors([
        (t('error.submit') || 'Hubo un problema al enviar.') +
        ' (' + err.message + ')'
      ]);
      $btnSubmit.disabled = false;
      $btnSubmit.textContent = t('nav.submit') || 'Entregá aplikashon';
    }
  }

  // POST with a timeout and three attempts, for the requests we cannot afford
  // to lose. Retries a network failure or a 5xx; never a 4xx, which the server
  // understood and refused on purpose.
  async function postWithRetry(url, body, attempts) {
    const max = attempts || 3;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timeoutId = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 45000) : null;
      try {
        const opts = { method: 'POST', body: body };
        if (ctrl) opts.signal = ctrl.signal;
        const res = await fetch(url, opts);
        if (timeoutId) clearTimeout(timeoutId);
        if (res.status >= 500 && i < max - 1) {
          lastErr = new Error('Server returned ' + res.status);
          await new Promise(function (r) { setTimeout(r, 1500 * (i + 1)); });
          continue;
        }
        return res;
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        lastErr = err;
        if (i < max - 1) {
          await new Promise(function (r) { setTimeout(r, 1500 * (i + 1)); });
          continue;
        }
      }
    }
    throw lastErr || new Error('Network error');
  }

  // ===== EMAIL VERIFICATION =====
  // Flujo: cliente escribe email → click "Verificar" → llama email-verify-send
  // → ingresa código → click "Confirmar" → llama email-verify-confirm.
  // emailVerifiedFor guarda el email exacto que se verificó; si lo cambia, se
  // invalida y tiene que verificar de nuevo.
  let emailVerifiedFor = null;
  let emailVerifiedAt = null;
  let resendCooldownTimer = null;

  // Lista corta de typos comunes en dominios populares.
  const EMAIL_TYPO_MAP = {
    'gnail.com': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'gmail.co': 'gmail.com',
    'hotnail.com': 'hotmail.com',
    'hotmal.com': 'hotmail.com',
    'yhaoo.com': 'yahoo.com',
    'yaho.com': 'yahoo.com',
    'outlok.com': 'outlook.com',
    'outloo.com': 'outlook.com',
    'live.co': 'live.com',
  };

  function suggestEmailFix(email) {
    if (!email || !email.includes('@')) return null;
    const [user, domain] = email.toLowerCase().split('@');
    const fix = EMAIL_TYPO_MAP[domain];
    return fix ? (user + '@' + fix) : null;
  }

  function isEmailVerified() {
    if (!EMAIL_VERIFY_REQUIRED) return true;
    const emailInput = $('[name="email"]');
    if (!emailInput) return true;
    return !!emailVerifiedFor && verificacionVigente(emailVerifiedAt) &&
      emailInput.value.trim().toLowerCase() === emailVerifiedFor;
  }

  function setVerifyStatus(msg, kind) {
    const el = $('#emailVerifyStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function startResendCooldown(seconds) {
    const resendBtn = $('#emailVerifyResendBtn');
    if (!resendBtn) return;
    if (resendCooldownTimer) clearInterval(resendCooldownTimer);
    let remaining = seconds;
    resendBtn.hidden = false;
    resendBtn.disabled = true;
    const baseText = t('step3.email_verify_resend') || 'Manda kodigo atrobe';
    function tick() {
      if (remaining <= 0) {
        clearInterval(resendCooldownTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = baseText;
        return;
      }
      resendBtn.textContent = baseText + ' (' + remaining + 's)';
      remaining -= 1;
    }
    tick();
    resendCooldownTimer = setInterval(tick, 1000);
  }

  async function sendVerificationCode() {
    const emailInput = $('[name="email"]');
    if (!emailInput) return;
    const email = emailInput.value.trim().toLowerCase();
    if (!email || !emailInput.checkValidity()) {
      setVerifyStatus(t('step3.email_verify_invalid') || 'Email inválido', 'warn');
      return;
    }
    const verifyBtn = $('#emailVerifyBtn');
    const panel = $('#emailVerifyPanel');
    if (verifyBtn) verifyBtn.disabled = true;
    setVerifyStatus(t('step3.email_verify_sending') || 'Enviando código...', 'loading');
    try {
      const res = await fetch(EMAIL_VERIFY_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, tracking_id: getTrackingId(), lang: currentLang })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        if (panel) panel.hidden = false;
        setVerifyStatus(t('step3.email_verify_sent') || 'Código enviado. Revise su email.', 'ok');
        startResendCooldown(data.cooldown_seconds || 60);
        const codeInput = $('#emailVerifyCode');
        if (codeInput) codeInput.focus();
      } else if (data.reason === 'cooldown') {
        if (panel) panel.hidden = false;
        setVerifyStatus(t('step3.email_verify_cooldown') || 'Espere unos segundos antes de pedir otro código.', 'warn');
        startResendCooldown(data.cooldown_seconds || 60);
      } else {
        setVerifyStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
      }
    } catch (e) {
      console.warn('email verify send failed', e);
      setVerifyStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
    } finally {
      if (verifyBtn) verifyBtn.disabled = false;
    }
  }

  async function confirmVerificationCode() {
    const emailInput = $('[name="email"]');
    const codeInput = $('#emailVerifyCode');
    if (!emailInput || !codeInput) return;
    const email = emailInput.value.trim().toLowerCase();
    const code = codeInput.value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      setVerifyStatus(t('step3.email_verify_code_format') || 'El código son 6 dígitos.', 'warn');
      return;
    }
    const confirmBtn = $('#emailVerifyConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    setVerifyStatus(t('step3.email_verify_checking') || 'Verificando...', 'loading');
    try {
      const res = await fetch(EMAIL_VERIFY_CONFIRM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code, tracking_id: getTrackingId() })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.verified) {
        marcarEmailVerificado(email);
        saveDraft();
      } else if (data.reason === 'wrong_code') {
        setVerifyStatus(
          (t('step3.email_verify_wrong', { left: data.attempts_left }) ||
            'Código incorrecto. Le quedan ' + data.attempts_left + ' intentos.'),
          'warn'
        );
      } else if (data.reason === 'exhausted') {
        setVerifyStatus(t('step3.email_verify_exhausted') || 'Demasiados intentos. Pida un código nuevo.', 'warn');
      } else if (data.reason === 'no_active_code') {
        setVerifyStatus(t('step3.email_verify_no_active') || 'No hay código activo. Pida uno nuevo.', 'warn');
      } else {
        setVerifyStatus(t('step3.email_verify_error') || 'No pudimos verificar el código.', 'warn');
      }
    } catch (e) {
      console.warn('email verify confirm failed', e);
      setVerifyStatus(t('step3.email_verify_error') || 'No pudimos verificar el código.', 'warn');
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  function marcarEmailVerificado(email, at) {
    emailVerifiedFor = email;
    emailVerifiedAt = at || new Date().toISOString();
    const panel = $('#emailVerifyPanel');
    const success = $('#emailVerifySuccess');
    const verifyBtn = $('#emailVerifyBtn');
    const emailInput = $('[name="email"]');
    if (panel) panel.hidden = true;
    if (success) success.hidden = false;
    if (verifyBtn) verifyBtn.hidden = true;
    if (emailInput) emailInput.readOnly = true;
    setVerifyStatus('', '');
    clearInterval(resendCooldownTimer);
  }

  function resetEmailVerification() {
    emailVerifiedFor = null;
    const panel = $('#emailVerifyPanel');
    const success = $('#emailVerifySuccess');
    const verifyBtn = $('#emailVerifyBtn');
    const emailInput = $('[name="email"]');
    if (panel) panel.hidden = true;
    if (success) success.hidden = true;
    if (verifyBtn) verifyBtn.hidden = false;
    if (emailInput) emailInput.readOnly = false;
    setVerifyStatus('', '');
    clearInterval(resendCooldownTimer);
  }

  // ===== SPOUSE E-MAIL VERIFICATION (22-nov-2026) =====
  // The same one-time code as the applicant's own e-mail (/email-verify, same
  // session id), sent to the spouse's inbox with a text that says why
  // (`para: 'conyuge'`). The spouse gives the code to the applicant. Optional:
  // an e-mail that is not verified does not stop the application; the server
  // keeps it as not verified and sends nothing to it.
  let conyugeEmailVerifiedFor = null;
  let conyugeEmailVerifiedAt = null;

  function conyugeEmailStatus(msg, kind) {
    const el = $('#conyugeEmailVerifyStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function marcarConyugeEmail(email, at) {
    conyugeEmailVerifiedFor = email;
    conyugeEmailVerifiedAt = at || new Date().toISOString();
    const panel = $('#conyugeEmailVerifyPanel');
    const ok = $('#conyugeEmailVerifySuccess');
    const btn = $('#conyugeEmailVerifyBtn');
    const input = $('[name="conyuge_email"]');
    if (panel) panel.hidden = true;
    if (ok) ok.hidden = false;
    if (btn) btn.hidden = true;
    if (input) input.readOnly = true;
    conyugeEmailStatus('', '');
  }

  function resetConyugeEmail() {
    conyugeEmailVerifiedFor = null;
    conyugeEmailVerifiedAt = null;
    const panel = $('#conyugeEmailVerifyPanel');
    const ok = $('#conyugeEmailVerifySuccess');
    const btn = $('#conyugeEmailVerifyBtn');
    const input = $('[name="conyuge_email"]');
    if (panel) panel.hidden = true;
    if (ok) ok.hidden = true;
    if (btn) btn.hidden = false;
    if (input) input.readOnly = false;
    conyugeEmailStatus('', '');
  }

  async function enviarCodigoConyuge() {
    const input = $('[name="conyuge_email"]');
    if (!input) return;
    const email = input.value.trim().toLowerCase();
    if (!email || !input.checkValidity()) {
      conyugeEmailStatus(t('step3.email_verify_invalid') || 'Email inválido', 'warn');
      return;
    }
    const propio = $('[name="email"]');
    if (propio && propio.value.trim().toLowerCase() === email) {
      conyugeEmailStatus(t('error.conyuge_email_propio') || 'El correo de su cónyuge no puede ser el mismo que el suyo.', 'warn');
      return;
    }
    const btn = $('#conyugeEmailVerifyBtn');
    if (btn) btn.disabled = true;
    conyugeEmailStatus(t('step3.email_verify_sending') || 'Enviando código...', 'loading');
    try {
      const res = await fetch(EMAIL_VERIFY_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, tracking_id: getTrackingId(), lang: currentLang, para: 'conyuge' })
      });
      const data = await res.json().catch(() => ({}));
      const panel = $('#conyugeEmailVerifyPanel');
      if (data.ok) {
        if (panel) panel.hidden = false;
        conyugeEmailStatus(t('step3.email_verify_sent') || 'Código enviado.', 'ok');
        const code = $('#conyugeEmailVerifyCode');
        if (code) code.focus();
      } else if (data.reason === 'cooldown') {
        if (panel) panel.hidden = false;
        conyugeEmailStatus(t('step3.email_verify_cooldown') || 'Espere unos segundos antes de pedir otro código.', 'warn');
      } else {
        conyugeEmailStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
      }
    } catch (e) {
      console.warn('spouse email verify send failed', e);
      conyugeEmailStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function confirmarCodigoConyuge() {
    const input = $('[name="conyuge_email"]');
    const codeInput = $('#conyugeEmailVerifyCode');
    if (!input || !codeInput) return;
    const email = input.value.trim().toLowerCase();
    const code = codeInput.value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      conyugeEmailStatus(t('step3.email_verify_code_format') || 'El código son 6 dígitos.', 'warn');
      return;
    }
    const btn = $('#conyugeEmailVerifyConfirmBtn');
    if (btn) btn.disabled = true;
    conyugeEmailStatus(t('step3.email_verify_checking') || 'Verificando...', 'loading');
    try {
      const res = await fetch(EMAIL_VERIFY_CONFIRM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code, tracking_id: getTrackingId() })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.verified) {
        marcarConyugeEmail(email);
        saveDraft();
      } else if (data.reason === 'wrong_code') {
        conyugeEmailStatus(t('step3.email_verify_wrong', { left: data.attempts_left }) ||
          ('Código incorrecto. Le quedan ' + data.attempts_left + ' intentos.'), 'warn');
      } else if (data.reason === 'exhausted') {
        conyugeEmailStatus(t('step3.email_verify_exhausted') || 'Demasiados intentos. Pida un código nuevo.', 'warn');
      } else if (data.reason === 'no_active_code') {
        conyugeEmailStatus(t('step3.email_verify_no_active') || 'No hay código activo. Pida uno nuevo.', 'warn');
      } else {
        conyugeEmailStatus(t('step3.email_verify_error') || 'No pudimos verificar el código.', 'warn');
      }
    } catch (e) {
      console.warn('spouse email verify confirm failed', e);
      conyugeEmailStatus(t('step3.email_verify_error') || 'No pudimos verificar el código.', 'warn');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireConyugeEmailVerification() {
    const input = $('[name="conyuge_email"]');
    const btn = $('#conyugeEmailVerifyBtn');
    const confirm = $('#conyugeEmailVerifyConfirmBtn');
    if (btn) btn.addEventListener('click', enviarCodigoConyuge);
    if (confirm) confirm.addEventListener('click', confirmarCodigoConyuge);
    if (input) {
      input.addEventListener('input', () => {
        if (conyugeEmailVerifiedFor && input.value.trim().toLowerCase() !== conyugeEmailVerifiedFor) {
          resetConyugeEmail();
        }
        conyugeEmailStatus(input.value.trim() && !conyugeEmailVerifiedFor
          ? (t('step3.conyuge_email_pendiente') || 'Sin verificar: no le enviaremos nada a ese correo.')
          : '', '');
      });
    }
  }

  function wireEmailVerification() {
    const emailInput = $('[name="email"]');
    const verifyBtn = $('#emailVerifyBtn');
    const confirmBtn = $('#emailVerifyConfirmBtn');
    const resendBtn = $('#emailVerifyResendBtn');
    const typoEl = $('#emailTypoSuggestion');

    if (verifyBtn) verifyBtn.addEventListener('click', sendVerificationCode);
    if (confirmBtn) confirmBtn.addEventListener('click', confirmVerificationCode);
    if (resendBtn) resendBtn.addEventListener('click', sendVerificationCode);

    if (emailInput) {
      emailInput.addEventListener('input', () => {
        // Si cambió el email después de verificar, reset.
        if (emailVerifiedFor && emailInput.value.trim().toLowerCase() !== emailVerifiedFor) {
          resetEmailVerification();
        }
        // Anti-typo: sugerir dominio correcto.
        if (!typoEl) return;
        const fix = suggestEmailFix(emailInput.value.trim());
        if (fix) {
          typoEl.hidden = false;
          typoEl.innerHTML = (t('step3.email_typo_q') || '¿Quiso decir') +
            ' <a href="#" id="emailTypoFix">' + fix + '</a>?';
          const link = $('#emailTypoFix');
          if (link) link.addEventListener('click', e => {
            e.preventDefault();
            emailInput.value = fix;
            typoEl.hidden = true;
          });
        } else {
          typoEl.hidden = true;
        }
      });
    }
  }

  // ===== PHONE (WhatsApp) VERIFICATION ===== (espejo del email)
  let phoneVerifiedFor = null;
  let phoneVerifiedAt = null;
  let phoneResendTimer = null;

  function isPhoneVerified() {
    if (!PHONE_VERIFY_REQUIRED) return true;
    const phoneInput = $('[name="telefono_movil"]');
    if (!phoneInput) return true;
    return !!phoneVerifiedFor && verificacionVigente(phoneVerifiedAt) &&
      phoneInput.value.trim() === phoneVerifiedFor;
  }

  function setPhoneStatus(msg, kind) {
    const el = $('#phoneVerifyStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function startPhoneCooldown(seconds) {
    const resendBtn = $('#phoneVerifyResendBtn');
    if (!resendBtn) return;
    if (phoneResendTimer) clearInterval(phoneResendTimer);
    let remaining = seconds;
    resendBtn.hidden = false;
    resendBtn.disabled = true;
    const baseText = t('step3.phone_verify_resend') || 'Manda kodigo atrobe';
    function tick() {
      if (remaining <= 0) {
        clearInterval(phoneResendTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = baseText;
        return;
      }
      resendBtn.textContent = baseText + ' (' + remaining + 's)';
      remaining -= 1;
    }
    tick();
    phoneResendTimer = setInterval(tick, 1000);
  }

  async function sendPhoneCode() {
    const phoneInput = $('[name="telefono_movil"]');
    if (!phoneInput) return;
    const phone = phoneInput.value.trim();
    if (!phone || !phoneInput.checkValidity()) {
      setPhoneStatus(t('step3.phone_verify_invalid') || 'Número inválido', 'warn');
      return;
    }
    const verifyBtn = $('#phoneVerifyBtn');
    const panel = $('#phoneVerifyPanel');
    if (verifyBtn) verifyBtn.disabled = true;
    setPhoneStatus(t('step3.phone_verify_sending') || 'Enviando código...', 'loading');
    try {
      const res = await fetch(PHONE_VERIFY_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, tracking_id: getTrackingId(), lang: currentLang })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        if (panel) panel.hidden = false;
        setPhoneStatus(t('step3.phone_verify_sent') || 'Código enviado por WhatsApp.', 'ok');
        startPhoneCooldown(data.cooldown_seconds || 60);
        const codeInput = $('#phoneVerifyCode');
        if (codeInput) codeInput.focus();
      } else if (data.reason === 'cooldown') {
        if (panel) panel.hidden = false;
        setPhoneStatus(t('step3.phone_verify_cooldown') || 'Espere unos segundos antes de pedir otro código.', 'warn');
        startPhoneCooldown(data.cooldown_seconds || 60);
      } else {
        setPhoneStatus(t('step3.phone_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
      }
    } catch (e) {
      console.warn('phone verify send failed', e);
      setPhoneStatus(t('step3.phone_verify_error') || 'No pudimos enviar el código. Intente de nuevo.', 'warn');
    } finally {
      if (verifyBtn) verifyBtn.disabled = false;
    }
  }

  async function confirmPhoneCode() {
    const phoneInput = $('[name="telefono_movil"]');
    const codeInput = $('#phoneVerifyCode');
    if (!phoneInput || !codeInput) return;
    const phone = phoneInput.value.trim();
    const code = codeInput.value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      setPhoneStatus(t('step3.phone_verify_code_format') || 'El código son 6 dígitos.', 'warn');
      return;
    }
    const confirmBtn = $('#phoneVerifyConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    setPhoneStatus(t('step3.phone_verify_checking') || 'Verificando...', 'loading');
    try {
      const res = await fetch(PHONE_VERIFY_CONFIRM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, code: code, tracking_id: getTrackingId() })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.verified) {
        marcarTelefonoVerificado(phone);
        saveDraft();
      } else if (data.reason === 'wrong_code') {
        setPhoneStatus(
          (t('step3.phone_verify_wrong', { left: data.attempts_left }) ||
            'Código incorrecto. Le quedan ' + data.attempts_left + ' intentos.'),
          'warn'
        );
      } else if (data.reason === 'exhausted') {
        setPhoneStatus(t('step3.phone_verify_exhausted') || 'Demasiados intentos. Pida un código nuevo.', 'warn');
      } else if (data.reason === 'no_active_code') {
        setPhoneStatus(t('step3.phone_verify_no_active') || 'No hay código activo. Pida uno nuevo.', 'warn');
      } else {
        setPhoneStatus(t('step3.phone_verify_error') || 'No pudimos verificar el código.', 'warn');
      }
    } catch (e) {
      console.warn('phone verify confirm failed', e);
      setPhoneStatus(t('step3.phone_verify_error') || 'No pudimos verificar el código.', 'warn');
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  function marcarTelefonoVerificado(phone, at) {
    phoneVerifiedFor = phone;
    phoneVerifiedAt = at || new Date().toISOString();
    const panel = $('#phoneVerifyPanel');
    const success = $('#phoneVerifySuccess');
    const verifyBtn = $('#phoneVerifyBtn');
    const phoneInput = $('[name="telefono_movil"]');
    if (panel) panel.hidden = true;
    if (success) success.hidden = false;
    if (verifyBtn) verifyBtn.hidden = true;
    if (phoneInput) phoneInput.readOnly = true;
    setPhoneStatus('', '');
    clearInterval(phoneResendTimer);
  }

  // A reload keeps a confirmed e-mail / mobile confirmed, but only while the
  // field still holds that same value (the same rule isEmailVerified and
  // isPhoneVerified apply on every check).
  // The server counts a confirmed code for 24 h. The form stops trusting it an
  // hour earlier, so a customer who submits right at the edge is not told
  // "verified" by the screen and "unverified" by the server.
  const VERIFICACION_VALIDA_HORAS = 23;
  function verificacionVigente(at) {
    const ms = Date.parse(at || '');
    if (!isFinite(ms)) return false;
    const edad = Date.now() - ms;
    return edad >= -5 * 60 * 1000 && edad < VERIFICACION_VALIDA_HORAS * 3600 * 1000;
  }

  function restaurarVerificaciones(draft) {
    if (!draft) return;
    // A draft saved before the session id was kept (18-nov-2026) cannot say
    // under which session its codes were confirmed: the customer confirms
    // them again rather than submit contacts the server will not accept.
    if (!draft._trackingId) return;
    // Only a verification still inside the window the server accepts. A draft
    // without the time (saved before 19-nov-2026) cannot prove it: new code.
    const emailInput = $('[name="email"]');
    if (draft._emailVerifiedFor && emailInput && verificacionVigente(draft._emailVerifiedAt) &&
        emailInput.value.trim().toLowerCase() === draft._emailVerifiedFor) {
      marcarEmailVerificado(draft._emailVerifiedFor, draft._emailVerifiedAt);
    }
    const conyugeMailInput = $('[name="conyuge_email"]');
    if (draft._conyugeEmailVerifiedFor && conyugeMailInput && verificacionVigente(draft._conyugeEmailVerifiedAt) &&
        conyugeMailInput.value.trim().toLowerCase() === draft._conyugeEmailVerifiedFor) {
      marcarConyugeEmail(draft._conyugeEmailVerifiedFor, draft._conyugeEmailVerifiedAt);
    }
    const phoneInput = $('[name="telefono_movil"]');
    if (draft._phoneVerifiedFor && phoneInput && verificacionVigente(draft._phoneVerifiedAt) &&
        phoneInput.value.trim() === draft._phoneVerifiedFor) {
      marcarTelefonoVerificado(draft._phoneVerifiedFor, draft._phoneVerifiedAt);
    }
  }

  function resetPhoneVerification() {
    phoneVerifiedFor = null;
    const panel = $('#phoneVerifyPanel');
    const success = $('#phoneVerifySuccess');
    const verifyBtn = $('#phoneVerifyBtn');
    const phoneInput = $('[name="telefono_movil"]');
    if (panel) panel.hidden = true;
    if (success) success.hidden = true;
    if (verifyBtn) verifyBtn.hidden = false;
    if (phoneInput) phoneInput.readOnly = false;
    setPhoneStatus('', '');
    clearInterval(phoneResendTimer);
  }

  function wirePhoneVerification() {
    const phoneInput = $('[name="telefono_movil"]');
    const verifyBtn = $('#phoneVerifyBtn');
    const confirmBtn = $('#phoneVerifyConfirmBtn');
    const resendBtn = $('#phoneVerifyResendBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', sendPhoneCode);
    if (confirmBtn) confirmBtn.addEventListener('click', confirmPhoneCode);
    if (resendBtn) resendBtn.addEventListener('click', sendPhoneCode);
    if (phoneInput) {
      phoneInput.addEventListener('input', () => {
        if (phoneVerifiedFor && phoneInput.value.trim() !== phoneVerifiedFor) {
          resetPhoneVerification();
        }
      });
    }
  }

  // ===== EVENT WIRING =====
  // ===== TRACKING (progreso del formulario, para el dashboard de aplicaciones) =====
  // Idempotency key of THIS application (see submitToV2). Same lifetime as
  // the draft: kept in it, dropped by clearDraft after a successful send.
  let _submissionIdMemo = '';
  function adoptarSubmissionId(id) {
    if (typeof id === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(id)) _submissionIdMemo = id;
  }
  function getSubmissionId() {
    if (_submissionIdMemo) return _submissionIdMemo;
    _submissionIdMemo = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    return _submissionIdMemo;
  }

  let _trackingIdMemo = '';
  function adoptarTrackingId(id) {
    if (typeof id === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(id)) _trackingIdMemo = id;
  }
  function getTrackingId() {
    if (_trackingIdMemo) return _trackingIdMemo;
    try { localStorage.removeItem('cfl_tracking_id'); } catch (e) {}
    _trackingIdMemo = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    return _trackingIdMemo;
  }
  // El préstamo pasó del paso 6 al 1 (15-nov-2026) y los demás se corrieron un
  // lugar. El tablero de n8n identifica cada SECCIÓN por su número viejo, así
  // que se sigue mandando ese número en `paso` (misma sección, mismo nombre en
  // el tablero) y el orden nuevo va aparte en `paso_v2`.
  const PASO_LEGACY = { 1: 6, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 7 };
  function track(paso, evento) {
    try {
      const legacy = evento === 'paso' ? (PASO_LEGACY[paso] || paso) : paso;
      fetch(TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_id: getTrackingId(), paso: legacy, paso_v2: paso, evento: evento, idioma: currentLang }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  // ===== Upload tracker — garantiza que TODOS los documentos llegan a S3 =====
  // Cada subida queda registrada acá; submitForm espera a que todas terminen
  // (con reintentos automáticos) antes de entregar la solicitud.
  const uploadTracker = {};

  function uploadDoc(file, docType, idx) {
    // In v2-direct mode the documents travel as base64 in the intake POST, so we
    // skip the n8n S3 upload entirely (OCR still runs separately on attach).
    if (USE_V2_INTAKE) return Promise.resolve();
    const safeIdx = idx || 0;
    const key = docType + '_' + safeIdx;
    const entry = { file: file, docType: docType, idx: safeIdx, state: 'pending', attempts: 0 };
    entry.promise = uploadAttempt(entry);
    uploadTracker[key] = entry;
    return entry.promise;
  }

  async function uploadAttempt(entry) {
    for (let attempt = 0; attempt < 3; attempt++) {
      entry.attempts = attempt + 1;
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timeoutId = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 45000) : null;
      try {
        const fd = new FormData();
        fd.append('doc_type', entry.docType);
        fd.append('idx', String(entry.idx));
        fd.append('tracking_id', getTrackingId());
        fd.append('file', entry.file);
        const opts = { method: 'POST', body: fd };
        if (ctrl) opts.signal = ctrl.signal;
        const res = await fetch(UPLOAD_URL, opts);
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        entry.state = 'done';
        return;
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (attempt < 2) {
          await new Promise(function (r) { setTimeout(r, 1500 * (attempt + 1)); });
          continue;
        }
        entry.state = 'failed';
        console.warn('uploadDoc fallo definitivo:', entry.docType, entry.idx, err);
        return;
      }
    }
  }

  // Espera a que todas las subidas pendientes terminen (éxito o fallo tras
  // reintentos). Devuelve { ok, fallidos } para que submitForm decida si entregar.
  async function waitForUploads() {
    const entries = Object.values(uploadTracker);
    if (entries.length === 0) return { ok: true, fallidos: [] };
    await Promise.all(entries.map(function (e) { return e.promise; }));
    const fallidos = entries.filter(function (e) { return e.state === 'failed'; });
    return { ok: fallidos.length === 0, fallidos: fallidos };
  }

  // Al entregar la solicitud, enlaza los documentos subidos con la aplicación
  // creada (copia las URLs S3 a aplicaciones.url_* para que Access los baje).
  function vincularDocumentos(aplicacionId) {
    try {
      fetch(LINK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_id: getTrackingId(), aplicacion_id: aplicacionId }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function wireEvents() {
    $btnNext.addEventListener('click', () => {
      if (!validateStep(currentStep)) return;
      saveDraft();
      if (currentStep === 6) buildSummary();
      if (currentStep < TOTAL_STEPS) {
        const next = currentStep + 1;
        showStep(next);
        // Saved AFTER moving: the saveDraft above still recorded the step
        // being left, so a reload brought the customer one step back.
        saveDraft();
        track(next, 'paso');
      }
    });

    $btnPrev.addEventListener('click', () => {
      if (currentStep > 1) { showStep(currentStep - 1); saveDraft(); }
    });

    $form.addEventListener('submit', submitForm);

    $form.addEventListener('change', e => {
      if (e.target && e.target.classList && e.target.classList.contains('invalid') && e.target.type !== 'file') clearFieldError(e.target);
      if (e.target && e.target.type === 'radio') {
        const g = e.target.closest('.field');
        if (g) { const p = g.querySelector(':scope > .field-error'); if (p) p.remove(); }
      }
      saveDraft();
      if (e.target.type === 'radio') updateConditionals();
      if (e.target.tagName === 'SELECT') updateConditionals();
      // El plazo es un <select> (dispara 'change', no 'input'), así que
      // syncSliders no lo cubre: sin esto la cuota estimada quedaba estática al
      // cambiar el plazo. El monto ya recalcula por su slider, se incluye por
      // las dudas si alguna vez deja de ser slider.
      if (e.target.name === 'plazo_meses' || e.target.name === 'monto_solicitado') updateQuote();
      if (e.target.name === 'tipo_empleado') updatePensionadoMode();
      if (e.target.name === 'frecuencia_salario') renderDynamicSlots();
      // Cualquier upload en Step 2 actualiza el contador.
      if (e.target.type === 'file') updateUploadCounter();
      markRequiredLabels();
    });

    $form.addEventListener('input', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('invalid')) clearFieldError(e.target);
      // Debounce auto-save
      clearTimeout(window._cflSaveTimer);
      window._cflSaveTimer = setTimeout(saveDraft, 800);
    });

    $langSwitch.addEventListener('change', e => {
      loadI18n(e.target.value);
      saveDraft();
    });
  }

  // ===== INIT =====
  async function init() {
    aplicarMaxNacimiento();
    setupUploads();
    syncSliders();
    wireEvents();
    wireEmailVerification();
    wireConyugeEmailVerification();
    wirePhoneVerification();

    // Detect preferred language: ?lang= > localStorage > browser > pap
    const draft = loadDraft();
    // Resume the draft's session (see saveDraft) before anything asks for it.
    adoptarTrackingId(draft && draft._trackingId);
    adoptarSubmissionId(draft && draft._submissionId);
    const browserLang = (navigator.language || 'pap').toLowerCase().slice(0, 2);
    let urlLang = null;
    try { urlLang = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    const preferred =
      (urlLang && LANGS.includes(urlLang) ? urlLang : null) ||
      (draft && LANGS.includes(draft._lang) ? draft._lang : null) ||
      (LANGS.includes(browserLang) ? browserLang : 'pap');

    await loadI18n(preferred);
    restoreDraft();
    // La cuota se pide AL CARGAR (antes arrancaba en "XCG —" hasta mover algo).
    updateQuote(true);

    // Render inicial de los slots de Step 2 según tipo_empleado / frecuencia_salario
    // restaurados desde el draft. Si todavía no fueron elegidos muestra hint.
    updatePensionadoMode();
    renderDynamicSlots();
    markRequiredLabels();

    // Retomar donde quedó. Los campos de texto vuelven del localStorage y los
    // documentos de IndexedDB (ver DRAFT DOCUMENTS); antes se arrancaba
    // siempre en el Paso 1 porque los archivos no se podían restaurar, y en
    // el celular eso pasaba cada vez que el cliente iba a la app del banco a
    // bajar un extracto.
    restaurarVerificaciones(draft);
    await restaurarDocumentos();
    restauracionInicialHecha = true;
    const paso = pasoParaRetomar(draft && draft._step);
    if (paso === TOTAL_STEPS) buildSummary();
    showStep(paso);
    track(paso, 'inicio');
    wireInhouden();
    wireConyuge();
  }

  // ── Inhouden ─────────────────────────────────────────────────────────────
  //
  // Es el escalón más alto de los métodos de repago y el único que no se puede
  // deducir del banco, porque depende del empleador. Por eso se pregunta, y por
  // eso quien contesta que sí tiene que confirmar que YA PREGUNTÓ antes de
  // contestar: declararlo sin haberlo verificado puede costar la solicitud.
  //
  // La casilla sólo aparece cuando dice que sí, porque pedirle que confirme
  // algo que acaba de negar no tiene sentido y entrena a la gente a tildar sin
  // leer.
  function wireInhouden() {
    const sel = document.querySelector('#inhoudenSelect');
    const box = document.querySelector('#inhoudenAttest');
    const chk = document.querySelector('#inhoudenAttestBox');
    if (!sel || !box || !chk) return;
    const sync = function () {
      const si = sel.value === 'si';
      box.hidden = !si;
      chk.required = si;
      if (!si) chk.checked = false;
    };
    sel.addEventListener('change', sync);
    sync();
  }

  // ── Kònyuge ──────────────────────────────────────────────────────────────
  //
  // Ley di Kòrsou ta eksigí konsentimentu di e kònyuge pa un fiansa, pues e
  // kònyuge mester firma na e sita ku identifikashon bálido. Si nos no sa ken e
  // ta, nos no por bisa e kliente ku e mester bin kuné, i e sita ta pèrdè:
  // CFL-10092 a yega te na oferta aseptá sin ningun kònyuge registrá.
  //
  // Tres desishon:
  //
  //  * E kampo nan NO tin `required` den e HTML; nos ta pone i kita e for di
  //    akinan. Un kampo obligatorio ku no ta wòrdu mustrá ta blokea e envio sin
  //    bisa pakiko, i e kliente no por hasi nada ku esei.
  //
  //  * E sédula ta keda opshonal. Hopi hende no tin e number di su kasá na man
  //    — Leonard tampoko tabatin e pa CFL-10092 — i un kampo obligatorio ku
  //    nos no por yena ta kita un solisitut kompleto. Nos ta kompletá e na
  //    oficina.
  //
  //  * Nos ta kopia pa Referensia 1 SOLAMENTE miéntras e kliente no a toka e
  //    kampo nan ku su man. Ken ku skirbi otro kos ayanan ta manda, no nos.
  function wireConyuge() {
    const sel = document.querySelector('[name="estado_civil"]');
    const box = document.querySelector('#conyugeBlock');
    if (!sel || !box) return;

    const f = (n) => document.querySelector('[name="' + n + '"]');
    const nombre = f('conyuge_nombre');
    const apellido = f('conyuge_apellido');
    const telefono = f('conyuge_telefono');
    const sedula = f('conyuge_numero_id');
    const correo = f('conyuge_email');
    // E foto di e sédula di e kasá ta obligatorio (22-nov-2026): for di dje
    // nos ta lesa nòmber, number i fecha di nasementu. E number skirbí ta
    // keda opshonal (e ta sali di e foto). E email ta opshonal.
    const fotoCedula = document.querySelector('input[type="file"][name="doc_cedula_conyuge"]');
    const obligatorio = [nombre, apellido, telefono, fotoCedula].filter(Boolean);

    const refNombre = f('ref1_nombre');
    const refTelefono = f('ref1_telefono');
    const refRelacion = f('ref1_relacion');

    // Si e kliente ya a skirbi su Referensia 1 su mes, nos no ta pisa e.
    let refTocadaAMano = Boolean(
      (refNombre && refNombre.value.trim()) ||
      (refTelefono && refTelefono.value.trim())
    );
    [refNombre, refTelefono, refRelacion].forEach((el) => {
      if (el) el.addEventListener('input', () => { refTocadaAMano = true; });
    });

    const casado = () => sel.value === 'kasá';

    function copiarAReferencia() {
      if (!casado() || refTocadaAMano) return;
      const completo = [
        nombre ? nombre.value.trim() : '',
        apellido ? apellido.value.trim() : '',
      ].filter(Boolean).join(' ');
      if (refNombre) refNombre.value = completo;
      if (refTelefono && telefono) refTelefono.value = telefono.value.trim();
      if (refRelacion && completo) refRelacion.value = 'kasá';
    }

    function sync() {
      const si = casado();
      box.hidden = !si;
      obligatorio.forEach((el) => { el.required = si; });
      if (!si) {
        // Ken ku kambia di "Kasá" pa otro kos no mester manda datos di un
        // kasá ku e no tin.
        [nombre, apellido, telefono, sedula, correo].forEach((el) => {
          if (el) el.value = '';
        });
        if (correo) resetConyugeEmail();
        if (fotoCedula && fotoCedula.files && fotoCedula.files.length > 0) quitarArchivo(fotoCedula);
        ocrResults.doc_cedula_conyuge = null;
        if (refRelacion && refRelacion.value === 'kasá' && !refTocadaAMano) {
          refRelacion.value = '';
          if (refNombre) refNombre.value = '';
          if (refTelefono) refTelefono.value = '';
        }
        return;
      }
      copiarAReferencia();
    }

    sel.addEventListener('change', sync);
    [nombre, apellido, telefono].forEach((el) => {
      if (el) el.addEventListener('input', copiarAReferencia);
    });
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
