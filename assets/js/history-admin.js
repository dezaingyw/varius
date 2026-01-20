// assets/js/history-admin.js
// Versión con badges en columna "Estado de Pago", fila naranja (#fff7ed) para pendientes,
// y restaurado el nombre del cliente mostrado junto al título.

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

// CORRECCIÓN: usar los IDs actuales en history.html
const kpiPurchasesEl = document.getElementById('kpi-purchases-amount');
const kpiTotalEl = document.getElementById('kpi-total-amount');
const kpiProductsEl = document.getElementById('kpi-products-amount');

// Restaurar referencia al elemento que muestra el nombre del cliente
const clientNameEl = document.getElementById('clientName');

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

        // Build payment status badge and apply pending-row for non-paid
        let payHtml = '';
        if (isOrderPaid(o)) {
            payHtml = `<span class="status-badge status-activo">Pagado</span>`;
        } else {
            payHtml = `<span class="status-badge status-inactivo">Pendiente</span>`;
            tr.classList.add('pending-row');
        }

        tr.innerHTML = `<td data-label="Fecha">${escapeHtml(dateStr)}</td>
                        <td data-label="Total">${escapeHtml(totalStr)}</td>
                        <td data-label="Productos">${escapeHtml(prodText)}</td>
                        <td data-label="Estado de Pago">${payHtml}</td>`;
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
    const from = histFrom ? histFrom.value : null;
    const to = histTo ? histTo.value : null;
    const search = (histSearch && histSearch.value || '').trim();
    const customerIdParam = qParam('customerId') || qParam('phone') || qParam('name') || '';

    histOrdersContainer.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><div class="loader" aria-hidden="true"></div><div>Cargando pedidos...</div></div>';

    try {
        const orders = await fetchHistory({ fromDate: from, toDate: to, searchTerm: search, customerIdParam });
        renderHistoryOrders(orders);
        const kpis = computeKPIs(orders);
        renderKPIs(kpis);
        if (exportCsvBtn) exportCsvBtn.onclick = () => exportOrdersToCsv(orders);

        // Mostrar nombre del cliente si está disponible: preferir query param customerName,
        // sino intentar extraerlo de la primera orden encontrada.
        let clientName = qParam('customerName') || qParam('name') || '';
        if (!clientName && orders.length > 0) {
            const o = orders.find(x => x.customerData && (x.customerData.name || x.customerData.Customname));
            if (o && o.customerData) clientName = o.customerData.name || o.customerData.Customname || '';
        }
        if (clientName && clientNameEl) {
            clientNameEl.textContent = clientName;
            clientNameEl.style.display = 'inline-block';
        } else if (clientNameEl) {
            clientNameEl.textContent = '';
            clientNameEl.style.display = 'none';
        }
    } catch (err) {
        console.error('Error loading history:', err);
        histOrdersContainer.innerHTML = '<div class="small-muted">Error cargando historial (ver consola).</div>';
        showToast('Error cargando historial (ver consola)');
    }
}

if (applyHistFilters) applyHistFilters.addEventListener('click', loadAndRender);
if (clearHistFilters) clearHistFilters.addEventListener('click', () => { if (histFrom) histFrom.value = ''; if (histTo) histTo.value = ''; if (histSearch) histSearch.value = ''; loadAndRender(); });

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
    if (nameParam && histSearch && !histSearch.value) histSearch.value = nameParam;
    if (phoneParam && histSearch && !histSearch.value) histSearch.value = phoneParam;

    // Si viene customerName via query string, mostrarla inmediatamente
    const immediateName = qParam('customerName') || qParam('name') || '';
    if (immediateName && clientNameEl) {
        clientNameEl.textContent = immediateName;
        clientNameEl.style.display = 'inline-block';
    }

    await loadAndRender();
});