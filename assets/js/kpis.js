// assets/js/kpis.js
// KPIs en tiempo real con comparación entre "Pedidos hoy" y la última fecha previa que tuvo pedidos.
// Añadido: modal de "Ventas del día" que lista pedidos del día, con total y columna "quién" (vendedor).
// Cambios: prioriza assignedSellerName si existe y aplica "Title Case" (primera letra en mayúscula) a nombres mostrados.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore,
    collection,
    query,
    onSnapshot,
    orderBy,
    where
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

// Referencias a elementos KPI
const ordersTodayEl = document.getElementById('kpi-orders-today');
const salesEl = document.getElementById('kpi-sales');
const lowStockValueEl = document.getElementById('kpi-lowstock-value');
const lowStockArticle = document.getElementById('kpi-lowstock');

// Modal elements for low stock (existing)
const lowStockModal = document.getElementById('lowStockModal');
const lowStockModalBody = document.getElementById('lowStockModalBody');
const lowStockListEl = document.getElementById('lowStockList');
const lowStockModalClose = document.getElementById('lowStockModalClose');
const lowStockModalOk = document.getElementById('lowStockModalOk');

let lowStockProducts = []; // cached list of products with stock < 5

// Inject improved styles for KPI comparison and modals
(function injectStyles() {
    const css = `
    /* small red comparative text beside KPI */
    .kpi-compare { display:block; font-size:12px; color:var(--muted, #9ca3af); margin-top:4px; }
    .kpi-compare .compare-number { color:#dc2626; font-weight:700; font-size:11px; margin-left:6px; }

    /* shared modal overlay */
    .kpi-modal-overlay {
        position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
        background:rgba(2,6,23,0.45); z-index:1200; padding:20px;
    }
    .kpi-modal-panel {
        background:var(--surface,#fff); border-radius:10px; max-width:980px; width:100%;
        max-height:90vh; overflow:auto; box-shadow:0 14px 40px rgba(2,6,23,0.25);
        padding:20px; border:1px solid rgba(2,6,23,0.06);
    }
    .kpi-modal-panel .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .kpi-modal-panel .modal-header h2 { margin:0; font-size:18px; text-transform:capitalize; }
    .kpi-modal-panel .close-btn { border:none; background:transparent; font-size:20px; cursor:pointer; color:var(--muted,#6b7280); }

    /* compare grid */
    .compare-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
    @media (max-width:720px) { .compare-grid { grid-template-columns:1fr; } }
    .compare-card { border:1px solid rgba(2,6,23,0.06); padding:14px; border-radius:8px; background:var(--card-bg,#fff); }
    .compare-card .muted { color:var(--muted,#6b7280); font-size:13px; }
    .compare-card .stat { font-size:20px; font-weight:700; margin-top:8px; }
    .compare-card .small { font-size:12px; color:var(--muted,#6b7280); margin-top:6px; }

    /* sales table */
    .sales-table { width:100%; border-collapse:collapse; margin-top:10px; }
    .sales-table th, .sales-table td { text-align:left; padding:10px 8px; border-bottom:1px solid rgba(2,6,23,0.04); font-size:13px; }
    .sales-table th { color:var(--muted,#374151); font-weight:700; background:transparent; }
    .sales-total-row td { font-weight:700; font-size:15px; }
    .no-data { color:var(--muted,#6b7280); padding:12px; }

    button.btn-secondary.kpi { background:transparent; border:1px solid rgba(2,6,23,0.08); padding:8px 12px; border-radius:6px; cursor:pointer; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
})();

function formatMoney(n) {
    try { return Number(n || 0).toLocaleString(); } catch (e) { return String(n || 0); }
}

function parseOrderDate(docData) {
    if (!docData) return null;
    if (docData.createdAt && typeof docData.createdAt.toDate === 'function') return docData.createdAt.toDate();
    if (docData.timestamp && typeof docData.timestamp.toDate === 'function') return docData.timestamp.toDate();
    if (docData.orderDate) {
        const d = new Date(docData.orderDate);
        if (!isNaN(d)) return d;
    }
    return null;
}

function startOfDayLocal(d = new Date()) {
    const dt = new Date(d);
    dt.setHours(0, 0, 0, 0);
    return dt;
}
function dateKeyFromDate(d) {
    const dt = new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function isDelivered(data) {
    if (!data) return false;
    const s = (data.shippingStatus || data.shipping_state || data.status || '').toString().toLowerCase();
    if (s.includes('deliver') || s.includes('entreg') || s.includes('delivered')) return true;
    if (data.isDelivered === true) return true;
    if (data.deliveredAt || data.delivered_at) return true;
    return false;
}

function isPaymentStatusPaid(data) {
    if (!data) return false;
    const ps = (
        data.paymentStatus ||
        data.payment_status ||
        (data.payment && (data.payment.paymentStatus || data.payment.status)) ||
        (data.payment && data.payment.state) ||
        ''
    ).toString().toLowerCase();
    return ps === 'pagado' || ps === 'paid' || ps.includes('pagad') || ps.includes('paid');
}

// Title case helper: convierte "ramon serra" => "Ramon Serra". No modifica emails.
function titleCase(s) {
    if (!s && s !== '') return s;
    const str = String(s).trim();
    if (!str) return str;
    // don't title-case emails or tokens that contain '@' or have many non-letter chars
    if (str.includes('@') || /^[0-9-_.]{3,}$/.test(str)) return str;
    // split by spaces, underscores, hyphens; preserve internal capitalization for acronyms? we'll lowercase then capitalize first
    return str.split(/\s+/).map(part => {
        // keep punctuation inside part (e.g. "O'neil")
        return part.split(/[-_]/).map(p => {
            if (!p) return '';
            return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
        }).join('-');
    }).join(' ');
}

function getCustomerName(data) {
    if (!data) return '—';
    let name = '—';
    if (data.customerData) {
        name = data.customerData.name || data.customerData.fullName || data.customerData.Customname || data.customerData.email || data.customerData.phone || name;
    } else {
        name = data.customerName || data.customer || data.email || data.customerId || name;
    }
    if (!name) return '—';
    // Title case unless it's an email
    return titleCase(name);
}

function getSellerName(data) {
    if (!data) return '—';
    // Prefer assignedSellerName (common field in your screenshot), then several fallbacks
    let name = null;

    // common assigned fields (variations)
    const assignedCandidates = [
        data.assignedSellerName,
        data.assigned_seller_name,
        data.assignment && data.assignment.assignedSellerName,
        data.assignedSeller || data.assignedSellerName || data.assignedSeller_name
    ];
    for (const c of assignedCandidates) {
        if (c) { name = c; break; }
    }

    // fallback to explicit email or seller fields
    if (!name) {
        name = data.assignedSellerEmail || data.assignedSellerEmailAddress || data.assignedSellerEmailString || data.assignedSellerEmail || null;
    }
    if (!name) {
        name = data.vendedor || data.sellerName || data.seller || data.salesperson || data.salesman || data.sellerId || null;
    }
    if (!name) return '—';
    return titleCase(name);
}

// Suscripción realtime para KPIs (ahora guardamos orders[] en cada bucket)
function subscribeKpisRealtime() {
    try {
        const ordersCol = collection(db, 'orders');
        const q = query(ordersCol, orderBy('orderDate', 'desc'));
        onSnapshot(q, snapshot => {
            const byDate = new Map();

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                const date = parseOrderDate(data);
                if (!date) return;
                const key = dateKeyFromDate(date);

                if (!byDate.has(key)) {
                    byDate.set(key, {
                        count: 0,
                        sales: 0,
                        deliveredCount: 0,
                        customers: new Set(),
                        productCounts: new Map(),
                        maxOrder: { id: null, total: 0, raw: null },
                        orders: [] // <-- lista con objetos { id, total, data, dateObj }
                    });
                }
                const bucket = byDate.get(key);
                bucket.count += 1;

                let totalValue = 0;
                if (typeof data.total === 'number') totalValue = data.total;
                else if (typeof data.total === 'string' && !isNaN(Number(data.total))) totalValue = Number(data.total);
                else if (typeof data.totalUSD === 'number') totalValue = data.totalUSD;
                else if (typeof data.subtotal === 'number') totalValue = data.subtotal;
                else if (data.items && Array.isArray(data.items)) {
                    totalValue = data.items.reduce((acc, it) => {
                        if (!it) return acc;
                        const s = (typeof it.subtotal === 'number') ? it.subtotal : ((typeof it.price === 'number' && typeof it.quantity === 'number') ? it.price * it.quantity : 0);
                        return acc + (s || 0);
                    }, 0);
                }

                // Añadir al total de ventas SOLO si el pedido está marcado como pagado
                if (isPaymentStatusPaid(data)) {
                    bucket.sales += (totalValue || 0);
                }

                if (isDelivered(data)) bucket.deliveredCount += 1;

                let customerId = null;
                if (data.customerData) {
                    if (data.customerData.email) customerId = data.customerData.email;
                    else if (data.customerData.phone) customerId = data.customerData.phone;
                    else if (data.customerData.Customname) customerId = data.customerData.Customname;
                }
                if (!customerId) {
                    customerId = data.customerId || data.userId || data.user_id || data.email || null;
                }
                if (customerId) bucket.customers.add(String(customerId));

                if (data.items && Array.isArray(data.items)) {
                    data.items.forEach(it => {
                        if (!it) return;
                        const name = it.name || it.productName || it.title || (it.productId ? String(it.productId) : 'Sin nombre');
                        const qty = (typeof it.quantity === 'number') ? it.quantity : (it.qty ? Number(it.qty) : 0);
                        const prev = bucket.productCounts.get(name) || 0;
                        bucket.productCounts.set(name, prev + (qty || 0));
                    });
                }

                if (totalValue > (bucket.maxOrder.total || 0)) {
                    bucket.maxOrder = { id: docSnap.id, total: totalValue, raw: data };
                }

                // push order into bucket.orders
                bucket.orders.push({
                    id: docSnap.id,
                    total: totalValue || 0,
                    data,
                    dateObj: date
                });
            });

            // determine today and prev
            const todayKey = dateKeyFromDate(startOfDayLocal());
            const keys = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a)); // desc
            let prevKey = null;
            for (const k of keys) {
                if (k < todayKey) { prevKey = k; break; }
            }

            const todayBucket = byDate.get(todayKey) || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 }, orders: [] };
            const prevBucket = prevKey ? byDate.get(prevKey) : { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 }, orders: [] };

            // Update KPI numbers
            const ordersToday = todayBucket.count || 0;
            if (ordersTodayEl) {
                const prevCount = prevBucket.count || 0;
                const display = `${escapeHtml(String(ordersToday))}
                    <span class="kpi-compare"><span class="small muted">última fecha: ${prevKey || '—'}</span>
                    <span class="compare-number">${escapeHtml(String(prevCount))}</span></span>`;
                ordersTodayEl.innerHTML = display;
            }

            // Sales KPI - mostramos suma de ventas pagadas hoy
            if (salesEl) salesEl.textContent = formatMoney(todayBucket.sales);

            // cache completo
            window.__kpis_cache = window.__kpis_cache || {};
            window.__kpis_cache.ordersByDate = byDate;
            window.__kpis_cache.todayKey = todayKey;
            window.__kpis_cache.prevKey = prevKey;
            window.__kpis_cache.todayBucket = todayBucket;
            window.__kpis_cache.prevBucket = prevBucket;

        }, err => {
            console.error('KPIs realtime snapshot error:', err);
            if (ordersTodayEl) ordersTodayEl.textContent = '—';
            if (salesEl) salesEl.textContent = '—';
        });
    } catch (err) {
        console.error('subscribeKpisRealtime error:', err);
        if (ordersTodayEl) ordersTodayEl.textContent = '—';
        if (salesEl) salesEl.textContent = '—';
    }
}

// Low stock subscription (sin cambios funcionales)
function subscribeLowStockRealtime() {
    try {
        const productsCol = collection(db, 'product');
        const lowQuery = query(productsCol, where('stock', '<', 5), orderBy('stock', 'asc'));
        onSnapshot(lowQuery, snapshot => {
            const arr = [];
            snapshot.forEach(docSnap => {
                const d = docSnap.data();
                arr.push({
                    id: docSnap.id,
                    name: d.name || d.title || d.productName || 'Sin nombre',
                    stock: typeof d.stock === 'number' ? d.stock : (d.stock ? Number(d.stock) : 0),
                    sku: d.sku || d.code || ''
                });
            });
            lowStockProducts = arr;
            if (lowStockValueEl) lowStockValueEl.textContent = String(arr.length);
            if (lowStockArticle) {
                if (arr.length > 0) { lowStockArticle.classList.add('has-low-stock'); lowStockArticle.setAttribute('aria-pressed', 'false'); }
                else { lowStockArticle.classList.remove('has-low-stock'); lowStockArticle.setAttribute('aria-pressed', 'false'); }
            }
        }, err => {
            console.error('Low stock onSnapshot error:', err);
            if (lowStockValueEl) lowStockValueEl.textContent = '—';
        });
    } catch (err) {
        console.error('subscribeLowStockRealtime error:', err);
        if (lowStockValueEl) lowStockValueEl.textContent = '—';
    }
}

// Low stock modal open/close
function openLowStockModal() {
    if (!lowStockModal) return;
    const list = lowStockProducts || [];
    if (lowStockListEl) lowStockListEl.innerHTML = '';
    if (!list.length) {
        const p = document.createElement('div'); p.className = 'no-data'; p.textContent = 'Ningún stock se encuentra por debajo de 5.'; lowStockListEl.appendChild(p);
    } else {
        list.forEach(p => {
            const row = document.createElement('div');
            row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center';
            row.style.padding = '10px'; row.style.borderRadius = '8px'; row.style.background = '#fff';
            row.style.boxShadow = 'inset 0 0 0 1px rgba(2,6,23,0.02)';
            row.innerHTML = `<div style="display:flex;flex-direction:column;"><div style="font-weight:700">${escapeHtml(titleCase(p.name))}</div><div style="font-size:12px;color:var(--muted)">${escapeHtml(p.sku || '')}</div></div><div style="font-weight:800;color:${p.stock <= 0 ? '#b91c1c' : '#dc2626'}">${p.stock}</div>`;
            lowStockListEl.appendChild(row);
        });
    }
    lowStockModal.classList.remove('hidden'); lowStockModal.setAttribute('aria-hidden', 'false');
    const panel = lowStockModal.querySelector('.modal-content'); if (panel) panel.focus();
}
function closeLowStockModal() { if (!lowStockModal) return; lowStockModal.classList.add('hidden'); lowStockModal.setAttribute('aria-hidden', 'true'); if (lowStockListEl) lowStockListEl.innerHTML = ''; }

// Escape helper
function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Attach click handlers for low-stock KPI article
if (lowStockArticle) {
    lowStockArticle.addEventListener('click', openLowStockModal);
    lowStockArticle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLowStockModal(); } });
}

// Comparativa modal
function createOrdersCompareModal() {
    let existing = document.getElementById('ordersCompareModal');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'ordersCompareModal';
    overlay.className = 'kpi-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `<div class="kpi-modal-panel" role="document"><div class="modal-header"><h2>Comparativa de pedidos</h2><button id="ordersCompareClose" aria-label="Cerrar" class="close-btn">&times;</button></div><div id="ordersCompareContent"></div></div>`;
    document.body.appendChild(overlay);
    const panel = overlay.querySelector('.kpi-modal-panel'); if (panel) { panel.tabIndex = -1; panel.focus(); }

    const closeBtn = overlay.querySelector('#ordersCompareClose');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { const el = document.getElementById('ordersCompareModal'); if (el) el.remove(); document.removeEventListener('keydown', onEsc); } });
    return overlay;
}
function topProductFromMap(productCounts) {
    if (!productCounts || productCounts.size === 0) return null;
    let topName = null, topQty = 0;
    for (const [name, qty] of productCounts.entries()) {
        if (qty > topQty) { topQty = qty; topName = name; }
    }
    return topName ? { name: topName, qty: topQty } : null;
}
function openOrdersCompareModal() {
    const cache = window.__kpis_cache || {};
    const todayKey = cache.todayKey;
    const prevKey = cache.prevKey;
    const today = cache.todayBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };
    const prev = cache.prevBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 } };

    const modal = createOrdersCompareModal();
    const content = modal.querySelector('#ordersCompareContent');

    const topToday = topProductFromMap(today.productCounts);
    const topPrev = topProductFromMap(prev.productCounts);

    content.innerHTML = `
      <div class="compare-grid" style="margin-bottom:12px;">
        <div class="compare-card"><div class="muted">Fecha</div><div class="stat">${escapeHtml(todayKey)}</div></div>
        <div class="compare-card"><div class="muted">Fecha comparativa</div><div class="stat">${escapeHtml(prevKey || '—')}</div></div>

        <div class="compare-card"><div class="muted">Pedidos</div><div class="stat">${escapeHtml(String(today.count || 0))}</div><div class="small">vs ${escapeHtml(String(prev.count || 0))}</div></div>
        <div class="compare-card"><div class="muted">Ventas totales (solo "pagado")</div><div class="stat">$ ${escapeHtml(formatMoney(today.sales || 0))}</div><div class="small">vs $ ${escapeHtml(formatMoney(prev.sales || 0))}</div></div>

        <div class="compare-card"><div class="muted">Clientes únicos</div><div class="stat">${escapeHtml(String((today.customers && today.customers.size) || 0))}</div><div class="small">vs ${escapeHtml(String((prev.customers && prev.customers.size) || 0))}</div></div>
        <div class="compare-card"><div class="muted">Entregas</div><div class="stat">${escapeHtml(String(today.deliveredCount || 0))}</div><div class="small">vs ${escapeHtml(String(prev.deliveredCount || 0))}</div></div>

        <div class="compare-card" style="grid-column:1 / -1;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div><div class="muted">Producto más vendido</div><div class="stat">${topToday ? escapeHtml(titleCase(topToday.name)) + ' (' + escapeHtml(String(topToday.qty)) + ')' : '—'}</div></div>
            <div style="text-align:right;"><div class="muted">Vs</div><div class="stat">${topPrev ? escapeHtml(titleCase(topPrev.name)) + ' (' + escapeHtml(String(topPrev.qty)) + ')' : '—'}</div></div>
          </div>
        </div>

        <div class="compare-card" style="grid-column:1 / -1;">
          <div class="muted">Pedido más grande</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
            <div><div class="small">ID</div><div class="stat">${today.maxOrder && today.maxOrder.id ? escapeHtml(today.maxOrder.id) : '—'}</div></div>
            <div><div class="small">Total</div><div class="stat">$ ${escapeHtml(formatMoney(today.maxOrder && today.maxOrder.total || 0))}</div></div>
            <div style="text-align:right;"><div class="small">Vs</div><div class="small">ID: ${prev.maxOrder && prev.maxOrder.id ? escapeHtml(prev.maxOrder.id) : '—'}</div><div class="stat">$ ${escapeHtml(formatMoney(prev.maxOrder && prev.maxOrder.total || 0))}</div></div>
          </div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button id="ordersCompareCloseBtn" class="btn-secondary kpi">Cerrar</button></div>
    `;

    const closeBtn2 = modal.querySelector('#ordersCompareCloseBtn');
    if (closeBtn2) closeBtn2.addEventListener('click', () => modal.remove());
    const panel = modal.querySelector('.kpi-modal-panel'); if (panel) panel.focus();
}

// --- NUEVO: Modal de ventas (lista de pedidos del día) ---
function createSalesModal() {
    let existing = document.getElementById('salesListModal');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'salesListModal';
    overlay.className = 'kpi-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="kpi-modal-panel" role="document">
        <div class="modal-header">
          <h2>Ventas - Pedidos del día</h2>
          <button id="salesModalClose" aria-label="Cerrar" class="close-btn">&times;</button>
        </div>
        <div id="salesModalContent"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    const panel = overlay.querySelector('.kpi-modal-panel'); if (panel) { panel.tabIndex = -1; panel.focus(); }

    const closeBtn = overlay.querySelector('#salesModalClose');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { const el = document.getElementById('salesListModal'); if (el) el.remove(); document.removeEventListener('keydown', onEsc); } });
    return overlay;
}

function openSalesModal() {
    const cache = window.__kpis_cache || {};
    const todayKey = cache.todayKey;
    const today = cache.todayBucket || { orders: [], sales: 0 };

    const modal = createSalesModal();
    const content = modal.querySelector('#salesModalContent');

    // Build table of orders
    const orders = (today.orders && Array.isArray(today.orders)) ? today.orders : [];
    // compute totals
    let totalPaid = 0; // suma solo pedidos pagados
    let totalGross = 0; // suma de todos los pedidos (totalValue)
    orders.forEach(o => {
        totalGross += (o.total || 0);
        if (isPaymentStatusPaid(o.data)) totalPaid += (o.total || 0);
    });

    if (!orders.length) {
        content.innerHTML = `<div class="no-data">No hay pedidos para la fecha ${escapeHtml(todayKey || '—')}.</div>
                             <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button id="salesCloseBtn" class="btn-secondary kpi">Cerrar</button></div>`;
        const closeBtn = modal.querySelector('#salesCloseBtn'); if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());
        return;
    }

    // Build HTML table
    let rowsHtml = orders.map(o => {
        const id = o.id || '—';
        const cust = escapeHtml(getCustomerName(o.data));
        const seller = escapeHtml(getSellerName(o.data));
        const dt = o.dateObj ? (new Date(o.dateObj)).toLocaleString() : '';
        const paid = isPaymentStatusPaid(o.data) ? 'Pagado' : 'No pagado';
        return `<tr>
            <td><strong>${escapeHtml(id)}</strong></td>
            <td>${cust}</td>
            <td style="white-space:nowrap;">${escapeHtml(dt)}</td>
            <td>${seller}</td>
            <td>${escapeHtml(paid)}</td>
            <td style="text-align:right;">$ ${escapeHtml(formatMoney(o.total || 0))}</td>
        </tr>`;
    }).join('');

    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div><div class="muted">Fecha</div><div class="stat">${escapeHtml(todayKey)}</div></div>
        <div style="text-align:right;">
          <div class="muted">Total pagado (solo "pagado")</div>
          <div class="stat">$ ${escapeHtml(formatMoney(totalPaid))}</div>
          <div class="small">Total bruto: $ ${escapeHtml(formatMoney(totalGross))}</div>
        </div>
      </div>

      <table class="sales-table" aria-label="Pedidos del día">
        <thead><tr><th>ID</th><th>Cliente</th><th>Fecha / Hora</th><th>Vendedor</th><th>Pago</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr class="sales-total-row"><td colspan="5">TOTAL (pagado)</td><td style="text-align:right">$ ${escapeHtml(formatMoney(totalPaid))}</td></tr></tfoot>
      </table>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;"><button id="salesCloseBtn2" class="btn-secondary kpi">Cerrar</button></div>
    `;

    const closeBtn2 = modal.querySelector('#salesCloseBtn2');
    if (closeBtn2) closeBtn2.addEventListener('click', () => modal.remove());
    const panel = modal.querySelector('.kpi-modal-panel'); if (panel) panel.focus();
}

// Attach click to the "Pedidos hoy" KPI (existente)
(function attachOrdersKpiClick() {
    if (!ordersTodayEl) return;
    let parent = ordersTodayEl;
    while (parent && parent.tagName && parent.tagName.toLowerCase() !== 'article') {
        parent = parent.parentElement;
    }
    const kpiArticle = parent;
    if (!kpiArticle) return;
    kpiArticle.style.cursor = 'pointer';
    kpiArticle.setAttribute('tabindex', '0');
    kpiArticle.addEventListener('click', () => { openOrdersCompareModal(); });
    kpiArticle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrdersCompareModal(); } });
})();

// --- NUEVO: Attach click to Sales KPI (kpi-sales span inside) ---
(function attachSalesKpiClick() {
    if (!salesEl) return;
    // encontrar el artículo padre
    let parent = salesEl;
    while (parent && parent.tagName && parent.tagName.toLowerCase() !== 'article') {
        parent = parent.parentElement;
    }
    const kpiArticle = parent;
    if (!kpiArticle) return;
    kpiArticle.style.cursor = 'pointer';
    kpiArticle.setAttribute('tabindex', '0');
    kpiArticle.addEventListener('click', () => { openSalesModal(); });
    kpiArticle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSalesModal(); } });
})();

// Attach modal close handlers (low stock)
if (lowStockModalClose) lowStockModalClose.addEventListener('click', closeLowStockModal);
if (lowStockModalOk) lowStockModalOk.addEventListener('click', closeLowStockModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLowStockModal(); });

// Start subscriptions
subscribeKpisRealtime();
subscribeLowStockRealtime();