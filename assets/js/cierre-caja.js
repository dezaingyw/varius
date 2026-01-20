// Versión actualizada de cierre-caja.js (con filtros para vendedor, motorizado y forma de pago)
// - Normaliza method+currency
// - Agrupa pagos por método+moneda primaria (sin duplicados)
// - Añadido filtro UI/logic
// - KPIs en layout horizontal
// - Añadida detección de cash_closure para ocultar detalles si la caja ya está cerrada
// - Acordeón collapsible para vendedores
// - Botón refrescar ahora vuelve a la fecha actual y limpia filtros
// - Selección de fecha dispara búsqueda en tiempo real (debounced)
// - Mejora: filtros ahora aplican automáticamente al cambiar (sin pulsar "Aplicar")
// - Mejora: botón "Limpiar" restablece y aplica inmediatamente
// - Mejora: oculta filtros + conciliación + botones de cierre cuando el usuario filtra por un día distinto al día por defecto (hoy)

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
const toast = (m, t = 3000) => {
    const el = $('#toast');
    if (!el) return alert(m);
    el.textContent = m; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', t);
};

// ---------- formateo ----------
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

function formatCurrencyUSD(v) {
    return `$ ${formatNumberCustom(Number(v), 2)}`;
}

function formatDateDisplay(d) { try { return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return String(d); } }

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
    if (typeof value === 'object' && typeof value.toDate === 'function') { try { return value.toDate(); } catch { } }
    if (typeof value === 'object' && (value.seconds || value._seconds)) {
        const s = value.seconds ?? value._seconds; return new Date(s * 1000);
    }
    if (typeof value === 'number') return value > 1e12 ? new Date(value) : new Date(value * 1000);
    if (typeof value === 'string') { const d = new Date(value); return isNaN(d) ? null : d; }
    if (value instanceof Date) return value;
    return null;
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

// ---------- DOM refs ----------
const dateInput = $('#cierre-date');
const displayDate = $('#display-date');
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

// NEW refs for hiding/showing whole sections
const filterCard = $('#filter-card');
const conciliationSection = $('#conciliation-section');

let currentUser = null;
let lastFetchedOrders = []; // guardamos los pedidos originales para re-filtrar en memoria

function setDefaultDate() { const t = new Date(); if (dateInput) dateInput.value = t.toISOString().slice(0, 10); if (displayDate) displayDate.textContent = formatDateDisplay(t); }

function dayRangeFromISO(isoDate) { const start = new Date(isoDate + 'T00:00:00'); const end = new Date(isoDate + 'T23:59:59.999'); return { start, end }; }

// debounce helper
function debounce(fn, wait = 300) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

// Debounced version of applyFilters to avoid demasiadas ejecuciones rápidas
const debouncedApplyFilters = debounce(() => { try { applyFilters(); } catch (e) { console.error(e); } }, 200);

// Firestore fetching
async function fetchOrdersForDate(isoDate) {
    const { start, end } = dayRangeFromISO(isoDate);
    const ordersCol = collection(db, 'orders');

    try {
        const q = query(ordersCol, where('paymentStatus', '==', 'pagado'), where('paidAt', '>=', Timestamp.fromDate(start)), where('paidAt', '<=', Timestamp.fromDate(end)));
        const snap = await getDocs(q);
        if (snap && !snap.empty) {
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
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

// Comprueba si ya existe un cierre guardado para la fecha (dateISO)
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

// Construcción de datos y cálculos (se acumula por moneda primaria)
function buildCascadeData(orders) {
    const sellers = new Map();

    const summary = { totalBs: 0, totalUsd: 0, totalOrders: orders.length, totalsByMethod: {} };

    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';

        const { payments, motorizado } = extractPaymentsFromOrder(order);

        // acumular resumen
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

// Render KPIs
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

// Render tarjetas por método
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

// Render cascade (vendedores -> motorizados -> pedidos) con acordeón
function renderCascade(sellersMap) {
    if (!cascadeContainer) return;
    cascadeContainer.innerHTML = '';
    if (!sellersMap || sellersMap.size === 0) {
        cascadeContainer.innerHTML = '<div class="muted">No hay pedidos para la fecha seleccionada.</div>';
        return;
    }
    for (const [sellerName, riderMap] of sellersMap.entries()) {
        const sv = document.createElement('div'); sv.className = 'vendedor collapsed'; // start collapsed
        const sellerTotal = Array.from(riderMap.values()).flat().reduce((acc, item) => {
            return acc + (item.payments || []).reduce((s, p) => s + ((p.primary === 'bs') ? (p.bs || 0) : 0), 0)
                + (item.motorizado?.bs || 0);
        }, 0);
        // header (clickable)
        const header = document.createElement('div');
        header.className = 'vh clickable';
        header.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span class="chev">▸</span><div><div class="v-title">👤 Vendedor: ${sellerName}</div><div class="muted">Comisiones / totales mostrados por pedido</div></div></div><div class="badge-total">${formatCurrencyBs(sellerTotal)}</div>`;
        sv.appendChild(header);

        // content container (hidden when collapsed)
        const content = document.createElement('div');
        content.className = 'v-content';

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
                })() : `<div class="motorizado-fee"><div class="muted" style="font-size:13px"> </div></div>`;

                pd.innerHTML = `<div class="pedido-header"><div><strong>📄 ${o.id}</strong> — ${cust} <span class="muted">• ${dateStr}</span></div>${motHtml}</div><div class="payments">${paymentsHtml}</div><div class="subtotal-row"><div>Subtotal</div><div>${formatCurrencyBs(subtotalBs)} ${subtotalUsd ? ` / ${formatCurrencyUSD(subtotalUsd)}` : ''}</div></div>`;
                mv.appendChild(pd);
            }

            content.appendChild(mv);
        }

        sv.appendChild(content);
        cascadeContainer.appendChild(sv);

        // Toggle behavior: header click expands/collapses content
        header.addEventListener('click', () => {
            const isCollapsed = sv.classList.contains('collapsed');
            if (isCollapsed) {
                sv.classList.remove('collapsed');
                sv.classList.add('expanded');
                const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▾';
            } else {
                sv.classList.remove('expanded');
                sv.classList.add('collapsed');
                const chev = header.querySelector('.chev'); if (chev) chev.textContent = '▸';
            }
        });
    }
}

// --- FILTROS: poblar opciones y aplicar filtros ---
function populateFilterOptions(orders) {
    if (!filterSeller || !filterRider || !filterPayment) return;
    const sellersSet = new Set();
    const ridersSet = new Set();
    const paymentsMap = new Map(); // key -> label

    for (const order of orders) {
        const sellerName = order.assignedSellerName || order.assignedSeller || order.sellerName || order.vendedor || 'Desconocido';
        const riderName = order.assignedMotorizedName || order.assignedMotorName || order.motorizado || order.riderName || 'Sin asignar';
        sellersSet.add(String(sellerName));
        ridersSet.add(String(riderName));
        const { payments, motorizado } = extractPaymentsFromOrder(order);
        for (const p of payments) {
            const pk = p.key; // ejemplo: 'efectivo','pago-movil','paypal'
            if (!paymentsMap.has(pk)) paymentsMap.set(pk, p.label);
        }
        // incluir pago motorizado como opción especial si aparece
        if (motorizado && ((motorizado.bs || 0) > 0 || (motorizado.usd || 0) > 0)) {
            if (!paymentsMap.has('motorizado')) paymentsMap.set('motorizado', 'Pago motorizado');
        }
    }

    // rellenar selects (limpiar primero manteniendo opción 'all')
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

    // restaurar selección si sigue disponible
    if ([...filterSeller.options].some(o => o.value === prevSeller)) filterSeller.value = prevSeller;
    if ([...filterRider.options].some(o => o.value === prevRider)) filterRider.value = prevRider;
    if ([...filterPayment.options].some(o => o.value === prevPayment)) filterPayment.value = prevPayment;
}

function applyFilters() {
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
                // buscar en payments si existe key igual a selPayment
                const found = (payments || []).some(p => p.key === selPayment);
                if (!found) return false;
            }
        }

        return true;
    });

    const { sellers, summary } = buildCascadeData(filtered);
    renderKpis(summary);
    renderSummaryCards(summary);
    renderCascade(sellers);
    if (concBsInput) concBsInput.value = formatNumberCustom(Math.round(summary.totalBs * 100) / 100, 2);
    if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round(summary.totalUsd * 100) / 100, 2);
}

// Orquestador
async function calculateAndRender() {
    if (!dateInput) { console.error('#cierre-date no encontrado'); return; }
    const iso = dateInput.value;
    if (!iso) return toast('Selecciona una fecha');

    // Si la fecha seleccionada es distinta de la fecha por defecto (hoy), tratamos como "filtro por día"
    const defaultISO = new Date().toISOString().slice(0, 10);
    const isFilteredDay = iso !== defaultISO;

    // Mostrar/ocultar bloques según si el usuario filtró por un día (isFilteredDay)
    try {
        if (filterCard) filterCard.style.display = isFilteredDay ? 'none' : '';
        if (conciliationSection) conciliationSection.style.display = isFilteredDay ? 'none' : '';
        if (btnCloseCash) btnCloseCash.style.display = isFilteredDay ? 'none' : '';
    } catch (e) {
        console.warn('Error mostrando/ocultando secciones:', e);
    }

    const d = new Date(iso); if (displayDate) displayDate.textContent = formatDateDisplay(d);
    if (cascadeContainer) cascadeContainer.innerHTML = '<div class="muted">Cargando...</div>';

    try {
        // Comprueba si la caja ya está cerrada para la fecha
        const closed = await checkIfClosed(iso);
        if (closed) {
            // mostrar aviso y resumen de cierre guardado, sin mostrar pedidos
            if (cascadeContainer) {
                cascadeContainer.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div><strong>Caja cerrada para ${formatDateDisplay(new Date(iso))}</strong><div class="muted">Los detalles de pedidos no se muestran porque la caja ya fue cerrada. Cambia la fecha y pulsa "Aplicar" para consultar otra fecha.</div></div><div style="text-align:right"><div style="font-weight:700">Totales guardados</div><div>${formatCurrencyBs(closed.data.totals?.bs ?? 0)} ${closed.data.totals?.usd ? ` / ${formatCurrencyUSD(closed.data.totals?.usd)}` : ''}</div></div></div></div>`;
            }

            // Aseguramos que al estar cerrada la caja, las secciones solicitadas queden ocultas
            try {
                if (filterCard) filterCard.style.display = 'none';
                if (conciliationSection) conciliationSection.style.display = 'none';
                if (btnCloseCash) btnCloseCash.style.display = 'none';
            } catch (e) { /* noop */ }

            // Deshabilitar selects para evitar confusión
            if (filterSeller) filterSeller.disabled = true;
            if (filterRider) filterRider.disabled = true;
            if (filterPayment) filterPayment.disabled = true;
            if (btnApplyFilters) btnApplyFilters.disabled = true;
            if (btnResetFilters) btnResetFilters.disabled = true;

            // Llenar KPIs y conciliación con valores del cierre si existen
            const fakeSummary = { totalBs: closed.data.totals?.bs ?? 0, totalUsd: closed.data.totals?.usd ?? 0, totalOrders: 0, totalsByMethod: closed.data.totals?.totalsByMethod || {} };
            renderKpis(fakeSummary);
            renderSummaryCards(fakeSummary);
            if (concBsInput) concBsInput.value = formatNumberCustom(Math.round((closed.data.conciliacion?.bs ?? 0) * 100) / 100, 2);
            if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round((closed.data.conciliacion?.usd ?? 0) * 100) / 100, 2);
            // no continuamos con fetch de pedidos ni renderCascade de pedidos
            return { closed: true, closure: closed };
        } else {
            // aseguramos que filtros estén habilitados (si no estamos en modo "filtrado por día")
            if (!isFilteredDay) {
                if (filterSeller) filterSeller.disabled = false;
                if (filterRider) filterRider.disabled = false;
                if (filterPayment) filterPayment.disabled = false;
                if (btnApplyFilters) btnApplyFilters.disabled = false;
                if (btnResetFilters) btnResetFilters.disabled = false;
            } else {
                // Si estamos en modo 'filtrado por día' dejamos deshabilitados los selects (además de ocultarlos)
                if (filterSeller) filterSeller.disabled = true;
                if (filterRider) filterRider.disabled = true;
                if (filterPayment) filterPayment.disabled = true;
            }
        }

        const orders = await fetchOrdersForDate(iso);
        lastFetchedOrders = orders.slice(); // guardamos copia
        // Solo poblamos las opciones si NO estamos en modo 'filtrado por día'
        if (!isFilteredDay) populateFilterOptions(lastFetchedOrders);

        const { sellers, summary } = buildCascadeData(orders);
        renderKpis(summary);
        renderSummaryCards(summary);
        renderCascade(sellers);

        if (concBsInput) concBsInput.value = formatNumberCustom(Math.round(summary.totalBs * 100) / 100, 2);
        if (concUsdInput) concUsdInput.value = formatNumberCustom(Math.round(summary.totalUsd * 100) / 100, 2);
        return { orders, summary };
    } catch (err) {
        console.error('Error calculando cierre:', err);
        toast('Error cargando datos. Revisa la consola.');
        if (cascadeContainer) cascadeContainer.innerHTML = '<div class="muted">Error al cargar datos.</div>';
        return null;
    }
}

// Guardar cierre
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

// listeners
$('#btn-apply')?.addEventListener('click', () => calculateAndRender());

// Actualizado: al pulsar refrescar, volver a la fecha actual y limpiar filtros antes de recalcular
$('#btn-calc')?.addEventListener('click', () => {
    // restablecer fecha al día actual
    setDefaultDate();

    // limpiar selects de filtros si existen
    if (filterSeller) { filterSeller.value = 'all'; filterSeller.disabled = false; }
    if (filterRider) { filterRider.value = 'all'; filterRider.disabled = false; }
    if (filterPayment) { filterPayment.value = 'all'; filterPayment.disabled = false; }

    // asegurar que las secciones ocultadas por "filtrar por día" se muestren de nuevo
    try {
        if (filterCard) filterCard.style.display = '';
        if (conciliationSection) conciliationSection.style.display = '';
        if (btnCloseCash) btnCloseCash.style.display = '';
    } catch (e) { /* noop */ }

    // recalcular
    calculateAndRender();
});

$('#btn-close-cash')?.addEventListener('click', async () => {
    const iso = dateInput?.value; if (!iso) return toast('Selecciona la fecha para cerrar la caja');
    const result = await calculateAndRender(); if (!result) return;
    if (result.closed) { return toast('La caja ya está cerrada para la fecha seleccionada'); }
    if (!confirm('¿Deseas cerrar la caja de la fecha seleccionada? Se guardará en cash_closures.')) return;
    try { const id = await saveCashClosure(result.summary, iso); toast('Caja cerrada. ID: ' + id, 5000); } catch (err) { console.error(err); toast('Error guardando cierre'); }
});
$('#btn-save-conciliation')?.addEventListener('click', async () => {
    const iso = dateInput?.value; if (!iso) return toast('Selecciona fecha');
    try {
        const coll = collection(db, 'cash_conciliations');
        await addDoc(coll, { dateISO: iso, bs: parseFormattedNumber(concBsInput?.value || 0), usd: parseFormattedNumber(concUsdInput?.value || 0), createdAt: serverTimestamp(), createdBy: currentUser ? { uid: currentUser.uid, email: currentUser.email } : null });
        toast('Conciliación guardada');
    } catch (err) { console.error(err); toast('Error guardando conciliación'); }
});

// Aplicar filtros manual (se mantiene por compatibilidad)
btnApplyFilters?.addEventListener('click', () => applyFilters());

// Reset mejorado: restaura selects, rehabilita si es necesario, actualiza opciones y aplica
btnResetFilters?.addEventListener('click', () => {
    if (filterSeller) { filterSeller.value = 'all'; filterSeller.disabled = false; }
    if (filterRider) { filterRider.value = 'all'; filterRider.disabled = false; }
    if (filterPayment) { filterPayment.value = 'all'; filterPayment.disabled = false; }

    // Asegurarnos de que las opciones estén sincronizadas con los últimos pedidos fetchados
    if (lastFetchedOrders && lastFetchedOrders.length) populateFilterOptions(lastFetchedOrders);

    // Aplicar filtros inmediatamente
    applyFilters();
});

// Auto-aplicar filtros cuando el usuario cambie cualquier select (sin pulsar "Aplicar")
if (filterSeller) {
    filterSeller.addEventListener('change', debouncedApplyFilters);
    filterSeller.addEventListener('input', debouncedApplyFilters);
}
if (filterRider) {
    filterRider.addEventListener('change', debouncedApplyFilters);
    filterRider.addEventListener('input', debouncedApplyFilters);
}
if (filterPayment) {
    filterPayment.addEventListener('change', debouncedApplyFilters);
    filterPayment.addEventListener('input', debouncedApplyFilters);
}

onAuthStateChanged(auth, (u) => currentUser = u);

// --- Formateo en inputs de conciliación ---
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

if (concBsInput) {
    concBsInput.addEventListener('keydown', sanitizeInputKey);
    concBsInput.addEventListener('input', () => formatInputValueForDisplay(concBsInput, 2));
    concBsInput.addEventListener('blur', () => formatInputValueForDisplay(concBsInput, 2));
}

if (concUsdInput) {
    concUsdInput.addEventListener('keydown', sanitizeInputKey);
    concUsdInput.addEventListener('input', () => formatInputValueForDisplay(concUsdInput, 2));
    concUsdInput.addEventListener('blur', () => formatInputValueForDisplay(concUsdInput, 2));
}

// Disparar búsqueda en tiempo real al cambiar la fecha (debounced)
if (dateInput) {
    const debouncedCalc = debounce(() => {
        calculateAndRender();
    }, 300);
    dateInput.addEventListener('change', () => debouncedCalc());
    // algunos navegadores disparan input cuando se selecciona desde el datepicker
    dateInput.addEventListener('input', () => debouncedCalc());
}

// init
(function init() { setDefaultDate(); calculateAndRender().catch(e => console.error(e)); })();
