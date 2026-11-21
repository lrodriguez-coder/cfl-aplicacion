/* =============================================================================
   Estado de la solicitud — estado.html (Ronda 13, formulario#0).

   Al terminar el formulario la persona recibe un enlace firmado (pantalla final
   y correo de acuse): estado.html#t=<token>. Esta página lo lee, pregunta al API
   en qué etapa está la solicitud y, si la frena un DOCUMENTO, deja mandar ese
   documento desde el teléfono (PDF o foto, sin forzar la cámara).

   - El token va en el FRAGMENTO (#t=): nunca llega al servidor de GitHub Pages
     ni sale en un Referer.
   - El API sólo devuelve el primer nombre, el número de solicitud, un código de
     etapa y los tipos de documento pedidos. Todo el texto vive aquí, en los 4
     idiomas del formulario. Al cliente: "usted" (es), "u" (nl).
   - Todo lo que viene del API se pinta con textContent, nunca como HTML.
============================================================================= */
(function () {
  'use strict';

  var API = 'https://api.curloans.com/v1/public/application-status/';
  var MAX_BYTES = 20 * 1024 * 1024; // the API's MAX_DOCUMENT_BYTES
  var PHONE = '+5999 526 8480';

  var T = {
    pap: {
      tagline: 'Estado di bo aplikashon',
      hello: 'Bon dia {name},', helloNoName: 'Bon dia,',
      number: 'Bo number di aplikashon',
      stage: {
        received: ['Risibí', 'Nos a risibí bo aplikashon. Pronto un ofisial ta kuminsá revisá e.'],
        documents_in_review: ['Dokumentonan den revishon', 'Nos ta revisando bo dokumentonan. No mester hasi nada awor.'],
        action_needed: ['Falta un dokumento', 'Pa sigui ku bo aplikashon, nos mester e dokumento(nan) akí bou.'],
        in_analysis: ['Den análisis', 'Bo aplikashon ta den análisis di krédito.'],
        offer_ready: ['Oferta kla', 'Bo oferta ta kla. Nos a manda bo e oferta; si bo no a risibí e, tuma kontakto ku nos.'],
        offer_accepted: ['Oferta aseptá', 'Bo a aseptá e oferta. Nos ta prepará e firma i e pago.'],
        closed: ['Será', 'E aplikashon akí ta será. Pa kualke pregunta, tuma kontakto ku nos.']
      },
      steps: ['Risibí', 'Dokumentonan', 'Análisis', 'Oferta'],
      docsTitle: 'Dokumento ku nos mester',
      docsHint: 'Skohe un PDF òf un potret kla (JPG/PNG). Màksimo 20 MB.',
      reason: {
        missing: 'Nos no a risibí e dokumento akí.',
        expired: 'E dokumento ku nos tin a vense. Manda un ku ta bálido.',
        recent_needed: 'Nos mester e mas resien (e último lunanan), kla i kompleto.',
        periods: 'Nos mester esun di: {months}. Kla i kompleto.',
        unreadable: 'Nos no por a lesa e dokumento bon. Manda un kopia mas kla.'
      },
      doc: {
        cedula_front: 'Sédula (dilanti)', id_secondary: 'Otro identifikashon', payslip: 'Slip di salario',
        bank_statement: 'Estado di kuenta di banko', work_letter: 'Karta di trabou', address_proof: 'Prueba di adrès',
        aqualectra: 'Faktura di Aqualectra', tax_form: 'Formulario di belasting',
        business_registration: 'Registro di Kámara di Komersio', other: 'Otro dokumento'
      },
      send: 'Manda', sending: 'Mandando…',
      sent: 'Risibí. Nos ta lesa e dokumento awor; e estado ta aktualisá pronto.',
      pick: 'Skohe un archivo promé.',
      err: {
        LINK_INVALID: ['E link no ta bálido', 'Kontrolá ku bo a habri e link kompleto ku nos a manda bo. Si e problema sigui, tuma kontakto ku nos.'],
        LINK_EXPIRED: ['E link a vense', 'Pa motibo di siguridat e link ta bálido pa un tempu limitá. Tuma kontakto ku nos pa un link nobo.'],
        NETWORK: ['No por a konektá', 'Purba atrobe den un ratu.'],
        TOO_LARGE: 'E archivo ta muchu grandi (màksimo 20 MB).',
        TOO_SMALL: 'E archivo ta bashí òf muchu chikitu.',
        UNSUPPORTED_TYPE: 'Nos ta aseptá solamente PDF òf potret (JPG/PNG).',
        NOT_REQUESTED: 'Nos no ta warda e dokumento akí mas. Rekargá e página.',
        TOO_MANY_UPLOADS: 'Bo a manda e màksimo di archivo pa e aplikashon akí. Tuma kontakto ku nos.',
        RATE: 'Muchu purba. Warda algun minüt i purba atrobe.',
        GENERIC: 'E archivo no a manda. Purba atrobe.'
      },
      contact: 'Pregunta? Yama nos na {phone}.'
    },
    es: {
      tagline: 'Estado de su solicitud',
      hello: 'Hola {name},', helloNoName: 'Hola,',
      number: 'Su número de solicitud',
      stage: {
        received: ['Recibida', 'Hemos recibido su solicitud. Un oficial empezará a revisarla en breve.'],
        documents_in_review: ['Documentos en revisión', 'Estamos revisando sus documentos. Por ahora no necesita hacer nada.'],
        action_needed: ['Falta un documento', 'Para continuar con su solicitud necesitamos el documento o los documentos de abajo.'],
        in_analysis: ['En análisis', 'Su solicitud está en análisis de crédito.'],
        offer_ready: ['Oferta lista', 'Su oferta está lista. Se la enviamos; si no la recibió, contáctenos.'],
        offer_accepted: ['Oferta aceptada', 'Usted aceptó la oferta. Estamos preparando la firma y el desembolso.'],
        closed: ['Cerrada', 'Esta solicitud está cerrada. Para cualquier consulta, contáctenos.']
      },
      steps: ['Recibida', 'Documentos', 'Análisis', 'Oferta'],
      docsTitle: 'Documento que necesitamos',
      docsHint: 'Elija un PDF o una foto nítida (JPG/PNG). Máximo 20 MB.',
      reason: {
        missing: 'No recibimos este documento.',
        expired: 'El documento que tenemos está vencido. Envíe uno vigente.',
        recent_needed: 'Necesitamos el más reciente (los últimos meses), nítido y completo.',
        periods: 'Necesitamos el de: {months}. Nítido y completo.',
        unreadable: 'No pudimos leer bien el documento. Envíe una copia más nítida.'
      },
      doc: {
        cedula_front: 'Cédula (frente)', id_secondary: 'Otra identificación', payslip: 'Recibo de salario',
        bank_statement: 'Estado de cuenta bancario', work_letter: 'Carta de trabajo', address_proof: 'Comprobante de domicilio',
        aqualectra: 'Factura de Aqualectra', tax_form: 'Formulario de impuestos',
        business_registration: 'Registro de la Cámara de Comercio', other: 'Otro documento'
      },
      send: 'Enviar', sending: 'Enviando…',
      sent: 'Recibido. Estamos leyendo el documento; el estado se actualizará en breve.',
      pick: 'Primero elija un archivo.',
      err: {
        LINK_INVALID: ['El enlace no es válido', 'Verifique que abrió el enlace completo que le enviamos. Si el problema sigue, contáctenos.'],
        LINK_EXPIRED: ['El enlace venció', 'Por seguridad el enlace vale por un tiempo limitado. Contáctenos y le enviaremos uno nuevo.'],
        NETWORK: ['No se pudo conectar', 'Inténtelo de nuevo en un momento.'],
        TOO_LARGE: 'El archivo es demasiado grande (máximo 20 MB).',
        TOO_SMALL: 'El archivo está vacío o es demasiado pequeño.',
        UNSUPPORTED_TYPE: 'Sólo aceptamos PDF o fotos (JPG/PNG).',
        NOT_REQUESTED: 'Ya no estamos esperando este documento. Vuelva a cargar la página.',
        TOO_MANY_UPLOADS: 'Ya envió el máximo de archivos para esta solicitud. Contáctenos.',
        RATE: 'Demasiados intentos. Espere unos minutos y vuelva a intentarlo.',
        GENERIC: 'No se pudo enviar el archivo. Inténtelo de nuevo.'
      },
      contact: '¿Preguntas? Llámenos al {phone}.'
    },
    en: {
      tagline: 'Your application status',
      hello: 'Hello {name},', helloNoName: 'Hello,',
      number: 'Your application number',
      stage: {
        received: ['Received', 'We have received your application. An officer will start reviewing it shortly.'],
        documents_in_review: ['Documents in review', 'We are reviewing your documents. There is nothing you need to do right now.'],
        action_needed: ['A document is missing', 'To continue with your application we need the document(s) below.'],
        in_analysis: ['In analysis', 'Your application is in credit analysis.'],
        offer_ready: ['Offer ready', 'Your offer is ready. We have sent it to you; if you did not receive it, please contact us.'],
        offer_accepted: ['Offer accepted', 'You accepted the offer. We are preparing the signing and the disbursement.'],
        closed: ['Closed', 'This application is closed. For any question, please contact us.']
      },
      steps: ['Received', 'Documents', 'Analysis', 'Offer'],
      docsTitle: 'Document we need',
      docsHint: 'Choose a PDF or a sharp photo (JPG/PNG). Maximum 20 MB.',
      reason: {
        missing: 'We did not receive this document.',
        expired: 'The document we have has expired. Please send a valid one.',
        recent_needed: 'We need the most recent one (the last months), sharp and complete.',
        periods: 'We need the one for: {months}. Sharp and complete.',
        unreadable: 'We could not read the document well. Please send a sharper copy.'
      },
      doc: {
        cedula_front: 'ID card (front)', id_secondary: 'Other ID', payslip: 'Payslip',
        bank_statement: 'Bank statement', work_letter: 'Employment letter', address_proof: 'Proof of address',
        aqualectra: 'Aqualectra bill', tax_form: 'Tax form',
        business_registration: 'Chamber of Commerce registration', other: 'Other document'
      },
      send: 'Send', sending: 'Sending…',
      sent: 'Received. We are reading the document; the status will update shortly.',
      pick: 'Please choose a file first.',
      err: {
        LINK_INVALID: ['This link is not valid', 'Please check that you opened the complete link we sent you. If the problem continues, contact us.'],
        LINK_EXPIRED: ['This link has expired', 'For security the link is valid for a limited time. Contact us and we will send you a new one.'],
        NETWORK: ['Could not connect', 'Please try again in a moment.'],
        TOO_LARGE: 'The file is too large (maximum 20 MB).',
        TOO_SMALL: 'The file is empty or too small.',
        UNSUPPORTED_TYPE: 'We only accept PDF files or photos (JPG/PNG).',
        NOT_REQUESTED: 'We are no longer waiting for this document. Please reload the page.',
        TOO_MANY_UPLOADS: 'You have sent the maximum number of files for this application. Please contact us.',
        RATE: 'Too many attempts. Please wait a few minutes and try again.',
        GENERIC: 'The file could not be sent. Please try again.'
      },
      contact: 'Questions? Call us at {phone}.'
    },
    nl: {
      tagline: 'Status van uw aanvraag',
      hello: 'Beste {name},', helloNoName: 'Beste klant,',
      number: 'Uw aanvraagnummer',
      stage: {
        received: ['Ontvangen', 'Wij hebben uw aanvraag ontvangen. Een medewerker begint binnenkort met de beoordeling.'],
        documents_in_review: ['Documenten in behandeling', 'Wij controleren uw documenten. U hoeft nu niets te doen.'],
        action_needed: ['Er ontbreekt een document', 'Om verder te gaan met uw aanvraag hebben wij het onderstaande document nodig.'],
        in_analysis: ['In analyse', 'Uw aanvraag is in kredietanalyse.'],
        offer_ready: ['Aanbod klaar', 'Uw aanbod is klaar. Wij hebben het u gestuurd; heeft u het niet ontvangen, neem dan contact met ons op.'],
        offer_accepted: ['Aanbod geaccepteerd', 'U heeft het aanbod geaccepteerd. Wij bereiden de ondertekening en de uitbetaling voor.'],
        closed: ['Gesloten', 'Deze aanvraag is gesloten. Neem voor vragen contact met ons op.']
      },
      steps: ['Ontvangen', 'Documenten', 'Analyse', 'Aanbod'],
      docsTitle: 'Document dat wij nodig hebben',
      docsHint: 'Kies een pdf of een scherpe foto (JPG/PNG). Maximaal 20 MB.',
      reason: {
        missing: 'Wij hebben dit document niet ontvangen.',
        expired: 'Het document dat wij hebben is verlopen. Stuur een geldig exemplaar.',
        recent_needed: 'Wij hebben het meest recente nodig (de laatste maanden), scherp en volledig.',
        periods: 'Wij hebben dat van {months} nodig. Scherp en volledig.',
        unreadable: 'Wij konden het document niet goed lezen. Stuur een scherpere kopie.'
      },
      doc: {
        cedula_front: 'Identiteitskaart (voorkant)', id_secondary: 'Ander identiteitsbewijs', payslip: 'Loonstrook',
        bank_statement: 'Bankafschrift', work_letter: 'Werkgeversverklaring', address_proof: 'Bewijs van adres',
        aqualectra: 'Aqualectra-rekening', tax_form: 'Belastingformulier',
        business_registration: 'Inschrijving Kamer van Koophandel', other: 'Ander document'
      },
      send: 'Versturen', sending: 'Versturen…',
      sent: 'Ontvangen. Wij lezen het document; de status wordt binnenkort bijgewerkt.',
      pick: 'Kies eerst een bestand.',
      err: {
        LINK_INVALID: ['Deze link is niet geldig', 'Controleer of u de volledige link heeft geopend die wij u stuurden. Blijft het probleem, neem dan contact met ons op.'],
        LINK_EXPIRED: ['Deze link is verlopen', 'Om veiligheidsredenen is de link beperkt geldig. Neem contact met ons op voor een nieuwe link.'],
        NETWORK: ['Geen verbinding', 'Probeer het over een moment opnieuw.'],
        TOO_LARGE: 'Het bestand is te groot (maximaal 20 MB).',
        TOO_SMALL: 'Het bestand is leeg of te klein.',
        UNSUPPORTED_TYPE: 'Wij accepteren alleen pdf-bestanden of foto\'s (JPG/PNG).',
        NOT_REQUESTED: 'Wij wachten niet meer op dit document. Laad de pagina opnieuw.',
        TOO_MANY_UPLOADS: 'U heeft het maximale aantal bestanden voor deze aanvraag verstuurd. Neem contact met ons op.',
        RATE: 'Te veel pogingen. Wacht enkele minuten en probeer het opnieuw.',
        GENERIC: 'Het bestand kon niet worden verstuurd. Probeer het opnieuw.'
      },
      contact: 'Vragen? Bel ons op {phone}.'
    }
  };

  var STEP_INDEX = { received: 0, documents_in_review: 1, action_needed: 1, in_analysis: 2, offer_ready: 3, offer_accepted: 3 };

  function $(id) { return document.getElementById(id); }
  function fill(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return vars && k in vars ? vars[k] : ''; }); }

  function readToken() {
    var h = (location.hash || '').replace(/^#/, '');
    var m = /(?:^|&)t=([^&]+)/.exec(h) || /[?&]t=([^&]+)/.exec(location.search || '');
    if (!m) return '';
    var t = decodeURIComponent(m[1]);
    return /^[A-Za-z0-9_-]+~[A-Za-z0-9_-]+$/.test(t) ? t : '';
  }

  var token = readToken();
  var lang = 'pap';
  var status = null;     // last answer of the API
  var errorKey = null;   // LINK_INVALID / LINK_EXPIRED / NETWORK
  var notes = {};        // per document type: { cls, text }

  function savedLang() { try { return localStorage.getItem('cfl_estado_lang'); } catch (e) { return null; } }
  function saveLang(l) { try { localStorage.setItem('cfl_estado_lang', l); } catch (e) { /* private mode */ } }
  function fromApiLang(l) { return l === 'pa' ? 'pap' : (T[l] ? l : null); }
  function fromBrowser() {
    var n = (navigator.language || '').slice(0, 2).toLowerCase();
    return n === 'es' || n === 'en' || n === 'nl' ? n : null;
  }

  function render() {
    var L = T[lang];
    document.documentElement.lang = lang;
    document.documentElement.setAttribute('data-lang', lang);
    $('langSwitch').value = lang;
    $('stTagline').textContent = L.tagline;
    document.title = 'Curaçao Fast Loans — ' + L.tagline;
    $('stLoading').hidden = !!(status || errorKey);

    if (errorKey) {
      var e = L.err[errorKey] || L.err.LINK_INVALID;
      $('stError').hidden = false;
      $('stMain').hidden = true;
      $('stErrorTitle').textContent = e[0];
      $('stErrorBody').textContent = e[1] + ' ' + fill(L.contact, { phone: PHONE });
      return;
    }
    $('stError').hidden = true;
    if (!status) return;
    $('stMain').hidden = false;

    $('stHello').textContent = status.firstName ? fill(L.hello, { name: status.firstName }) : L.helloNoName;
    $('stNumberLabel').textContent = L.number;
    $('stNumber').textContent = status.applicationNumber || '—';
    var st = L.stage[status.stage] || L.stage.documents_in_review;
    $('stStage').textContent = st[0];
    $('stDetail').textContent = st[1];

    var steps = $('stSteps');
    steps.textContent = '';
    var at = STEP_INDEX[status.stage];
    steps.hidden = at === undefined;
    L.steps.forEach(function (name, i) {
      var li = document.createElement('li');
      li.textContent = name;
      if (at !== undefined) li.className = i < at ? 'done' : (i === at ? 'now' : '');
      steps.appendChild(li);
    });

    var docs = status.canUpload ? (status.missingDocuments || []) : [];
    $('stDocs').hidden = docs.length === 0;
    $('stDocsTitle').textContent = L.docsTitle;
    $('stDocsHint').textContent = L.docsHint;
    var list = $('stDocList');
    list.textContent = '';
    docs.forEach(function (d) { list.appendChild(docBlock(d, L)); });
    $('stContact').textContent = fill(L.contact, { phone: PHONE });
  }

  // Month names per language, for the months the status asks for (gauntlet
  // r14, formulario#7: "we need October 2026", not "the most recent one").
  var MONTHS = {
    pap: ['yanüari', 'febrüari', 'mart', 'aprel', 'mei', 'yüni', 'yüli', 'ougùstùs', 'sèptèmber', 'òktober', 'novèmber', 'desèmber'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december']
  };
  function monthsText(periods) {
    var names = MONTHS[lang] || MONTHS.es;
    return periods.map(function (p) {
      var m = /^(\d{4})-(\d{2})$/.exec(String(p));
      var name = m ? names[Number(m[2]) - 1] : null;
      return name ? name + ' ' + m[1] : String(p);
    }).join(', ');
  }
  function reasonText(d, L) {
    if (Array.isArray(d.periods) && d.periods.length && L.reason.periods) {
      return fill(L.reason.periods, { months: monthsText(d.periods) });
    }
    return L.reason[d.reason] || L.reason.missing;
  }

  function docBlock(d, L) {
    var box = document.createElement('div');
    box.className = 'st-doc';
    box.setAttribute('data-doc', d.documentType);
    var h = document.createElement('h3');
    h.textContent = L.doc[d.documentType] || L.doc.other;
    var p = document.createElement('p');
    p.className = 'field-hint';
    p.textContent = reasonText(d, L);
    // No `capture`: the phone offers files (PDF) as well as the camera.
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,image/*';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = L.send;
    var msg = document.createElement('p');
    msg.className = 'st-msg';
    var n = notes[d.documentType];
    if (n) { msg.className = 'st-msg ' + n.cls; msg.textContent = n.text; }
    btn.addEventListener('click', function () { upload(d.documentType, input, btn, msg); });
    box.appendChild(h); box.appendChild(p); box.appendChild(input); box.appendChild(btn); box.appendChild(msg);
    return box;
  }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // A photo is re-drawn as a JPEG of at most 2400 px: a phone picture fits well
  // under the limit, and a format the reader cannot open (HEIC, where the
  // browser can decode it) becomes one it can. If the browser cannot decode
  // it, the original goes and the API says whether it is accepted.
  function prepareImage(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || typeof createImageBitmap !== 'function') { resolve(file); return; }
      createImageBitmap(file).then(function (bmp) {
        var max = 2400, w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas');
        cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.85);
      }).catch(function () { resolve(file); });
    });
  }

  function upload(docType, input, btn, msg) {
    var L = T[lang];
    var file = input.files && input.files[0];
    function say(cls, text) { notes[docType] = { cls: cls, text: text }; msg.className = 'st-msg ' + cls; msg.textContent = text; }
    if (!file) { say('err', L.pick); return; }
    btn.disabled = true;
    btn.textContent = L.sending;
    prepareImage(file).then(function (blob) {
      if (blob.size > MAX_BYTES) throw { code: 'TOO_LARGE' };
      return toBase64(blob);
    }).then(function (b64) {
      var name = (file.name || 'document').replace(/\.(heic|heif)$/i, '.jpg');
      return fetch(API + encodeURIComponent(token) + '/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentType: docType, filename: name.slice(0, 200), fileBase64: b64 })
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) return;
        var code = (j && j.error && j.error.code) || (res.status === 429 ? 'RATE' : 'GENERIC');
        if (res.status === 429 && code !== 'TOO_MANY_UPLOADS') code = 'RATE';
        throw { code: code };
      });
    }).then(function () {
      say('ok', L.sent);
      input.value = '';
      setTimeout(load, 800);
    }).catch(function (e) {
      var code = e && e.code;
      if (code === 'LINK_INVALID' || code === 'LINK_EXPIRED') { errorKey = code; render(); return; }
      say('err', L.err[code] || L.err.GENERIC);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = T[lang].send;
    });
  }

  function load() {
    if (!token) { errorKey = 'LINK_INVALID'; render(); return; }
    fetch(API + encodeURIComponent(token), { cache: 'no-store' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.status === 410) { errorKey = 'LINK_EXPIRED'; return; }
        if (!res.ok) { errorKey = res.status === 404 ? 'LINK_INVALID' : 'NETWORK'; return; }
        errorKey = null;
        var first = !status;
        status = j;
        // The language the client chose in the form, unless they picked one here.
        if (first && !savedLang()) lang = fromApiLang(j.language) || lang;
      });
    }).catch(function () { errorKey = 'NETWORK'; }).then(render);
  }

  lang = fromApiLang(savedLang()) || fromBrowser() || 'pap';
  $('langSwitch').addEventListener('change', function (e) {
    var v = e.target.value;
    if (T[v]) { lang = v; saveLang(v); render(); }
  });
  render();
  load();
})();
