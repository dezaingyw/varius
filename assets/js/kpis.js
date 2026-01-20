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

    /* ---- New compare modal styles (adapted from your provided design) ---- */
    .compare-modal-overlay {
        display:none;
        position:fixed;
        inset:0;
        background: rgba(2,6,23,0.6);
        z-index:1400;
        padding:20px;
        backdrop-filter: blur(4px);
        overflow-y:auto;
    }
    .compare-modal-overlay.active {
        display:flex;
        align-items:flex-start;
        justify-content:center;
        padding-top:40px;
        padding-bottom:40px;
    }
    .compare-modal-panel {
        background: #fff;
        border-radius: 14px;
        width:100%;
        max-width:1200px;
        box-shadow: 0 20px 60px rgba(2,6,23,0.3);
        position:relative;
        animation: compareModalIn .28s ease-out;
        overflow:hidden;
    }
    @keyframes compareModalIn {
        from { opacity:0; transform: translateY(-20px) scale(.995); }
        to { opacity:1; transform: translateY(0) scale(1); }
    }
    .compare-modal-header { padding:20px 28px; border-bottom:1px solid #eef2f7; }
    .compare-modal-title { font-size:22px; font-weight:650; color:#111827; display:flex; gap:10px; align-items:center; }
    .compare-modal-subtitle { font-size:13px; color:#6b7280; margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .compare-close-btn {
        position:absolute; top:18px; right:18px; width:36px; height:36px; border-radius:8px; background:#f3f4f6; border:none; cursor:pointer; font-size:18px; color:#6b7280;
    }
    .compare-modal-body { padding:24px 28px; max-height:72vh; overflow:auto; }

    .metrics-grid {
        display:grid;
        grid-template-columns: repeat(auto-fit,minmax(220px,1fr));
        gap:16px;
        margin-bottom:22px;
    }
    .metric-card {
        background:#fbfdff;
        border:1px solid #eef2f7;
        border-radius:12px;
        padding:16px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
    }
    .metric-icon {
        width:44px;height:44px;border-radius:10px;background:#667eea;color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;margin-right:10px;
    }
    .metric-info { flex:1; min-width:0; }
    .metric-label { font-size:12px;color:#6b7280; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .metric-value { font-size:20px;font-weight:650;color:#111827; }
    .change-badge { padding:6px 10px; border-radius:8px; font-weight:700; font-size:12px; display:inline-flex; align-items:center; gap:6px; }
    .change-positive { background:#dcfce7; color:#15803d; }
    .change-negative { background:#fee2e2; color:#dc2626; }

    .section-divider { height:1px; background:#eef2f7; margin:22px 0; border-radius:2px; }

    .products-grid { display:grid; grid-template-columns:1fr; gap:16px; }
    @media(min-width:1024px){ .products-grid { grid-template-columns:1fr 1fr; } }
    .product-card { background:#fbfdff; border:1px solid #eef2f7; border-radius:12px; padding:16px; }
    .product-list { display:flex; flex-direction:column; gap:12px; }
    .product-item { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .product-meta { display:flex; gap:12px; align-items:center; min-width:0; }
    .product-rank { width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800; }
    .product-details { min-width:0; overflow:hidden; }
    .product-name { font-weight:700; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .product-id { font-size:12px; color:#9ca3af; margin-top:4px; }

    .orders-grid { display:grid; grid-template-columns:1fr; gap:16px; margin-top:14px; }
    @media(min-width:768px){ .orders-grid { grid-template-columns:1fr 1fr; } }
    .order-card { background:#fbfdff; border:1px solid #eef2f7; border-radius:12px; padding:18px; }
    .order-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f1f5f9; }
    .order-row:last-child { border-bottom:none; }

    .comparison-summary { background:#f8fafc; border-radius:12px; padding:16px; display:flex; gap:18px; align-items:center; justify-content:center; margin-top:18px; flex-wrap:wrap; }
    .summary-item { display:flex; gap:8px; align-items:center; }
    .summary-value.positive { color:#15803d; font-weight:800; }
    .summary-value.negative { color:#dc2626; font-weight:800; }

    /* Responsive */
    @media(max-width:640px){
        .compare-modal-panel { border-radius:10px; margin:8px; }
        .compare-modal-header { padding:16px; }
        .compare-modal-body { padding:16px; }
    }
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

// --- REPLACED: Comparativa modal (nuevo diseño acorde a tu ejemplo) ---

function buildTopProductsArray(productCountsMap, limit = 5) {
    if (!productCountsMap || !(productCountsMap instanceof Map)) return [];
    const arr = Array.from(productCountsMap.entries()).map(([name, qty]) => ({ name, qty }));
    arr.sort((a, b) => b.qty - a.qty);
    return arr.slice(0, limit);
}

function createOrdersCompareModal() {
    let existing = document.getElementById('ordersCompareModal');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'ordersCompareModal';
    overlay.className = 'compare-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="compare-modal-panel" role="document">
        <button class="compare-close-btn" id="ordersCompareClose" aria-label="Cerrar">✕</button>
        <div class="compare-modal-header">
          <div class="compare-modal-title">📈 Comparación de Pedidos</div>
          <div class="compare-modal-subtitle" id="ordersCompareSubtitle"></div>
        </div>
        <div class="compare-modal-body" id="ordersCompareContent"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // focus handling & events
    const panel = overlay.querySelector('.compare-modal-panel'); if (panel) { panel.tabIndex = -1; panel.focus(); }
    const closeBtn = overlay.querySelector('#ordersCompareClose');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const onEsc = function onEsc(e) { if (e.key === 'Escape') { const el = document.getElementById('ordersCompareModal'); if (el) el.remove(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
    return overlay;
}

function openOrdersCompareModal() {
    const cache = window.__kpis_cache || {};
    const todayKey = cache.todayKey || dateKeyFromDate(new Date());
    const prevKey = cache.prevKey || null;
    const today = cache.todayBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 }, orders: [] };
    const prev = cache.prevBucket || { count: 0, sales: 0, deliveredCount: 0, customers: new Set(), productCounts: new Map(), maxOrder: { id: null, total: 0 }, orders: [] };

    const modal = createOrdersCompareModal();

    // IMPORTANT: activar la clase 'active' para que el overlay sea visible
    if (modal && modal.classList) modal.classList.add('active');

    const subtitleEl = modal.querySelector('#ordersCompareSubtitle');
    if (subtitleEl) subtitleEl.innerHTML = `<span><span class="date-badge">${escapeHtml(todayKey)}</span> (Actual)</span> <span>vs</span> <span><span class="date-badge">${escapeHtml(prevKey || '—')}</span> (Anterior)</span>`;

    const content = modal.querySelector('#ordersCompareContent');

    // Metrics (Total orders, Sales pagadas, Clientes únicos, Entregas)
    const metrics = [
        { icon: '📦', label: 'Total Pedidos', current: today.count || 0, previous: prev.count || 0 },
        { icon: '💰', label: 'Ventas Pagadas', current: formatMoney(today.sales || 0), previous: formatMoney(prev.sales || 0), isMoney: true },
        { icon: '👥', label: 'Clientes Únicos', current: (today.customers && today.customers.size) || 0, previous: (prev.customers && prev.customers.size) || 0 },
        { icon: '🚚', label: 'Entregas', current: today.deliveredCount || 0, previous: prev.deliveredCount || 0 }
    ];

    // Build metrics grid HTML
    const metricsHtml = metrics.map(m => {
        // compute percentage change if numeric
        let changeHtml = '';
        try {
            const currNum = Number(String(m.current).replace(/[^0-9.-]+/g, '')) || 0;
            const prevNum = Number(String(m.previous).replace(/[^0-9.-]+/g, '')) || 0;
            if (prevNum > 0) {
                const diff = currNum - prevNum;
                const pct = Math.round((diff / prevNum) * 1000) / 10; // one decimal
                const cls = (diff >= 0) ? 'change-positive' : 'change-negative';
                const arrow = (diff >= 0) ? '↑' : '↓';
                changeHtml = `<div><div class="change-badge ${cls}">${arrow} ${Math.abs(pct)}%</div><div class="previous-value">vs ${m.isMoney ? '$' + escapeHtml(m.previous) : escapeHtml(String(m.previous))}</div></div>`;
            } else {
                // no prev
                changeHtml = `<div><div class="previous-value">vs ${m.isMoney ? '$' + escapeHtml(m.previous) : escapeHtml(String(m.previous))}</div></div>`;
            }
        } catch (e) {
            changeHtml = `<div class="previous-value">vs ${escapeHtml(String(m.previous))}</div>`;
        }

        return `<div class="metric-card">
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                <div class="metric-icon" aria-hidden="true">${m.icon}</div>
                <div class="metric-info">
                    <div class="metric-label">${escapeHtml(m.label)}</div>
                    <div class="metric-value">${m.isMoney ? '$' + escapeHtml(String(m.current)) : escapeHtml(String(m.current))}</div>
                </div>
            </div>
            <div style="text-align:right;">${changeHtml}</div>
        </div>`;
    }).join('');

    // Build top products lists
    const topToday = buildTopProductsArray(today.productCounts, 5);
    const topPrev = buildTopProductsArray(prev.productCounts, 5);

    function productListHtml(arr, tag) {
        if (!arr || !arr.length) return `<div class="no-data">No hay datos</div>`;
        return `<div class="product-list">` + arr.map((p, i) => {
            return `<div class="product-item">
                <div class="product-meta">
                    <div class="product-rank" style="background:${i === 0 ? '#ddd6fe' : '#eef2ff'}; color:${i === 0 ? '#6d28d9' : '#6b7280'}">${i + 1}</div>
                    <div class="product-details">
                        <div class="product-name">${escapeHtml(titleCase(p.name))}</div>
                        <div class="product-id">cantidad: ${escapeHtml(String(p.qty))}</div>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:800">${escapeHtml(String(p.qty))} uds</div>
                </div>
            </div>`;
        }).join('') + `</div>`;
    }

    // Biggest orders
    const todayMax = today.maxOrder || { id: null, total: 0 };
    const prevMax = prev.maxOrder || { id: null, total: 0 };

    // Orders and lists (we won't show full details, just summary)
    const html = `
      <div class="metrics-grid">${metricsHtml}</div>
      <div class="section-divider"></div>

      <div class="section-title" style="font-weight:650;margin-bottom:12px;display:flex;align-items:center;gap:10px;">🛒 Productos Más Vendidos</div>
      <div class="products-grid">
        <div class="product-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-weight:700">${escapeHtml(todayKey)}</div>
            <div class="badge badge-current" style="background:#667eea;color:#fff;padding:6px 10px;border-radius:8px;font-weight:650;">Actual</div>
          </div>
          ${productListHtml(topToday, 'actual')}
        </div>

        <div class="product-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-weight:650">${escapeHtml(prevKey || '—')}</div>
            <div class="badge badge-previous" style="background:#fff;border:1px solid #eef2f7;color:#6b7280;padding:6px 10px;border-radius:8px;font-weight:650;">Anterior</div>
          </div>
          ${productListHtml(topPrev, 'prev')}
        </div>
      </div>

      <div class="section-divider"></div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:stretch;">
        <div style="flex:1;min-width:280px;">
          <div style="font-weight:650;margin-bottom:10px;">📦 Detalles del Pedido Más Grande</div>
          <div class="orders-grid">
            <div class="order-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="font-weight:650">${escapeHtml(todayKey)}</div>
                <div style="background:#667eea;color:#fff;padding:6px 10px;border-radius:8px;font-weight:650;">Actual</div>
              </div>
              <div class="order-row"><div class="order-label">ID del Pedido</div><div class="order-value order-id">${todayMax.id ? escapeHtml(todayMax.id) : '—'}</div></div>
              <div class="order-row"><div class="order-label">Monto Total</div><div class="order-value large">$ ${escapeHtml(formatMoney(todayMax.total || 0))}</div></div>
              <div class="order-row"><div class="order-label">Artículos</div><div class="order-value">${(today.orders && today.orders.length) ? today.orders.reduce((acc, o) => acc + ((o.data && o.data.items && o.data.items.length) || 0), 0) : '—'}</div></div>
            </div>

            <div class="order-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="font-weight:700">${escapeHtml(prevKey || '—')}</div>
                <div style="background:#fff;border:1px solid #eef2f7;color:#6b7280;padding:6px 10px;border-radius:8px;font-weight:650;">Anterior</div>
              </div>
              <div class="order-row"><div class="order-label">ID del Pedido</div><div class="order-value order-id">${prevMax.id ? escapeHtml(prevMax.id) : '—'}</div></div>
              <div class="order-row"><div class="order-label">Monto Total</div><div class="order-value">$ ${escapeHtml(formatMoney(prevMax.total || 0))}</div></div>
              <div class="order-row"><div class="order-label">Artículos</div><div class="order-value">${(prev.orders && prev.orders.length) ? prev.orders.reduce((acc, o) => acc + ((o.data && o.data.items && o.data.items.length) || 0), 0) : '—'}</div></div>
            </div>
          </div>
        </div>

        <div style="flex:1;min-width:260px;">
          <div style="font-weight:650;margin-bottom:10px;">📋 Resumen Rápido</div>
          <div class="comparison-summary">
            <div class="summary-item">
              <div class="summary-label">Diferencia en Valor:</div>
              <div class="summary-value ${(today.sales - prev.sales) >= 0 ? 'positive' : 'negative'}">
                ${(today.sales - prev.sales) >= 0 ? '↑' : '↓'} $ ${escapeHtml(formatMoney(Math.abs((today.sales || 0) - (prev.sales || 0))))}
              </div>
            </div>
            <div class="divider-vertical" style="width:1px;height:36px;background:#e6eef7;border-radius:2px;"></div>
            <div class="summary-item">
              <div class="summary-label">Diferencia en Artículos:</div>
              <div class="summary-value ${((Array.from(today.productCounts.values()).reduce((a, b) => a + b, 0)) - (Array.from(prev.productCounts.values()).reduce((a, b) => a + b, 0))) >= 0 ? 'positive' : 'negative'}">
                ${((Array.from(today.productCounts.values()).reduce((a, b) => a + b, 0)) - (Array.from(prev.productCounts.values()).reduce((a, b) => a + b, 0))) >= 0 ? '↑' : '↓'} ${escapeHtml(String(Math.abs((Array.from(today.productCounts.values()).reduce((a, b) => a + b, 0)) - (Array.from(prev.productCounts.values()).reduce((a, b) => a + b, 0)))))} artículos
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <button id="ordersCompareCloseBtn" class="btn-secondary kpi" style="border-radius:8px;padding:8px 12px;">Cerrar</button>
      </div>
    `;

    content.innerHTML = html;

    const closeBtn2 = modal.querySelector('#ordersCompareCloseBtn');
    if (closeBtn2) closeBtn2.addEventListener('click', () => modal.remove());
    const panel = modal.querySelector('.compare-modal-panel'); if (panel) panel.focus();
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
// Reemplazar attachOrdersKpiClick y attachSalesKpiClick por lo siguiente:

(function attachOrdersKpiClick() {
    const el = document.getElementById('kpi-orders-today');
    if (!el) {
        console.warn('attachOrdersKpiClick: no se encontró #kpi-orders-today');
        return;
    }

    // usa closest para mayor robustez
    const kpiArticle = el.closest('article') || el.parentElement;
    if (!kpiArticle) {
        console.warn('attachOrdersKpiClick: no se encontró elemento article padre');
        return;
    }

    kpiArticle.style.cursor = 'pointer';
    // si ya tiene tabindex no lo cambiamos, pero nos aseguramos que exista para accesibilidad
    if (!kpiArticle.hasAttribute('tabindex')) kpiArticle.setAttribute('tabindex', '0');

    const openHandler = (evt) => {
        // si se hizo click en un control que no debe abrir el modal (ej. botón interno), ignorar
        if (evt && evt.target && evt.target.closest && evt.target.closest('button.kpi-action')) {
            // dejamos pasar para que el botón haga lo suyo; no abrimos el modal por ese click
            return;
        }
        openOrdersCompareModal();
    };

    kpiArticle.addEventListener('click', openHandler);
    kpiArticle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openHandler(e);
        }
    });

    // también enlazamos el botón interno .kpi-action (si existe) para que abra el modal, 
    // y evitamos que detenga la propagación si queremos que funcione desde ahí.
    const actionBtn = kpiArticle.querySelector('.kpi-action, button.kpi-action');
    if (actionBtn) {
        // Si el botón ya tenía lógica distinta, puedes quitar esto.
        actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openOrdersCompareModal();
        });
    }
})();

(function attachSalesKpiClick() {
    const el = document.getElementById('kpi-sales');
    if (!el) {
        console.warn('attachSalesKpiClick: no se encontró #kpi-sales');
        return;
    }

    const kpiArticle = el.closest('article') || el.parentElement;
    if (!kpiArticle) {
        console.warn('attachSalesKpiClick: no se encontró elemento article padre');
        return;
    }

    kpiArticle.style.cursor = 'pointer';
    if (!kpiArticle.hasAttribute('tabindex')) kpiArticle.setAttribute('tabindex', '0');

    const openHandler = (evt) => {
        if (evt && evt.target && evt.target.closest && evt.target.closest('button.kpi-action')) {
            return;
        }
        openSalesModal();
    };

    kpiArticle.addEventListener('click', openHandler);
    kpiArticle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openHandler(e);
        }
    });

    const actionBtn = kpiArticle.querySelector('.kpi-action, button.kpi-action');
    if (actionBtn) {
        actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openSalesModal();
        });
    }
})();

// Attach modal close handlers (low stock)
if (lowStockModalClose) lowStockModalClose.addEventListener('click', closeLowStockModal);
if (lowStockModalOk) lowStockModalOk.addEventListener('click', closeLowStockModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLowStockModal(); });

// Start subscriptions
subscribeKpisRealtime();
subscribeLowStockRealtime();