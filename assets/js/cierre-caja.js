// cierre-caja.js — Archivo completo con todas las mejoras:
// - Resumen fijo (hoy) y selección desde Calendario (día(s)/semana/mes)
// - Calendario muestra: verde = cierre realizado, rojo = pendiente
// - Selección multi-día y aplicar selección para mostrar en Resumen
// - Toasts mejorados, banner de cierre en Resumen, ocultado de controles cuando aplica
// - Guardado de conciliaciones y cierre (uno por cada fecha seleccionada)
// - Cálculo y visualización de comisiones (percent / amount) para vendedores y motorizados
// - Muestra montos fijos con decimales en headers y por pedido
//
// NOTA: Este script depende de firebase-config.js ubicado en la misma carpeta (o ../ o ../../).
// Incluye imports dinámicos a Firebase CDN (v12.x) y usa Firestore.

const modBase = new URL('.', import.meta.url);

let firebaseConfig;
try {
    try { firebaseConfig = (await import(new URL('./firebase-config.js', modBase).href)).firebaseConfig; } catch { }
    if (!firebaseConfig) try { firebaseConfig = (await import(new URL('../firebase-config.js', modBase).href)).firebaseConfig; } catch { }
    if (!firebaseConfig) try { firebaseConfig = (await import(new URL('../../firebase-config.js', modBase).href)).firebaseConfig; } catch { }
    if (!firebaseConfig) throw new Error('firebase-config.js no encontrado en rutas probadas');
} catch (err) {
    console.error('Error cargando firebase-config.js:', err);
    throw err;
}

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore,
    collection,
    query,
    where,
    getDocs,
    Timestamp,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---------- DOM helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------- Enhanced Toasts ----------
function showToast(message, opts = {}) {
    const { type = 'info', duration = 3500 } = opts;
    const el = $('#toast');
    if (!el) return alert(message);
    el.className = '';
    el.classList.add('toast', `toast-${type}`);
    el.innerHTML = `
    <div class="toast-body">
      <div class="toast-message">${message}</div>
      <button class="toast-close" aria-label="Cerrar">&times;</button>
    </div>
  `;
    el.style.display = 'block';
    const closeBtn = el.querySelector('.toast-close');
    const hide = () => { el.style.display = 'none'; el.className = ''; el.innerHTML = ''; };
    closeBtn?.addEventListener('click', hide);
    if (duration > 0) setTimeout(hide, duration);
}
const toast = (m, t = 3000) => showToast(m, { type: 'info', duration: t });

// ---------- formatting helpers ----------
function formatNumberCustom(value, decimals = 2) {
    if (value == null || isNaN(Number(value))) value = 0;
    const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    return new Intl.NumberFormat('en-US', opts).format(Number(value));
}
function formatCurrencyBs(v) {
    if (v == null) v = 0;
    const decimals = 2;
    return `Bs ${formatNumberCustom(Number(v), decimals)}`;
}
function formatCurrencyUSD(v) {
    return `$ ${formatNumberCustom(Number(v), 2)}`;
}
function formatDateDisplay(d) {
    try {
        return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
        return String(d);
    }
}
// Reemplaza isoFromDate con esta versión que devuelve la fecha en zona local (YYYY-MM-DD)
function isoFromDate(d) {
    if (!(d instanceof Date)) d = new Date(d);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function parseFormattedNumber(str) {
    if (!str && str !== 0) return 0;
    if (typeof str === 'number') return str;
    const s = String(str).replace(/[^\d\.\-\,]/g, '');
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    let normalized = s;
    if (commas > 0 && dots === 0) {
        normalized = s.replace(/,/g, '');
    } else if (commas > 0 && dots > 0) {
        normalized = s.replace(/,/g, '');
    } else {
        normalized = s;
    }
    const n = parseFloat(normalized);
    return isNaN(n) ? 0 : n;
}

// ---------- normalization helpers ----------
function toDateFromPossible(value) {
    if (!value) return null;
    if (typeof value === 'object' && typeof value.toDate === 'function') {
        try { return value.toDate(); } catch { }
    }
    if (typeof value === 'object' && (value.seconds || value._seconds)) {
        const s = value.seconds ?? value._seconds;
        return new Date(s * 1000);
    }
    if (typeof value === 'number') return value > 1e12 ? new Date(value) : new Date(value * 1000);
    if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d) ? null : d;
    }
    if (value instanceof Date) return value;
    return null;
}

// Nuevo helper: obtener la fecha "oficial" del pedido y campo usado
function getOrderDateInfo(order) {
    // Orden de prioridad: preferimos payment.paidAt, paidAt, payment.createdAt, createdAt, paymentUpdatedAt, updatedAt, payment.conversionRateDate
    const candidates = [
        { field: 'payment.paidAt', value: order?.payment?.paidAt },
        { field: 'paidAt', value: order?.paidAt },
        { field: 'payment.createdAt', value: order?.payment?.createdAt },
        { field: 'createdAt', value: order?.createdAt },
        { field: 'paymentUpdatedAt', value: order?.paymentUpdatedAt },
        { field: 'updatedAt', value: order?.updatedAt },
        { field: 'payment.conversionRateDate', value: order?.payment?.conversionRateDate }
    ];
    for (const c of candidates) {
        const dt = toDateFromPossible(c.value);
        if (dt) return { date: dt, field: c.field };
    }
    return { date: null, field: null };
}

function determinePrimaryCurrency(m) {
    const currency = String((m.currency || '').toLowerCase() || '').trim();
    const method = String((m.method || m.type || '').toLowerCase() || '').trim();
    const bs = Number(m.bsAmount ?? m.originalAmount ?? m.amount ?? m.totalBs ?? 0);
    const usd = Number(m.usdAmount ?? m.usdEquivalent ?? m.usdEquivalentAmount ?? m.totalUsd ?? 0);

    if (currency) {
        if (currency.includes('bs') || currency.includes('bol')) return 'bs';
        if (currency.includes('usd') || currency.includes('dolar') || currency.includes('usd$')) return 'usd';
    }
    if (method) {
        if (method.includes('efectivo') || method.includes('cash')) {
            if (method.includes('cash') && currency.includes('usd')) return 'usd';
            return 'bs';
        }
        if (method.includes('usd') || method.includes('dolar') || method.includes('zelle') || method.includes('paypal')) {
            if (method.includes('paypal') && bs > 0 && usd === 0) return 'bs';
            return 'usd';
        }
        if (method.includes('mobile') || method.includes('pago') || method.includes('mobil') || method.includes('pago-movil')) return 'bs';
    }

    if (bs > 0 && usd === 0) return 'bs';
    if (usd > 0 && bs === 0) return 'usd';

    if (bs > 0 && usd > 0) {
        if (m.originalAmount && m.currency && String(m.currency).toLowerCase().includes('bs')) return 'bs';
        if (m.originalAmount && m.currency && String(m.currency).toLowerCase().includes('usd')) return 'usd';
        if (m.usdEquivalent || m.usdEquivalentAmount) return 'bs';
        return 'bs';
    }

    return 'bs';
}

function normalizePaymentMethod(raw) {
    const currency = String((raw.currency || '').toLowerCase()).trim();
    const method = String((raw.method || raw.type || '').toLowerCase()).trim();

    const primary = determinePrimaryCurrency(raw);

    let key = 'other';
    let label = raw.method || raw.type || raw.currency || 'Otro';
    let cls = '';

    if ((currency.includes('bs') && method.includes('cash')) || method.includes('efectivo') || (primary === 'bs' && method.includes('cash'))) {
        key = 'efectivo';
        label = 'Efectivo';
        cls = 'payment-efectivo';
    } else if ((currency.includes('usd') && method.includes('usd')) || method === 'usd' || method.includes('usd') || method.includes('dolar')) {
        key = 'efectivo-usd';
        label = 'Efectivo (USD)';
        cls = 'payment-usd';
    } else if (method.includes('mobile') || method.includes('pago movil') || method.includes('pago-movil') || method.includes('pago')) {
        key = 'pago-movil';
        label = 'Pago Móvil';
        cls = 'payment-movil';
    } else if (method.includes('paypal')) {
        key = 'paypal';
        label = 'PayPal';
        cls = 'payment-paypal';
    } else if (method.includes('zelle')) {
        key = 'zelle';
        label = 'Zelle';
        cls = 'payment-paypal';
    } else if (method.includes('card') || method.includes('tarjeta')) {
        key = 'card';
        label = 'Tarjeta';
        cls = '';
    } else if (method.includes('motorizad') || /rider|delivery|motorizado/.test(method) || /motorizad/i.test(label)) {
        key = 'motorizado';
        label = 'Pago motorizado';
        cls = '';
    } else {
        if (primary === 'usd') { key = 'efectivo-usd'; label = 'Efectivo (USD)'; cls = 'payment-usd'; }
        else { key = 'efectivo'; label = 'Efectivo'; cls = 'payment-efectivo'; }
    }

    return { key, label, cls, primary };
}

function extractPaymentsFromOrder(orderDoc) {
    const rawPayments = [];
    const p = orderDoc.payment || orderDoc.payments || {};
    if (Array.isArray(p.methods) && p.methods.length) rawPayments.push(...p.methods);
    else if (Array.isArray(orderDoc.methods) && orderDoc.methods.length) rawPayments.push(...orderDoc.methods);
    else if (Array.isArray(p) && p.length) rawPayments.push(...p);
    else {
        rawPayments.push(Object.assign({}, p || {}, { amount: orderDoc.total || 0, currency: orderDoc.currency || '', method: orderDoc.paymentMethod || '' }));
    }

    const map = new Map();
    let motorizadoAmountBs = 0;
    let motorizadoAmountUsd = 0;

    for (const m of rawPayments) {
        const bs = Number(m.bsAmount ?? m.originalAmount ?? m.amount ?? m.totalBs ?? 0);
        const usd = Number(m.usdAmount ?? m.usdEquivalent ?? m.usdEquivalentAmount ?? m.totalUsd ?? 0);
        const norm = normalizePaymentMethod(m);
        const primary = determinePrimaryCurrency(m); // 'bs'|'usd'
        const mapKey = `${norm.key}::${primary}`;

        const methodLower = String((m.method || m.type || '').toLowerCase());
        if (methodLower.includes('motoriz') || methodLower.includes('rider') || methodLower.includes('delivery') || String(m.label || '').toLowerCase().includes('motoriz')) {
            if (primary === 'bs') motorizadoAmountBs += bs;
            else motorizadoAmountUsd += usd;
            continue;
        }

        if (!map.has(mapKey)) map.set(mapKey, { key: norm.key, label: norm.label, cls: norm.cls, primary, bs: 0, usd: 0 });
        const entry = map.get(mapKey);
        if (primary === 'bs') entry.bs += bs;
        else entry.usd += usd;
    }

    const payments = Array.from(map.values());
    return { payments, motorizado: { bs: motorizadoAmountBs, usd: motorizadoAmountUsd } };
}

// ---------- debounce ----------
function debounce(fn, wait = 300) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

// ---------- DOM refs ----------
const displayDate = $('#display-date');
const displayDatePill = $('#display-date-pill');
const applyBtn = $('#btn-apply');
const calcBtn = $('#btn-calc');
const cascadeContainer = $('#cascade-container');
const summaryCards = $('#summary-cards');
const kpiCards = $('#kpi-cards');
const btnCloseCash = $('#btn-close-cash');
const concBsInput = $('#conciliation-bs');
const concUsdInput = $('#conciliation-usd');
const saveConciliationBtn = $('#btn-save-conciliation');

const filterSeller = $('#filter-seller');
const filterRider = $('#filter-rider');
const filterPayment = $('#filter-payment');
const btnApplyFilters = $('#btn-apply-filters');
const btnResetFilters = $('#btn-reset-filters');

const tabResumenBtn = $('#tab-resumen-btn');
const tabCalendarioBtn = $('#tab-calendario-btn');
const contentResumen = $('#content-resumen');
const contentCalendario = $('#content-calendario');

const calPrev = $('#cal-prev');
const calToday = $('#cal-today');
const calNext = $('#cal-next');
const calGrid = $('#calendar-grid');
const calMonthName = $('#calendar-month-name');

const selectWeekBtn = $('#select-week');
const selectMonthBtn = $('#select-month');
const clearSelectionBtn = $('#clear-selection');
const applySelectionBtn = $('#apply-selection');

const filterCard = $('#filter-card');
const conciliationSection = $('#conciliation-section');

let currentUser = null;
let lastFetchedOrders = []; // guard copy of displayed orders
let closuresCache = []; // cache closures for visible month

// Calendar selection state and calendar state
const selectedDates = new Set();
const calState = { currentCalendarMonth: new Date() };

// ---------- Commission helpers (improved) ----------
const userCommissionCache = new Map();

/**
 * Busca la configuración de comisión por uid/email/nameLower.
 * Devuelve { commissionType, commissionValue, commissionCurrency?, rawUserDoc? }
 */
async function getUserCommissionByAny(candidate) {
    if (!candidate) return { commissionType: 'percent', commissionValue: 0 };
    // normalize input
    let uid = null, email = null, name = null;
    if (typeof candidate === 'string') {
        if (candidate.includes('@')) email = candidate.toLowerCase();
        else uid = candidate;
    } else if (typeof candidate === 'object') {
        uid = candidate.uid || null;
        email = (candidate.email || candidate.emailLower) ? String(candidate.email || candidate.emailLower).toLowerCase() : null;
        name = candidate.name || candidate.nameLower || null;
    }

    const emailLower = email ? String(email).toLowerCase() : null;
    const nameLower = name ? String(name).toLowerCase() : null;

    const cacheKey = emailLower || uid || (nameLower ? `name:${nameLower}` : null);
    if (cacheKey && userCommissionCache.has(cacheKey)) return userCommissionCache.get(cacheKey);

    try {
        const usersCol = collection(db, 'users');
        let snap = null;

        // Try several queries to increase chances (emailLower, email, uid, nameLower, name)
        if (emailLower) {
            try {
                let q = query(usersCol, where('emailLower', '==', emailLower));
                snap = await getDocs(q);
            } catch (e) { /* ignore */ }
            if ((!snap || snap.empty)) {
                try {
                    let q2 = query(usersCol, where('email', '==', emailLower));
                    snap = await getDocs(q2);
                } catch (e) { /* ignore */ }
            }
            if ((!snap || snap.empty)) {
                try {
                    let q3 = query(usersCol, where('email', '==', email));
                    snap = await getDocs(q3);
                } catch (e) { /* ignore */ }
            }
        }

        if ((!snap || snap.empty) && uid) {
            try {
                const q2 = query(usersCol, where('uid', '==', String(uid)));
                snap = await getDocs(q2);
            } catch (e) { /* ignore */ }
        }

        if ((!snap || snap.empty) && nameLower) {
            try {
                const q3 = query(usersCol, where('nameLower', '==', String(nameLower)));
                snap = await getDocs(q3);
            } catch (e) { /* ignore */ }
            if ((!snap || snap.empty)) {
                try {
                    const q4 = query(usersCol, where('name', '==', String(name)));
                    snap = await getDocs(q4);
                } catch (e) { /* ignore */ }
            }
        }

        if (snap && !snap.empty) {
            const data = snap.docs[0].data();

            // --- Mejor detección de tipo/valor de comisión (cubriendo variantes comunes de nombres) ---
            let commissionType = data?.commissionType ?? data?.commission?.type ?? null;
            if (!commissionType) {
                if (data?.commissionPercent || data?.commission_percent || data?.commissionRate || data?.commission_rate || data?.commissionPercentValue) commissionType = 'percent';
                if (data?.commissionAmount || data?.commission_amount || data?.commission_value || data?.commissionFixed || data?.commission_fixed) commissionType = 'amount';
            }
            if (!commissionType) commissionType = 'percent';

            const commissionValue = Number(
                data?.commissionValue ??
                data?.commission?.value ??
                data?.commissionPercent ??
                data?.commission_percent ??
                data?.commissionRate ??
                data?.commission_rate ??
                data?.commissionAmount ??
                data?.commission_amount ??
                data?.commission_value ??
                data?.commissionFixed ??
                data?.commission_fixed ??
                0
            ) || 0;

            const commissionCurrency = data?.commissionCurrency ?? data?.commission?.currency ?? data?.commission_currency ?? null; // opcional
            const res = { commissionType, commissionValue, commissionCurrency, rawUserDoc: data };
            if (cacheKey) userCommissionCache.set(cacheKey, res);
            return res;
        }
    } catch (err) {
        console.warn('Error buscando user commission:', err);
    }

    const fallback = { commissionType: 'percent', commissionValue: 0 };
    if (cacheKey) userCommissionCache.set(cacheKey, fallback);
    return fallback;
}

/**
 * Calcula la comisión (BS/USD) para un pedido según la configuración provista.
 * role: 'seller' | 'rider'
 * - seller: base = total pedido (pagos BS / USD + motorizado BS/USD)
 * - rider: base = únicamente la parte motorizado (si hay); si no hay monto de motorizado, fallback al total
 * Devuelve { bs, usd, label, type, value, currency }
 */
function computeCommissionAmounts(order, commissionConfig = {}, role = 'seller') {
    const { payments, motorizado } = extractPaymentsFromOrder(order);

    const totalBs = (payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? Number(p.bs || 0) : 0), 0) + (motorizado?.bs || 0);
    const totalUsd = (payments || []).reduce((s, p) => s + ((p.primary === 'usd') ? Number(p.usd || 0) : 0), 0) + (motorizado?.usd || 0);

    let baseBs = totalBs;
    let baseUsd = totalUsd;
    if (role === 'rider') {
        if ((motorizado?.bs || 0) > 0 || (motorizado?.usd || 0) > 0) {
            baseBs = motorizado.bs || 0;
            baseUsd = motorizado.usd || 0;
        } else {
            baseBs = totalBs;
            baseUsd = totalUsd;
        }
    }

    const type = commissionConfig?.commissionType ?? 'percent';
    const value = Number(commissionConfig?.commissionValue ?? 0) || 0;
    const currency = commissionConfig?.commissionCurrency || null;

    if (type === 'percent') {
        const bs = Math.round((baseBs * (value / 100)) * 100) / 100;
        const usd = Math.round((baseUsd * (value / 100)) * 100) / 100;
        const label = `${value}%`;
        return { bs, usd, label, type, value, currency: currency || 'bs' };
    } else if (type === 'amount') {
        // si la amount tiene currency especificada la respetamos, sino asumimos Bs
        const bs = (currency && String(currency).toLowerCase().includes('usd')) ? 0 : Number(value);
        const usd = (currency && String(currency).toLowerCase().includes('usd')) ? Number(value) : 0;
        const label = (currency && String(currency).toLowerCase().includes('usd')) ? `USD ${formatNumberCustom(value, 2)}` : `Bs ${formatNumberCustom(value, 2)}`;
        return { bs, usd, label, type, value, currency };
    }
    return { bs: 0, usd: 0, label: '0', type: 'percent', value: 0, currency: null };
}

/**
 * Recorre un array de pedidos (los objetos order) y les agrega:
 *  - _sellerCommissionBs, _sellerCommissionUsd, _sellerCommissionType, _sellerCommissionValue, _sellerCommissionLabel
 *  - _riderCommissionBs, _riderCommissionUsd, _riderCommissionType, _riderCommissionValue, _riderCommissionLabel
 *
 * El identificador del vendedor/motorizado se busca en propiedades comunes del pedido
 */
async function attachCommissionsToOrders(orders) {
    if (!Array.isArray(orders)) return;
    for (const order of orders) {
        try {
            // Determinar identificadores probables del vendedor/motorizado (uid/email/name)
            const sellerIdCandidates = [
                order.assignedSellerId, order.assignedSellerUid, order.sellerId, order.sellerUid,
                order.assignedSellerEmail, order.sellerEmail, order.createdBy?.uid, order.createdBy?.email
            ].filter(Boolean);

            const sellerNameCandidates = [
                order.assignedSellerName, order.assignedSeller, order.sellerName, order.vendedor, order.createdBy?.name
            ].filter(Boolean);

            // ---- AMPLIADO: incluir más campos que puedan contener email/name/uid del motorizado ----
            const riderIdCandidates = [
                order.assignedMotorizedId, order.assignedMotorizedUid, order.riderId, order.motorizadoId,
                order.assignedMotorizedEmail, order.riderEmail, order.assignedMotorName, order.assignedMotorEmail, order.assignedMotorized // fallback
            ].filter(Boolean);

            const riderNameCandidates = [
                order.assignedMotorizedName, order.assignedMotorName, order.assignedMotorizedName, order.assignedMotorName, order.motorizado, order.riderName
            ].filter(Boolean);

            let sellerConfig = null;
            if (sellerIdCandidates.length) sellerConfig = await getUserCommissionByAny(sellerIdCandidates[0]);
            if ((!sellerConfig || sellerConfig.commissionValue === undefined || sellerConfig.commissionValue === null) && sellerNameCandidates.length) {
                sellerConfig = await getUserCommissionByAny({ name: sellerNameCandidates[0] });
            }
            if (!sellerConfig) sellerConfig = { commissionType: 'percent', commissionValue: 0 };

            let riderConfig = null;
            if (riderIdCandidates.length) riderConfig = await getUserCommissionByAny(riderIdCandidates[0]);
            if ((!riderConfig || riderConfig.commissionValue === undefined || riderConfig.commissionValue === null) && riderNameCandidates.length) {
                riderConfig = await getUserCommissionByAny({ name: riderNameCandidates[0] });
            }
            if (!riderConfig) riderConfig = { commissionType: 'percent', commissionValue: 0 };

            const sellerComm = computeCommissionAmounts(order, sellerConfig, 'seller');
            const riderComm = computeCommissionAmounts(order, riderConfig, 'rider');

            // Añadir campos al propio objeto order (renderCascade / buildCascadeData usan este objeto)
            order._sellerCommissionBs = sellerComm.bs ?? 0;
            order._sellerCommissionUsd = sellerComm.usd ?? 0;
            order._sellerCommissionType = sellerComm.type ?? sellerConfig.commissionType ?? 'percent';
            order._sellerCommissionValue = sellerComm.value ?? sellerConfig.commissionValue ?? 0;
            order._sellerCommissionLabel = sellerComm.label ?? (order._sellerCommissionType === 'percent' ? `${order._sellerCommissionValue}%` : `Bs ${formatNumberCustom(order._sellerCommissionValue, 2)}`);

            order._riderCommissionBs = riderComm.bs ?? 0;
            order._riderCommissionUsd = riderComm.usd ?? 0;
            order._riderCommissionType = riderComm.type ?? riderConfig.commissionType ?? 'percent';
            order._riderCommissionValue = riderComm.value ?? riderConfig.commissionValue ?? 0;
            order._riderCommissionLabel = riderComm.label ?? (order._riderCommissionType === 'percent' ? `${order._riderCommissionValue}%` : `Bs ${formatNumberCustom(order._riderCommissionValue, 2)}`);

            // DEBUG: si quieres ver por consola (descomenta)
            // console.debug('attachCommissionsToOrders', order.id, { sellerConfig, riderConfig, sellerComm, riderComm });
        } catch (err) {
            console.warn('attachCommissionsToOrders error para order', order?.id, err);
            order._sellerCommissionBs = 0;
            order._sellerCommissionUsd = 0;
            order._sellerCommissionType = 'percent';
            order._sellerCommissionValue = 0;
            order._sellerCommissionLabel = '0';
            order._riderCommissionBs = 0;
            order._riderCommissionUsd = 0;
            order._riderCommissionType = 'percent';
            order._riderCommissionValue = 0;
            order._riderCommissionLabel = '0';
        }
    }
}

// ---------- Firestore helpers ----------
function dayRangeFromISO(isoDate) {
    const start = new Date(isoDate + 'T00:00:00');
    const end = new Date(isoDate + 'T23:59:59.999');
    return { start, end };
}

async function fetchOrdersForDate(isoDate) {
    const { start, end } = dayRangeFromISO(isoDate);
    const ordersCol = collection(db, 'orders');

    try {
        const q = query(ordersCol, where('paymentStatus', '==', 'pagado'), where('paidAt', '>=', Timestamp.fromDate(start)), where('paidAt', '<=', Timestamp.fromDate(end)));
        const snap = await getDocs(q);
        if (snap && !snap.empty) return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Consulta por paidAt falló (indices/tipos):', err);
    }

    try {
        const q2 = query(ordersCol, where('paymentStatus', '==', 'pagado'));
        const snap2 = await getDocs(q2);
        const docs = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
        const filtered = docs.filter(doc => {
            const candidates = [doc.paidAt, doc.payment?.paidAt, doc.createdAt, doc.paymentUpdatedAt, doc.updatedAt, doc.payment?.conversionRateDate];
            for (const c of candidates) {
                const dt = toDateFromPossible(c);
                if (dt && dt >= start && dt <= end) return true;
            }
            return false;
        });
        return filtered;
    } catch (err) {
        console.error('Error en fallback:', err);
        return [];
    }
}

async function fetchOrdersForRange(startISO, endISO) {
    const start = new Date(startISO + 'T00:00:00');
    const end = new Date(endISO + 'T23:59:59.999');
    const ordersCol = collection(db, 'orders');

    try {
        const q = query(ordersCol, where('paymentStatus', '==', 'pagado'), where('paidAt', '>=', Timestamp.fromDate(start)), where('paidAt', '<=', Timestamp.fromDate(end)));
        const snap = await getDocs(q);
        if (snap && !snap.empty) return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Range query fallback (indices):', err);
    }

    try {
        const q2 = query(collection(db, 'orders'), where('paymentStatus', '==', 'pagado'));
        const snap2 = await getDocs(q2);
        const docs = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
        return docs.filter(doc => {
            const candidates = [doc.paidAt, doc.payment?.paidAt, doc.createdAt, doc.paymentUpdatedAt, doc.updatedAt, doc.payment?.conversionRateDate];
            for (const c of candidates) {
                const dt = toDateFromPossible(c);
                if (!dt) continue;
                if (dt >= start && dt <= end) return true;
            }
            return false;
        });
    } catch (err) {
        console.error('Error en fetchOrdersForRange fallback:', err);
        return [];
    }
}

async function fetchClosuresInRange(startISO, endISO) {
    try {
        const closuresCol = collection(db, 'cash_closures');
        const q = query(closuresCol, where('dateISO', '>=', startISO), where('dateISO', '<=', endISO));
        const snap = await getDocs(q);
        if (snap && !snap.empty) return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return [];
    } catch (err) {
        console.warn('Error fetching cash_closures for calendar:', err);
        return [];
    }
}

async function checkIfClosed(isoDate) {
    try {
        const closuresCol = collection(db, 'cash_closures');
        const q = query(closuresCol, where('dateISO', '==', isoDate));
        const snap = await getDocs(q);
        if (snap && !snap.empty) {
            const doc = snap.docs[0];
            return { id: doc.id, data: doc.data() };
        }
    } catch (err) {
        console.warn('Error comprobando cash_closures:', err);
    }
    return null;
}

// ---------- Data aggregation & rendering ----------
function buildCascadeData(orders) {
    const sellers = new Map();
    const summary = { totalBs: 0, totalUsd: 0, totalOrders: orders.length, totalsByMethod: {} };

    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';
        const { payments, motorizado } = extractPaymentsFromOrder(order);

        for (const p of payments) {
            if (p.primary === 'bs') summary.totalBs += Number(p.bs || 0);
            else summary.totalUsd += Number(p.usd || 0);

            const key = `${p.key}_${p.primary}`;
            if (!summary.totalsByMethod[key]) summary.totalsByMethod[key] = { bs: 0, usd: 0, rawMethod: p.key };
            if (p.primary === 'bs') summary.totalsByMethod[key].bs += Number(p.bs || 0);
            else summary.totalsByMethod[key].usd += Number(p.usd || 0);
        }

        if (motorizado.bs) summary.totalBs += motorizado.bs;
        if (motorizado.usd) summary.totalUsd += motorizado.usd;

        const sName = String(sellerName);
        const rName = String(riderName);
        if (!sellers.has(sName)) sellers.set(sName, new Map());
        const sellerMap = sellers.get(sName);
        if (!sellerMap.has(rName)) sellerMap.set(rName, []);
        sellerMap.get(rName).push({ id: order.id, order, payments, motorizado });
    }

    return { sellers, summary };
}

function renderKpis(summary) {
    if (!kpiCards) return;
    kpiCards.innerHTML = '';
    const kpis = [
        { label: 'Total Cobrado (Bs)', value: formatCurrencyBs(summary.totalBs) },
        { label: 'Total Cobrado (USD)', value: formatCurrencyUSD(summary.totalUsd) },
        { label: 'Pedidos Procesados', value: summary.totalOrders }
    ];
    for (const k of kpis) {
        const el = document.createElement('div'); el.className = 'kpi';
        el.innerHTML = `<div class="label">${k.label}</div><div class="value">${k.value}</div>`;
        kpiCards.appendChild(el);
    }
}

function renderSummaryCards(summary) {
    if (!summaryCards) return;
    summaryCards.innerHTML = '';
    const entries = Object.entries(summary.totalsByMethod).sort((a, b) => (b[1].bs + b[1].usd) - (a[1].bs + a[1].usd));
    for (const [key, v] of entries) {
        const div = document.createElement('div'); div.className = 'card summary-card';
        const parts = key.split('_');
        const method = (parts[0] || 'otro').toUpperCase();
        const currency = (parts[1] || 'bs').toUpperCase();
        const label = `${method} (${currency})`;
        const value = currency === 'BS' ? formatCurrencyBs(v.bs) : formatCurrencyUSD(v.usd);
        const alt = currency === 'BS' ? formatCurrencyUSD(v.usd) : formatCurrencyBs(v.bs);
        div.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="alt">${alt}</div>`;
        summaryCards.appendChild(div);
    }
    if (entries.length === 0) summaryCards.innerHTML = '<div class="muted">Sin desglose por método</div>';
}

function renderCascade(sellersMap) {
    if (!cascadeContainer) return;
    cascadeContainer.innerHTML = '';
    if (!sellersMap || sellersMap.size === 0) {
        cascadeContainer.innerHTML = '<div class="muted">No hay pedidos para la fecha seleccionada.</div>';
        return;
    }
    for (const [sellerName, riderMap] of sellersMap.entries()) {
        const sv = document.createElement('div'); sv.className = 'vendedor expanded';

        // sellerOrders: array de items { id, order, payments, motorizado }
        const sellerOrders = Array.from(riderMap.values()).flat();

        // Total vendedor (en Bs y USD) sumando pagos BS/USD y motorizado
        const sellerTotalBs = sellerOrders.reduce((acc, item) => {
            return acc + (item.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0) + (item.motorizado?.bs || 0);
        }, 0);
        const sellerTotalUsd = sellerOrders.reduce((acc, item) => {
            return acc + (item.payments || []).reduce((s, p) => s + ((p.primary === 'usd') ? (p.usd || 0) : 0), 0) + (item.motorizado?.usd || 0);
        }, 0);

        // calcular comision total del vendedor (sumando order._sellerCommissionBs/_sellerCommissionUsd)
        const sellerCommissionTotalBs = sellerOrders.reduce((acc, item) => acc + (item.order?._sellerCommissionBs || 0), 0);
        const sellerCommissionTotalUsd = sellerOrders.reduce((acc, item) => acc + (item.order?._sellerCommissionUsd || 0), 0);

        // Obtener tipo/valor más representativo del vendedor (si todos iguales se muestra, si varían se muestra "Varias")
        const sellerTypes = new Set(sellerOrders.map(it => it.order?._sellerCommissionType || 'percent'));
        const sellerValues = new Set(sellerOrders.map(it => it.order?._sellerCommissionValue ?? 0));
        let sellerTypeLabel = '';
        if (sellerTypes.size === 1) {
            const t = Array.from(sellerTypes)[0];
            const v = Array.from(sellerValues)[0];
            sellerTypeLabel = t === 'percent' ? `${v}%` : `Bs ${formatNumberCustom(v, 2)}`;
        } else {
            sellerTypeLabel = 'Varias';
        }

        const sellerCommissionDisplay = `${formatCurrencyBs(sellerCommissionTotalBs)}${sellerCommissionTotalUsd ? ` / ${formatCurrencyUSD(sellerCommissionTotalUsd)}` : ''}`;
        const sellerTotalDisplay = `${formatCurrencyBs(sellerTotalBs)}${sellerTotalUsd ? ` / ${formatCurrencyUSD(sellerTotalUsd)}` : ''}`;

        const header = document.createElement('div'); header.className = 'vh clickable';
        header.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span class="chev">▾</span><div><div class="v-title">👤 Vendedor: ${sellerName}</div><div class="muted">Comisiones / totales mostrados por pedido</div></div></div><div class="badge-total">${sellerTotalDisplay} <span class="small-muted" style="font-weight:500;margin-left:8px">• Tipo: ${sellerTypeLabel} • Comisión: ${sellerCommissionDisplay}</span></div>`;
        sv.appendChild(header);

        const content = document.createElement('div'); content.className = 'v-content';
        for (const [riderName, orders] of riderMap.entries()) {
            const mv = document.createElement('div'); mv.className = 'motorizado';
            const riderTotalBs = orders.reduce((acc, it) => acc + (it.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0) + (it.motorizado?.bs || 0), 0);
            const riderTotalUsd = orders.reduce((acc, it) => acc + (it.payments || []).reduce((s, p) => s + ((p.primary === 'usd') ? (p.usd || 0) : 0), 0) + (it.motorizado?.usd || 0), 0);

            // comision del motorizado (sumando it.order._riderCommissionBs/_riderCommissionUsd)
            const riderCommissionTotalBs = orders.reduce((acc, it) => acc + (it.order?._riderCommissionBs || 0), 0);
            const riderCommissionTotalUsd = orders.reduce((acc, it) => acc + (it.order?._riderCommissionUsd || 0), 0);

            // Obtener tipo/valor representativo motorizado
            const riderTypes = new Set(orders.map(it => it.order?._riderCommissionType || 'percent'));
            const riderValues = new Set(orders.map(it => it.order?._riderCommissionValue ?? 0));
            let riderTypeLabel = '';
            if (riderTypes.size === 1) {
                const t = Array.from(riderTypes)[0];
                const v = Array.from(riderValues)[0];
                riderTypeLabel = t === 'percent' ? `${v}%` : `Bs ${formatNumberCustom(v, 2)}`;
            } else {
                riderTypeLabel = 'Varias';
            }

            const riderCommissionDisplay = `${formatCurrencyBs(riderCommissionTotalBs)}${riderCommissionTotalUsd ? ` / ${formatCurrencyUSD(riderCommissionTotalUsd)}` : ''}`;
            const riderTotalDisplay = `${formatCurrencyBs(riderTotalBs)}${riderTotalUsd ? ` / ${formatCurrencyUSD(riderTotalUsd)}` : ''}`;

            mv.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="font-weight:700">🧑‍💼 Motorizado: ${riderName} • <span class="muted">${orders.length} pedidos</span></div><div class="motorizado-badge">${riderTotalDisplay} <span class="small-muted" style="font-weight:500;margin-left:8px">• Tipo: ${riderTypeLabel} • Comisión: ${riderCommissionDisplay}</span></div></div>`;

            for (const o of orders) {
                const pd = document.createElement('div'); pd.className = 'pedido';
                const order = o.order;

                // Usar getOrderDateInfo para obtener la fecha consistente
                const info = getOrderDateInfo(order);
                const dateStr = info.date ? info.date.toLocaleDateString() : '—';

                const cust = order.customerName || order.clientName || order.buyer || order.recipientName || '';

                const paymentsHtml = (o.payments && o.payments.length) ? o.payments.map(p => {
                    const main = p.primary === 'bs' ? formatCurrencyBs(p.bs) : formatCurrencyUSD(p.usd);
                    const alt = p.primary === 'bs' ? (p.usd ? ` ${formatCurrencyUSD(p.usd)}` : '') : (p.bs ? ` ${formatCurrencyBs(p.bs)}` : '');
                    const cls = p.cls || '';
                    let icon = '💰';
                    if (p.key === 'pago-movil') icon = '📱';
                    if (p.key === 'paypal') icon = '💳';
                    if (p.key === 'zelle') icon = '💳';
                    return `<div class="payment-row"><div class="payment-left"><span class="icon">${icon}</span><span class="payment-label ${cls}">${p.label}</span></div><div class="payment-amount ${cls}"><span class="main">${main}</span><span class="small">${alt.trim()}</span></div></div>`;
                }).join('') : '<div class="muted">Sin detalles de pago</div>';

                const subtotalBs = (o.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0);
                const subtotalUsd = (o.payments || []).reduce((s, p) => s + ((p.primary === 'usd') ? (p.usd || 0) : 0), 0);
                const motHtml = (o.motorizado && ((o.motorizado.bs || 0) > 0 || (o.motorizado.usd || 0) > 0)) ? (() => {
                    if (o.motorizado.bs) return `<div class="motorizado-fee"><div class="motorizado-badge">${formatCurrencyBs(o.motorizado.bs)}</div></div>`;
                    return `<div class="motorizado-fee"><div class="motorizado-badge">${formatCurrencyUSD(o.motorizado.usd)}</div></div>`;
                })() : `<div class="motorizado-fee"><div class="muted" style="font-size:13px"> </div></div>`;

                // Mostrar comisiones por pedido (si existen) y su tipo/valor
                const sellerCommPerOrderBs = order._sellerCommissionBs || 0;
                const sellerCommPerOrderUsd = order._sellerCommissionUsd || 0;
                const sellerCommPerOrderDisplay = sellerCommPerOrderBs || sellerCommPerOrderUsd ? `${formatCurrencyBs(sellerCommPerOrderBs)}${sellerCommPerOrderUsd ? ` / ${formatCurrencyUSD(sellerCommPerOrderUsd)}` : ''}` : '';

                const riderCommPerOrderBs = order._riderCommissionBs || 0;
                const riderCommPerOrderUsd = order._riderCommissionUsd || 0;
                const riderCommPerOrderDisplay = riderCommPerOrderBs || riderCommPerOrderUsd ? `${formatCurrencyBs(riderCommPerOrderBs)}${riderCommPerOrderUsd ? ` / ${formatCurrencyUSD(riderCommPerOrderUsd)}` : ''}` : '';

                let commissionHtml = '';

                pd.innerHTML = `<div class="pedido-header"><div><strong>📄 ${o.id}</strong> — ${cust} <span class="muted">• ${dateStr}</span></div>${motHtml}</div><div class="payments">${paymentsHtml}</div><div class="subtotal-row"><div>Subtotal</div><div>${formatCurrencyBs(subtotalBs)} ${subtotalUsd ? ` / ${formatCurrencyUSD(subtotalUsd)}` : ''}</div></div>${commissionHtml}
                `;
                mv.appendChild(pd);
            }

            content.appendChild(mv);
        }

        sv.appendChild(content);
        cascadeContainer.appendChild(sv);

        header.addEventListener('click', () => {
            const isCollapsed = sv.classList.contains('collapsed');
            if (isCollapsed) {
                sv.classList.remove('collapsed'); sv.classList.add('expanded');
                const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▾';
            } else {
                sv.classList.remove('expanded'); sv.classList.add('collapsed');
                const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▸';
            }
        });
    }
}

// ---------- Filters population ----------
function populateFilterOptions(orders) {
    if (!filterSeller || !filterRider || !filterPayment) return;
    const sellersSet = new Set(), ridersSet = new Set(), paymentsMap = new Map();

    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';
        sellersSet.add(String(sellerName));
        ridersSet.add(String(riderName));
        const { payments, motorizado } = extractPaymentsFromOrder(order);
        for (const p of payments) {
            const pk = p.key;
            if (!paymentsMap.has(pk)) paymentsMap.set(pk, p.label);
        }
        if (motorizado && ((motorizado.bs || 0) > 0 || (motorizado.usd || 0) > 0)) {
            if (!paymentsMap.has('motorizado')) paymentsMap.set('motorizado', 'Pago motorizado');
        }
    }

    const prevSeller = filterSeller.value || 'all';
    const prevRider = filterRider.value || 'all';
    const prevPayment = filterPayment.value || 'all';

    filterSeller.innerHTML = '<option value="all">Todos</option>';
    filterRider.innerHTML = '<option value="all">Todos</option>';
    filterPayment.innerHTML = '<option value="all">Todas</option>';

    Array.from(sellersSet).sort().forEach(s => {
        const opt = document.createElement('option'); opt.value = s; opt.textContent = s;
        filterSeller.appendChild(opt);
    });
    Array.from(ridersSet).sort().forEach(r => {
        const opt = document.createElement('option'); opt.value = r; opt.textContent = r;
        filterRider.appendChild(opt);
    });
    Array.from(paymentsMap.entries()).sort((a, b) => a[1].localeCompare(b[1])).forEach(([k, label]) => {
        const opt = document.createElement('option'); opt.value = k; opt.textContent = label;
        filterPayment.appendChild(opt);
    });

    if ([...filterSeller.options].some(o => o.value === prevSeller)) filterSeller.value = prevSeller;
    if ([...filterRider.options].some(o => o.value === prevRider)) filterRider.value = prevRider;
    if ([...filterPayment.options].some(o => o.value === prevPayment)) filterPayment.value = prevPayment;
}

// ---------- Filters apply ----------
function applyFiltersToLastFetched() {
    if (!lastFetchedOrders || !lastFetchedOrders.length) return;
    let filtered = lastFetchedOrders.slice();
    const selSeller = filterSeller?.value || 'all';
    const selRider = filterRider?.value || 'all';
    const selPayment = filterPayment?.value || 'all';

    filtered = filtered.filter(order => {
        const sellerName = String(order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido');
        const riderName = String(order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar');

        if (selSeller !== 'all' && sellerName !== selSeller) return false;
        if (selRider !== 'all' && riderName !== selRider) return false;

        if (selPayment !== 'all') {
            const { payments, motorizado } = extractPaymentsFromOrder(order);
            if (selPayment === 'motorizado') {
                if (!((motorizado?.bs || 0) > 0 || (motorizado?.usd || 0) > 0)) return false;
            } else {
                const found = (payments || []).some(p => p.key === selPayment);
                if (!found) return false;
            }
        }

        return true;
    });

    const { sellers, summary } = buildCascadeData(filtered);
    renderKpis(summary); renderSummaryCards(summary); renderCascade(sellers);
    if (concBsInput) concBsInput.value = formatNumberCustom(Math.round(summary.totalBs * 100) / 100, 2);
    if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round(summary.totalUsd * 100) / 100, 2);
}

// ---------- Calendar rendering & selection ----------
async function renderCalendar() {
    if (!calGrid || !calMonthName) return;
    const cur = new Date(calState.currentCalendarMonth.getFullYear(), calState.currentCalendarMonth.getMonth(), 1);
    const year = cur.getFullYear(), month = cur.getMonth();
    calMonthName.textContent = cur.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const firstISO = isoFromDate(firstDayOfMonth);
    const lastISO = isoFromDate(lastDayOfMonth);

    const closures = await fetchClosuresInRange(firstISO, lastISO);
    closuresCache = closures;
    const ordersInRange = await fetchOrdersForRange(firstISO, lastISO);

    const closuresMap = new Map();
    for (const c of closures) if (c.dateISO) closuresMap.set(c.dateISO, c);

    const ordersMap = new Map();
    for (const o of ordersInRange) {
        const candidates = [o.paidAt, o.payment?.paidAt, o.createdAt, o.paymentUpdatedAt, o.updatedAt];
        for (const c of candidates) {
            const dt = toDateFromPossible(c);
            if (!dt) continue;
            const iso = isoFromDate(dt);
            if (!ordersMap.has(iso)) ordersMap.set(iso, []);
            ordersMap.get(iso).push(o);
            break;
        }
    }

    calGrid.innerHTML = '';

    const firstWeekday = firstDayOfMonth.getDay(); // 0 sunday
    const offset = firstWeekday === 0 ? 6 : firstWeekday - 1;

    for (let i = 0; i < offset; i++) {
        const empty = document.createElement('div');
        empty.style.minHeight = '96px';
        empty.style.border = '1px solid #f1f3f5';
        empty.style.background = '#fff';
        calGrid.appendChild(empty);
    }

    const todayISO = isoFromDate(new Date());

    for (let day = 1; day <= lastDayOfMonth.getDate(); day++) {
        const dateObj = new Date(year, month, day);
        const iso = isoFromDate(dateObj);
        const closure = closuresMap.get(iso);
        const ordersForDay = ordersMap.get(iso) || [];

        const cell = document.createElement('div');
        cell.className = 'calendar-cell';
        cell.dataset.iso = iso;
        cell.style.minHeight = '96px';
        cell.style.border = '1px solid #f1f3f5';
        cell.style.padding = '10px';
        cell.style.boxSizing = 'border-box';
        cell.style.display = 'flex';
        cell.style.flexDirection = 'column';
        cell.style.justifyContent = 'space-between';
        cell.style.cursor = 'pointer';

        if (closure) cell.classList.add('calendar-closed');
        else if (ordersForDay.length > 0 && iso <= todayISO) cell.classList.add('calendar-pending');
        else cell.classList.add('calendar-empty');

        if (selectedDates.has(iso)) cell.classList.add('calendar-selected');

        const top = document.createElement('div');
        top.style.display = 'flex';
        top.style.justifyContent = 'space-between';
        top.style.alignItems = 'start';

        const dayLabel = document.createElement('span');
        dayLabel.textContent = day;
        dayLabel.style.fontWeight = '700';
        dayLabel.style.color = closure ? '#065f46' : (ordersForDay.length > 0 && iso <= todayISO ? '#7a1c1c' : '#94a3b8');
        top.appendChild(dayLabel);

        if (closure) {
            const icon = document.createElement('span'); icon.innerHTML = '✔'; icon.style.color = '#16a34a'; icon.style.fontSize = '12px';
            top.appendChild(icon);
        } else if (ordersForDay.length > 0 && iso <= todayISO) {
            const icon = document.createElement('span'); icon.innerHTML = '!'; icon.style.color = '#ef4444'; icon.style.fontSize = '12px';
            top.appendChild(icon);
        }

        cell.appendChild(top);

        if (closure) {
            const content = document.createElement('div');
            content.innerHTML = `<div style="margin-top:8px"><div style="font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase">Cierre</div><div style="margin-top:6px;font-weight:800;color:#0f172a">${formatCurrencyBs(closure.totals?.bs ?? 0)} ${closure.totals?.usd ? ` / ${formatCurrencyUSD(closure.totals.usd)}` : ''}</div></div>`;
            cell.appendChild(content);
        } else if (ordersForDay.length > 0) {
            const content = document.createElement('div');
            content.innerHTML = `<div style="margin-top:8px"><div style="font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase">${ordersForDay.length} pedidos</div></div>`;
            cell.appendChild(content);
        } else {
            const placeholder = document.createElement('div'); placeholder.style.height = '20px'; cell.appendChild(placeholder);
        }

        cell.addEventListener('click', () => {
            const isoDay = cell.dataset.iso;
            if (selectedDates.has(isoDay)) { selectedDates.delete(isoDay); cell.classList.remove('calendar-selected'); }
            else { selectedDates.add(isoDay); cell.classList.add('calendar-selected'); }
        });

        cell.addEventListener('dblclick', async () => {
            selectedDates.clear(); selectedDates.add(iso);
            await applySelectionAndGoToResumen();
        });

        calGrid.appendChild(cell);
    }
}

// ---------- selection utils ----------
function clearSelection() {
    selectedDates.clear();
    $$('.calendar-cell.calendar-selected').forEach(el => el.classList.remove('calendar-selected'));
}

function selectMonth() {
    clearSelection();
    const cur = calState.currentCalendarMonth;
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const last = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) selectedDates.add(isoFromDate(new Date(d)));
    $$('.calendar-cell').forEach(el => {
        if (selectedDates.has(el.dataset.iso)) el.classList.add('calendar-selected'); else el.classList.remove('calendar-selected');
    });
}

function selectWeekOfAnySelected() {
    if (selectedDates.size === 0) {
        const isoToday = isoFromDate(new Date());
        if ($(`[data-iso="${isoToday}"]`)) selectedDates.add(isoToday);
        else {
            const firstCell = document.querySelector('.calendar-cell');
            if (firstCell && firstCell.dataset.iso) selectedDates.add(firstCell.dataset.iso);
        }
    }
    const firstIso = Array.from(selectedDates).sort()[0];
    const dt = new Date(firstIso + 'T00:00:00');
    const weekday = dt.getDay();
    const offset = weekday === 0 ? -6 : 1 - weekday;
    const monday = new Date(dt); monday.setDate(dt.getDate() + offset);
    clearSelection();
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        selectedDates.add(isoFromDate(d));
    }
    $$('.calendar-cell').forEach(el => {
        if (selectedDates.has(el.dataset.iso)) el.classList.add('calendar-selected'); else el.classList.remove('calendar-selected');
    });
}

async function applySelectionAndGoToResumen() {
    if (selectedDates.size === 0) {
        await calculateAndRenderForSelected(null);
    } else {
        await calculateAndRenderForSelected(selectedDates);
    }
    switchTab('resumen');
}

// ---------- closure banner in Resumen ----------
function renderClosureBanner(closuresForRange, datesArray) {
    const existing = document.getElementById('closure-banner');
    if (existing) existing.remove();

    const closedDates = new Map();
    for (const c of closuresForRange) if (c.dateISO) closedDates.set(c.dateISO, c);

    const banner = document.createElement('div');
    banner.id = 'closure-banner';
    banner.className = 'card';
    banner.style.marginBottom = '12px';
    banner.style.padding = '12px 16px';
    banner.style.display = 'flex';
    banner.style.justifyContent = 'space-between';
    banner.style.alignItems = 'center';
    banner.style.gap = '12px';

    if (!datesArray || datesArray.length === 0) {
        const todayISO = isoFromDate(new Date());
        if (closedDates.has(todayISO)) {
            const closure = closedDates.get(todayISO);
            banner.innerHTML = `<div><strong>La caja del día ${formatDateDisplay(new Date(todayISO + 'T00:00:00'))} ya fue cerrada</strong><div class="muted">Totales guardados: ${formatCurrencyBs(closure.totals?.bs ?? 0)} ${closure.totals?.usd ? ` / ${formatCurrencyUSD(closure.totals.usd)}` : ''}</div></div>`;
            if (conciliationSection) conciliationSection.style.display = 'none';
            if (btnCloseCash) btnCloseCash.style.display = 'none';
        } else {
            if (conciliationSection) conciliationSection.style.display = '';
            if (btnCloseCash) btnCloseCash.style.display = '';
            return;
        }
    } else {
        const closedList = [];
        for (const d of datesArray) {
            if (closedDates.has(d)) closedList.push({ date: d, closure: closedDates.get(d) });
        }
        if (closedList.length === 0) {
            if (conciliationSection) conciliationSection.style.display = '';
            if (btnCloseCash) btnCloseCash.style.display = '';
            return;
        }
        const closedDatesStr = closedList.map(c => `${new Date(c.date + 'T00:00:00').toLocaleDateString('es-ES')}`).join(', ');
        const totalsSummary = closedList.map(c => `${new Date(c.date + 'T00:00:00').toLocaleDateString('es-ES')}: ${formatCurrencyBs(c.closure.totals?.bs ?? 0)}`).join(' • ');
        banner.innerHTML = `<div><strong>La(s) caja(s) de las siguientes fecha(s) ya fueron cerradas:</strong><div class="muted" style="margin-top:6px">${closedDatesStr}</div><div style="margin-top:6px;font-weight:700">${totalsSummary}</div></div>`;
        const allClosed = closedList.length === datesArray.length;
        if (allClosed) {
            if (conciliationSection) conciliationSection.style.display = 'none';
            if (btnCloseCash) btnCloseCash.style.display = 'none';
        } else {
            if (conciliationSection) conciliationSection.style.display = '';
            if (btnCloseCash) btnCloseCash.style.display = '';
        }
    }

    if (cascadeContainer) cascadeContainer.parentNode.insertBefore(banner, cascadeContainer);
}

// ---------- main calculate function for selected dates (or today) ----------
async function calculateAndRenderForSelected(datesSet = null) {
    let datesArray;
    if (!datesSet || datesSet.size === 0) {
        const todayISO = isoFromDate(new Date());
        datesArray = [todayISO];
    } else {
        datesArray = Array.from(datesSet).sort();
    }

    const start = datesArray[0], end = datesArray[datesArray.length - 1];
    if (!start || !end) return;

    try {
        const closures = await fetchClosuresInRange(start, end);
        const orders = await fetchOrdersForRange(start, end);

        const keep = orders.filter(order => {
            const info = getOrderDateInfo(order);
            if (!info.date) return false;
            const iso = isoFromDate(info.date);
            return datesArray.includes(iso);
        });

        lastFetchedOrders = keep.slice();
        await attachCommissionsToOrders(lastFetchedOrders);

        populateFilterOptions(keep);
        const { sellers, summary } = buildCascadeData(keep);
        renderKpis(summary);
        renderSummaryCards(summary);
        renderCascade(sellers);
        if (concBsInput) concBsInput.value = formatNumberCustom(Math.round(summary.totalBs * 100) / 100, 2);
        if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round(summary.totalUsd * 100) / 100, 2);

        const orderDateSet = new Set();
        for (const o of keep) {
            const info = getOrderDateInfo(o);
            if (info.date) orderDateSet.add(isoFromDate(info.date));
        }
        const orderDates = Array.from(orderDateSet).sort();

        if (orderDates.length === 1) {
            if (displayDate) displayDate.textContent = formatDateDisplay(new Date(orderDates[0] + 'T00:00:00'));
            if (displayDatePill) displayDatePill.textContent = orderDates[0].split('-').reverse().join('/');
        } else if (orderDates.length > 1) {
            const first = new Date(orderDates[0] + 'T00:00:00'), last = new Date(orderDates[orderDates.length - 1] + 'T00:00:00');
            if (displayDate) displayDate.textContent = `${formatDateDisplay(first)} — ${formatDateDisplay(last)} (${orderDates.length} días)`;
            if (displayDatePill) displayDatePill.textContent = `${orderDates[0].split('-').reverse().join('/')} — ${orderDates[orderDates.length - 1].split('-').reverse().join('/')}`;
        } else {
            if (datesArray.length === 1) {
                if (displayDate) displayDate.textContent = formatDateDisplay(new Date(datesArray[0] + 'T00:00:00'));
                if (displayDatePill) displayDatePill.textContent = datesArray[0].split('-').reverse().join('/');
            } else {
                const first = new Date(datesArray[0] + 'T00:00:00'), last = new Date(datesArray[datesArray.length - 1] + 'T00:00:00');
                if (displayDate) displayDate.textContent = `${formatDateDisplay(first)} — ${formatDateDisplay(last)} (${datesArray.length} días)`;
                if (displayDatePill) displayDatePill.textContent = `${datesArray[0].split('-').reverse().join('/')} — ${datesArray[datesArray.length - 1].split('-').reverse().join('/')}`;
            }
        }

        renderClosureBanner(closures, datesArray);

        try {
            console.log('Pedidos retenidos y fecha usada por cada uno:', keep.map(o => {
                const info = getOrderDateInfo(o);
                return { id: o.id, dateISO: info.date ? isoFromDate(info.date) : null, field: info.field, sellerComm: o._sellerCommissionBs, riderComm: o._riderCommissionBs, sellerType: o._sellerCommissionType, riderType: o._riderCommissionType, sellerCommUsd: o._sellerCommissionUsd, riderCommUsd: o._riderCommissionUsd };
            }));
        } catch (e) { /* ignore */ }

        return { orders: keep, summary, closures };
    } catch (err) {
        console.error('Error calculando cierre multi-fecha:', err);
        showToast('Error cargando datos. Revisa la consola.', { type: 'error', duration: 5000 });
        if (cascadeContainer) cascadeContainer.innerHTML = '<div class="muted">Error al cargar datos.</div>';
        return null;
    }
}

// ---------- Save closure (per day) ----------
async function saveCashClosure(summary, isoDate) {
    const closuresCol = collection(db, 'cash_closures');
    const payload = {
        dateISO: isoDate,
        dateLabel: formatDateDisplay(new Date(isoDate + 'T00:00:00')),
        totals: { bs: summary.totalBs ?? 0, usd: summary.totalUsd ?? 0, totalsByMethod: summary.totalsByMethod || {} },
        createdAt: serverTimestamp(),
        createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null,
        conciliacion: { bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0) }
    };
    const docRef = await addDoc(closuresCol, payload);
    return docRef.id;
}

// ---------- Save conciliacion (improved toast) ----------
$('#btn-save-conciliation')?.addEventListener('click', async () => {
    const iso = selectedDates.size ? Array.from(selectedDates).sort()[0] : isoFromDate(new Date());
    try {
        const coll = collection(db, 'cash_conciliations');
        const docRef = await addDoc(coll, { dateISO: iso, bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0), createdAt: serverTimestamp(), createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null });
        showToast('Conciliación guardada correctamente', { type: 'success', duration: 3500 });
        await calculateAndRenderForSelected(selectedDates.size ? selectedDates : null);
    } catch (err) {
        console.error(err);
        showToast('Error guardando conciliación', { type: 'error', duration: 5000 });
    }
});

// ---------- Close cash (per selected dates) ----------
$('#btn-close-cash')?.addEventListener('click', async () => {
    const toClose = selectedDates.size ? Array.from(selectedDates).sort() : [isoFromDate(new Date())];
    try {
        const closures = await fetchClosuresInRange(toClose[0], toClose[toClose.length - 1]);
        const closedSet = new Set(closures.map(c => c.dateISO));
        for (const d of toClose) {
            if (closedSet.has(d)) {
                showToast(`La fecha ${new Date(d + 'T00:00:00').toLocaleDateString('es-ES')} ya tiene cierre`, { type: 'info', duration: 4000 });
                return;
            }
        }

        const result = await calculateAndRenderForSelected(selectedDates.size ? selectedDates : null);
        if (!result) return;

        if (!confirm(`Deseas cerrar la(s) fecha(s) seleccionada(s)? Se guardará en cash_closures.`)) return;

        const closuresSaved = [];
        for (const d of toClose) {
            const payload = {
                dateISO: d,
                dateLabel: formatDateDisplay(new Date(d + 'T00:00:00')),
                totals: { bs: result.summary.totalBs ?? 0, usd: result.summary.totalUsd ?? 0, totalsByMethod: result.summary.totalsByMethod || {} },
                createdAt: serverTimestamp(),
                createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null,
                conciliacion: { bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0) }
            };
            const docRef = await addDoc(collection(db, 'cash_closures'), payload);
            closuresSaved.push({ id: docRef.id, date: d });
        }

        const firstId = closuresSaved.length ? closuresSaved[0].id : '';
        showToast(`Caja cerrada (${closuresSaved.length} registro(s)). ID: ${firstId}`, { type: 'success', duration: 5000 });

        await calculateAndRenderForSelected(selectedDates.size ? selectedDates : null);
    } catch (err) {
        console.error(err);
        showToast('Error guardando cierre de caja', { type: 'error', duration: 5000 });
    }
});

// ---------- Listeners: tabs, calendar controls, filters ----------
function switchTab(tab) {
    if (tab === 'resumen') {
        tabResumenBtn.classList.add('active'); tabResumenBtn.setAttribute('aria-pressed', 'true');
        tabCalendarioBtn.classList.remove('active'); tabCalendarioBtn.setAttribute('aria-pressed', 'false');
        if (contentResumen) contentResumen.classList.remove('hidden');
        if (contentCalendario) contentCalendario.classList.add('hidden');
    } else {
        tabCalendarioBtn.classList.add('active'); tabCalendarioBtn.setAttribute('aria-pressed', 'true');
        tabResumenBtn.classList.remove('active'); tabResumenBtn.setAttribute('aria-pressed', 'false');
        if (contentCalendario) contentCalendario.classList.remove('hidden');
        if (contentResumen) contentResumen.classList.add('hidden');
        renderCalendar();
    }
}

tabResumenBtn?.addEventListener('click', () => switchTab('resumen'));
tabCalendarioBtn?.addEventListener('click', () => switchTab('calendario'));

calPrev?.addEventListener('click', () => { calState.currentCalendarMonth.setMonth(calState.currentCalendarMonth.getMonth() - 1); renderCalendar(); });
calNext?.addEventListener('click', () => { calState.currentCalendarMonth.setMonth(calState.currentCalendarMonth.getMonth() + 1); renderCalendar(); });
calToday?.addEventListener('click', () => { calState.currentCalendarMonth = new Date(); renderCalendar(); });

selectMonthBtn?.addEventListener('click', () => selectMonth());
selectWeekBtn?.addEventListener('click', () => selectWeekOfAnySelected());
clearSelectionBtn?.addEventListener('click', () => clearSelection());
applySelectionBtn?.addEventListener('click', () => applySelectionAndGoToResumen());

$('#btn-calc')?.addEventListener('click', async () => {
    clearSelection();
    await calculateAndRenderForSelected(null);
    switchTab('resumen');
});

$('#btn-apply')?.addEventListener('click', () => calculateAndRenderForSelected(selectedDates.size ? selectedDates : null));
btnApplyFilters?.addEventListener('click', () => applyFiltersToLastFetched());
btnResetFilters?.addEventListener('click', () => {
    if (filterSeller) { filterSeller.value = 'all'; filterSeller.disabled = false; }
    if (filterRider) { filterRider.value = 'all'; filterRider.disabled = false; }
    if (filterPayment) { filterPayment.value = 'all'; filterPayment.disabled = false; }
    if (lastFetchedOrders && lastFetchedOrders.length) populateFilterOptions(lastFetchedOrders);
    applyFiltersToLastFetched();
});

if (filterSeller) { filterSeller.addEventListener('change', () => applyFiltersToLastFetched()); filterSeller.addEventListener('input', () => applyFiltersToLastFetched()); }
if (filterRider) { filterRider.addEventListener('change', () => applyFiltersToLastFetched()); filterRider.addEventListener('input', () => applyFiltersToLastFetched()); }
if (filterPayment) { filterPayment.addEventListener('change', () => applyFiltersToLastFetched()); filterPayment.addEventListener('input', () => applyFiltersToLastFetched()); }

// Conciliation input handling
function formatInputValueForDisplay(el, decimals = 2) {
    if (!el) return;
    const raw = el.value;
    const n = parseFormattedNumber(raw);
    el.value = formatNumberCustom(n, decimals);
}
function sanitizeInputKey(e) {
    const allowed = ['Backspace', 'ArrowLeft', 'ArrowRight', 'Delete', 'Tab'];
    if (allowed.includes(e.key)) return;
    if (!/^[0-9\.,\-]$/.test(e.key)) e.preventDefault();
}
if (concBsInput) { concBsInput.addEventListener('keydown', sanitizeInputKey); concBsInput.addEventListener('input', () => formatInputValueForDisplay(concBsInput, 2)); concBsInput.addEventListener('blur', () => formatInputValueForDisplay(concBsInput, 2)); }
if (concUsdInput) { concUsdInput.addEventListener('keydown', sanitizeInputKey); concUsdInput.addEventListener('input', () => formatInputValueForDisplay(concUsdInput, 2)); concUsdInput.addEventListener('blur', () => formatInputValueForDisplay(concUsdInput, 2)); }

// ---------- Auth & init ----------
onAuthStateChanged(auth, (u) => currentUser = u);

(async function init() {
    // Show today's data by default
    const t = new Date();
    if (displayDate) displayDate.textContent = formatDateDisplay(t);
    if (displayDatePill) displayDatePill.textContent = isoFromDate(t).split('-').reverse().join('/');
    await calculateAndRenderForSelected(null);
    switchTab('resumen');
})();
