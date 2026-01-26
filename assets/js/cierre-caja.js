// cierre-caja.js — Version con calendario seleccionable y Resumen fijo a "hoy" por defecto
// - Resumen muestra hoy por defecto (sin input de fecha que el usuario pueda cambiar).
// - Calendario pinta: verde = cierre realizado, rojo = pendiente (hay pedidos pero sin cierre).
// - Permite seleccionar 1 o varios días, semana o mes, y aplicar selección para regresar a Resumen.
// - Reusa las funciones Firestore ya existentes; añade fetch por rango y lógica de selección.

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

// DOM helpers
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const toast = (m, t = 3000) => {
    const el = $('#toast');
    if (!el) return alert(m);
    el.textContent = m; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', t);
};

// Formatting helpers (kept from original)
function formatNumberCustom(value, decimals = 2) {
    if (value == null || isNaN(Number(value))) value = 0;
    const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    return new Intl.NumberFormat('en-US', opts).format(Number(value));
}
function formatCurrencyBs(v) {
    if (v == null) v = 0;
    const hasDecimals = Math.abs(Number(v) - Math.trunc(Number(v))) > 0;
    const decimals = hasDecimals ? 2 : 0;
    return `Bs ${formatNumberCustom(Number(v), decimals)}`;
}
function formatCurrencyUSD(v) { return `$ ${formatNumberCustom(Number(v), 2)}`; }
function formatDateDisplay(d) { try { return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return String(d); } }
function isoFromDate(d) { return d.toISOString().slice(0, 10); }
function parseFormattedNumber(str) {
    if (!str && str !== 0) return 0;
    if (typeof str === 'number') return str;
    const s = String(str).replace(/[^\d\.\-\,]/g, '');
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    let normalized = s;
    if (commas > 0 && dots === 0) normalized = s.replace(/,/g, '');
    else if (commas > 0 && dots > 0) normalized = s.replace(/,/g, '');
    const n = parseFloat(normalized);
    return isNaN(n) ? 0 : n;
}

// date normalization helpers (kept)
function toDateFromPossible(value) {
    if (!value) return null;
    if (typeof value === 'object' && typeof value.toDate === 'function') { try { return value.toDate(); } catch { } }
    if (typeof value === 'object' && (value.seconds || value._seconds)) {
        const s = value.seconds ?? value._seconds; return new Date(s * 1000);
    }
    if (typeof value === 'number') return value > 1e12 ? new Date(value) : new Date(value * 1000);
    if (typeof value === 'string') { const d = new Date(value); return isNaN(d) ? null : d; }
    if (value instanceof Date) return value;
    return null;
}

// payment normalization (kept from your code)
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
    let key = 'other'; let label = raw.method || raw.type || raw.currency || 'Otro'; let cls = '';
    if ((currency.includes('bs') && method.includes('cash')) || method.includes('efectivo') || (primary === 'bs' && method.includes('cash'))) {
        key = 'efectivo'; label = 'Efectivo'; cls = 'payment-efectivo';
    } else if ((currency.includes('usd') && method.includes('usd')) || method === 'usd' || method.includes('usd') || method.includes('dolar')) {
        key = 'efectivo-usd'; label = 'Efectivo (USD)'; cls = 'payment-usd';
    } else if (method.includes('mobile') || method.includes('pago movil') || method.includes('pago-movil') || method.includes('pago')) {
        key = 'pago-movil'; label = 'Pago Móvil'; cls = 'payment-movil';
    } else if (method.includes('paypal')) { key = 'paypal'; label = 'PayPal'; cls = 'payment-paypal'; }
    else if (method.includes('zelle')) { key = 'zelle'; label = 'Zelle'; cls = 'payment-paypal'; }
    else if (method.includes('card') || method.includes('tarjeta')) { key = 'card'; label = 'Tarjeta'; cls = ''; }
    else if (method.includes('motorizad') || /rider|delivery|motorizado/.test(method) || /motorizad/i.test(label)) { key = 'motorizado'; label = 'Pago motorizado'; cls = ''; }
    else { if (primary === 'usd') { key = 'efectivo-usd'; label = 'Efectivo (USD)'; cls = 'payment-usd'; } else { key = 'efectivo'; label = 'Efectivo'; cls = 'payment-efectivo'; } }
    return { key, label, cls, primary };
}
function extractPaymentsFromOrder(orderDoc) {
    const rawPayments = [];
    const p = orderDoc.payment || orderDoc.payments || {};
    if (Array.isArray(p.methods) && p.methods.length) rawPayments.push(...p.methods);
    else if (Array.isArray(orderDoc.methods) && orderDoc.methods.length) rawPayments.push(...orderDoc.methods);
    else if (Array.isArray(p) && p.length) rawPayments.push(...p);
    else rawPayments.push(Object.assign({}, p || {}, { amount: orderDoc.total || 0, currency: orderDoc.currency || '', method: orderDoc.paymentMethod || '' }));
    const map = new Map();
    let motorizadoAmountBs = 0, motorizadoAmountUsd = 0;
    for (const m of rawPayments) {
        const bs = Number(m.bsAmount ?? m.originalAmount ?? m.amount ?? m.totalBs ?? 0);
        const usd = Number(m.usdAmount ?? m.usdEquivalent ?? m.usdEquivalentAmount ?? m.totalUsd ?? 0);
        const norm = normalizePaymentMethod(m);
        const primary = determinePrimaryCurrency(m);
        const mapKey = `${norm.key}::${primary}`;
        const methodLower = String((m.method || m.type || '').toLowerCase());
        if (methodLower.includes('motoriz') || methodLower.includes('rider') || methodLower.includes('delivery') || String(m.label || '').toLowerCase().includes('motoriz')) {
            if (primary === 'bs') motorizadoAmountBs += bs; else motorizadoAmountUsd += usd;
            continue;
        }
        if (!map.has(mapKey)) map.set(mapKey, { key: norm.key, label: norm.label, cls: norm.cls, primary, bs: 0, usd: 0 });
        const entry = map.get(mapKey);
        if (primary === 'bs') entry.bs += bs; else entry.usd += usd;
    }
    const payments = Array.from(map.values());
    return { payments, motorizado: { bs: motorizadoAmountBs, usd: motorizadoAmountUsd } };
}

// DOM refs
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
let lastFetchedOrders = []; // keep last fetched orders (for filters)
let closuresCache = []; // cache closures fetched per month

// Calendar selection state
const selectedDates = new Set();

// Calendar internal state
const calState = { currentCalendarMonth: new Date() };

// Helper: set default UI date (today) — Resumen will show today by default
function setDefaultDateDisplay() {
    const t = new Date();
    if (displayDate) displayDate.textContent = formatDateDisplay(t);
    if (displayDatePill) displayDatePill.textContent = isoFromDate(t).split('-').reverse().join('/');
}

// Firestore helpers: fetch orders for a date (existing function logic adapted to be reusable)
function dayRangeFromISO(isoDate) {
    const start = new Date(isoDate + 'T00:00:00');
    const end = new Date(isoDate + 'T23:59:59.999');
    return { start, end };
}
async function fetchOrdersForDate(isoDate) {
    // same original implementation
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

// New: fetch orders for a date range (inclusive). Uses optimized query when possible; fallback to fetch all paid and filter by date.
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
    // fallback: fetch all paid orders (may be heavy) and filter
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

// Fetch closures in a given ISO range (by dateISO)
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

// existing checkIfClosed (kept)
async function checkIfClosed(isoDate) {
    try {
        const closuresCol = collection(db, 'cash_closures');
        const q = query(closuresCol, where('dateISO', '==', isoDate));
        const snap = await getDocs(q);
        if (snap && !snap.empty) { const doc = snap.docs[0]; return { id: doc.id, data: doc.data() }; }
    } catch (err) { console.warn('Error comprobando cash_closures:', err); }
    return null;
}

// Build cascade data (kept)
function buildCascadeData(orders) {
    const sellers = new Map();
    const summary = { totalBs: 0, totalUsd: 0, totalOrders: orders.length, totalsByMethod: {} };
    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';
        const { payments, motorizado } = extractPaymentsFromOrder(order);
        for (const p of payments) {
            if (p.primary === 'bs') summary.totalBs += Number(p.bs || 0); else summary.totalUsd += Number(p.usd || 0);
            const key = `${p.key}_${p.primary}`;
            if (!summary.totalsByMethod[key]) summary.totalsByMethod[key] = { bs: 0, usd: 0, rawMethod: p.key };
            if (p.primary === 'bs') summary.totalsByMethod[key].bs += Number(p.bs || 0); else summary.totalsByMethod[key].usd += Number(p.usd || 0);
        }
        if (motorizado.bs) summary.totalBs += motorizado.bs;
        if (motorizado.usd) summary.totalUsd += motorizado.usd;
        const sName = String(sellerName), rName = String(riderName);
        if (!sellers.has(sName)) sellers.set(sName, new Map());
        const sellerMap = sellers.get(sName);
        if (!sellerMap.has(rName)) sellerMap.set(rName, []);
        sellerMap.get(rName).push({ id: order.id, order, payments, motorizado });
    }
    return { sellers, summary };
}

// Render functions (KPIs, summary cards, cascade) — kept from previous implementation
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
        const sellerTotal = Array.from(riderMap.values()).flat().reduce((acc, item) => {
            return acc + (item.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0) + (item.motorizado?.bs || 0);
        }, 0);
        const header = document.createElement('div');
        header.className = 'vh clickable';
        header.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span class="chev">▾</span><div><div class="v-title">👤 Vendedor: ${sellerName}</div><div class="muted">Comisiones / totales mostrados por pedido</div></div></div><div class="badge-total">${formatCurrencyBs(sellerTotal)}</div>`;
        sv.appendChild(header);

        const content = document.createElement('div'); content.className = 'v-content';
        for (const [riderName, orders] of riderMap.entries()) {
            const mv = document.createElement('div'); mv.className = 'motorizado';
            const riderTotal = orders.reduce((acc, it) => acc + (it.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0) + (it.motorizado?.bs || 0), 0);
            mv.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="font-weight:700">🧑‍💼 Motorizado: ${riderName} • <span class="muted">${orders.length} pedidos</span></div><div class="motorizado-badge">${formatCurrencyBs(riderTotal)}</div></div>`;
            for (const o of orders) {
                const pd = document.createElement('div'); pd.className = 'pedido';
                const order = o.order;
                const dtCandidates = [order.paidAt, order.payment?.paidAt, order.createdAt, order.paymentUpdatedAt, order.updatedAt];
                let paidAt = null;
                for (const r of dtCandidates) { const dt = toDateFromPossible(r); if (dt) { paidAt = dt; break; } }
                const dateStr = paidAt ? paidAt.toLocaleDateString() : '—';
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
                })() : `<div class="motorizado-fee"><div class="muted" style="font-size:13px"></div></div>`;

                pd.innerHTML = `<div class="pedido-header"><div><strong>📄 ${o.id}</strong> — ${cust} <span class="muted">• ${dateStr}</span></div>${motHtml}</div><div class="payments">${paymentsHtml}</div><div class="subtotal-row"><div>Subtotal</div><div>${formatCurrencyBs(subtotalBs)} ${subtotalUsd ? ` / ${formatCurrencyUSD(subtotalUsd)}` : ''}</div></div>`;
                mv.appendChild(pd);
            }
            content.appendChild(mv);
        }

        sv.appendChild(content);
        cascadeContainer.appendChild(sv);

        header.addEventListener('click', () => {
            const isCollapsed = sv.classList.contains('collapsed');
            if (isCollapsed) { sv.classList.remove('collapsed'); sv.classList.add('expanded'); const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▾'; }
            else { sv.classList.remove('expanded'); sv.classList.add('collapsed'); const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▸'; }
        });
    }
}

// Filters population (kept)
function populateFilterOptions(orders) {
    if (!filterSeller || !filterRider || !filterPayment) return;
    const sellersSet = new Set(), ridersSet = new Set(), paymentsMap = new Map();
    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';
        sellersSet.add(String(sellerName)); ridersSet.add(String(riderName));
        const { payments, motorizado } = extractPaymentsFromOrder(order);
        for (const p of payments) { const pk = p.key; if (!paymentsMap.has(pk)) paymentsMap.set(pk, p.label); }
        if (motorizado && ((motorizado.bs || 0) > 0 || (motorizado.usd || 0) > 0)) { if (!paymentsMap.has('motorizado')) paymentsMap.set('motorizado', 'Pago motorizado'); }
    }
    const prevSeller = filterSeller.value || 'all', prevRider = filterRider.value || 'all', prevPayment = filterPayment.value || 'all';
    filterSeller.innerHTML = '<option value="all">Todos</option>';
    filterRider.innerHTML = '<option value="all">Todos</option>';
    filterPayment.innerHTML = '<option value="all">Todas</option>';
    Array.from(sellersSet).sort().forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; filterSeller.appendChild(opt); });
    Array.from(ridersSet).sort().forEach(r => { const opt = document.createElement('option'); opt.value = r; opt.textContent = r; filterRider.appendChild(opt); });
    Array.from(paymentsMap.entries()).sort((a, b) => a[1].localeCompare(b[1])).forEach(([k, label]) => { const opt = document.createElement('option'); opt.value = k; opt.textContent = label; filterPayment.appendChild(opt); });
    if ([...filterSeller.options].some(o => o.value === prevSeller)) filterSeller.value = prevSeller;
    if ([...filterRider.options].some(o => o.value === prevRider)) filterRider.value = prevRider;
    if ([...filterPayment.options].some(o => o.value === prevPayment)) filterPayment.value = prevPayment;
}

// Apply filters (kept)
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

// Calculate and render for a set of ISO dates (selectedDates) or for today if no selection
async function calculateAndRenderForSelected(datesSet = null) {
    // if datesSet is null => show today's date only
    let datesArray;
    if (!datesSet || datesSet.size === 0) {
        const todayISO = isoFromDate(new Date());
        datesArray = [todayISO];
    } else {
        datesArray = Array.from(datesSet).sort();
    }

    // update pill to show single date or range / count
    if (displayDate) {
        if (datesArray.length === 1) displayDate.textContent = formatDateDisplay(new Date(datesArray[0]));
        else {
            const first = new Date(datesArray[0]); const last = new Date(datesArray[datesArray.length - 1]);
            displayDate.textContent = `${formatDateDisplay(first)} — ${formatDateDisplay(last)} (${datesArray.length} días)`;
        }
    }
    if (displayDatePill) {
        if (datesArray.length === 1) displayDatePill.textContent = datesArray[0].split('-').reverse().join('/');
        else displayDatePill.textContent = `${datesArray[0].split('-').reverse().join('/')} — ${datesArray[datesArray.length-1].split('-').reverse().join('/')}`;
    }

    // Fetch orders for the whole span to minimize queries, then filter per day
    const start = datesArray[0], end = datesArray[datesArray.length - 1];
    if (!start || !end) return;
    try {
        // fetch range
        const orders = await fetchOrdersForRange(start, end);
        // filter to only dates in set (match paidAt or other date candidates)
        const keep = orders.filter(order => {
            const candidates = [order.paidAt, order.payment?.paidAt, order.createdAt, order.paymentUpdatedAt, order.updatedAt];
            for (const c of candidates) {
                const dt = toDateFromPossible(c);
                if (!dt) continue;
                const iso = isoFromDate(dt);
                if (datesArray.includes(iso)) return true;
            }
            return false;
        });
        lastFetchedOrders = keep.slice();
        // populate filters based on keep (if filters visible)
        populateFilterOptions(keep);
        const { sellers, summary } = buildCascadeData(keep);
        renderKpis(summary); renderSummaryCards(summary); renderCascade(sellers);
        if (concBsInput) concBsInput.value = formatNumberCustom(Math.round(summary.totalBs * 100) / 100, 2);
        if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round(summary.totalUsd * 100) / 100, 2);
        return { orders: keep, summary };
    } catch (err) {
        console.error('Error calculando cierre multi-fecha:', err);
        toast('Error cargando datos. Revisa la consola.');
        if (cascadeContainer) cascadeContainer.innerHTML = '<div class="muted">Error al cargar datos.</div>';
        return null;
    }
}

// Tab switching
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
        renderCalendar(); // refresh calendar when opening
    }
}

// Calendar rendering with closures & orders (to mark pending days)
async function renderCalendar() {
    if (!calGrid || !calMonthName) return;
    const cur = new Date(calState.currentCalendarMonth.getFullYear(), calState.currentCalendarMonth.getMonth(), 1);
    const year = cur.getFullYear(), month = cur.getMonth();
    calMonthName.textContent = cur.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const firstISO = isoFromDate(firstDayOfMonth);
    const lastISO = isoFromDate(lastDayOfMonth);

    // fetch closures for month and orders for month (to detect pending)
    const closures = await fetchClosuresInRange(firstISO, lastISO);
    closuresCache = closures; // cache
    const ordersInRange = await fetchOrdersForRange(firstISO, lastISO);

    // map closures by dateISO
    const closuresMap = new Map();
    for (const c of closures) if (c.dateISO) closuresMap.set(c.dateISO, c);

    // map orders count by ISO day
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

    const firstWeekday = firstDayOfMonth.getDay(); // 0 sun
    const offset = firstWeekday === 0 ? 6 : firstWeekday - 1;

    // pad empties
    for (let i = 0; i < offset; i++) {
        const empty = document.createElement('div');
        empty.style.minHeight = '96px'; empty.style.border = '1px solid #f1f3f5'; empty.style.background = '#fff';
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

        // base state classes
        if (closure) cell.classList.add('calendar-closed'); // green
        else if (ordersForDay.length > 0 && iso <= todayISO) cell.classList.add('calendar-pending'); // red
        else cell.classList.add('calendar-empty');

        // selected?
        if (selectedDates.has(iso)) cell.classList.add('calendar-selected');

        const top = document.createElement('div');
        top.style.display = 'flex'; top.style.justifyContent = 'space-between'; top.style.alignItems = 'start';

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

        // click toggles selection
        cell.addEventListener('click', (e) => {
            const isoDay = cell.dataset.iso;
            if (selectedDates.has(isoDay)) { selectedDates.delete(isoDay); cell.classList.remove('calendar-selected'); }
            else { selectedDates.add(isoDay); cell.classList.add('calendar-selected'); }
        });

        // double click: quick select day and apply
        cell.addEventListener('dblclick', async () => {
            selectedDates.clear(); selectedDates.add(iso);
            await applySelectionAndGoToResumen();
        });

        calGrid.appendChild(cell);
    }
}

// Selection utilities
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
    // update UI
    $$('.calendar-cell').forEach(el => {
        if (selectedDates.has(el.dataset.iso)) el.classList.add('calendar-selected'); else el.classList.remove('calendar-selected');
    });
}
function selectWeekOfAnySelected() {
    // if none selected, use today or first day clicked in grid (take first visible)
    if (selectedDates.size === 0) {
        // pick today's weekday in the current month view if present
        const isoToday = isoFromDate(new Date());
        if ($(`[data-iso="${isoToday}"]`)) selectedDates.add(isoToday);
        else {
            // fall back to first day cell
            const firstCell = document.querySelector('.calendar-cell');
            if (firstCell && firstCell.dataset.iso) selectedDates.add(firstCell.dataset.iso);
        }
    }
    // take the first selected date to determine week
    const firstIso = Array.from(selectedDates).sort()[0];
    const dt = new Date(firstIso + 'T00:00:00');
    // get monday of that week
    const weekday = dt.getDay(); // 0=Sun
    const offset = weekday === 0 ? -6 : 1 - weekday; // offset to monday
    const monday = new Date(dt); monday.setDate(dt.getDate() + offset);
    // select monday..sunday
    clearSelection();
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        selectedDates.add(isoFromDate(d));
    }
    // update UI
    $$('.calendar-cell').forEach(el => {
        if (selectedDates.has(el.dataset.iso)) el.classList.add('calendar-selected'); else el.classList.remove('calendar-selected');
    });
}

// Apply selection and go to resumen: fetch orders for selected dates then switch tab
async function applySelectionAndGoToResumen() {
    // if no selection, treat as today
    if (selectedDates.size === 0) {
        await calculateAndRenderForSelected(null);
    } else {
        await calculateAndRenderForSelected(selectedDates);
    }
    switchTab('resumen');
}

// Calendar navigation
function calPrevMonth() { calState.currentCalendarMonth.setMonth(calState.currentCalendarMonth.getMonth() - 1); renderCalendar(); }
function calNextMonth() { calState.currentCalendarMonth.setMonth(calState.currentCalendarMonth.getMonth() + 1); renderCalendar(); }
function calTodayFunc() { calState.currentCalendarMonth = new Date(); renderCalendar(); }

// Event listeners
tabResumenBtn?.addEventListener('click', () => switchTab('resumen'));
tabCalendarioBtn?.addEventListener('click', () => switchTab('calendario'));

calPrev?.addEventListener('click', () => calPrevMonth());
calNext?.addEventListener('click', () => calNextMonth());
calToday?.addEventListener('click', () => calTodayFunc());

selectMonthBtn?.addEventListener('click', () => selectMonth());
selectWeekBtn?.addEventListener('click', () => selectWeekOfAnySelected());
clearSelectionBtn?.addEventListener('click', () => clearSelection());
applySelectionBtn?.addEventListener('click', () => applySelectionAndGoToResumen());

$('#btn-calc')?.addEventListener('click', async () => {
    // refresh resumen to today's view (clear selection)
    clearSelection();
    await calculateAndRenderForSelected(null);
    // ensure UI shows resumen
    switchTab('resumen');
});

// Filters & conciliation behavior (kept)
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

// Save closure / conciliation (kept)
async function saveCashClosure(summary, isoDate) {
    const closuresCol = collection(db, 'cash_closures');
    const payload = {
        dateISO: isoDate,
        dateLabel: formatDateDisplay(new Date(isoDate)),
        totals: { bs: summary.totalBs ?? 0, usd: summary.totalUsd ?? 0, totalsByMethod: summary.totalsByMethod || {} },
        createdAt: serverTimestamp(),
        createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null,
        conciliacion: { bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0) }
    };
    const docRef = await addDoc(closuresCol, payload);
    return docRef.id;
}
$('#btn-close-cash')?.addEventListener('click', async () => {
    // the summary is always for today or selected dates; for simplicity use today's iso if none selected
    const iso = selectedDates.size ? Array.from(selectedDates).sort()[0] : isoFromDate(new Date());
    const result = await calculateAndRenderForSelected(selectedDates.size ? selectedDates : null);
    if (!result) return;
    // if any of selected dates already closed, alert; else confirm
    const closures = closuresCache || [];
    const closedDates = new Set(closures.map(c => c.dateISO));
    const toClose = selectedDates.size ? Array.from(selectedDates) : [iso];
    for (const d of toClose) {
        if (closedDates.has(d)) return toast('Al menos una de las fechas seleccionadas ya está cerrada');
    }
    if (!confirm('¿Deseas cerrar la(s) fecha(s) seleccionada(s)? Se guardará en cash_closures.')) return;
    try {
        // Save closure aggregated per day (simple approach: save single closure for the first day)
        // You may want to adapt this to save per day or a grouped closure.
        const id = await saveCashClosure(result.summary, toClose[0]);
        toast('Caja cerrada. ID: ' + id, 5000);
    } catch (err) { console.error(err); toast('Error guardando cierre'); }
});
$('#btn-save-conciliation')?.addEventListener('click', async () => {
    const iso = selectedDates.size ? Array.from(selectedDates).sort()[0] : isoFromDate(new Date());
    try {
        const coll = collection(db, 'cash_conciliations');
        await addDoc(coll, { dateISO: iso, bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0), createdAt: serverTimestamp(), createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null });
        toast('Conciliación guardada');
    } catch (err) { console.error(err); toast('Error guardando conciliación'); }
});

// Formating conciliation inputs (kept)
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

// Auth state
onAuthStateChanged(auth, (u) => currentUser = u);

// Init: render resumen (today) and set pill
(async function init() {
    setDefaultDateDisplay();
    await calculateAndRenderForSelected(null);
    switchTab('resumen');
})();
