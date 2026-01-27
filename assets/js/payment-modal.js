// assets/js/payment-modal.js
// Modal de cobro — soporta múltiples métodos y conversión USD/EUR <> Bs
// Actualizaciones:
// - Formato numérico en inputs: "." = separador de miles, "," = separador decimal.
// - Al activar un método de pago el input correspondiente recibe foco y selecciona todo.
// - El checkbox USD (BCV) queda seleccionado por defecto al abrir el modal.
// - Los montos resultantes de la conversión (pmTotalBs) se muestran en negrita.
// - Forzar coma como separador decimal en inputs (reemplaza '.' por ',' mientras escribe).
// - Resalta en negrita las tasas dentro de pmConvInfo.
// - Soporta selección de múltiples métodos: cuando hay un faltante, se fracciona
//   automáticamente entre los métodos seleccionados (respetando campos editados por el usuario).
// - Distribución en tiempo real: al seleccionar/desmarcar métodos o al editar cualquier campo
//   se recalcula y redistribuye el faltante entre los campos elegibles (no marcados como userEdited).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    serverTimestamp,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// DOM elementos
const modal = document.getElementById('paymentModal');
const pmCustomerName = document.getElementById('pmCustomerName');
const pmTotal = document.getElementById('pmTotal');
const pmTotalBs = document.getElementById('pmTotalBs');
const paymentForm = document.getElementById('paymentForm');
const pmReceivedEl = document.getElementById('pmReceived');
const pmErrorEl = document.getElementById('pmError');
const pmAmountCorrect = document.getElementById('pmAmountCorrect');
const pmConfirmBtn = document.getElementById('pmConfirmBtn');
const pmCancelBtn = document.getElementById('pmCancelBtn');
const pmChecksSelector = '.pm-check';
const pmAmountSelector = '.pm-amount';

const convChecksSelector = '.pm-conv-check';
const pmAssignRate = document.getElementById('pmAssignRate');
const pmAssignRateWrap = document.getElementById('pmAssignRateWrap');
const pmConvInfo = document.getElementById('pmConvInfo');
const pmApplyConversion = document.getElementById('pmApplyConversion');
const pmRemainingEl = document.getElementById('pmRemaining');

const pmMobileDetails = document.getElementById('pmMobileDetails');
const pmMobileBank = document.getElementById('pmMobileBank');
const pmMobileRef = document.getElementById('pmMobileRef');

let currentOrder = null;
let currentUser = null;

let rates = {
    usd_bcv: null,
    eur_bcv: null,
    date: null,
    apiSource: null,
    apiRaw: null,
    isTomorrow: false
};

onAuthStateChanged(auth, (u) => { currentUser = u; });

/* ---------------- Helpers de formato ---------------- */

/**
 * Limpia una cadena numérica quitando separadores de miles y adaptando la coma decimal.
 * Acepta formatos:
 *  - "1.234.567,89" (puntos miles, coma decimal) => "1234567.89"
 *  - "1234567.89" (punto decimal) => "1234567.89"
 *  - "1,234,567.89" (coma thousands usado en algunos locales) => "1234567.89"
 */
function cleanNumberString(str) {
    if (str == null) return '';
    let s = String(str).trim();
    s = s.replace(/\s+/g, ''); // quitar espacios

    // Si contiene ambos separadores '.' y ',' asumimos '.' = miles y ',' = decimal
    if (s.indexOf('.') !== -1 && s.indexOf(',') !== -1) {
        s = s.replace(/\./g, '').replace(',', '.');
        return s;
    }

    // Si solo contiene coma y no punto => asumimos coma decimal
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) {
        return s.replace(',', '.');
    }

    // En otro caso, remover comas (posibles thousands en formato anglo) y dejar puntos como decimal
    s = s.replace(/,/g, '');
    return s;
}

/**
 * Formatea un número para mostrar en input con separador de miles "." y separador decimal ","
 * decimals: número de decimales a mostrar (por defecto 2)
 */
function formatNumberForInput(value, decimals = 2) {
    if (value === null || value === undefined || value === '') return '';
    const num = Number(value);
    if (isNaN(num)) return '';
    const fixed = (typeof decimals === 'number') ? num.toFixed(decimals) : String(num);
    const parts = fixed.split('.');
    // Insertar separador de miles "."
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    // Unir con coma decimal
    return parts.length > 1 ? `${parts[0]},${parts[1]}` : parts[0];
}

function isBlank(str) {
    return !str || String(str).trim().length === 0;
}

/* Reemplaza puntos por comas en el valor visible del input mientras se escribe,
   y trata de mantener la posición del cursor. */
function enforceCommaDecimalInput(inputEl) {
    if (!inputEl) return;
    try {
        const start = inputEl.selectionStart;
        const before = inputEl.value;
        // Reemplazar todos los puntos por comas (evita introducir punto decimal)
        const after = before.replace(/\./g, ',');
        if (after === before) return; // no hay cambios
        inputEl.value = after;
        // restaurar cursor en una posición aproximada
        const diff = after.length - before.length; // normalmente 0 (reemplazo 1:1)
        const newPos = Math.max(0, (start || 0) + diff);
        inputEl.setSelectionRange(newPos, newPos);
    } catch (e) {
        // si algo falla, no bloquear la entrada
        console.warn('enforceCommaDecimalInput error', e);
    }
}

/* ---------------- UI helpers ---------------- */
function showModal() {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const firstChk = modal.querySelector(pmChecksSelector);
    if (firstChk) firstChk.focus();
}

function closeModal() {
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    cleanup();
}

function setMobileRequired(flag) {
    if (pmMobileBank) {
        pmMobileBank.required = !!flag;
        if (flag) pmMobileBank.setAttribute('aria-required', 'true');
        else pmMobileBank.removeAttribute('aria-required');
    }
    if (pmMobileRef) {
        pmMobileRef.required = !!flag;
        if (flag) pmMobileRef.setAttribute('aria-required', 'true');
        else pmMobileRef.removeAttribute('aria-required');
    }
    if (pmMobileDetails) {
        pmMobileDetails.style.display = flag ? 'block' : 'none';
        pmMobileDetails.setAttribute('aria-hidden', flag ? 'false' : 'true');
    }
}

function cleanup() {
    if (paymentForm) paymentForm.reset();
    if (pmReceivedEl) pmReceivedEl.textContent = '$. 0.00';
    if (pmErrorEl) { pmErrorEl.style.display = 'none'; pmErrorEl.textContent = ''; }
    pmAssignRateWrap.style.display = 'none';
    pmConvInfo.textContent = '';
    pmTotalBs.textContent = '';
    // ensure mobile details hidden and not required
    setMobileRequired(false);
    // reset user-edited flags and format amounts to default 0,00 (con coma decimal)
    document.querySelectorAll('.pm-amount').forEach(inp => {
        delete inp.dataset.userEdited;
        inp.value = formatNumberForInput(0, 2);
        inp.disabled = true;
    });
    if (pmAssignRate) {
        delete pmAssignRate.dataset.userEdited;
        pmAssignRate.value = '';
    }
}

/* ---------------- Conversion / Rates ---------------- */

const EXCHANGE_API = 'https://api.dolarvzla.com/public/exchange-rate';

function todayString(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
}

// Reemplazar la función fetchRates por esta versión más robusta y con logging visible en UI

// Reemplazar la función fetchRates por esta versión de debug + manejo 401
async function fetchRates() {
    const showUiInfo = (msg) => {
        try { if (pmConvInfo) pmConvInfo.textContent = msg; } catch (e) { /* ignore */ }
    };

    const controller = new AbortController();
    const timeoutMs = 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Cache-busting para evitar respuestas en cache distintas entre sesiones
    const url = EXCHANGE_API + '?_=' + Date.now();

    try {
        console.debug('fetchRates: solicitando API de tasas a', url);
        const resp = await fetch(url, { method: 'GET', mode: 'cors', headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timer);

        // Si no OK, intentar leer body para diagnosticar (por ejemplo 401 con mensaje)
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.warn('fetchRates: respuesta no OK', resp.status, resp.statusText, text);
            showUiInfo(`Error obteniendo tasa: ${resp.status} ${resp.statusText}. ${text ? 'Detalle: ' + text : ''}`);

            // si es 401 -> indicar claramente que la API requiere autorización
            if (resp.status === 401) {
                console.warn('fetchRates: 401 Unauthorized — la API requiere autenticación o la clave no es válida.');
                // Dejar rates en null de forma explícita
                rates.usd_bcv = null; rates.eur_bcv = null; rates.date = null; rates.apiRaw = null; rates.apiSource = EXCHANGE_API; rates.isTomorrow = false;
                return;
            }

            // reintento simple (sin query param) por si algún proxy falla con querystring
            try {
                const resp2 = await fetch(EXCHANGE_API, { method: 'GET', mode: 'cors', headers: { 'Accept': 'application/json' } });
                if (resp2.ok) {
                    const j2 = await resp2.json();
                    rates.apiRaw = j2; rates.apiSource = EXCHANGE_API;
                    const current2 = j2?.current;
                    if (current2) {
                        const apiDate2 = String(current2.date || '').slice(0,10);
                        const usd2 = Number(current2.usd);
                        const eur2 = Number(current2.eur);
                        const today = todayString(0);
                        const tomorrow = todayString(1);
                        if (apiDate2 === today || apiDate2 === tomorrow) {
                            rates.usd_bcv = (usd2 && !isNaN(usd2)) ? usd2 : null;
                            rates.eur_bcv = (eur2 && !isNaN(eur2)) ? eur2 : null;
                            rates.date = apiDate2;
                            rates.isTomorrow = (apiDate2 === tomorrow);
                            console.debug('fetchRates: retry OK, tasas asignadas', rates);
                            return;
                        }
                    }
                } else {
                    const t2 = await resp2.text().catch(()=>'');
                    console.warn('fetchRates retry no OK', resp2.status, t2);
                    showUiInfo(`Retry: ${resp2.status} ${resp2.statusText}. ${t2}`);
                }
            } catch (retryErr) {
                console.warn('fetchRates retry error', retryErr);
            }

            // fallback: dejar tasas null y mostrar mensaje (para que la UI no rompa)
            rates.usd_bcv = null; rates.eur_bcv = null; rates.date = null; rates.apiRaw = null; rates.apiSource = EXCHANGE_API; rates.isTomorrow = false;
            return;
        }

        // OK path
        const j = await resp.json();
        console.debug('fetchRates: payload recibido', j);
        rates.apiRaw = j; rates.apiSource = EXCHANGE_API;
        const current = j?.current;
        if (!current) {
            showUiInfo('Formato inesperado de la API de tasas.');
            rates.usd_bcv = null; rates.eur_bcv = null; rates.date = null; rates.isTomorrow = false;
            return;
        }

        const apiDate = String(current.date || '').slice(0,10);
        const usd = Number(current.usd);
        const eur = Number(current.eur);
        const today = todayString(0);
        const tomorrow = todayString(1);

        if (apiDate === today) {
            rates.usd_bcv = (usd && !isNaN(usd)) ? usd : null;
            rates.eur_bcv = (eur && !isNaN(eur)) ? eur : null;
            rates.date = apiDate;
            rates.isTomorrow = false;
            console.debug('fetchRates: usando tasa para hoy', rates);
            return;
        }
        if (apiDate === tomorrow) {
            rates.usd_bcv = (usd && !isNaN(usd)) ? usd : null;
            rates.eur_bcv = (eur && !isNaN(eur)) ? eur : null;
            rates.date = apiDate;
            rates.isTomorrow = true;
            console.debug('fetchRates: usando tasa para mañana', rates);
            return;
        }

        console.warn(`fetchRates: tasa API con fecha ${apiDate} no es hoy ni mañana`);
        showUiInfo('Tasa API fuera de rango de fecha.');
        rates.usd_bcv = null; rates.eur_bcv = null; rates.date = apiDate || null; rates.isTomorrow = false;
    } catch (e) {
        clearTimeout(timer);
        console.warn('fetchRates error', e);
        rates.usd_bcv = null; rates.eur_bcv = null; rates.date = null; rates.apiRaw = null; rates.apiSource = EXCHANGE_API; rates.isTomorrow = false;
        if (e && e.name === 'AbortError') showUiInfo('Timeout obteniendo tasa. Reintenta.');
        else showUiInfo('Error obteniendo tasa: ' + (e && e.message ? e.message : String(e)));
    }
}

/* ---------------- Conversión y cálculo ---------------- */

function parseAmountFor(method) {
    const el = document.querySelector(`.pm-amount[data-method="${method}"]`);
    const chk = document.querySelector(`.pm-check[data-method="${method}"]`);
    if (!el || !chk) return 0;
    const raw = cleanNumberString(el.value || '0');
    const val = Number(raw || 0);
    if (!chk.checked) return 0;
    return isNaN(val) ? 0 : val;
}

function getSelectedConversion() {
    const sel = document.querySelector(convChecksSelector + ':checked');
    if (!sel) return null;
    return sel.dataset.conv;
}

function getActiveRate() {
    const sel = getSelectedConversion();
    if (!sel) return null;
    if (sel === 'usd_bcv') return rates.usd_bcv || null;
    if (sel === 'eur_bcv') return rates.eur_bcv || null;
    if (sel === 'assign') {
        const v = Number(cleanNumberString(pmAssignRate.value || '0'));
        return (v > 0) ? v : null;
    }
    return null;
}

function formatBs(v) {
    // For Bs formatting use Spanish locale to get "." thousands and "," decimals
    return `Bs. ${Number(v || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* computeTotalsAndUI ahora también devuelve remainingUSD para distribución */
function computeTotalsAndUI() {
    pmErrorEl.style.display = 'none';
    pmErrorEl.textContent = '';

    const totalUSD = Number(currentOrder?.total || currentOrder?.amount || currentOrder?.totalAmount || 0);

    const usdAmount = parseAmountFor('usd');
    const paypalAmount = parseAmountFor('paypal');

    const cashBs = parseAmountFor('cash');
    const mobileBs = parseAmountFor('mobile');
    const otherBs = parseAmountFor('other');
    const bsTotal = cashBs + mobileBs + otherBs;

    const mobileChecked = Boolean(document.querySelector('.pm-check[data-method="mobile"]')?.checked);
    const cashChecked = Boolean(document.querySelector('.pm-check[data-method="cash"]')?.checked);

    let rate = getActiveRate();

    let bsToUsdEquivalent = null;
    if (bsTotal > 0) {
        if ((mobileChecked || cashChecked) && !rate) {
            pmErrorEl.textContent = 'Para convertir montos en Bs a USD necesitas seleccionar una opción de conversión válida (tasa del día o asignada).';
            pmErrorEl.style.display = 'block';
            bsToUsdEquivalent = NaN;
        } else if (rate) {
            bsToUsdEquivalent = Number((bsTotal / rate));
        } else {
            bsToUsdEquivalent = 0;
        }
    } else {
        bsToUsdEquivalent = 0;
    }

    const totalReceivedUSD = (usdAmount || 0) + (paypalAmount || 0) + (isNaN(bsToUsdEquivalent) ? 0 : bsToUsdEquivalent);
    pmReceivedEl.textContent = `$. ${Number(totalReceivedUSD).toFixed(2)}`;

    const remainingUSD = Number((totalUSD - totalReceivedUSD) || 0);
    pmRemainingEl.textContent = `Resto: $. ${remainingUSD.toFixed(2)}`;

    const sel = getSelectedConversion();
    // Show bold amount for pmTotalBs where appropriate and bold rates in pmConvInfo
    if ((sel === 'usd_bcv' && rates.usd_bcv) || (sel === 'eur_bcv' && rates.eur_bcv) || sel === 'assign') {
        if (mobileChecked || cashChecked) {
            if (sel === 'usd_bcv' && rates.usd_bcv) {
                const bsVal = totalUSD * rates.usd_bcv;
                pmTotalBs.innerHTML = `≈ <strong>${formatBs(bsVal)}</strong> (tasa <strong>${rates.usd_bcv}</strong> Bs/USD, fecha ${rates.date})`;
                pmConvInfo.innerHTML = `Tasa activa: <strong>${rates.usd_bcv}</strong> Bs por USD (fecha ${rates.date})${rates.isTomorrow ? ' — la tasa corresponde al día siguiente.' : ''}`;
            } else if (sel === 'eur_bcv' && rates.eur_bcv) {
                const bsVal = totalUSD * rates.eur_bcv;
                pmTotalBs.innerHTML = `≈ <strong>${formatBs(bsVal)}</strong> (tasa <strong>${rates.eur_bcv}</strong> Bs/EUR, fecha ${rates.date})`;
                pmConvInfo.innerHTML = `Tasa activa: <strong>${rates.eur_bcv}</strong> Bs por EUR (fecha ${rates.date})${rates.isTomorrow ? ' — la tasa corresponde al día siguiente.' : ''}`;
            } else if (sel === 'assign') {
                const v = Number(cleanNumberString(pmAssignRate.value || '0'));
                if (v > 0) {
                    const bsVal = totalUSD * v;
                    pmTotalBs.innerHTML = `≈ <strong>${formatBs(bsVal)}</strong> (tasa asignada <strong>${formatNumberForInput(v, 2)}</strong> Bs/USD)`;
                    pmConvInfo.innerHTML = `Tasa asignada: <strong>${formatNumberForInput(v, 2)}</strong> Bs por USD`;
                } else {
                    pmTotalBs.textContent = '';
                    pmConvInfo.textContent = 'Ingresa una tasa personalizada válida.';
                }
            }
        } else {
            pmTotalBs.textContent = '';
            pmConvInfo.textContent = 'Selecciona Pago Móvil o Efectivo para ver el total en Bs.';
            if (rates.isTomorrow) pmConvInfo.textContent += ' (la tasa disponible es para el día siguiente).';
        }
    } else {
        pmTotalBs.textContent = '';
        if (rates.date) {
            pmConvInfo.textContent = `Tasas disponibles en API pero no seleccionadas o no aplican (fecha API: ${rates.date}).`;
            if (rates.isTomorrow) pmConvInfo.textContent += ' Nota: la tasa es para el día siguiente.';
        } else {
            pmConvInfo.textContent = 'Tasa no disponible para hoy. Selecciona "Asignar" o revisa la API.';
        }
    }

    return { totalUSD, totalReceivedUSD, remainingUSD, rate, bsTotal, bsBreakdown: { cashBs, mobileBs, otherBs }, rateSnapshot: { usd_bcv: rates.usd_bcv, eur_bcv: rates.eur_bcv, date: rates.date, source: rates.apiSource } };
}

function usdToBs(usd, rate) {
    return Number((usd * rate) || 0);
}

function bsToUsd(bs, rate) {
    return rate ? Number(bs / rate) : NaN;
}

/* ---------------- Distribución del faltante entre métodos ----------------
   Estrategia:
   - Calcula remainingUSD.
   - Encuentra métodos seleccionados (checked) cuyos inputs no hayan sido editados manualmente
     (dataset.userEdited !== 'true') y cuyo valor numérico actual sea 0 (campo vacío o 0).
   - Si no hay tasa y hay métodos Bs entre los elegibles, se priorizan los métodos USD.
   - Divide remainingUSD en partes iguales entre los métodos elegibles.
   - Para métodos Bs, convierte la porción USD a Bs con la tasa activa.
*/
function distributeRemaining() {
    try {
        const { remainingUSD, rate } = computeTotalsAndUI();
        if (!remainingUSD || remainingUSD <= 0) return;

        const methodEls = Array.from(document.querySelectorAll(pmChecksSelector)).map(chk => {
            const method = chk.dataset.method;
            const amountInput = document.querySelector(`.pm-amount[data-method="${method}"]`);
            return { chk, method, amountInput };
        }).filter(x => x.chk && x.chk.checked && x.amountInput);

        // Eligible: checked && input exists && not userEdited (or dataset.userEdited === 'false') && numeric value == 0
        const eligible = methodEls.filter(({ amountInput }) => {
            const isUserEdited = amountInput.dataset && amountInput.dataset.userEdited === 'true';
            const val = Number(cleanNumberString(amountInput.value || '0')) || 0;
            return !isUserEdited && val === 0;
        });

        if (!eligible.length) return;

        // Separate by currency
        const usdEligible = eligible.filter(e => e.method === 'usd' || e.method === 'paypal');
        const bsEligible = eligible.filter(e => ['cash', 'mobile', 'other'].includes(e.method));

        // If bsEligible present but no rate -> avoid filling bs; if no usdEligible either, show message and return
        if ((!rate || !isFinite(rate)) && bsEligible.length && !usdEligible.length) {
            // can't convert, abort
            pmErrorEl.textContent = 'No hay tasa disponible para convertir USD a Bs. Asigna una tasa o edita manualmente los montos en Bs.';
            pmErrorEl.style.display = 'block';
            return;
        }

        // Build final list to distribute across:
        // If both USD and Bs eligible, distribute across all eligible (convert Bs share using rate).
        // If rate not available, prefer USDEligible only.
        let finalEligible = [];
        if (rate && isFinite(rate)) {
            finalEligible = eligible;
        } else {
            finalEligible = usdEligible;
        }

        if (!finalEligible.length) return;

        const parts = finalEligible.length;
        const perUsd = remainingUSD / parts;

        finalEligible.forEach((entry) => {
            const { method, amountInput } = entry;
            if (!amountInput) return;
            if (method === 'usd' || method === 'paypal') {
                // assign USD share
                amountInput.value = formatNumberForInput(perUsd, 2);
                amountInput.disabled = false;
                amountInput.dataset.userEdited = 'false';
            } else {
                // Bs method: convert perUsd to Bs using active rate
                const bsAmount = rate && isFinite(rate) ? Number((perUsd * rate).toFixed(2)) : 0;
                amountInput.value = formatNumberForInput(bsAmount, 2);
                amountInput.disabled = false;
                amountInput.dataset.userEdited = 'false';
                if (method === 'mobile') setMobileRequired(true);
            }
        });

        // focus + select first filled input
        const firstFilled = finalEligible[0];
        if (firstFilled && firstFilled.amountInput) {
            setTimeout(() => {
                try {
                    firstFilled.amountInput.focus();
                    if (typeof firstFilled.amountInput.select === 'function') firstFilled.amountInput.select();
                } catch (e) { }
            }, 0);
        }

        // recompute UI after assignment
        computeTotalsAndUI();
    } catch (err) {
        console.warn('distributeRemaining error', err);
    }
}

/* ---------------- Auto-llenado inteligente (mantiene compatibilidad) ---------------- */

function autoFillBsIfNeeded() {
    const sel = getSelectedConversion();
    const rate = getActiveRate();
    if (!sel || !rate) return;
    const { remainingUSD } = computeTotalsAndUI();
    if (remainingUSD <= 0) return;

    // If there are eligible fields, prefer distributeRemaining (it will split across multiple methods)
    distributeRemaining();
}

/* ---------------- Events ---------------- */

document.addEventListener('change', (e) => {
    if (e.target && (e.target.matches(pmChecksSelector) || e.target.matches(pmAmountSelector))) {
        document.querySelectorAll(pmChecksSelector).forEach(chk => {
            const method = chk.dataset.method;
            const amountInput = document.querySelector(`.pm-amount[data-method="${method}"]`);
            if (!amountInput) return;
            if (chk === e.target && chk.checked) {
                amountInput.disabled = false;
                // only set dataset.userEdited=false if it didn't come with a user edit
                if (!amountInput.dataset || amountInput.dataset.userEdited !== 'true') amountInput.dataset.userEdited = 'false';
                // Focus y seleccionar todo para que el usuario pueda escribir inmediatamente
                setTimeout(() => {
                    try {
                        amountInput.focus();
                        if (typeof amountInput.select === 'function') amountInput.select();
                    } catch (err) {
                        console.warn('No fue posible seleccionar el campo de monto', err);
                    }
                }, 0);
            } else {
                amountInput.disabled = !chk.checked;
            }
            if (!chk.checked) {
                amountInput.value = formatNumberForInput(0, 2);
                delete amountInput.dataset.userEdited;
            }
        });

        if (e.target && e.target.matches('.pm-check[data-method="mobile"]')) {
            const mobileChk = e.target;
            if (mobileChk.checked) {
                // show mobile details and mark fields required
                setMobileRequired(true);
            } else {
                // hide and remove required
                setMobileRequired(false);
                if (pmMobileBank) pmMobileBank.value = '';
                if (pmMobileRef) pmMobileRef.value = '';
            }
        }

        computeTotalsAndUI();
        // after recomputing, try to distribute remaining among eligible fields (real-time)
        setTimeout(() => distributeRemaining(), 0);
    }

    if (e.target && e.target.matches(convChecksSelector)) {
        if (e.target.checked) {
            document.querySelectorAll(convChecksSelector).forEach(c => {
                if (c !== e.target) c.checked = false;
            });
        }
        const sel = getSelectedConversion();
        pmAssignRateWrap.style.display = (sel === 'assign') ? 'block' : 'none';

        if ((sel === 'usd_bcv' && !rates.usd_bcv) || (sel === 'eur_bcv' && !rates.eur_bcv) || !rates.date) {
            fetchRates().then(() => {
                computeTotalsAndUI();
                distributeRemaining();
            }).catch(() => {
                computeTotalsAndUI();
                distributeRemaining();
            });
        } else {
            computeTotalsAndUI();
            distributeRemaining();
        }
    }

    if (e.target && e.target.id === 'pmAssignRate') {
        computeTotalsAndUI();
        distributeRemaining();
    }
});

// aplicar conversión al Pago Móvil (rellena el campo mobile o cash en Bs) - botón manual
if (pmApplyConversion) {
    pmApplyConversion.addEventListener('click', () => {
        pmErrorEl.style.display = 'none';
        pmErrorEl.textContent = '';

        const rate = getActiveRate();
        const { remainingUSD } = computeTotalsAndUI();
        if (remainingUSD <= 0) {
            pmErrorEl.textContent = 'No hay resto para convertir.';
            pmErrorEl.style.display = 'block';
            return;
        }
        if (!rate) {
            pmErrorEl.textContent = 'Selecciona una tasa de conversión válida antes de convertir.';
            pmErrorEl.style.display = 'block';
            return;
        }

        const mobileChk = document.querySelector(`.pm-check[data-method="mobile"]`);
        const cashChk = document.querySelector(`.pm-check[data-method="cash"]`);
        const mobileInput = document.querySelector(`.pm-amount[data-method="mobile"]`);
        const cashInput = document.querySelector(`.pm-amount[data-method="cash"]`);
        const bsAmount = Number(usdToBs(remainingUSD, rate).toFixed(2));

        if (mobileChk && mobileChk.checked && mobileInput) {
            mobileChk.checked = true;
            mobileInput.disabled = false;
            mobileInput.value = formatNumberForInput(bsAmount, 2);
            mobileInput.dataset.userEdited = 'false';
            setMobileRequired(true);
            computeTotalsAndUI();
            // focus and select to allow immediate editing
            setTimeout(() => { try { mobileInput.focus(); mobileInput.select(); } catch (e) { } }, 0);
            return;
        }
        if (cashChk && cashChk.checked && cashInput) {
            cashChk.checked = true;
            cashInput.disabled = false;
            cashInput.value = formatNumberForInput(bsAmount, 2);
            cashInput.dataset.userEdited = 'false';
            computeTotalsAndUI();
            setTimeout(() => { try { cashInput.focus(); cashInput.select(); } catch (e) { } }, 0);
            return;
        }

        pmErrorEl.textContent = 'Selecciona Pago Móvil o Efectivo antes de aplicar la conversión.';
        pmErrorEl.style.display = 'block';
    });
}

// input events: detectar cuando el usuario edita manualmente un campo (para no sobrescribirlo)
// y recalcular totales; si el usuario cambia cualquier monto, redistribuir el faltante en tiempo real
document.addEventListener('input', (e) => {
    if (!e.target) return;

    // Forzar coma como separador decimal en inputs de monto y en tasa asignada
    if (e.target.matches(pmAmountSelector) || e.target.id === 'pmAssignRate') {
        enforceCommaDecimalInput(e.target);
    }

    if (e.target && e.target.matches(pmAmountSelector)) {
        // mark this field as user-edited
        e.target.dataset.userEdited = 'true';
        // Do not format on each keystroke to avoid caret issues; compute totals
        computeTotalsAndUI();
        // When the user types in any amount field, redistribute remainingUSD across other eligible fields in real time
        setTimeout(() => distributeRemaining(), 0);
        return;
    }

    if (e.target && (e.target.matches('#pmAssignRate') || e.target.matches(convChecksSelector))) {
        computeTotalsAndUI();
        distributeRemaining();
    }
});

// Formatear inputs al perder foco para mostrar separadores (puntos miles, coma decimales)
document.addEventListener('blur', (e) => {
    if (e.target && e.target.matches(pmAmountSelector)) {
        // formatear con 2 decimales usando el nuevo formato
        const cleaned = cleanNumberString(e.target.value || '0');
        const num = Number(cleaned || 0);
        e.target.value = formatNumberForInput(num, 2);
        computeTotalsAndUI();
        // after formatting, redistribute if needed
        setTimeout(() => distributeRemaining(), 0);
    }
}, true);

// Formatear tasa asignada al perder foco (2 decimales)
if (pmAssignRate) {
    pmAssignRate.addEventListener('blur', (ev) => {
        const cleaned = cleanNumberString(pmAssignRate.value || '');
        const num = Number(cleaned || 0);
        if (num > 0) {
            pmAssignRate.value = formatNumberForInput(num, 2);
        } else {
            pmAssignRate.value = '';
        }
        computeTotalsAndUI();
        distributeRemaining();
    });
}

/* ---------------- Lógica principal: abrir modal y confirmar cobranza ---------------- */

function parseItemProductIdAndQty(item) {
    const productId = item.productId || item.product || item.product_id || item.id || item.productIdRef || item._id;
    const qty = Number(item.quantity || item.qty || item.count || item.quantityOrdered || item.q || 1) || 1;
    return { productId, qty };
}

export async function openPaymentModal(orderObj) {
    if (!orderObj) return;
    currentOrder = orderObj;

    pmCustomerName.textContent = orderObj.customerData?.Customname || orderObj.customerData?.name || orderObj.clientName || orderObj.customer || '—';
    const total = orderObj.total || orderObj.amount || orderObj.totalAmount || 0;
    pmTotal.textContent = `$. ${Number(total).toFixed(2)}`;

    cleanup();

    // Por defecto seleccionar la conversión BCV USD
    const usdConvChk = document.querySelector('.pm-conv-check[data-conv="usd_bcv"]');
    if (usdConvChk) {
        usdConvChk.checked = true;
        usdConvChk.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        pmAssignRateWrap.style.display = 'none';
    }

    // Cargar tasas y actualizar UI
    fetchRates().then(() => {
        computeTotalsAndUI();
        distributeRemaining();
    }).catch(() => {
        computeTotalsAndUI();
        distributeRemaining();
    });

    showModal();

    const mobileChkInit = document.querySelector(`.pm-check[data-method="mobile"]`);
    if (mobileChkInit) {
        if (mobileChkInit.checked) {
            setMobileRequired(true);
        } else {
            setMobileRequired(false);
        }
    }

    pmConfirmBtn.onclick = async () => {
        try {
            pmErrorEl.style.display = 'none';
            pmErrorEl.textContent = '';

            if (!currentUser) {
                pmErrorEl.textContent = 'Usuario no autenticado.';
                pmErrorEl.style.display = 'block';
                return;
            }

            // Validate mobile bank/reference if mobile payment is selected
            const mobileChk = document.querySelector('.pm-check[data-method="mobile"]');
            if (mobileChk && mobileChk.checked) {
                if (isBlank(pmMobileBank?.value)) {
                    pmErrorEl.textContent = 'Selecciona un banco para Pago Móvil.';
                    pmErrorEl.style.display = 'block';
                    if (pmMobileBank) pmMobileBank.focus();
                    return;
                }
                if (isBlank(pmMobileRef?.value)) {
                    pmErrorEl.textContent = 'Ingresa la referencia bancaria.';
                    pmErrorEl.style.display = 'block';
                    if (pmMobileRef) pmMobileRef.focus();
                    return;
                }
            }

            const methods = [];
            document.querySelectorAll(pmChecksSelector).forEach(chk => {
                if (!chk.checked) return;
                const method = chk.dataset.method;
                const amountInput = document.querySelector(`.pm-amount[data-method="${method}"]`);
                const raw = cleanNumberString(amountInput?.value || '0');
                const amount = Number(raw || 0);
                if (isNaN(amount) || amount <= 0) return;
                const currency = (method === 'usd' || method === 'paypal') ? 'USD' : 'Bs';
                const extra = {};
                if (method === 'mobile') {
                    extra.bank = pmMobileBank?.value || '';
                    extra.reference = pmMobileRef?.value || '';
                }
                methods.push({ method, amount, currency, ...extra });
            });

            if (methods.length === 0) {
                pmErrorEl.textContent = 'Selecciona al menos un método con un monto mayor a 0.';
                pmErrorEl.style.display = 'block';
                return;
            }

            const { totalUSD, totalReceivedUSD } = computeTotalsAndUI();

            const EPS = 0.005;
            if (isNaN(totalReceivedUSD)) {
                pmErrorEl.textContent = 'Hay montos en Bs sin una tasa de conversión válida.';
                pmErrorEl.style.display = 'block';
                return;
            }
            if (Math.abs(totalReceivedUSD - totalUSD) > EPS) {
                pmErrorEl.textContent = `El total abonado ($${totalReceivedUSD.toFixed(2)}) no coincide con el total a cobrar ($${totalUSD.toFixed(2)}). Ajusta los montos.`;
                pmErrorEl.style.display = 'block';
                return;
            }

            const convSelected = getSelectedConversion();
            const effectiveRate = getActiveRate() || null;
            const rateSource = (convSelected === 'assign') ? 'manual' : (rates.apiSource || EXCHANGE_API);
            const rateDate = rates.date || null;
            const rateSnapshot = { usd_bcv: rates.usd_bcv, eur_bcv: rates.eur_bcv, fetchedAt: rates.date, source: rates.apiSource, apiRaw: rates.apiRaw };

            const detailedMethods = methods.map(m => {
                if (m.currency === 'Bs') {
                    const usdEquivalent = effectiveRate ? Number((m.amount / effectiveRate).toFixed(6)) : null;
                    return {
                        method: m.method,
                        currency: m.currency,
                        originalAmount: Number(m.amount),
                        bsAmount: Number(m.amount),
                        usdEquivalent: usdEquivalent,
                        conversion: effectiveRate ? { type: convSelected, rate: effectiveRate, rateDate, rateSource } : null,
                        bank: m.bank || '',
                        reference: m.reference || ''
                    };
                } else {
                    return {
                        method: m.method,
                        currency: m.currency,
                        originalAmount: Number(m.amount),
                        bsAmount: effectiveRate ? Number(usdToBs(m.amount, effectiveRate).toFixed(2)) : null,
                        usdEquivalent: Number(m.amount),
                        conversion: effectiveRate ? { type: convSelected, rate: effectiveRate, rateDate, rateSource } : null
                    };
                }
            });

            const totalReceivedBs = detailedMethods.reduce((acc, mm) => {
                if (mm.currency === 'Bs') return acc + (Number(mm.bsAmount || 0));
                if (mm.currency === 'USD' && mm.bsAmount) return acc + Number(mm.bsAmount || 0);
                return acc;
            }, 0);

            const totalInBsAtRate = (effectiveRate && totalUSD) ? Number((totalUSD * effectiveRate).toFixed(2)) : null;

            const paymentObj = {
                methods: detailedMethods,
                totalUSD: Number(totalUSD.toFixed(6)),
                totalReceivedUSD: Number(totalReceivedUSD.toFixed(6)),
                totalReceivedBs: Number(totalReceivedBs.toFixed(2)),
                totalInBsAtRate: totalInBsAtRate,
                conversionSelected: convSelected,
                conversionRate: effectiveRate,
                conversionRateDate: rateDate,
                conversionRateSource: rateSource,
                rateSnapshot: rate_snapshot_safe(rateSnapshot),
                confirmedBy: currentUser.uid,
                confirmedByEmail: currentUser.email || '',
                paidAt: serverTimestamp()
            };

            const orderRef = doc(db, 'orders', currentOrder.id);

            try {
                await runTransaction(db, async (tx) => {
                    const orderSnap = await tx.get(orderRef);
                    if (!orderSnap.exists()) throw new Error('Pedido ya no existe.');
                    const orderData = orderSnap.data();

                    const items = orderData.items || currentOrder.items || [];
                    const prodMap = new Map();
                    for (const item of items) {
                        const { productId, qty } = parseItemProductIdAndQty(item);
                        if (!productId) continue;
                        if (!prodMap.has(productId)) prodMap.set(productId, { qty: 0, ref: doc(db, 'product', productId) });
                        const entry = prodMap.get(productId);
                        entry.qty += qty;
                    }

                    const prodEntries = Array.from(prodMap.entries());
                    const prodSnaps = [];
                    for (const [productId, { ref }] of prodEntries) {
                        const snap = await tx.get(ref);
                        prodSnaps.push({ productId, ref, snap });
                    }

                    for (const { productId, ref, snap } of prodSnaps) {
                        if (!snap.exists()) {
                            console.warn('Producto no encontrado al confirmar pago (se saltará):', productId);
                            continue;
                        }
                        const prodData = snap.data();
                        const currentStock = Number(prodData.stock || 0);
                        const orderedQty = prodMap.get(productId).qty || 0;
                        const newStock = Math.max(0, currentStock - orderedQty);
                        const newSales = (typeof prodData.salesCount === 'number' ? prodData.salesCount : 0) + orderedQty;

                        tx.update(ref, {
                            stock: newStock,
                            salesCount: newSales,
                            updatedAt: serverTimestamp()
                        });
                    }

                    tx.update(orderRef, {
                        paymentStatus: 'pagado',
                        payment: paymentObj,
                        paymentUpdatedAt: serverTimestamp(),
                        shippingStatus: 'entregado',
                        shippingUpdatedAt: serverTimestamp()
                    });
                });
            } catch (txErr) {
                console.error('Transaction error updating products/order:', txErr);
                pmErrorEl.textContent = `Pago registrado pero no se pudo actualizar inventario/pedido atomically: ${txErr.message || txErr}`;
                pmErrorEl.style.display = 'block';
                return;
            }

            document.dispatchEvent(new CustomEvent('payment:confirmed', { detail: { orderId: currentOrder.id } }));

            closeModal();
        } catch (err) {
            console.error('Error registrando cobranza:', err);
            let msg = 'Error registrando cobranza. Revisa la consola.';
            const code = err && err.code ? String(err.code) : '';
            if (code.includes('permission-denied')) msg = 'Acceso denegado. Revisa permisos de Firestore y tu sesión.';
            else if (code.includes('unauthenticated')) msg = 'Usuario no autenticado. Inicia sesión e intenta de nuevo.';
            else if (err && err.message) msg = err.message;
            pmErrorEl.textContent = msg;
            pmErrorEl.style.display = 'block';
        }
    };
}

if (pmCancelBtn) pmCancelBtn.addEventListener('click', () => closeModal());
if (document.getElementById('paymentModalClose')) {
    document.getElementById('paymentModalClose').addEventListener('click', () => closeModal());
}

/* ---------------- Helpers finales ---------------- */

// small helper to keep rateSnapshot safe (avoid circular structures)
function rate_snapshot_safe(snap) {
    try {
        return JSON.parse(JSON.stringify(snap));
    } catch (e) {
        return { usd_bcv: rates.usd_bcv, eur_bcv: rates.eur_bcv, date: rates.date, source: rates.apiSource };
    }
}
