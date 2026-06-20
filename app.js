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
  const OCR_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-ocr';
  const TRACK_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/aplicacion-web-track';
  const UPLOAD_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-upload';
  const LINK_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/web-aplicacion-vincular';
  const EMAIL_VERIFY_SEND_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/email-verify-send';
  const EMAIL_VERIFY_CONFIRM_URL = 'https://curacaofastloans.app.n8n.cloud/webhook/email-verify-confirm';

  // Master switch: si está en false la verificación de email se vuelve
  // opcional (el cliente puede enviar sin verificar). Útil para apagar
  // rápido si el workflow n8n tiene un problema.
  const EMAIL_VERIFY_REQUIRED = true;

  // Bypass total de validación entre pasos (solo para revisar UI sin que
  // bloquee). En producción siempre false.
  const BYPASS_STEP_VALIDATION = false;

  // doc field name → OCR doc_type
  // NOTA: doc_bancos NO se OCR-ea en el form (consume mucho API ~$0.40/banco).
  // Se guarda el archivo igual via submit. El analista o un workflow async procesa
  // la extracción completa cuando se abra la aplicación.
  const OCR_TYPES = {
    doc_cedula: 'cedula',
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
    payslip: {
      empleador: 'empleador',
      cargo: 'cargo',
      salario_neto_total: 'salario_neto',
    },
    carta: {
      empleador: 'empleador',
      cargo: 'cargo',
      salario_neto: 'salario_neto',
      tipo_empleo: 'tipo_empleado',
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
    doc_id_adicional: ['paspoort', 'rijbewijs'],
    doc_payslips: ['payslip'],
    doc_bancos: ['bank_statement'],
    doc_carta_trabajo: ['employment_letter'],
    doc_aqualectra: ['aqualectra'],
  };
  // Slots cuya vigencia se verifica (el OCR devuelve fecha_vencimiento).
  const EXPIRY_DOCS = ['doc_cedula', 'doc_id_adicional'];

  // ===== STATE =====
  let currentStep = 1;
  let i18nTexts = {};
  let currentLang = 'pap';

  // OCR results per doc_type, indexed por input.name (e.g., doc_cedula → {nombre_completo, ...})
  // Para payslips/bancos guardamos array (1 por archivo subido)
  const ocrResults = {
    doc_cedula: null,
    doc_id_adicional: null,
    doc_payslips: [],
    doc_bancos: [],
    doc_carta_trabajo: null,
    doc_aqualectra: null,
  };

  // Resultado de validación por slot: { tipo:'ok'|'mismatch'|'unknown',
  // expired:bool, detected:string, vence:string }. Se rehace en cada subida.
  const docCheck = {};

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
    doc_id_adicional: 'step1.id_adicional',
    doc_payslips: 'step2.payslips',
    doc_bancos: 'step2.bancos',
    doc_carta_trabajo: 'step2.carta',
    doc_aqualectra: 'step2.aqualectra'
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

  function validateStep(n) {
    // TEMPORAL: bypass total mientras Leonard revisa el form.
    if (BYPASS_STEP_VALIDATION) {
      clearErrors();
      return true;
    }
    const step = $('.step[data-step="' + n + '"]');
    if (!step) return true;
    // 1) Required fields - check todo: presencia + pattern + type
    const requiredFields = $$('input[required]:not([type="file"]), select[required], textarea[required]', step);
    // 2) Optional fields con pattern - validar SOLO si tienen valor (para no rechazar vacío)
    const patternFields = $$('input[pattern]:not([required])', step);
    const errs = [];
    const errMsgs = [];
    requiredFields.forEach(f => {
      f.classList.remove('invalid');
      if (!f.checkValidity()) {
        f.classList.add('invalid');
        errs.push(f.name);
        // Mensaje específico según el tipo de error
        if (f.validity.patternMismatch) {
          errMsgs.push((f.title || f.name) + ': ' + (t('error.format') || 'formato inválido'));
        } else if (f.validity.typeMismatch && f.type === 'email') {
          errMsgs.push(f.name + ': ' + (t('error.email') || 'email inválido'));
        } else if (f.validity.valueMissing) {
          errMsgs.push(f.name + ': ' + (t('error.required') || 'requerido'));
        } else if (f.validity.rangeUnderflow || f.validity.rangeOverflow) {
          errMsgs.push(f.name + ': ' + (t('error.range') || 'valor fuera de rango'));
        } else {
          errMsgs.push(f.name + ': ' + (t('error.invalid') || 'inválido'));
        }
      }
    });
    patternFields.forEach(f => {
      f.classList.remove('invalid');
      if (f.value && f.value.trim() !== '' && !f.checkValidity()) {
        f.classList.add('invalid');
        errs.push(f.name);
        errMsgs.push((f.title || f.name) + ': ' + (t('error.format') || 'formato inválido'));
      }
    });
    // Documentos obligatorios: no dejar avanzar si falta alguno (respeta modo pensionado)
    $$('input[type="file"][required]', step).forEach(f => {
      const lbl = f.closest('.upload-label');
      f.classList.remove('invalid');
      if (lbl) lbl.classList.remove('invalid');
      if (!f.files || f.files.length === 0) {
        f.classList.add('invalid');
        if (lbl) lbl.classList.add('invalid');
        errs.push(f.name);
        errMsgs.push((t('error.doc_required') || 'Falta subir un documento obligatorio') + ': ' + docLabelFor(f));
      }
    });
    // Tipo de documento incorrecto / documento vencido (aplica a TODOS los file inputs con archivo)
    $$('input[type="file"]', step).forEach(f => {
      if (!f.files || f.files.length === 0) return;
      const lbl = f.closest('.upload-label');
      f.classList.remove('invalid');
      if (lbl) lbl.classList.remove('invalid');
      const c = docCheck[f.name];
      if (!c) return;
      if (c.tipo === 'mismatch') {
        f.classList.add('invalid');
        if (lbl) lbl.classList.add('invalid');
        errs.push(f.name);
        errMsgs.push(t('error.doc_tipo_incorrecto', { doc: docLabelFor(f), detected: tipoLabel(c.detected) })
          || (docLabelFor(f) + ': documento incorrecto'));
      } else if (c.expired) {
        f.classList.add('invalid');
        if (lbl) lbl.classList.add('invalid');
        errs.push(f.name);
        errMsgs.push(t('error.doc_vencido', { doc: docLabelFor(f), date: c.vence })
          || (docLabelFor(f) + ': documento vencido'));
      }
    });
    // Conditional required fields (e.g., dolencia_detalle solo si dolencia_salud=true)
    $$('.conditional.visible', step).forEach(c => {
      if (c.value === '' || c.value === null) {
        c.classList.add('invalid');
        errs.push(c.name);
        errMsgs.push(c.name + ': ' + (t('error.required') || 'requerido'));
      }
    });
    // Email verificado: en Step 3, exigimos que el email esté confirmado por código
    // antes de seguir. Bypass si EMAIL_VERIFY_REQUIRED=false.
    if (n === 3 && EMAIL_VERIFY_REQUIRED) {
      const emailInput = step.querySelector('[name="email"]');
      if (emailInput && emailInput.value && !isEmailVerified()) {
        emailInput.classList.add('invalid');
        errs.push('email');
        errMsgs.push(t('step3.email_verify_required') ||
          'Verificá tu email antes de continuar (clic en "Verificar").');
      }
    }
    // Sanity peso/altura: la altura en cm de una persona siempre supera el peso en kg.
    // Si peso >= altura el usuario casi seguro invirtió los dos campos.
    if (n === 4) {
      const pesoEl = step.querySelector('[name="peso_kg"]');
      const alturaEl = step.querySelector('[name="altura_cm"]');
      if (pesoEl && alturaEl && pesoEl.value && alturaEl.value &&
          Number(pesoEl.value) >= Number(alturaEl.value)) {
        pesoEl.classList.add('invalid');
        alturaEl.classList.add('invalid');
        errs.push('peso_kg');
        errMsgs.push(t('error.peso_altura') ||
          'Revisá peso y altura: la altura (cm) debe ser mayor que el peso (kg). ¿Los pusiste al revés?');
      }
    }
    // Paso 6: no permitir aplicar si la cuota de referencia es 0
    if (n === 6) {
      const montoEl = step.querySelector('[name="monto_solicitado"]');
      const plazoEl = step.querySelector('[name="plazo_meses"]');
      const m = parseFloat(montoEl && montoEl.value) || 0;
      const p = parseInt(plazoEl && plazoEl.value, 10) || 0;
      const cuotaRef = (m > 0 && p > 0) ? calcularCuotaCFL(m, p) : 0;
      if (!(cuotaRef > 0)) {
        if (montoEl) montoEl.classList.add('invalid');
        errs.push('monto_solicitado');
        errMsgs.push(t('error.cuota_cero') || 'La cuota de referencia no puede ser 0. Revise el monto y el plazo.');
      }
    }
    if (errs.length > 0) {
      showErrors(errMsgs.length > 0 ? errMsgs : [t('error.fill_required') || 'Por favor kompletá tur fildt rekerí.']);
      return false;
    }
    clearErrors();
    return true;
  }

  function showErrors(messages) {
    $errors.innerHTML = '<ul>' + messages.map(m => '<li>' + m + '</li>').join('') + '</ul>';
    $errors.classList.add('show');
  }
  function clearErrors() {
    $errors.innerHTML = '';
    $errors.classList.remove('show');
  }

  // ===== AUTO-SAVE =====
  function saveDraft() {
    const data = {};
    new FormData($form).forEach((val, key) => {
      if (val instanceof File) return; // Files not auto-saved
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* localStorage full or disabled */ }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
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
    const freqField = $('#frecuenciaSalarioField');
    if (freqField) {
      const showFreq = tipoSel.value === 'fijo' || tipoSel.value === 'contrato';
      freqField.style.display = showFreq ? '' : 'none';
      // Si lo ocultamos, limpiamos su valor para que no contamine el submit.
      if (!showFreq) {
        const freqSel = freqField.querySelector('[name="frecuencia_salario"]');
        if (freqSel) freqSel.value = '';
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
  };

  function monthLabel(year, monthIdx0) {
    const arr = MONTH_NAMES[currentLang] || MONTH_NAMES.pap;
    return arr[monthIdx0] + ' ' + year;
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
        (t('step2.banco_pdf_only') || 'Solo PDF — descargá del internet banking del banco.') + '</p>';
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
      updateUploadCounter();
      return;
    }
    lastDynamicSlotsSignature = sig;

    if (payslips.length === 0) {
      payslipsContainer.innerHTML = '<p class="hint">' +
        (t('step2.choose_tipo_first') || 'Promé skohe tipo di empleo i (si aplika) frekuensia di salario na Paso 1.') +
        '</p>';
    } else {
      payslipsContainer.innerHTML = payslips
        .map((p, i) => buildSlotHTML('doc_payslips', i + 1, p, tipo !== 'pensionado'))
        .join('');
    }
    bancosContainer.innerHTML = bancos
      .map((p, i) => buildSlotHTML('doc_bancos', i + 1, p, true))
      .join('');

    updateUploadCounter();
  }

  // Cuenta documentos required cargados / total y muestra en #uploadCounter.
  function updateUploadCounter() {
    const step2 = $('.step[data-step="2"]');
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

  // ===== QUOTE CALCULATION (Step 6) =====
  // Tabla de referencia oficial CFL — cuota por cada 1000 XCG por término.
  // Promedios calculados de la tabla publicada en curloans.com (incluye interés,
  // garantía, seguro de vida y plan de ahorro).
  const CFL_CUOTA_TABLE = [
    { meses: 6,  cuotaPer1000: 242.86 },
    { meses: 12, cuotaPer1000: 128.18 },
    { meses: 18, cuotaPer1000: 91.35 },
    { meses: 24, cuotaPer1000: 65.81 },
    { meses: 36, cuotaPer1000: 48.53 },
  ];

  function calcularCuotaCFL(monto, plazo) {
    const table = CFL_CUOTA_TABLE;
    if (plazo <= table[0].meses) {
      return (monto / 1000) * table[0].cuotaPer1000;
    }
    if (plazo >= table[table.length - 1].meses) {
      return (monto / 1000) * table[table.length - 1].cuotaPer1000;
    }
    for (let i = 0; i < table.length - 1; i++) {
      if (plazo >= table[i].meses && plazo <= table[i + 1].meses) {
        const t1 = table[i].meses;
        const t2 = table[i + 1].meses;
        const c1 = table[i].cuotaPer1000;
        const c2 = table[i + 1].cuotaPer1000;
        const ratio = (plazo - t1) / (t2 - t1);
        const cuota1000 = c1 + (c2 - c1) * ratio;
        return (monto / 1000) * cuota1000;
      }
    }
    return 0;
  }

  function updateQuote() {
    const monto = parseFloat($('[name="monto_solicitado"]').value) || 0;
    const plazo = parseInt($('[name="plazo_meses"]').value) || 0;
    if (!monto || !plazo) return;
    const cuota = calcularCuotaCFL(monto, plazo);
    const total = cuota * plazo;
    const $qMonto = $('#qMonto');
    const $qPlazo = $('#qPlazo');
    const $qCuota = $('#qCuota');
    const $qTotal = $('#qTotal');
    const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if ($qMonto) $qMonto.textContent = 'XCG ' + fmt(monto);
    if ($qPlazo) $qPlazo.textContent = plazo + ' ' + (t('step6.q_meses') || 'lunan');
    if ($qCuota) $qCuota.textContent = 'XCG ' + fmt(cuota);
    if ($qTotal) $qTotal.textContent = 'XCG ' + fmt(total);
  }

  // ===== FILE UPLOADS (preview + OCR auto-fill) =====
  function setupUploads() {
    $$('input[type="file"]').forEach(input => {
      input.addEventListener('change', e => {
        const preview = $('[data-preview-for="' + input.name + '"]');
        if (!preview) return;
        preview.innerHTML = '';
        const files = Array.from(input.files || []);
        docCheck[input.name] = undefined; // re-validar tipo/vigencia en cada nueva selección
        if (files.length === 0) return;
        const label = input.closest('.upload-label');
        if (label) label.classList.add('has-file');
        files.forEach((file, fidx) => {
          // Sube cada documento a S3 al adjuntarlo (en paralelo con el OCR).
          // Aplica a TODOS los tipos, incluidos los estados de banco.
          uploadDoc(file, input.name, fidx);
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

        // doc_bancos: NO se hace OCR completo en el form (consume mucho API),
        // pero SÍ se hace una clasificación liviana para validar que el archivo
        // sea realmente un estado de banco. La extracción completa va al backend.
        if (baseDocName(input.name) === 'doc_bancos') {
          setOcrStatus(preview, '🔎 ' + (t('ocr.checking_type') || 'Verificando tipo de documento…'), 'loading');
          (async () => {
            for (let i = 0; i < files.length; i++) {
              await classifyDoc(files[i], input.name, i);
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
          })();
        }
      });
    });

    // Event delegation para slots dinámicos generados después de init.
    // Replicamos un subset mínimo del listener directo de arriba:
    // preview + uploadDoc + (clasificación o OCR según base name).
    document.addEventListener('change', e => {
      const input = e.target;
      if (!input || input.type !== 'file') return;
      if (!input.name) return;
      const base = baseDocName(input.name);
      // Solo nos interesan los slots dinámicos (sufijo numérico).
      if (!/_\d+$/.test(input.name)) return;
      const preview = $('[data-preview-for="' + input.name + '"]');
      if (!preview) return;
      preview.innerHTML = '';
      const files = Array.from(input.files || []);
      docCheck[input.name] = undefined;
      if (files.length === 0) {
        updateUploadCounter();
        return;
      }
      const label = input.closest('.upload-label');
      if (label) label.classList.add('has-file');
      files.forEach((file, fidx) => {
        uploadDoc(file, input.name, fidx);
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
      if (base === 'doc_bancos') {
        setOcrStatus(preview, '🔎 ' + (t('ocr.checking_type') || 'Verificando tipo de documento…'), 'loading');
        (async () => {
          for (let i = 0; i < files.length; i++) {
            await classifyDoc(files[i], input.name, i);
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
          updateUploadCounter();
        })();
      } else {
        updateUploadCounter();
      }
    });
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
    const m = /_(\d+)$/.exec(inputName);
    const realIdx = m ? Number(m[1]) - 1 : idx;
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

  function tipoLabel(tipo) {
    return (tipo && t('tipo.' + tipo)) || t('tipo.unknown') || 'un documento';
  }
  function expectedTipoLabel(inputName) {
    const KEY = {
      doc_cedula: 'cedula',
      doc_id_adicional: 'id_adicional',
      doc_payslips: 'payslip',
      doc_bancos: 'bank_statement',
      doc_carta_trabajo: 'employment_letter',
      doc_aqualectra: 'aqualectra',
    };
    return tipoLabel(KEY[inputName]);
  }

  // Evalúa un resultado OCR/clasificación de UN archivo: detecta tipo y vigencia,
  // y actualiza el agregado docCheck[inputName]. Devuelve el detalle de este archivo.
  function evaluateDoc(inputName, data, idx) {
    const expected = EXPECTED_TIPO[inputName];
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
    docCheck[inputName] = cur;
    return { tipoStatus: tipoStatus, expired: expired, detected: detected, vence: vence };
  }

  // Clasificación liviana para el estado de banco (no pasa por OCR completo):
  // solo pide el tipo de documento. No bloquea si la clasificación falla.
  // Para bank statements usamos el modo 'banco_liviano' que ADEMÁS del tipo
  // extrae el periodo (desde/hasta) sin las transacciones — barato y rápido.
  async function classifyDoc(file, inputName, idx) {
    try {
      const fd = new FormData();
      const base = baseDocName(inputName);
      const mode = (base === 'doc_bancos') ? 'banco_liviano' : 'clasificar';
      fd.append('doc_type', mode);
      fd.append('file', file);
      const res = await fetch(OCR_URL, { method: 'POST', body: fd });
      if (!res.ok) return;
      const result = await res.json();
      const data = (result && result.data) || null;
      if (data) {
        evaluateDoc(inputName, data, idx);
        // Para bank statements: validar período expected vs detected.
        const periodCheck = validatePeriodForInput(inputName, data);
        if (periodCheck) docCheck[inputName] = Object.assign(docCheck[inputName] || {}, periodCheck);
      }
    } catch (e) { /* clasificación opcional: no bloquea */ }
  }

  // Compara el período expected del slot (data-expected-year/month) contra
  // lo que el OCR devolvió. Devuelve { periodMatch:bool, periodDetail:string }
  // o null si no se puede validar. NO BLOQUEA: solo informativo.
  function validatePeriodForInput(inputName, ocrData) {
    const input = $('[name="' + inputName + '"]');
    if (!input) return null;
    const expY = parseInt(input.dataset.expectedYear, 10);
    const expM = parseInt(input.dataset.expectedMonth, 10);
    if (!expY || !expM) return null;
    const base = baseDocName(inputName);
    let detY = null, detM = null;
    if (base === 'doc_payslips') {
      detY = parseInt(ocrData.periodo_anio, 10);
      detM = parseInt(ocrData.periodo_mes, 10);
    } else if (base === 'doc_bancos') {
      const desde = String(ocrData.periodo_desde || '');
      const m = /^(\d{4})-(\d{2})/.exec(desde);
      if (m) { detY = parseInt(m[1], 10); detM = parseInt(m[2], 10); }
    }
    if (!detY || !detM) return null;
    const match = (detY === expY && detM === expM);
    return {
      periodMatch: match,
      periodDetail: detY + '-' + String(detM).padStart(2, '0')
    };
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
         '. Verificá que el archivo correcto esté en este slot.'));
  }

  async function runOcr(file, docType, container, inputName, idx) {
    const suffix = (Array.isArray(ocrResults[inputName])) ? ' (' + (idx + 1) + ')' : '';
    setOcrStatus(container, '🔎 ' + (t('ocr.analyzing') || 'Analizando documento…') + suffix, 'loading');
    try {
      const fd = new FormData();
      fd.append('doc_type', docType);
      fd.append('file', file);
      const res = await fetch(OCR_URL, { method: 'POST', body: fd });
      if (!res.ok) {
        // 524 / 504 = Cloudflare/server timeout. Para bank statements grandes (>100s),
        // el análisis completo lo hace el backend al procesar la aplicación.
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
      const filled = (idx === 0) ? applyOcrAutoFill(docType, result.data) : [];
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
          '✓ ' + (t('ocr.filled') || 'Auto-completados') + ': ' + filled.join(', '),
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
    Object.keys(map).forEach(srcKey => {
      const targetName = map[srcKey];
      let val = data[srcKey];
      if (val === null || val === undefined || val === '') return;
      const field = $('[name="' + targetName + '"]');
      if (!field) return;
      // Mapeo especial para tipo_empleado (carta usa fijo|temporal|independiente; form usa fijo|contrato|pensionado|otro)
      if (targetName === 'tipo_empleado') {
        const lower = String(val).toLowerCase();
        if (lower.includes('pension') || lower.includes('jubilad') || lower.includes('penshon')) val = 'pensionado';
        else if (lower.includes('fij') || lower.includes('perman') || lower.includes('indefin')) val = 'fijo';
        else if (lower.includes('tempor') || lower.includes('contrat')) val = 'contrato';
        else val = 'otro';
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
    if (data.nombre_completo) rows.push(['Nòmber kompleto', data.nombre_completo]);
    if (data.numero_id) rows.push(['ID Number', data.numero_id]);
    if (data.fecha_nacimiento) rows.push(['Nasementu', data.fecha_nacimiento]);
    if (data.fecha_vencimiento) rows.push(['Vense', data.fecha_vencimiento]);
    if (data.nacionalidad) rows.push(['Nacionalidat', data.nacionalidad]);
    if (data.pais_nacimiento) rows.push(['Pais nasementu', data.pais_nacimiento]);
    if (data.sexo) rows.push(['Sekso', data.sexo]);
    if (data.estado_civil) rows.push(['Estado sivil', data.estado_civil]);
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML = '<div class="ocr-info-header">📋 Datos di sédula (auto-detektá — esakí ta wat ta guardá)</div>' +
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
    const tipoLabel = tipo === 'paspoort' ? 'Paspoort'
                    : tipo === 'rijbewijs' ? 'Rijbewijs'
                    : 'Documento';
    const rows = [];
    if (data.numero) rows.push(['Number', data.numero]);
    if (data.nombre_completo) rows.push(['Nòmber', data.nombre_completo]);
    if (data.fecha_vencimiento) rows.push(['Vense', data.fecha_vencimiento]);
    if (data.pais_emisor) rows.push(['Pais emisor', data.pais_emisor]);
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML = '<div class="ocr-info-header">📄 ' + tipoLabel + ' (auto-detektá)</div>' +
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
      const tipoLabel = tipo === 'paspoort' ? 'Paspoort'
                      : tipo === 'rijbewijs' ? 'Rijbewijs'
                      : 'Dok. adishonal';
      idAdicRows = row(tipoLabel, idAdic.numero)
                 + row('Vense', idAdic.fecha_vencimiento)
                 + row('Pais emisor', idAdic.pais_emisor);
    }

    // ===== Datos OCR del aqualectra (extra info útil para verificación de domicilio) =====
    const aqua = ocrResults.doc_aqualectra;
    let aquaRows = '';
    if (aqua && !aqua.error && !aqua._timeout) {
      aquaRows = row('Titular Aqualectra', aqua.titular)
               + row('Kliente# Aqualectra', aqua.numero_cliente);
    }

    $summary.innerHTML =
      '<h4>' + (t('summary.personal') || 'Datos Personales') + '</h4>' +
      '<dl>' +
        rowAlways(t('step3.nombre') || 'Nòmber kompleto', get('nombre_completo')) +
        rowAlways(t('step3.cedula_num') || 'Number sédula', get('numero_id')) +
        idAdicRows +
        rowAlways(t('step3.fecha_nac') || 'Nasementu', get('fecha_nacimiento')) +
        rowAlways(t('step3.tipo_empleado') || 'Tipo empleo',
                  (t('step3.tipo_empleado_' + (get('tipo_empleado') || 'otro')) || get('tipo_empleado') || '—')) +
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
        rowAlways(t('step3.cuenta_bancaria') || 'Number di kuenta', get('cuenta_bancaria_debito')) +
        rowAlways(t('step3.email') || 'Email', get('email')) +
        rowAlways(t('step3.direccion') || 'Direkshon', get('direccion')) +
      '</dl>' +

      '<h4>' + (t('summary.prestamo') || 'Fiansa') + '</h4>' +
      '<dl>' +
        rowAlways(t('step6.monto') || 'Monto', 'XCG ' + (get('monto_solicitado') || '0')) +
        rowAlways(t('step6.plazo') || 'Plazo', (get('plazo_meses') || '0') + ' ' + (t('step6.q_meses') || 'lunan')) +
        rowAlways(t('step6.proposito') || 'Propósito', get('proposito')) +
      '</dl>' +

      '<h4>' + (t('summary.contacto') || 'Kontakto') + '</h4>' +
      '<dl>' +
        rowAlways(t('step3.telefono_movil') || 'Selular', get('telefono_movil')) +
        row(t('step3.telefono_casa') || 'Tel kas', get('telefono_casa')) +
        rowAlways(t('step5.ref1') || 'Ref 1',
                  (get('ref1_nombre') || '—') + ' (' + (get('ref1_relacion') || '—') + ') — ' + (get('ref1_telefono') || '—')) +
        (has('ref2_nombre')
          ? rowAlways(t('step5.ref2') || 'Ref 2',
                      get('ref2_nombre') + ' (' + (get('ref2_relacion') || '—') + ') — ' + (get('ref2_telefono') || '—'))
          : '') +
      '</dl>' +

      '<h4>' + (t('summary.salud') || 'Salud') + '</h4>' +
      '<dl>' +
        rowAlways((t('step4.peso') || 'Peso') + ' / ' + (t('step4.talla') || 'Altura'),
                  (get('peso_kg') || '0') + ' kg / ' + (get('altura_cm') || '0') + ' cm') +
        rowAlways('Dòkter di kas', get('medico_cabecera')) +
        yesNoDetail(t('step4.q1') || '1/6 Keho serio', 'dolencia_salud', 'dolencia_detalle') +
        yesNoDetail(t('step4.q2') || '2/6 Operashon 5a', 'operacion_5_anos', 'operacion_5_anos_detalle') +
        yesNoDetail(t('step4.q3') || '3/6 Malesa/Diskpasidat', 'otra_enfermedad', 'otra_enfermedad_detalle') +
        yesNoDetail(t('step4.q4') || '4/6 Medikamentu', 'medicamentos_receta', 'medicamentos_detalle') +
        yesNoDetail(t('step4.q5') || '5/6 HIV', 'hiv', 'hiv_detalle') +
        yesNoDetail(t('step4.q7') || '6/6 Otro', 'circunstancias_salud', 'circunstancias_detalle') +
      '</dl>' +

      '<h4>' + (t('summary.docs') || 'Dokumentonan') + '</h4>' +
      '<dl>' +
        rowAlways('Sédula', fileCount('doc_cedula') > 0 ? '✓' : '—') +
        rowAlways('ID adicional', fileCount('doc_id_adicional') > 0 ? '✓' : '—') +
        rowAlways('Payslips', fileCount('doc_payslips') + '/3') +
        rowAlways('Estado di banko', fileCount('doc_bancos') + '/3') +
        rowAlways('Karta trabou', fileCount('doc_carta_trabajo') > 0 ? '✓' : '—') +
        rowAlways('Aqualectra', fileCount('doc_aqualectra') > 0 ? '✓' : '—') +
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

  function applyI18n() {
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
      // Los slots dinámicos usan el nombre de mes del idioma actual, re-renderizar.
      try { renderDynamicSlots(); } catch (err) {}
    } catch (e) {
      // fallback: don't break the form
      console.warn('No se pudo cargar idioma ' + lang + ':', e.message);
    }
  }

  // ===== SUBMIT =====
  async function submitForm(e) {
    e.preventDefault();
    if (!validateStep(7)) return;
    if (!$('[name="acepta_terminos"]').checked) {
      showErrors([t('error.terms') || 'Debes aseptá e términos i kondishon.']);
      return;
    }

    $btnSubmit.disabled = true;
    $btnSubmit.textContent = t('nav.submitting') || 'Mandando...';
    clearErrors();

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

      // Resultados OCR (para que el backend los use igual que pipeline WhatsApp)
      fd.append('_ocr_results', JSON.stringify(ocrResults));

      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        body: fd
      });

      if (!response.ok) throw new Error('Server returned ' + response.status);
      const result = await response.json();

      if (result.ok || result.aplicacion_id) {
        track(7, 'enviado');
        clearDraft();
        if (result.aplicacion_id) {
          $('#aplicacionIdMsg').textContent = '#' + result.aplicacion_id;
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

  // ===== EMAIL VERIFICATION =====
  // Flujo: cliente escribe email → click "Verificar" → llama email-verify-send
  // → ingresa código → click "Confirmar" → llama email-verify-confirm.
  // emailVerifiedFor guarda el email exacto que se verificó; si lo cambia, se
  // invalida y tiene que verificar de nuevo.
  let emailVerifiedFor = null;
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
    return emailVerifiedFor && emailInput.value.trim().toLowerCase() === emailVerifiedFor;
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
        setVerifyStatus(t('step3.email_verify_sent') || 'Código enviado. Revisá tu email.', 'ok');
        startResendCooldown(data.cooldown_seconds || 60);
        const codeInput = $('#emailVerifyCode');
        if (codeInput) codeInput.focus();
      } else if (data.reason === 'cooldown') {
        if (panel) panel.hidden = false;
        setVerifyStatus(t('step3.email_verify_cooldown') || 'Esperá unos segundos antes de pedir otro código.', 'warn');
        startResendCooldown(data.cooldown_seconds || 60);
      } else {
        setVerifyStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Probá de nuevo.', 'warn');
      }
    } catch (e) {
      console.warn('email verify send failed', e);
      setVerifyStatus(t('step3.email_verify_error') || 'No pudimos enviar el código. Probá de nuevo.', 'warn');
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
        emailVerifiedFor = email;
        const panel = $('#emailVerifyPanel');
        const success = $('#emailVerifySuccess');
        const verifyBtn = $('#emailVerifyBtn');
        if (panel) panel.hidden = true;
        if (success) success.hidden = false;
        if (verifyBtn) verifyBtn.hidden = true;
        emailInput.readOnly = true;
        setVerifyStatus('', '');
        clearInterval(resendCooldownTimer);
      } else if (data.reason === 'wrong_code') {
        setVerifyStatus(
          (t('step3.email_verify_wrong', { left: data.attempts_left }) ||
            'Código incorrecto. Te quedan ' + data.attempts_left + ' intentos.'),
          'warn'
        );
      } else if (data.reason === 'exhausted') {
        setVerifyStatus(t('step3.email_verify_exhausted') || 'Demasiados intentos. Pedí un código nuevo.', 'warn');
      } else if (data.reason === 'no_active_code') {
        setVerifyStatus(t('step3.email_verify_no_active') || 'No hay código activo. Pedí uno nuevo.', 'warn');
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
          typoEl.innerHTML = (t('step3.email_typo_q') || '¿Querías decir') +
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

  // ===== EVENT WIRING =====
  // ===== TRACKING (progreso del formulario, para el dashboard de aplicaciones) =====
  let _trackingIdMemo = '';
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
  function track(paso, evento) {
    try {
      fetch(TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_id: getTrackingId(), paso: paso, evento: evento, idioma: currentLang }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  // ===== Upload tracker — garantiza que TODOS los documentos llegan a S3 =====
  // Cada subida queda registrada acá; submitForm espera a que todas terminen
  // (con reintentos automáticos) antes de entregar la solicitud.
  const uploadTracker = {};

  function uploadDoc(file, docType, idx) {
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
        track(next, 'paso');
      }
    });

    $btnPrev.addEventListener('click', () => {
      if (currentStep > 1) showStep(currentStep - 1);
    });

    $form.addEventListener('submit', submitForm);

    $form.addEventListener('change', e => {
      saveDraft();
      if (e.target.type === 'radio') updateConditionals();
      if (e.target.tagName === 'SELECT') updateConditionals();
      if (e.target.name === 'tipo_empleado') updatePensionadoMode();
      if (e.target.name === 'frecuencia_salario') renderDynamicSlots();
      // Cualquier upload en Step 2 actualiza el contador.
      if (e.target.type === 'file') updateUploadCounter();
    });

    $form.addEventListener('input', () => {
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
    setupUploads();
    syncSliders();
    wireEvents();
    wireEmailVerification();

    // Detect preferred language: localStorage > browser > pap
    const draft = loadDraft();
    const browserLang = (navigator.language || 'pap').toLowerCase().slice(0, 2);
    const preferred =
      (draft && draft._lang) ||
      (['pap', 'es', 'en'].includes(browserLang) ? browserLang : 'pap');

    await loadI18n(preferred);
    restoreDraft();

    // Render inicial de los slots de Step 2 según tipo_empleado / frecuencia_salario
    // restaurados desde el draft. Si todavía no fueron elegidos muestra hint.
    updatePensionadoMode();
    renderDynamicSlots();

    // Siempre arrancar en Step 1 después de refresh — los file inputs no se pueden
    // restaurar (restricción del navegador) y el usuario debe re-subir documentos.
    // Los campos de texto sí se preservan via localStorage.
    showStep(1);
    track(1, 'inicio');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
