// assets/js/orders.js
// Versión actualizada: validaciones inline, leyendas en botones, productos agregados desaparecen de la lista disponible.
// - Conexión a Firestore, escucha pedidos en tiempo real.
// - Carga motorizados & productos disponibles.
// - Edit: ver, editar items, asignar motorizado (con comentario obligatorio si cambia), suspender.
// - Inline field errors y eliminación de producto de availableProducts al agregar.
// - Chat removido por petición.
// - Añadido: slider de imágenes dentro del modal "Ver detalle" (solo modal).
// - Mejora: si el item no tiene imágenes intenta obtenerlas desde el documento `product/{productId}`.

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

/* ================= INIT ================= */
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
const editMotComment = document.getElementById('edit-motorizado-comment');
const itemsList = document.getElementById('items-list');
const editItemsArea = document.getElementById('edit-items-area'); // contenedor de items + productos disponibles
const addItemBtn = document.getElementById('add-item-btn');
const newItemName = document.getElementById('new-item-name');
const newItemPrice = document.getElementById('new-item-price');
const newItemQty = document.getElementById('new-item-qty');
const editTotal = document.getElementById('edit-total');

/* ================= STATE ================= */
let orders = [];
let filteredOrders = [];
let ordersUnsubscribe = null;
let currentUser = null;
let currentUserRole = 'vendedor'; // 'admin' | 'vendedor' | 'motorizado'
let currentEditOrder = null;
let currentViewOrder = null;

let motorizados = []; // [{ id, name, email, ... }]
let availableProducts = [];

/* ================= Modal rotator state (for view modal only) ================= */
// Map of sliderElement -> { intervalId, imgs, imgEl, idx }
const modalRotators = new Map();

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
    return n.toLocaleString('es-VE', { style: 'currency', currency: 'USD' });
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

/* Traduce/normaliza estatus a español */
function translateStatus(raw) {
    if (!raw && raw !== 0) return '';
    const s = String(raw).trim().toLowerCase();

    const map = {
        // shipping / delivery
        'delivered': 'Entregado',
        'entregado': 'Entregado',
        'delivering': 'En entrega',
        'enruta': 'En ruta',
        'en ruta': 'En ruta',
        // payment
        'paid': 'Pagado',
        'pagado': 'Pagado',
        'pending': 'Pendiente',
        'pendiente': 'Pendiente',
        'failed': 'Fallido',
        'fallido': 'Fallido',
        // order status
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

/* Small helper to return inline SVGs (fill=currentColor so CSS colors apply) */
function getIconSvg(name, size = 16) {
    switch ((name || '').toLowerCase()) {
        case 'eye': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/></svg>`;
        case 'pencil': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" class="bi bi-pencil-square" viewBox="0 0 16 16"><path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/><path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/></svg>`;
        case 'clock': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" class="bi bi-clock-history" viewBox="0 0 16 16"><path d="M8.515 1.019A7 7 0 0 0 8 1V0a8 8 0 0 1 .589.022zm2.004.45a7 7 0 0 0-.985-.299l.219-.976q.576.129 1.126.342zm1.37.71a7 7 0 0 0-.439-.27l.493-.87a8 8 0 0 1 .979.654l-.615.789a7 7 0 0 0-.418-.302zm1.834 1.79a7 7 0 0 0-.653-.796l.724-.69q.406.429.747.91zm.744 1.352a7 7 0 0 0-.214-.468l.893-.45a8 8 0 0 1 .45 1.088l-.95.313a7 7 0 0 0-.179-.483m.53 2.507a7 7 0 0 0-.1-1.025l.985-.17q.1.58.116 1.17zm-.131 1.538q.05-.254.081-.51l.993.123a8 8 0 0 1-.23 1.155l-.964-.267q.069-.247.12-.501m-.952 2.379q.276-.436.486-.908l.914.405q-.24.54-.555 1.038zm-.964 1.205q.183-.183.35-.378l.758.653a8 8 0 0 1-.401.432z"/><path d="M8 1a7 7 0 1 0 4.95 11.95l.707.707A8.001 8.001 0 1 1 8 0z"/><path d="M7.5 3a.5.5 0 0 1 .5.5v5.21l3.248 1.856a.5.5 0 0 1-.496.868l-3.5-2A.5.5 0 0 1 7 9V3.5a.5.5 0 0 1 .5-.5"/></svg>`;
        case 'x-circle': return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>`;
        default: return '';
    }
}

/* Field errors inline */
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
    if (element.parentNode) {
        element.parentNode.insertBefore(el, element.nextSibling);
    } else {
        element.appendChild(el);
    }
    if (typeof element.focus === 'function') element.focus();
}

/* ================= NAV TO HISTORY HELPERS ================= */
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
    } catch (err) {
        console.warn('buildHistoryUrlFromOrder error', err);
        return 'history.html';
    }
}

/* ================= MODAL ROTATOR HELPERS ================= */
/* Small fade helper used by modal rotator */
function fadeImageToModal(imgEl, newSrc, dur = 240) {
    if (!imgEl) return;
    imgEl.style.transition = `opacity ${dur}ms ease`;
    imgEl.style.opacity = '0';
    setTimeout(() => { imgEl.src = newSrc; imgEl.style.opacity = '1'; }, dur);
}

/* Initialize simple rotators inside the view modal only.
   Structure expected:
   <div class="mini-slider"><div class="mini-track">
       <img src="..."> ... multiple imgs
   </div></div>
   Will replace track contents with a single display img and cycle through the list.
*/
function initModalRotators(root = document) {
    // clear previous (if any) before starting new ones
    clearModalRotators();

    if (!root) return;
    const sliders = Array.from(root.querySelectorAll('.mini-slider'));
    sliders.forEach(slider => {
        try {
            const track = slider.querySelector('.mini-track');
            if (!track) return;
            const imgs = Array.from(track.querySelectorAll('img')).map(i => i.src).filter(Boolean);
            // if no imgs but there are div placeholders, ignore
            if (!imgs.length) return;

            // clear track and create display
            track.innerHTML = '';
            const displayWrap = document.createElement('div');
            displayWrap.className = 'mini-display';
            displayWrap.style.width = '56px';
            displayWrap.style.height = '56px';
            displayWrap.style.overflow = 'hidden';
            const displayImg = document.createElement('img');
            displayImg.className = 'mini-current';
            displayImg.src = imgs[0];
            displayImg.style.width = '100%';
            displayImg.style.height = '100%';
            displayImg.style.objectFit = 'cover';
            displayImg.style.borderRadius = '6px';
            displayImg.style.transition = 'opacity 240ms ease';
            displayWrap.appendChild(displayImg);
            track.appendChild(displayWrap);

            let idx = 0;
            let intervalId = null;
            if (imgs.length > 1) {
                intervalId = setInterval(() => {
                    idx = (idx + 1) % imgs.length;
                    fadeImageToModal(displayImg, imgs[idx], 240);
                }, 2000);
            }

            modalRotators.set(slider, { intervalId, imgs, imgEl: displayImg, idx });
        } catch (e) {
            console.error('initModalRotators error', e);
        }
    });
}

function clearModalRotators() {
    for (const [el, info] of modalRotators.entries()) {
        try { if (info.intervalId) clearInterval(info.intervalId); } catch (e) { }
        modalRotators.delete(el);
    }
}

/* ================= RENDERERS ================= */
function render(list) {
    renderTable(list);
    renderCards(list);
}

/* Table */
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

        const totalTd = document.createElement('td'); totalTd.textContent = money(o.data && o.data.total); tr.appendChild(totalTd);

        const sellerTd = document.createElement('td'); sellerTd.textContent = (o.data && (o.data.assignedSellerName || o.data.assignedSellerEmail || o.data.assignedSeller)) || 'Sin vendedor'; tr.appendChild(sellerTd);

        const motoTd = document.createElement('td');
        const motoname = (o.data && (o.data.assignedMotorizedName || o.data.assignedDriverName || o.data.motorizadoName || o.data.assignedMotorizado)) || '';
        motoTd.innerHTML = motoname ? escapeHtml(motoname) : `<span class="state-badge">POR ASIGNAR</span>`;
        tr.appendChild(motoTd);

        const statusTd = document.createElement('td');
        const rawStatus = (o.data && o.data.status) || '';
        const rawShipping = (o.data && o.data.shippingStatus) || '';
        const rawPayment = (o.data && o.data.paymentStatus) || '';

        const shippingTranslated = translateStatus(rawShipping);
        const paymentTranslated = translateStatus(rawPayment);
        let displayStatus = translateStatus(rawStatus);

        // If status is 'asignado' and paymentStatus exists -> show paymentStatus (en español)
        if (String(rawStatus || '').toLowerCase() === 'asignado' || String(rawStatus || '').toLowerCase() === 'assigned') {
            if (rawPayment) displayStatus = paymentTranslated || displayStatus;
        }

        // If shippingStatus indicates delivered -> special
        const isDelivered = rawShipping && (String(rawShipping).toLowerCase() === 'entregado' || String(rawShipping).toLowerCase() === 'delivered');
        if (isDelivered) {
            statusTd.innerHTML = `<span class="badge paid">${escapeHtml('Pagado')}</span>`;
        } else {
            const cls = toBadgeClass(displayStatus);
            statusTd.innerHTML = `<span class="badge ${cls}">${escapeHtml(displayStatus)}</span>`;
        }
        tr.appendChild(statusTd);

        const actionsTd = document.createElement('td');
        const rowActions = document.createElement('div'); rowActions.className = 'row-actions';

        // Actions behavior:
        // - Si entregado: mostrar badge 'Entregado' y el botón Historial
        // - Si no entregado: mostrar View, Edit, History, Suspend
        if (isDelivered) {
            const deliveredSpan = document.createElement('span');
            deliveredSpan.className = 'badge delivered';
            deliveredSpan.textContent = 'Entregado';
            rowActions.appendChild(deliveredSpan);

            const histBtn = document.createElement('button');
            histBtn.className = 'btn-small btn-history';
            histBtn.title = 'Historial de Cliente';
            histBtn.innerHTML = `${getIconSvg('clock', 14)}`;
            histBtn.addEventListener('click', () => {
                const url = buildHistoryUrlFromOrder(o);
                window.location.href = url;
            });
            rowActions.appendChild(histBtn);
        } else {
            // View button
            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn-small btn-view';
            viewBtn.title = 'Ver detalles';
            viewBtn.innerHTML = `${getIconSvg('eye', 14)}`;
            viewBtn.addEventListener('click', () => openViewModal(o));
            rowActions.appendChild(viewBtn);

            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'btn-small btn-assign';
            editBtn.title = 'Editar Pedido';
            editBtn.innerHTML = `${getIconSvg('pencil', 14)}`;
            editBtn.addEventListener('click', () => openEditModal(o));
            rowActions.appendChild(editBtn);

            // History button -> ahora envía parámetros
            const histBtn = document.createElement('button');
            histBtn.className = 'btn-small btn-history';
            histBtn.title = 'Historial de Cliente';
            histBtn.innerHTML = `${getIconSvg('clock', 14)}`;
            histBtn.addEventListener('click', () => {
                const url = buildHistoryUrlFromOrder(o);
                window.location.href = url;
            });
            rowActions.appendChild(histBtn);

            // Suspend button
            const suspBtn = document.createElement('button');
            suspBtn.className = 'btn-small btn-suspender';
            suspBtn.title = 'Suspender este pedido';
            suspBtn.innerHTML = `${getIconSvg('x-circle', 14)}`;
            suspBtn.addEventListener('click', () => suspendOrder(o));
            rowActions.appendChild(suspBtn);
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

        // Buttons with icons
        const viewBtnHtml = `<button class="order-card-btn" data-action="view" data-id="${o.id}" title="Ver">${getIconSvg('eye', 14)} <span style="margin-left:6px">Ver</span></button>`;
        const editBtnHtml = `<button class="order-card-btn" data-action="edit" data-id="${o.id}" title="Editar">${getIconSvg('pencil', 14)} <span style="margin-left:6px">Editar</span></button>`;
        const histBtnHtml = `<button class="order-card-btn" data-action="history" data-id="${o.id}" title="Historial">${getIconSvg('clock', 14)} <span style="margin-left:6px">Historial</span></button>`;

        // If delivered, keep only history button
        const actionsHtml = isDelivered ? `${histBtnHtml}` : `${viewBtnHtml}${editBtnHtml}${histBtnHtml}`;

        card.innerHTML = `
      <div class="order-card-header">
        <div class="order-card-avatar"><img src="assets/img/avatar-placeholder.png" alt=""></div>
        <div class="order-card-cust">
          <div class="order-card-cust-name">${escapeHtml(cname)}</div>
          <div class="order-card-cust-address">${escapeHtml(address)}</div>
        </div>
        <div class="order-card-info">
          <div class="order-card-total">${money(o.data && o.data.total)}</div>
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
        if (s && ((od.status || '').toLowerCase() !== s.toLowerCase())) return false;
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
function buildOrdersQueryForRole(uid, role) {
    const col = collection(db, 'orders');
    try {
        if (role === 'vendedor' && uid) return query(col, where('assignedSeller', '==', uid), orderBy('orderDate', 'desc'));
        if (role === 'motorizado' && uid) return query(col, where('assignedMotor', '==', uid), orderBy('orderDate', 'desc'));
        // admin or default: view all
        return query(col, orderBy('orderDate', 'desc'));
    } catch {
        try { return query(col, orderBy('timestamp', 'desc')); }
        catch { return query(col); }
    }
}

function listenOrders() {
    if (ordersUnsubscribe) { ordersUnsubscribe(); ordersUnsubscribe = null; }
    const q = buildOrdersQueryForRole(currentUser ? currentUser.uid : null, currentUserRole);
    ordersUnsubscribe = onSnapshot(q, snap => {
        orders = [];
        snap.forEach(docSnap => orders.push({ id: docSnap.id, data: docSnap.data() }));
        orders.sort((a, b) => {
            const ad = a.data && (a.data.orderDate || a.data.timestamp);
            const bd = b.data && (b.data.orderDate || b.data.timestamp);
            const at = ad && typeof ad.toDate === 'function' ? ad.toDate().getTime() : (new Date(ad)).getTime();
            const bt = bd && typeof bd.toDate === 'function' ? (bd.toDate && typeof bd.toDate === 'function' ? bd.toDate().getTime() : (new Date(bd)).getTime()) : (new Date(bd)).getTime();
            return (bt || 0) - (at || 0);
        });
        applyFilters();
        showToast(`Pedidos cargados: ${orders.length}`, 900);
    }, err => {
        console.error('onSnapshot error:', err);
        showToast('No se pudieron cargar pedidos. Revisa la consola.');
    });
}

/* ================= VIEW / EDIT / SUSPEND ================= */
/* openViewModal made async so we can fetch images from product docs if item lacks images */
async function openViewModal(order) {
    currentViewOrder = order;
    const o = order.data || {};
    const cname = (o.customerData && (o.customerData.Customname || o.customerData.name)) || 'Sin nombre';
    const address = (o.customerData && o.customerData.address) || o.readable_address || '';
    const items = Array.isArray(o.items) ? o.items.slice() : [];

    if (!viewBody) return;

    // For each item, try to collect images:
    // priority: item.imageUrls (array) -> item.imageUrl / item.image (single) -> product doc imageUrls
    const itemsWithImgs = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        let imgs = [];
        try {
            if (Array.isArray(it.imageUrls) && it.imageUrls.length) imgs.push(...it.imageUrls.map(x => String(x).trim()).filter(Boolean));
            if (it.imageUrl && String(it.imageUrl).trim()) imgs.push(String(it.imageUrl).trim());
            if (it.image && String(it.image).trim()) imgs.push(String(it.image).trim());
        } catch (e) {
            console.warn('item image normalization error', e);
        }
        // If still empty and we have a productId, try to fetch product doc for imageUrls
        if (!imgs.length && (it.productId || it.product_id || it.product)) {
            const pid = it.productId || it.product_id || it.product;
            if (pid) {
                try {
                    const pSnap = await getDoc(doc(db, 'product', pid));
                    if (pSnap.exists()) {
                        const pdata = pSnap.data() || {};
                        if (Array.isArray(pdata.imageUrls) && pdata.imageUrls.length) imgs.push(...pdata.imageUrls.map(x => String(x).trim()).filter(Boolean));
                        else if (pdata.imageUrl && String(pdata.imageUrl).trim()) imgs.push(String(pdata.imageUrl).trim());
                    }
                } catch (err) {
                    console.warn('Error fetching product for images:', pid, err);
                }
            }
        }
        // dedupe & keep valid urls
        imgs = imgs.filter(Boolean).map(s => String(s));
        // Log for debugging if no images found
        if (!imgs.length) {
            console.debug('No images for item', it.name || it.productId || '(no id)');
        } else {
            console.debug('Images for item', it.name || it.productId || '(no name)', imgs);
        }
        itemsWithImgs.push({ ...it, imgs });
    }

    // Build products table - image column now supports a simple mini-slider per product.
    const productsHtml = `
      <div class="card products-card" style="border-radius:8px;padding:12px;">
        <h4 style="margin:0 0 10px 0;font-size:16px;">Productos (${itemsWithImgs.length})</h4>
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
              ${itemsWithImgs.map(it => {
        const qty = Number(it.quantity || it.qty || 1);
        const price = Number(it.price || it.unitPrice || it.subtotal || 0);
        const subtotal = qty * price;
        const imgs = Array.isArray(it.imgs) ? it.imgs : [];
        let imgCellHtml = '';
        if (imgs.length) {
            // Build mini-slider markup expected by initModalRotators
            const imgsHtml = imgs.map(src => `<img src="${escapeHtml(src)}" alt="${escapeHtml(it.name || '')}" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:6px;margin-right:6px;">`).join('');
            imgCellHtml = `<div class="mini-slider" style="display:flex;align-items:center;"><div class="mini-track">${imgsHtml}</div></div>`;
        } else {
            // placeholder with initials (like product table)
            const initials = escapeHtml(((it.name || '').slice(0,2) || 'IMG').toUpperCase());
            imgCellHtml = `<div style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#f3f4f6;color:#9aa0a6;font-weight:700">${initials}</div>`;
        }

        return `<tr style="border-bottom:1px solid #eef2f6;">
                            <td style="padding:10px 6px;vertical-align:middle;">${imgCellHtml}</td>
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

    // Información superior
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

    // initialize rotators inside the newly injected viewBody
    initModalRotators(viewBody);

    viewModal && viewModal.classList.remove('hidden');
    viewModal && viewModal.setAttribute('aria-hidden', 'false');
}

function closeViewModal() {
    viewModal && viewModal.classList.add('hidden');
    viewModal && viewModal.setAttribute('aria-hidden', 'true');
    currentViewOrder = null;
    // clear modal rotators to avoid intervals running in background
    clearModalRotators();
}

/* Abre editor: prepara select de motorizados y lista de items */
function openEditModal(order) {
    clearFieldErrors();
    currentEditOrder = JSON.parse(JSON.stringify(order));
    const o = currentEditOrder.data || {};
    if (editCustomer) editCustomer.textContent = (o.customerData && (o.customerData.Customname || o.customerData.name)) || 'Sin nombre';
    populateMotorizadoSelect();
    // Try to set select value to assignedMotor (uid) if present, otherwise try to match by email or name
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

/* ================= MOTORIZADOS ================= */
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
        opt.value = u.id; // store uid to be able to save assignedMotor = uid
        opt.text = `${u.name || u.email || u.id}`; // show readable label
        editMotorizadoSelect.appendChild(opt);
    });
}

/* ================= PRODUCTS (available to add) ================= */
/* Interpretación de discount:
   - 0 < discount <= 100 => porcentaje
   - discount > 100 => monto absoluto a restar
*/
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

/* Carga de productos disponibles (misma lógica robusta que antes) */
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
        console.debug('Productos disponibles (merged):', availableProducts.length);
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
                console.debug('Fallback readAll for', colRef.path, '-> found', tmp.length);
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
                    console.warn('onSnapshot (status in) error for', name, err);
                    fallbackReadAll(colRef);
                });
            } catch (e) {
                try {
                    const q2 = query(colRef, where('status', '==', 'Activo'));
                    onSnapshot(q2, snap => {
                        processSnapAndMerge(snap);
                        if ((!snap || snap.empty) && !listened) fallbackReadAll(colRef);
                    }, err => {
                        console.warn('onSnapshot (status == "Activo") error for', name, err);
                        fallbackReadAll(colRef);
                    });
                } catch (e2) {
                    console.warn('Query construcción falló para', name, e2);
                    fallbackReadAll(colRef);
                }
            }
            listened = true;
        } catch (err) {
            console.warn('No se pudo crear listener para colección', name, err);
        }
    });

    if (!listened) {
        try {
            const colRef = collection(db, 'products');
            fallbackReadAll(colRef);
        } catch (err) {
            console.error('No se pudo crear ningún listener de productos:', err);
            showToast('No se pudieron cargar productos. Revisa la consola.');
            renderAvailableProductsList();
        }
    }
}

/* Renderiza la sección de productos disponibles debajo de los items.
   Si un producto es agregado, se elimina de availableProducts y se re-renderiza. */
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

        if (p.discount && Number(p.discount) > 0) {
            const disc = document.createElement('div');
            disc.className = 'small-muted';
            disc.style.fontSize = '12px';
            let discText = '';
            const dnum = Number(p.discount);
            if (dnum > 0 && dnum <= 100) discText = `${dnum}% OFF`;
            else discText = `-${money(dnum)}`;
            disc.textContent = discText;
            right.appendChild(disc);
        }

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

/* ================= ITEMS EDIT ================= */
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

/* ================= SAVE (validaciones y guardado de motorizado con email y uid) ================= */
async function saveEditForm(e) {
    e && e.preventDefault();
    clearFieldErrors();
    if (!currentEditOrder) return;
    const original = orders.find(x => x.id === currentEditOrder.id);
    if (!original) { showToast('Pedido no encontrado'); return; }

    // Determinar motorizado seleccionado: preferir select (uid)
    const selectedMotorId = editMotorizadoSelect ? (editMotorizadoSelect.value || '') : '';
    const freeEntryName = ''; // input libre eliminado en UI, mantenemos por compatibilidad futura
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
            newAssignedMotorName = '';
        }
    } else if (freeEntryName) {
        newAssignedMotorName = freeEntryName;
    }

    // old motor identity to compare (prefer uid, otherwise email/name)
    const oldAssignedMotorUid = original.data && original.data.assignedMotor || '';
    const oldAssignedMotorEmail = original.data && (original.data.assignedMotorName || original.data.assignedMotorEmail) || '';
    const oldAssignedMotorName = original.data && (original.data.assignedMotorizedName || original.data.motorizadoName) || '';

    // If motorizado changed, comment mandatory
    const isMotorChanged = (
        (newAssignedMotorUid && newAssignedMotorUid !== oldAssignedMotorUid) ||
        (!newAssignedMotorUid && (newAssignedMotorEmail && newAssignedMotorEmail !== oldAssignedMotorEmail)) ||
        (!newAssignedMotorUid && !newAssignedMotorEmail && newAssignedMotorName && newAssignedMotorName !== oldAssignedMotorName)
    );

    if (isMotorChanged && !(editMotComment && editMotComment.value.trim())) {
        showFieldError(editMotComment || (editMotorizadoSelect), 'Debes justificar el cambio de motorizado.');
        showToast('Falta justificar el cambio de motorizado.');
        return;
    }

    // 2) Debe tener al menos un item
    const items = currentEditOrder.data.items || [];
    if (!items || items.length === 0) {
        if (itemsList) showFieldError(itemsList, 'El pedido debe contener al menos un producto.');
        showToast('Agrega al menos un producto al pedido.');
        return;
    }

    // 3) Validar cada item (precio > 0, qty >=1)
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
        // Guardar los campos solicitados:
        if (newAssignedMotorUid) updates.assignedMotor = newAssignedMotorUid;
        if (newAssignedMotorEmail) updates.assignedMotorName = newAssignedMotorEmail; // email field as requested (assignedMotorName)
        if (newAssignedMotorName) updates.assignedMotorizedName = newAssignedMotorName; // readable name
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

/* ================= SUSPEND ================= */
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
if (refreshBtn) refreshBtn.addEventListener('click', () => { listenOrders(); showToast('Sincronizando pedidos...'); });

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
    // No chat sidebar/responsive logic needed anymore
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        viewModal && viewModal.classList.add('hidden');
        editModal && editModal.classList.add('hidden');
        // ensure rotators cleared too
        clearModalRotators();
    }
});

/* ================= AUTH & START ================= */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        console.warn('Usuario no autenticado. Intentando cargar pedidos sin usuario (si reglas lo permiten).');
        currentUser = null;
        currentUserRole = 'vendedor';
        listenOrders();
        loadMotorizados();
        loadAvailableProducts();
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
    listenOrders();
    loadMotorizados();
    loadAvailableProducts();
});

/* ================= EXPORTS (optional) ================= */
export { listenOrders, render };

/* ================= END ================= */
