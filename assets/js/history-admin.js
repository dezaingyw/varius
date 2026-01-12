// assets/js/history-admin.js
// Versión funcional conservando la estructura original y con KPIs sobre los filtros.
// - KPIs (arriba de filtros): veces compradas, monto total gastado, cantidad total de productos
// - Una sola tabla de pedidos (Fecha | Total por compra | Productos | Estado de pago)
// - Totales consideran solo órdenes pagadas
// - Export CSV mantiene la información completa

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, query, orderBy, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM refs (manteniendo nombres originales donde aplicaba)
const histFrom = document.getElementById('histFrom');
const histTo = document.getElementById('histTo');
const histSearch = document.getElementById('histSearch');
const applyHistFilters = document.getElementById('applyHistFilters');
const clearHistFilters = document.getElementById('clearHistFilters');
const histOrdersContainer = document.getElementById('histOrdersContainer');
const exportCsvBtn = document.getElementById('exportCsv');
const toastEl = document.getElementById('toast');

const kpiPurchasesEl = document.getElementById('kpi-purchases');
const kpiTotalEl = document.getElementById('kpi-total');
const kpiProductsEl = document.getElementById('kpi-products');

let currentUser = null;
let currentUserRole = null;

function showToast(msg, ms = 3500) {
    if (!toastEl) { alert(msg); return; }
    toastEl.textContent = msg; toastEl.classList.remove('hidden'); toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => { toastEl.classList.remove('show'); toastEl.classList.add('hidden'); }, ms);
}
function qParam(name) { const p = new URLSearchParams(window.location.search); return p.get(name) || ''; }

function formatCurrency(amount) {
    try {
        return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(amount || 0));
    } catch (e) {
        return String(amount || 0);
    }
}
function escapeHtml(s) { if (s === null || s === undefined) return ''; return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;' }[c] || c)); }

/**
 * Considera una orden como "pagada" si su paymentStatus contiene palabras comunes
 */
function isOrderPaid(o) {
    if (!o) return false;
    const status = (o.paymentStatus || '') + '';
    return /paid|pagado|pagada|completado|completa/i.test(status);
}

async function fetchHistory({ fromDate, toDate, searchTerm, customerIdParam }) {
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, orderBy('orderDate', 'desc'));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(s => items.push({ id: s.id, ...s.data() }));

    let filtered = items;

    // Filtrar por rol si aplica (mantener compatibilidad con versión previa)
    if (currentUserRole === 'vendedor') filtered = filtered.filter(o => o.assignedSeller === currentUser.uid || (o.createdBy && o.createdBy === currentUser.uid));
    else if (currentUserRole === 'motorizado') filtered = filtered.filter(o => o.assignedMotor === currentUser.uid);

    if (customerIdParam) {
        filtered = filtered.filter(o => {
            const cid = (o.customerData && (o.customerData.uid || o.customerId || o.customerData.customerId)) || o.customerId || '';
            return (cid && cid === customerIdParam) || (o.customerData && (o.customerData.email === customerIdParam || o.customerData.phone === customerIdParam));
        });
    }

    if (fromDate || toDate) {
        const from = fromDate ? new Date(fromDate) : null;
        const to = toDate ? new Date(toDate) : null;
        filtered = filtered.filter(o => {
            if (!o.orderDate) return false;
            const od = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
            if (from && od < from) return false;
            if (to) {
                const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59);
                if (od > end) return false;
            }
            return true;
        });
    }

    if (searchTerm) {
        const s = searchTerm.toLowerCase();
        filtered = filtered.filter(o => {
            const name = (o.customerData && (o.customerData.name || o.customerData.Customname || '')) || '';
            const phone = (o.customerData && (o.customerData.phone || '')) || '';
            return (name && name.toLowerCase().includes(s)) || (phone && phone.toLowerCase().includes(s));
        });
    }

    return filtered;
}

/**
 * Calcula KPIs: purchases (órdenes pagadas), totalSpent (suma totales pagados),
 * productsCount (cantidad total de productos en órdenes pagadas).
 */
function computeKPIs(orders) {
    let purchases = 0;
    let totalSpent = 0;
    let productsCount = 0;
    let paidCount = 0;
    let unpaidCount = 0;

    for (const o of orders) {
        if (isOrderPaid(o)) {
            paidCount++;
            purchases++;
            totalSpent += Number(o.total || 0);
            const items = Array.isArray(o.items) ? o.items : [];
            for (const it of items) {
                const qty = Number(it.quantity || it.qty || it.cantidad || it.cant || 1) || 1;
                productsCount += qty;
            }
        } else {
            unpaidCount++;
        }
    }

    return { purchases, totalSpent, productsCount, ordersTotalCount: orders.length, paidCount, unpaidCount };
}

function renderKPIs(kpis) {
    if (kpiPurchasesEl) kpiPurchasesEl.textContent = String(kpis.purchases || 0);
    if (kpiTotalEl) kpiTotalEl.textContent = formatCurrency(kpis.totalSpent || 0);
    if (kpiProductsEl) kpiProductsEl.textContent = String(kpis.productsCount || 0);
}

function buildProductsText(items) {
    if (!Array.isArray(items) || items.length === 0) return '—';
    const parts = items.map(it => {
        const name = it.name || it.title || it.productName || (it.product && it.product.name) || 'Producto';
        const qty = Number(it.quantity || it.qty || it.cantidad || it.cant || 1) || 1;
        return qty > 1 ? `${name} (x${qty})` : name;
    });
    if (parts.length <= 3) return parts.join(', ');
    const first = parts.slice(0, 3).join(', ');
    const more = parts.length - 3;
    return `${first} … (+${more} más)`;
}

function renderHistoryOrders(orders) {
    histOrdersContainer.innerHTML = '';
    if (!orders.length) { histOrdersContainer.innerHTML = '<div class="small-muted">No hay pedidos que coincidan.</div>'; return; }

    const tbl = document.createElement('table'); tbl.className = 'history-table';
    const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>Fecha</th><th>Total</th><th>Productos</th><th>Estado de Pago</th></tr>';
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');

    orders.forEach(o => {
        const tr = document.createElement('tr');
        const d = o.orderDate ? (o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate)) : null;
        const dateStr = d ? d.toLocaleString('es-ES') : '—';
        const totalStr = o.total ? formatCurrency(o.total) : '—';
        const prodText = buildProductsText(Array.isArray(o.items) ? o.items : []);
        const pay = o.paymentStatus || (isOrderPaid(o) ? 'Pagado' : 'Pendiente');

        tr.innerHTML = `<td data-label="Fecha">${escapeHtml(dateStr)}</td>
                        <td data-label="Total">${escapeHtml(totalStr)}</td>
                        <td data-label="Productos">${escapeHtml(prodText)}</td>
                        <td data-label="Estado de Pago">${escapeHtml(pay)}</td>`;
        tbody.appendChild(tr);
    });

    tbl.appendChild(tbody);
    histOrdersContainer.appendChild(tbl);

    const kpis = computeKPIs(orders);
    const totalDiv = document.createElement('div');
    totalDiv.className = 'total-summary';
    totalDiv.innerHTML = `<div>Gasto total:</div><div>${formatCurrency(kpis.totalSpent || 0)}</div>`;
    histOrdersContainer.appendChild(totalDiv);
}

function exportOrdersToCsv(orders) {
    if (!orders || !orders.length) { showToast('No hay datos para exportar'); return; }
    const rows = [];
    rows.push(['orderId', 'date', 'customerName', 'customerPhone', 'itemsDetail', 'itemsCount', 'total', 'paymentStatus', 'incluidoEnTotales']);
    for (const o of orders) {
        const d = o.orderDate ? (o.orderDate.toDate ? o.orderDate.toDate().toISOString() : new Date(o.orderDate).toISOString()) : '';
        const name = o.customerData && (o.customerData.name || o.customerData.Customname || '') || '';
        const phone = o.customerData && (o.customerData.phone || '') || '';
        const itemsArr = Array.isArray(o.items) ? o.items.map(it => {
            const n = it.name || it.title || it.productName || (it.product && it.product.name) || 'Producto';
            const q = Number(it.quantity || it.qty || it.cantidad || it.cant || 1) || 1;
            return `${n} (x${q})`;
        }) : [];
        const itemsCount = Array.isArray(o.items) ? o.items.reduce((s, it) => s + (Number(it.quantity || it.qty || it.cantidad || it.cant || 1) || 1), 0) : 0;
        const total = String(o.total || 0);
        const payment = String(o.paymentStatus || '');
        const included = isOrderPaid(o) ? 'sí' : 'no';
        rows.push([o.id, d, name, phone, itemsArr.join(' | '), String(itemsCount), total, payment, included]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `historial_${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function loadAndRender() {
    const from = histFrom.value || null;
    const to = histTo.value || null;
    const search = (histSearch.value || '').trim();
    const customerIdParam = qParam('customerId') || qParam('phone') || qParam('name') || '';

    histOrdersContainer.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><div class="loader" aria-hidden="true"></div><div>Cargando pedidos...</div></div>';

    try {
        const orders = await fetchHistory({ fromDate: from, toDate: to, searchTerm: search, customerIdParam });
        renderHistoryOrders(orders);
        const kpis = computeKPIs(orders);
        renderKPIs(kpis);
        exportCsvBtn.onclick = () => exportOrdersToCsv(orders);
    } catch (err) {
        console.error('Error loading history:', err);
        histOrdersContainer.innerHTML = '<div class="small-muted">Error cargando historial (ver consola).</div>';
        showToast('Error cargando historial (ver consola)');
    }
}

applyHistFilters.addEventListener('click', loadAndRender);
clearHistFilters.addEventListener('click', () => { histFrom.value = ''; histTo.value = ''; histSearch.value = ''; loadAndRender(); });

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '/index.html'; return; }
    currentUser = user;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
    } catch (err) {
        console.error('Error fetching user role:', err);
        currentUserRole = 'vendedor';
    }
    const nameParam = qParam('name') || '';
    const phoneParam = qParam('phone') || '';
    if (nameParam && !histSearch.value) histSearch.value = nameParam;
    if (phoneParam && !histSearch.value) histSearch.value = phoneParam;
    await loadAndRender();
});
