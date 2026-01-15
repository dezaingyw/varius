// assets/js/vendedor-orders.js
// Versión para vendedores sin funcionalidad de chat.
// Mantiene: filtros (estado, fecha, cliente), modales, edición, marcar enviado (condicionado a motorizado), export CSV, responsive, etc.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    orderBy,
    onSnapshot,
    doc,
    getDoc,
    updateDoc,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ================= DOM REFS ================= */
const tbody = document.getElementById('ordersTbody');
const ordersCards = document.getElementById('ordersCards');
const toastEl = document.getElementById('toast');

const filterStatus = document.getElementById('filter-status');
const filterDate = document.getElementById('filter-date');
const filterClient = document.getElementById('filter-client');
const btnFilter = document.getElementById('btnFilter');
const btnClear = document.getElementById('btnClear');
const refreshBtn = document.getElementById('refreshBtn');

const viewModal = document.getElementById('order-view-modal');
const viewBody = document.getElementById('view-order-body');
const viewClose = document.getElementById('view-close');
const viewCloseBottom = document.getElementById('view-close-bottom');

const editModal = document.getElementById('order-edit-modal');
const editForm = document.getElementById('edit-order-form');
const editClose = document.getElementById('edit-close');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const editCustomer = document.getElementById('edit-customer');
const editMotorizadoSelect = document.getElementById('edit-motorizado');
const editMotorizadoFree = document.getElementById('edit-motorizado-free'); // opcional libre
const editMotComment = document.getElementById('edit-motorizado-comment');
const itemsList = document.getElementById('items-list');
const editItemsArea = document.getElementById('edit-items-area'); // contenedor de items + productos disponibles
const addItemBtn = document.getElementById('add-item-btn');
const newItemName = document.getElementById('new-item-name');
const newItemPrice = document.getElementById('new-item-price');
const newItemQty = document.getElementById('new-item-qty');
const editTotal = document.getElementById('edit-total');

const downloadCsvBtn = document.getElementById('downloadCsv');

let currentUser = null;
let currentUserRole = 'vendedor'; // 'admin' | 'vendedor' | 'motorizado'
let orders = [];
let filteredOrders = [];
let ordersUnsubscribe = null;
let currentEditOrder = null;
let currentViewOrder = null;

let motorizados = [];
let availableProducts = [];

/* ================= HELPERS ================= */
function showToast(text, timeout = 3000) {
    if (!toastEl) { console.log('TOAST:', text); return; }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), timeout);
}

function formatDateFlexible(val) {
    if (!val) return '';
    if (val && typeof val.toDate === 'function') return val.toDate().toLocaleString();
    try {
        const d = new Date(val);
        if (!isNaN(d)) return d.toLocaleString();
    } catch { }
    return String(val);
}

function money(val) {
    const n = Number(val) || 0;
    return n.toLocaleString();
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function isMobileViewport() {
    return window.matchMedia('(max-width:700px)').matches;
}

function toBadgeClass(text) {
    if (!text) return '';
    return String(text).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-áéíóúñ]/g, '');
}

function translateStatus(raw) {
    if (!raw && raw !== 0) return '';
    const s = String(raw).trim().toLowerCase();
    const map = {
        'delivered': 'Entregado',
        'entregado': 'Entregado',
        'delivering': 'En entrega',
        'enruta': 'En ruta',
        'en ruta': 'En ruta',
        'paid': 'Pagado',
        'pagado': 'Pagado',
        'pending': 'Pendiente',
        'pendiente': 'Pendiente',
        'failed': 'Fallido',
        'fallido': 'Fallido',
        'asignado': 'Asignado',
        'assigned': 'Asignado',
        'suspendido': 'Suspendido',
        'suspended': 'Suspendido',
        'cancelado': 'Cancelado',
        'cancelled': 'Cancelado',
        'entrega programada': 'Entrega programada',
        'enviado': 'Enviado',
        'enviado al motorizado': 'Enviado'
    };
    if (map[s]) return map[s];
    return String(raw).charAt(0).toUpperCase() + String(raw).slice(1);
}

function getIconSvg(name, size = 16) {
    switch ((name || '').toLowerCase()) {
        case 'eye': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/></svg>`;
        case 'pencil': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" viewBox="0 0 16 16"><path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/><path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>`;
        case 'clock': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" viewBox="0 0 16 16"><path d="M8.515 1.019A7 7 0 0 0 8 1V0a8 8 0 0 1 .589.022zm2.004.45a7 7 0 0 0-.985-.299l.219-.976q.576.129 1.126.342zm1.37.71a7 7 0 0 0-.439-.27l.493-.87a8 8 0 0 1 .979.654l-.615.789a7 7 0 0 0-.418-.302zm1.834 1.79a7 7 0 0 0-.653-.796l.724-.69q.406.429.747.91zm.744 1.352a7 7 0 0 0-.214-.468l.893-.45a8 8 0 0 1 .45 1.088l-.95.313a7 7 0 0 0-.179-.483m.53 2.507a7 7 0 0 0-.1-1.025l.985-.17q.1.58.116 1.17zm-.131 1.538q.05-.254.081-.51l.993.123a8 8 0 0 1-.23 1.155l-.964-.267q.069-.247.12-.501m-.952 2.379q.276-.436.486-.908l.914.405q-.24.54-.555 1.038zm-.964 1.205q.183-.183.350-.378l.758.653a8 8 0 0 1-.401.432z"/><path d="M8 1a7 7 0 1 0 4.95 11.95l.707.707A8.001 8.001 0 1 1 8 0z"/><path d="M7.5 3a.5.5 0 0 1 .5.5v5.21l3.248 1.856a.5.5 0 0 1-.496.868l-3.5-2A.5.5 0 0 1 7 9V3.5a.5.5 0 0 1 .5-.5"/></svg>`;
        case 'x-circle': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>`;
        default: return '';
    }
}

/* ================= FIELD ERRORS ================= */
function clearFieldErrors(container = document) {
    const errs = container.querySelectorAll('.field-error');
    errs.forEach(e => e.remove());
}
function showFieldError(element, message) {
    if (!element) return;
    const next = element.nextElementSibling;
    if (next && next.classList && next.classList.contains('field-error')) next.remove();
    const el = document.createElement('div');
    el.className = 'field-error';
    el.style.color = '#b91c1c';
    el.style.fontSize = '12px';
    el.style.marginTop = '6px';
    el.textContent = message;
    if (element.parentNode) element.parentNode.insertBefore(el, element.nextSibling);
    if (typeof element.focus === 'function') element.focus();
}

/* ================= HELPERS: history url ================= */
function buildHistoryUrlFromOrder(order) {
    try {
        const od = order && order.data ? order.data : order || {};
        const custData = od.customerData || od.customer || {};
        const custId = custData.uid || od.customerId || custData.customerId || '';
        const custName = custData.name || custData.Customname || od.customerName || '';
        const custPhone = custData.phone || custData.telefono || custData.mobile || '';
        const params = new URLSearchParams();
        if (custId) params.set('customerId', custId);
        if (custName) params.set('name', custName);
        if (custPhone) params.set('phone', custPhone);
        const q = params.toString();
        return q ? `history.html?${q}` : 'history.html';
    } catch (err) { console.warn('buildHistoryUrlFromOrder error', err); return 'history.html'; }
}

/* ================= RENDERERS ================= */
function render(list) {
    renderTable(list);
    renderCards(list);
}

/* Table renderer */
function renderTable(list) {
    if (!tbody) return;
    tbody.innerHTML = '';
    list.forEach(o => {
        const tr = document.createElement('tr');

        const idTd = document.createElement('td'); idTd.textContent = o.id || ''; tr.appendChild(idTd);

        const clientTd = document.createElement('td');
        const cname = (o.data && o.data.customerData && (o.data.customerData.Customname || o.data.customerData.name)) || (o.data && o.data.customer && o.data.customer.name) || 'Sin nombre';
        const clienteReg = (o.data && o.data.customerData && o.data.customerData.clienteReg) || '';
        clientTd.innerHTML = `<div style="font-weight:700">${escapeHtml(cname)}</div><div class="small-muted">${escapeHtml(clienteReg)}</div>`;
        tr.appendChild(clientTd);

        const dateTd = document.createElement('td'); dateTd.textContent = formatDateFlexible(o.data && (o.data.orderDate || o.data.timestamp || o.data.assignedAt)); tr.appendChild(dateTd);

        const totalTd = document.createElement('td'); totalTd.textContent = money(o.data && (o.data.total || o.data.amount)); tr.appendChild(totalTd);

        const sellerTd = document.createElement('td'); sellerTd.textContent = (o.data && (o.data.assignedSellerName || o.data.assignedSellerEmail || o.data.assignedSeller)) || 'Sin vendedor'; tr.appendChild(sellerTd);

        const motoTd = document.createElement('td');
        const motoname = (o.data && (o.data.assignedMotorizedName || o.data.assignedMotorName || o.data.assignedMotor || o.data.assignedMotorEmail || o.data.motorizadoName)) || '';
        motoTd.innerHTML = motoname ? escapeHtml(motoname) : `<span class="state-badge">POR ASIGNAR</span>`;
        tr.appendChild(motoTd);

        const statusTd = document.createElement('td');
        const rawStatus = (o.data && o.data.status) || '';
        const rawShipping = (o.data && o.data.shippingStatus) || '';
        const rawPayment = (o.data && o.data.paymentStatus) || '';

        const shippingTranslated = translateStatus(rawShipping);
        const paymentTranslated = translateStatus(rawPayment);
        let displayStatus = translateStatus(rawStatus);

        if (String(rawStatus || '').toLowerCase() === 'asignado' || String(rawStatus || '').toLowerCase() === 'assigned') {
            if (rawPayment) displayStatus = paymentTranslated || displayStatus;
        }

        const isDelivered = rawShipping && (String(rawShipping).toLowerCase() === 'entregado' || String(rawShipping).toLowerCase() === 'delivered');
        if (isDelivered) {
            statusTd.innerHTML = `<span class="badge paid">${escapeHtml('Pagado')}</span>`;
        } else {
            const cls = toBadgeClass(displayStatus);
            statusTd.innerHTML = `<span class="badge ${cls}">${escapeHtml(displayStatus || '')}</span>`;
        }
        tr.appendChild(statusTd);

        const actionsTd = document.createElement('td');
        const rowActions = document.createElement('div'); rowActions.className = 'row-actions';

        if (isDelivered) {
            const deliveredSpan = document.createElement('span');
            deliveredSpan.className = 'badge delivered';
            deliveredSpan.textContent = 'Entregado';
            rowActions.appendChild(deliveredSpan);

            const histBtn = document.createElement('button');
            histBtn.className = 'btn-small btn-history';
            histBtn.title = 'Historial de Cliente';
            histBtn.innerHTML = `${getIconSvg('clock', 14)}`;
            histBtn.addEventListener('click', () => { const url = buildHistoryUrlFromOrder(o); window.location.href = url; });
            rowActions.appendChild(histBtn);
        } else {
            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn-small btn-view';
            viewBtn.title = 'Ver detalles';
            viewBtn.innerHTML = `${getIconSvg('eye', 14)}`;
            viewBtn.addEventListener('click', () => openViewModal(o));
            rowActions.appendChild(viewBtn);

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-small btn-assign';
            editBtn.title = 'Editar Pedido';
            editBtn.innerHTML = `${getIconSvg('pencil', 14)}`;
            editBtn.addEventListener('click', () => openEditModal(o));
            rowActions.appendChild(editBtn);

            const histBtn = document.createElement('button');
            histBtn.className = 'btn-small btn-history';
            histBtn.title = 'Historial de Cliente';
            histBtn.innerHTML = `${getIconSvg('clock', 14)}`;
            histBtn.addEventListener('click', () => { const url = buildHistoryUrlFromOrder(o); window.location.href = url; });
            rowActions.appendChild(histBtn);

            const suspBtn = document.createElement('button');
            suspBtn.className = 'btn-small btn-suspender';
            suspBtn.title = 'Suspender este pedido';
            suspBtn.innerHTML = `${getIconSvg('x-circle', 14)}`;
            suspBtn.addEventListener('click', () => suspendOrder(o));
            rowActions.appendChild(suspBtn);
        }

        // Marcar enviado: solo si motorizado asignado y no enviado/entregado
        const shipped = (o.data && (o.data.shippingStatus || '')).toString().toLowerCase();
        const motAssigned = Boolean(o.data && (o.data.assignedMotor || o.data.assignedMotorizedName || o.data.assignedMotorName || o.data.assignedMotorEmail));
        if (!isDelivered) {
            const markBtn = document.createElement('button');
            markBtn.className = 'btn-small btn-mark-sent';
            markBtn.textContent = 'Marcar enviado';
            markBtn.title = motAssigned ? 'Marcar como enviado' : 'Requiere motorizado asignado';
            markBtn.disabled = !motAssigned || shipped === 'enviado' || shipped === 'entregado' || shipped === 'delivered';
            markBtn.addEventListener('click', async () => {
                if (!motAssigned) { showToast('No hay motorizado asignado. Asigna uno antes.', 3000); return; }
                try {
                    await updateDoc(doc(db, 'orders', o.id), { shippingStatus: 'enviado', shippingUpdatedAt: serverTimestamp() });
                    showToast('Pedido marcado como enviado.');
                } catch (err) {
                    console.error('Error marcando enviado:', err);
                    showToast('No se pudo marcar como enviado.', 3000);
                }
            });
            rowActions.appendChild(markBtn);
        }

        actionsTd.appendChild(rowActions); tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

/* Cards for mobile */
function renderCards(list) {
    if (!ordersCards) return;
    ordersCards.innerHTML = '';
    list.forEach(o => {
        const card = document.createElement('div'); card.className = 'order-card';
        const cname = (o.data && o.data.customerData && (o.data.customerData.Customname || o.data.customerData.name)) || (o.data && o.data.customer && o.data.customer.name) || 'Sin nombre';
        const address = (o.data && o.data.customerData && o.data.customerData.address) || (o.data && o.data.readable_address) || '';
        const items = (o.data && o.data.items) || [];
        const rawStatus = (o.data && o.data.status) || 'pendiente';
        const rawShipping = (o.data && o.data.shippingStatus) || '';
        const rawPayment = (o.data && o.data.paymentStatus) || '';
        const shippingTranslated = translateStatus(rawShipping);
        const paymentTranslated = translateStatus(rawPayment);
        let displayStatus = translateStatus(rawStatus);
        if (String(rawStatus || '').toLowerCase() === 'asignado' || String(rawStatus || '').toLowerCase() === 'assigned') {
            if (rawPayment) displayStatus = paymentTranslated || displayStatus;
        }
        const isDelivered = rawShipping && (String(rawShipping).toLowerCase() === 'entregado' || String(rawShipping).toLowerCase() === 'delivered');

        const viewBtnHtml = `<button class="order-card-btn" data-action="view" data-id="${o.id}" title="Ver">${getIconSvg('eye', 14)} <span style="margin-left:6px">Ver</span></button>`;
        const editBtnHtml = `<button class="order-card-btn" data-action="edit" data-id="${o.id}" title="Editar">${getIconSvg('pencil', 14)} <span style="margin-left:6px">Editar</span></button>`;
        const histBtnHtml = `<button class="order-card-btn" data-action="history" data-id="${o.id}" title="Historial">${getIconSvg('clock', 14)} <span style="margin-left:6px">Historial</span></button>`;
        const actionsHtml = isDelivered ? `${histBtnHtml}` : `${viewBtnHtml}${editBtnHtml}${histBtnHtml}`;

        card.innerHTML = `
      <div class="order-card-header">
        <div class="order-card-avatar"><img src="assets/img/avatar-placeholder.png" alt=""></div>
        <div class="order-card-cust">
          <div class="order-card-cust-name">${escapeHtml(cname)}</div>
          <div class="order-card-cust-address">${escapeHtml(address)}</div>
        </div>
        <div class="order-card-info">
          <div class="order-card-total">${money(o.data && (o.data.total || o.data.amount))}</div>
        </div>
      </div>
      <div class="order-card-prod">
        <strong>Productos:</strong>
        <ul>
          ${items.map(it => `<li>${escapeHtml(it.name)} x${escapeHtml(String(it.quantity || it.qty || 1))}</li>`).join('')}
        </ul>
      </div>
      <div class="order-card-status"><span class="badge ${isDelivered ? 'delivered' : toBadgeClass(displayStatus)}">${isDelivered ? 'Entregado' : escapeHtml(displayStatus)}</span></div>
      <div class="order-card-actions">
        ${actionsHtml}
      </div>
    `;
        card.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const a = btn.getAttribute('data-action');
                if (a === 'view') openViewModal(o);
                if (a === 'edit') openEditModal(o);
                if (a === 'history') {
                    const url = buildHistoryUrlFromOrder(o);
                    window.location.href = url;
                }
            });
        });
        ordersCards.appendChild(card);
    });
}

/* ================= FILTERS ================= */
function applyFilters() {
    const s = (filterStatus && filterStatus.value) || '';
    const d = (filterDate && filterDate.value) || '';
    const c = (filterClient && filterClient.value || '').toLowerCase();

    filteredOrders = orders.filter(o => {
        const od = o.data || {};
        if (s) {
            const rawStatus = (od.status || '').toLowerCase();
            const rawShipping = (od.shippingStatus || '').toLowerCase();
            const rawPayment = (od.paymentStatus || '').toLowerCase();
            if (!(rawStatus === s.toLowerCase() || rawShipping === s.toLowerCase() || rawPayment === s.toLowerCase())) return false;
        }
        if (d) {
            let odDate = '';
            const dField = od.orderDate || od.timestamp || od.assignedAt;
            if (dField && typeof dField.toDate === 'function') odDate = dField.toDate().toISOString().slice(0, 10);
            else if (typeof dField === 'string') odDate = (new Date(dField)).toISOString().slice(0, 10);
            if (!odDate || odDate !== d) return false;
        }
        if (c) {
            const cname = ((od.customerData && (od.customerData.Customname || od.customerData.name)) || (od.customer && od.customer.name) || '').toLowerCase();
            if (!cname.includes(c)) return false;
        }
        return true;
    });

    render(filteredOrders);
}

/* ================= FIRESTORE QUERY & LISTENER ================= */
function listenOrdersForSeller(uid) {
    if (ordersUnsubscribe) { ordersUnsubscribe(); ordersUnsubscribe = null; }
    try {
        const col = collection(db, 'orders');
        const q = query(col, where('assignedSeller', '==', uid), orderBy('orderDate', 'desc'));
        ordersUnsubscribe = onSnapshot(q, snap => {
            orders = [];
            snap.forEach(docSnap => orders.push({ id: docSnap.id, data: docSnap.data() }));
            orders.sort((a, b) => {
                const at = a.data && (a.data.orderDate || a.data.timestamp);
                const bt = b.data && (b.data.orderDate || b.data.timestamp);
                const atMs = at && typeof at.toDate === 'function' ? at.toDate().getTime() : (new Date(at)).getTime();
                const btMs = bt && typeof bt.toDate === 'function' ? bt.toDate().getTime() : (new Date(bt)).getTime();
                return (btMs || 0) - (atMs || 0);
            });
            applyFilters();
            showToast(`Pedidos cargados: ${orders.length}`, 900);
        }, err => {
            console.error('onSnapshot error:', err);
            showToast('No se pudieron cargar pedidos. Revisa la consola.');
        });
    } catch (err) {
        console.error('listenOrdersForSeller error', err);
        showToast('No se pudieron cargar pedidos. Revisa la consola.');
    }
}

/* ================= VIEW / EDIT / SUSPEND ================= */
function openViewModal(order) {
    currentViewOrder = order;
    const o = order.data || {};
    const cname = (o.customerData && (o.customerData.Customname || o.customerData.name)) || 'Sin nombre';
    const address = (o.customerData && o.customerData.address) || o.readable_address || '';
    const items = o.items || [];

    if (!viewBody) return;

    const productsHtml = `
      <div class="card products-card" style="border-radius:8px;padding:12px;">
        <h4 style="margin:0 0 10px 0;font-size:16px;">Productos (${items.length})</h4>
        <div style="overflow:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left;color:#6b7280;font-size:13px;border-bottom:1px solid #e5e7eb;">
                <th style="padding:10px 6px;width:80px;">Imagen</th>
                <th style="padding:10px 6px;">Producto</th>
                <th style="padding:10px 6px;width:80px;text-align:center;">Cant.</th>
                <th style="padding:10px 6px;width:140px;text-align:right;">Precio unit.</th>
                <th style="padding:10px 6px;width:140px;text-align:right;">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(it => {
        const qty = Number(it.quantity || it.qty || 1);
        const price = Number(it.price || it.unitPrice || it.subtotal || 0);
        const subtotal = qty * price;
        const imgSrc = (it.imageUrl && String(it.imageUrl).trim()) || (it.image && String(it.image).trim()) || '';
        const hasImg = /^https?:\/\//i.test(imgSrc);
        const imgHtml = hasImg
            ? `<img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(it.name || '')}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;">`
            : `<div style="width:56px;height:56px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;border-radius:6px;color:#9aa0a6;font-weight:700;font-size:12px;">${escapeHtml((it.name || '').slice(0, 2).toUpperCase() || 'IMG')}</div>`;
        return `<tr style="border-bottom:1px solid #eef2f6;">
                            <td style="padding:10px 6px;vertical-align:middle;">${imgHtml}</td>
                            <td style="padding:10px 6px;vertical-align:middle;"><div style="font-weight:700">${escapeHtml(it.name || 'Producto')}</div></td>
                            <td style="padding:10px 6px;vertical-align:middle;text-align:center;">${escapeHtml(String(qty))}</td>
                            <td style="padding:10px 6px;vertical-align:middle;text-align:right;color:#111;">${money(price)}</td>
                            <td style="padding:10px 6px;vertical-align:middle;text-align:right;color:#111;">${money(subtotal)}</td>
                          </tr>`;
    }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const shippingTranslated = translateStatus(o.shippingStatus);
    const paymentTranslated = translateStatus(o.paymentStatus);
    const statusTranslated = translateStatus(o.status);

    viewBody.innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start;">
      <div style="min-width:160px;"><div class="thumb" style="width:120px;height:120px;"></div></div>
      <div style="flex:1;">
        <h3 style="margin:0 0 6px 0">${escapeHtml(cname)} <small style="float:right">${money(o.total)}</small></h3>
        <div class="small-muted">${escapeHtml(address)}</div>
        <div style="margin-top:8px;">
          <strong>Vendedor:</strong> ${escapeHtml(o.assignedSellerName || o.assignedSellerEmail || o.assignedSeller || 'Sin vendedor')}<br/>
          <strong>Motorizado:</strong> ${(o.assignedMotorizedName || o.assignedDriverName || o.motorizadoName) ? escapeHtml(o.assignedMotorizedName || o.assignedDriverName || o.motorizadoName) : '<em>POR ASIGNAR</em>'}<br/>
          <strong>Estado pedido:</strong> ${escapeHtml(statusTranslated || '')}<br/>
          <strong>Estado envío:</strong> ${escapeHtml(shippingTranslated || '')}<br/>
          <strong>Estado pago:</strong> ${escapeHtml(paymentTranslated || '')}<br/>
          <strong>Fecha:</strong> ${formatDateFlexible(o.orderDate || o.timestamp || o.assignedAt)}
        </div>
      </div>
    </div>
    <hr/>
    ${productsHtml}
    `;

    viewModal && viewModal.classList.remove('hidden');
    viewModal && viewModal.setAttribute('aria-hidden', 'false');
}

function closeViewModal() {
    viewModal && viewModal.classList.add('hidden');
    viewModal && viewModal.setAttribute('aria-hidden', 'true');
    currentViewOrder = null;
}

/* ================= EDIT MODAL ================= */
// Implementation follows the same logic as in orders.js (omitted here for brevity but intact below)
function openEditModal(order) {
    clearFieldErrors();
    currentEditOrder = JSON.parse(JSON.stringify(order));
    const o = currentEditOrder.data || {};
    if (editCustomer) editCustomer.textContent = (o.customerData && (o.customerData.Customname || o.customerData.name)) || 'Sin nombre';
    populateMotorizadoSelect();
    const assignedMotorId = o.assignedMotor || '';
    const assignedMotorEmail = o.assignedMotorName || o.assignedMotorEmail || '';
    const assignedMotorNameVal = o.assignedMotorizedName || o.assignedDriverName || o.motorizadoName || '';
    if (editMotorizadoSelect) {
        if (assignedMotorId) {
            editMotorizadoSelect.value = assignedMotorId;
        } else {
            const found = motorizados.find(m => (m.email && String(m.email) === String(assignedMotorEmail)) || (m.name && String(m.name) === String(assignedMotorNameVal)));
            if (found) editMotorizadoSelect.value = found.id;
            else editMotorizadoSelect.value = '';
        }
    }
    if (editMotorizadoFree) editMotorizadoFree.value = '';
    if (editMotComment) editMotComment.value = '';
    buildItemsList(o.items || []);
    computeEditTotal();
    renderAvailableProductsList();
    editModal && editModal.classList.remove('hidden');
    editModal && editModal.setAttribute('aria-hidden', 'false');
}

function closeEditModal() {
    editModal && editModal.classList.add('hidden');
    editModal && editModal.setAttribute('aria-hidden', 'true');
    currentEditOrder = null;
}

/* ================= MOTORIZADOS, PRODUCTS, ITEMS, SAVE, SUSPEND ================= */
/* The functions loadMotorizados, populateMotorizadoSelect, loadAvailableProducts,
   renderAvailableProductsList, buildItemsList, computeEditTotal, saveEditForm,
   suspendOrder and CSV export are the same as in the previous full implementation.
   For brevity in this response they are included unchanged below. */

function loadMotorizados() {
    try {
        const q = query(collection(db, 'users'), where('role', '==', 'motorizado'));
        onSnapshot(q, snap => {
            motorizados = [];
            snap.forEach(s => {
                const d = s.data() || {};
                motorizados.push({ id: s.id, name: d.name || d.displayName || '', email: d.email || '', ...d });
            });
            populateMotorizadoSelect();
        }, err => {
            console.error('loadMotorizados onSnapshot error', err);
        });
    } catch (err) {
        console.error('loadMotorizados error', err);
    }
}

function populateMotorizadoSelect() {
    if (!editMotorizadoSelect) return;
    editMotorizadoSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.text = '-- POR ASIGNAR --';
    editMotorizadoSelect.appendChild(placeholder);

    motorizados.sort((a, b) => {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        return an.localeCompare(bn);
    });

    motorizados.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.text = `${u.name || u.email || u.id}`;
        editMotorizadoSelect.appendChild(opt);
    });
}

function getProductEffectivePrice(p) {
    const base = Number(p.price) || 0;
    const disc = p.discount;
    if (disc === undefined || disc === null || Number(disc) === 0) return base;
    const d = Number(disc);
    if (!isFinite(d)) return base;
    if (d > 0 && d <= 100) {
        return Math.max(0, base * (1 - d / 100));
    }
    return Math.max(0, base - d);
}

function loadAvailableProducts() {
    const colNames = ['products', 'product'];
    availableProducts = [];

    const processSnapAndMerge = (snap) => {
        const colItems = [];
        snap.forEach(s => {
            const d = s.data();
            if (!d) return;
            const st = (d.status || '').toString().toLowerCase();
            if (st === 'activo' || st === 'active') {
                colItems.push({ id: s.id, ...d });
            }
        });
        const map = {};
        (availableProducts || []).forEach(p => { map[p.id] = p; });
        colItems.forEach(p => { map[p.id] = p; });
        availableProducts = Object.values(map);
        renderAvailableProductsList();
    };

    const fallbackReadAll = (colRef) => {
        try {
            onSnapshot(colRef, snap => {
                const tmp = [];
                snap.forEach(s => {
                    const d = s.data();
                    if (!d) return;
                    const st = (d.status || '').toString().toLowerCase();
                    if (st === 'activo' || st === 'active') tmp.push({ id: s.id, ...d });
                });
                const map = {};
                (availableProducts || []).forEach(p => { map[p.id] = p; });
                tmp.forEach(p => { map[p.id] = p; });
                availableProducts = Object.values(map);
                renderAvailableProductsList();
            }, err => {
                console.error('Fallback onSnapshot error loading products for', colRef.path, err);
                renderAvailableProductsList();
                showToast('No se pudieron cargar productos. Revisa la consola.');
            });
        } catch (err) {
            console.error('Fallback readAll error for', colRef.path, err);
            renderAvailableProductsList();
            showToast('No se pudieron cargar productos. Revisa la consola.');
        }
    };

    let listened = false;
    colNames.forEach(name => {
        try {
            const colRef = collection(db, name);
            try {
                const statuses = ['Activo', 'activo', 'ACTIVE', 'active'];
                const q = query(colRef, where('status', 'in', statuses));
                onSnapshot(q, snap => {
                    processSnapAndMerge(snap);
                    if ((!snap || snap.empty) && !listened) {
                        fallbackReadAll(colRef);
                    }
                }, err => {
                    fallbackReadAll(colRef);
                });
            } catch (e) {
                try {
                    const q2 = query(colRef, where('status', '==', 'Activo'));
                    onSnapshot(q2, snap => {
                        processSnapAndMerge(snap);
                        if ((!snap || snap.empty) && !listened) fallbackReadAll(colRef);
                    }, err => {
                        fallbackReadAll(colRef);
                    });
                } catch (e2) {
                    fallbackReadAll(colRef);
                }
            }
            listened = true;
        } catch (err) {
        }
    });

    if (!listened) {
        try {
            const colRef = collection(db, 'products');
            fallbackReadAll(colRef);
        } catch (err) {
            renderAvailableProductsList();
            showToast('No se pudieron cargar productos. Revisa la consola.');
        }
    }
}

function renderAvailableProductsList() {
    if (!editItemsArea) return;
    let container = document.getElementById('available-products-list');
    if (!container) {
        const hr = document.createElement('hr');
        hr.style.margin = '12px 0';
        editItemsArea.appendChild(hr);

        container = document.createElement('div');
        container.id = 'available-products-list';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '8px';
        container.style.maxHeight = '180px';
        container.style.overflow = 'auto';
        editItemsArea.appendChild(container);
    }

    container.innerHTML = '';
    if (!availableProducts || availableProducts.length === 0) {
        const empty = document.createElement('div'); empty.className = 'small-muted'; empty.textContent = 'No hay productos disponibles.';
        container.appendChild(empty);
        return;
    }

    const sorted = [...availableProducts].sort((a, b) => (a.name_lower || (a.name || '').toLowerCase()).localeCompare(b.name_lower || (b.name || '').toLowerCase()));

    sorted.forEach(p => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '6px';
        row.style.border = '1px solid var(--border)';
        row.style.borderRadius = '8px';
        row.style.background = '#fff';

        const left = document.createElement('div');
        left.style.flex = '1';
        left.style.display = 'flex';
        left.style.flexDirection = 'column';
        left.style.gap = '3px';
        const title = document.createElement('div'); title.style.fontWeight = '700'; title.textContent = p.name || 'Sin nombre';
        const meta = document.createElement('div'); meta.className = 'small-muted'; meta.style.fontSize = '13px'; meta.textContent = `Stock: ${p.stock || 0} • ${p.category || ''}`;
        left.appendChild(title);
        left.appendChild(meta);

        const right = document.createElement('div'); right.style.display = 'flex'; right.style.alignItems = 'center'; right.style.gap = '8px';
        const priceVal = getProductEffectivePrice(p);
        const priceEl = document.createElement('div'); priceEl.style.fontWeight = '700'; priceEl.textContent = money(priceVal);

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn-secondary';
        addBtn.textContent = 'Agregar';
        addBtn.addEventListener('click', () => {
            if (!currentEditOrder) { showToast('Abre el editor de pedido para agregar productos.'); return; }
            currentEditOrder.data.items = currentEditOrder.data.items || [];
            currentEditOrder.data.items.push({
                productId: p.id,
                name: p.name,
                price: priceVal,
                quantity: 1
            });
            availableProducts = availableProducts.filter(x => x.id !== p.id);
            buildItemsList(currentEditOrder.data.items);
            computeEditTotal();
            renderAvailableProductsList();
            showToast(`${p.name} agregado.`);
        });

        right.appendChild(priceEl);
        right.appendChild(addBtn);

        row.appendChild(left);
        row.appendChild(right);

        container.appendChild(row);
    });
}

function buildItemsList(items) {
    if (!itemsList) return;
    itemsList.innerHTML = '';
    (items || []).forEach((it, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.marginBottom = '6px';
        const name = document.createElement('div'); name.style.flex = '1'; name.textContent = it.name || '';
        const qty = document.createElement('input'); qty.type = 'number'; qty.value = it.quantity || it.qty || 1; qty.min = 1; qty.style.width = '70px';
        qty.addEventListener('change', () => { currentEditOrder.data.items[idx].quantity = Number(qty.value); computeEditTotal(); });
        const price = document.createElement('input'); price.type = 'number'; price.step = '0.01'; price.value = it.price || it.unitPrice || it.subtotal || 0; price.style.width = '100px';
        price.addEventListener('change', () => { currentEditOrder.data.items[idx].price = Number(price.value); computeEditTotal(); });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-small'; remove.textContent = 'Eliminar';
        remove.addEventListener('click', () => {
            const removed = currentEditOrder.data.items.splice(idx, 1)[0];
            buildItemsList(currentEditOrder.data.items);
            computeEditTotal();
            renderAvailableProductsList();
        });
        row.appendChild(name); row.appendChild(qty); row.appendChild(price); row.appendChild(remove);
        itemsList.appendChild(row);
    });
}

function computeEditTotal() {
    if (!currentEditOrder) return;
    const items = currentEditOrder.data.items || [];
    const total = items.reduce((acc, it) => acc + ((Number(it.price) || 0) * (Number(it.quantity) || 1)), 0);
    currentEditOrder.data.total = total;
    if (editTotal) editTotal.textContent = money(total);
}

async function saveEditForm(e) {
    e && e.preventDefault();
    clearFieldErrors();
    if (!currentEditOrder) return;
    const original = orders.find(x => x.id === currentEditOrder.id);
    if (!original) { showToast('Pedido no encontrado'); return; }

    const selectedMotorId = editMotorizadoSelect ? (editMotorizadoSelect.value || '') : '';
    const freeEntry = editMotorizadoFree ? (editMotorizadoFree.value || '').trim() : '';
    let newAssignedMotorUid = '';
    let newAssignedMotorEmail = '';
    let newAssignedMotorName = '';

    if (selectedMotorId) {
        const found = motorizados.find(m => m.id === selectedMotorId);
        if (found) {
            newAssignedMotorUid = found.id;
            newAssignedMotorEmail = found.email || '';
            newAssignedMotorName = found.name || found.email || found.id || '';
        } else {
            newAssignedMotorUid = selectedMotorId;
            newAssignedMotorName = editMotorizadoFree && editMotorizadoFree.value ? editMotorizadoFree.value.trim() : '';
        }
    } else if (freeEntry) {
        const looksLikeEmail = /\S+@\S+\.\S+/.test(freeEntry);
        if (looksLikeEmail) {
            newAssignedMotorEmail = freeEntry;
            newAssignedMotorName = freeEntry.split('@')[0];
        } else {
            newAssignedMotorName = freeEntry;
        }
    }

    const oldAssignedMotorUid = original.data && original.data.assignedMotor || '';
    const oldAssignedMotorEmail = original.data && (original.data.assignedMotorName || original.data.assignedMotorEmail) || '';
    const oldAssignedMotorName = original.data && (original.data.assignedMotorizedName || original.data.motorizadoName) || '';

    const isMotorChanged = (
        (newAssignedMotorUid && newAssignedMotorUid !== oldAssignedMotorUid) ||
        (!newAssignedMotorUid && (newAssignedMotorEmail && newAssignedMotorEmail !== oldAssignedMotorEmail)) ||
        (!newAssignedMotorUid && !newAssignedMotorEmail && newAssignedMotorName && newAssignedMotorName !== oldAssignedMotorName)
    );

    if (isMotorChanged && !(editMotComment && editMotComment.value.trim())) {
        showFieldError(editMotComment || (editMotorizadoSelect || editMotorizadoFree), 'Debes justificar el cambio de motorizado.');
        showToast('Falta justificar el cambio de motorizado.');
        return;
    }

    const items = currentEditOrder.data.items || [];
    if (!items || items.length === 0) {
        if (itemsList) showFieldError(itemsList, 'El pedido debe contener al menos un producto.');
        showToast('Agrega al menos un producto al pedido.');
        return;
    }

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.name || String(it.name).trim() === '') {
            showFieldError(itemsList, `Producto en posición ${i + 1} sin nombre.`);
            showToast('Hay productos sin nombre.');
            return;
        }
        if (!(Number(it.price) > 0)) {
            showFieldError(itemsList, `Producto "${it.name}" debe tener precio mayor a 0.`);
            showToast('Hay productos con precio inválido.');
            return;
        }
        if (!(Number(it.quantity) >= 1)) {
            showFieldError(itemsList, `Producto "${it.name}" debe tener cantidad >= 1.`);
            showToast('Hay productos con cantidad inválida.');
            return;
        }
    }

    const docRef = doc(db, 'orders', currentEditOrder.id);
    const updates = {
        items: currentEditOrder.data.items || [],
        total: currentEditOrder.data.total || 0,
        updatedAt: serverTimestamp()
    };

    if (newAssignedMotorUid || newAssignedMotorEmail || newAssignedMotorName) {
        if (newAssignedMotorUid) updates.assignedMotor = newAssignedMotorUid;
        if (newAssignedMotorEmail) updates.assignedMotorName = newAssignedMotorEmail;
        if (newAssignedMotorName) updates.assignedMotorizedName = newAssignedMotorName;
        updates.assignedMotorizedAt = serverTimestamp();
        updates.lastMotorizedChange = {
            from: oldAssignedMotorUid || oldAssignedMotorEmail || oldAssignedMotorName || null,
            to: newAssignedMotorUid || newAssignedMotorEmail || newAssignedMotorName || null,
            comment: (editMotComment && editMotComment.value.trim()) || '',
            at: serverTimestamp()
        };
    }

    try {
        await updateDoc(docRef, updates);
        showToast('Pedido actualizado.');
        closeEditModal();
    } catch (err) {
        console.error('Error guardando pedido:', err);
        showToast('No se pudo guardar. Revisa la consola.');
    }
}

async function suspendOrder(order) {
    const docRef = doc(db, 'orders', order.id);
    const conf = window.confirm('¿Deseas suspender/cancelar este pedido?');
    if (!conf) return;
    try {
        await updateDoc(docRef, { status: 'suspendido', updatedAt: serverTimestamp() });
        showToast('Pedido suspendido.');
    } catch (err) {
        console.error('suspendOrder error', err);
        showToast('No se pudo suspender el pedido.');
    }
}

/* ================= EVENT WIRING & RESPONSIVE ================= */
if (btnFilter) btnFilter.addEventListener('click', applyFilters);
if (btnClear) btnClear.addEventListener('click', () => { filterStatus.value = ''; filterDate.value = ''; filterClient.value = ''; applyFilters(); });
if (refreshBtn) refreshBtn.addEventListener('click', () => { listenOrdersForSeller(currentUser ? currentUser.uid : null); showToast('Sincronizando pedidos...'); });

if (viewClose) viewClose.addEventListener('click', closeViewModal);
if (viewCloseBottom) viewCloseBottom.addEventListener('click', closeViewModal);
if (editClose) editClose.addEventListener('click', closeEditModal);
if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditModal);
if (addItemBtn) addItemBtn.addEventListener('click', () => {
    clearFieldErrors();
    const name = newItemName ? newItemName.value.trim() : '';
    const price = Number(newItemPrice ? newItemPrice.value || 0 : 0);
    const qty = Number(newItemQty ? newItemQty.value || 1 : 1);
    if (!name) { showFieldError(newItemName || itemsList, 'Agrega nombre del producto'); showToast('Agrega nombre del producto'); return; }
    if (!(price > 0)) { showFieldError(newItemPrice || itemsList, 'Precio debe ser mayor que 0'); showToast('Precio inválido'); return; }
    if (!(qty >= 1)) { showFieldError(newItemQty || itemsList, 'Cantidad debe ser al menos 1'); showToast('Cantidad inválida'); return; }
    if (!currentEditOrder) { showToast('Abre el editor de pedido para agregar productos.'); return; }
    currentEditOrder.data.items = currentEditOrder.data.items || [];
    currentEditOrder.data.items.push({ name, price, quantity: qty });
    buildItemsList(currentEditOrder.data.items);
    computeEditTotal();
    if (newItemName) newItemName.value = ''; if (newItemPrice) newItemPrice.value = ''; if (newItemQty) newItemQty.value = '1';
});
if (editForm) editForm.addEventListener('submit', saveEditForm);

window.addEventListener('resize', () => {
    // On resize we only update cards/table behavior (no chat)
    if (isMobileViewport()) {
        // mobile: cards visible, table may be lower priority
    } else {
        // desktop: table visible
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const vm = document.getElementById('order-view-modal');
        const em = document.getElementById('order-edit-modal');
        vm && vm.classList.add('hidden');
        em && em.classList.add('hidden');
    }
});

/* ================= AUTH & START ================= */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '/index.html';
        return;
    }
    currentUser = user;
    try {
        const udoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = udoc.exists() ? (udoc.data().role || 'vendedor') : 'vendedor';
    } catch (err) {
        console.error('Error leyendo rol de usuario:', err);
        currentUserRole = 'vendedor';
    }

    if (currentUserRole !== 'vendedor') {
        if (currentUserRole === 'administrador') window.location.href = '/admin/administrador.html';
        else if (currentUserRole === 'motorizado') window.location.href = '/admin/motorizado.html';
        else window.location.href = '/index.html';
        return;
    }

    listenOrdersForSeller(user.uid);
    loadMotorizados();
    loadAvailableProducts();
    showToast('Conectado como vendedor — mostrando solo tus pedidos');
});

/* ================= EXPORT CSV ================= */
if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const source = filteredOrders && filteredOrders.length ? filteredOrders : orders;
        if (!source || source.length === 0) { showToast('No hay datos para exportar.'); return; }
        const headers = ['id', 'clientName', 'productTitle', 'createdAt', 'total', 'paymentStatus', 'shippingStatus'];
        const rows = source.map(o => {
            const od = o.data || {};
            const createdAt = formatDateFlexible(od.orderDate || od.createdAt || od.timestamp);
            const clientName = (od.customerData && (od.customerData.Customname || od.customerData.name)) || (od.customer && od.customer.name) || '';
            return [
                `"${(o.id || '').replace(/"/g, '""')}"`,
                `"${(clientName || '').replace(/"/g, '""')}"`,
                `"${((od.items && od.items.map(i => i.name).join(', ')) || '').replace(/"/g, '""')}"`,
                `"${createdAt.replace(/"/g, '""')}"`,
                `"${String(od.total || od.amount || '')}"`,
                `"${String(od.paymentStatus || '')}"`,
                `"${String(od.shippingStatus || '')}"`
            ].join(',');
        });
        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    });
}
