// assets/js/unified-orders.js
// Unified orders table & cards for administrador, vendedor and motorizado pages.
// Features:
// - Role-aware Firestore query (admin sees all, vendedor only their orders, motorizado only theirs)
// - Filters: product, seller, motorizado, status, client search
// - Table (desktop) + cards (mobile) + pagination
// - Actions: View, Chat, Cobranza (opens payment-modal), Marcar como enviado (if motorizado assigned)
// - Responsive chat modal (no persistent sidebar) and floating chat button on mobile
// - Exports CSV
//
// Requires:
// - ../assets/js/firebase-config.js exporting firebaseConfig
// - assets/js/payment-modal.js exporting openPaymentModal(orderObj)
// - assets/js/order-view-modal.js or page having #viewModal and #viewModalBody
//
// Usage: include as module in pages (already done in HTML)

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
    getDocs,
    doc,
    getDoc,
    updateDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

import { openPaymentModal } from './payment-modal.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* DOM references */
const ordersBody = document.getElementById('ordersBody');
const ordersTable = document.getElementById('ordersTable');
const ordersCards = document.getElementById('ordersCards');

const filterProduct = document.getElementById('filterProduct');
const filterSeller = document.getElementById('filterSeller');
const filterMotor = document.getElementById('filterMotor');
const filterStatus = document.getElementById('filterStatus');
const filterClient = document.getElementById('filterClient');

const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

const perPageSelect = document.getElementById('perPageSelect');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');

const refreshBtn = document.getElementById('refreshBtn');
const exportCsv = document.getElementById('exportCsv');

const toastEl = document.getElementById('toast');

/* modals & chat */
const viewModal = document.getElementById('viewModal');
const viewModalBody = document.getElementById('viewModalBody');
const viewModalClose = document.getElementById('viewModalClose');
const viewCloseBtn = document.getElementById('viewCloseBtn');

const chatModal = document.getElementById('unifiedChatModal');
const chatMessagesWrap = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSend');
const chatModalCloseBtn = document.getElementById('chatModalClose');

/* state */
let currentUser = null;
let currentRole = null; // 'administrador' | 'vendedor' | 'motorizado'
let unsubscribeOrders = null;
let ordersCache = [];
let productsCache = [];
let usersCache = [];
let activeFilters = {};
let currentPage = 1;

/* helpers */
function showToast(msg, isError = false, ms = 3000) {
    if (!toastEl) {
        console.log(msg);
        return;
    }
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#b91c1c' : '#111827';
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function formatDate(d) {
    if (!d) return '-';
    if (d.toDate) d = d.toDate();
    try { return new Date(d).toLocaleString(); } catch { return String(d); }
}

function money(v) {
    try {
        const n = Number(v || 0);
        return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    } catch { return String(v || '0'); }
}

/* Firestore helpers */
function buildOrdersQueryForRole(uid, role) {
    const col = collection(db, 'orders');
    try {
        if (role === 'vendedor' && uid) return query(col, where('assignedSeller', '==', uid), orderBy('orderDate', 'desc'));
        if (role === 'motorizado' && uid) return query(col, where('assignedMotor', '==', uid), orderBy('orderDate', 'desc'));
        return query(col, orderBy('orderDate', 'desc'));
    } catch {
        // fallback without orderBy
        try {
            if (role === 'vendedor' && uid) return query(col, where('assignedSeller', '==', uid));
            if (role === 'motorizado' && uid) return query(col, where('assignedMotor', '==', uid));
            return query(col);
        } catch (e) {
            return query(col);
        }
    }
}

/* Load selectors (products, sellers, motorizados) */
async function loadSelectors() {
    try {
        // products (try 'product' or 'products')
        const names = ['product', 'products'];
        for (const name of names) {
            try {
                const snap = await getDocs(collection(db, name));
                productsCache = [];
                snap.forEach(s => {
                    const d = s.data();
                    if (!d) return;
                    productsCache.push({ id: s.id, name: d.name || d.title || s.id });
                });
                if (productsCache.length) break;
            } catch { /* continue */ }
        }
        // populate product select
        if (filterProduct) {
            filterProduct.innerHTML = '<option value="">Todos</option>';
            productsCache.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            productsCache.forEach(p => filterProduct.appendChild(Object.assign(document.createElement('option'), { value: p.name, textContent: p.name })));
        }

        // users (sellers & motorizados)
        usersCache = [];
        try {
            const usersSnap = await getDocs(collection(db, 'users'));
            usersSnap.forEach(s => usersCache.push({ id: s.id, ...s.data() }));
        } catch (e) {
            console.warn('Could not load users', e);
        }

        if (filterSeller) {
            filterSeller.innerHTML = '<option value="">Todos</option>';
            usersCache.filter(u => u.role === 'vendedor').sort((a, b) => (a.email || a.name || '').localeCompare(b.email || b.name || '')).forEach(u => {
                const opt = document.createElement('option'); opt.value = u.id; opt.textContent = u.email || u.name || u.id;
                filterSeller.appendChild(opt);
            });
        }
        if (filterMotor) {
            filterMotor.innerHTML = '<option value="">Todos</option>';
            usersCache.filter(u => u.role === 'motorizado').sort((a, b) => (a.email || a.name || '').localeCompare(b.email || b.name || '')).forEach(u => {
                const opt = document.createElement('option'); opt.value = u.id; opt.textContent = u.email || u.name || u.id;
                filterMotor.appendChild(opt);
            });
        }

        // hide seller selector on vendedor page (script will detect role and hide)
    } catch (err) {
        console.error('loadSelectors error', err);
    }
}

/* Subscribe to orders realtime */
function listenOrders() {
    if (!currentUser) return;
    if (unsubscribeOrders) { unsubscribeOrders(); unsubscribeOrders = null; }
    const q = buildOrdersQueryForRole(currentUser.uid, currentRole);
    unsubscribeOrders = onSnapshot(q, snapshot => {
        const arr = [];
        snapshot.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
        // sort by orderDate desc (client-side robust)
        arr.sort((a, b) => {
            const ad = a.orderDate && a.orderDate.toDate ? a.orderDate.toDate().getTime() : (a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0);
            const bd = b.orderDate && b.orderDate.toDate ? b.orderDate.toDate().getTime() : (b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0);
            return (bd || 0) - (ad || 0);
        });
        ordersCache = arr;
        currentPage = 1;
        render();
    }, err => {
        console.error('orders onSnapshot error', err);
        showToast('No se pudieron cargar pedidos en tiempo real.', true);
    });
}

/* Filtering */
function applyActiveFilters(order) {
    // product filter matches item names or productTitle
    if (activeFilters.product && activeFilters.product.trim()) {
        const p = activeFilters.product.toLowerCase();
        const matchesProduct = (order.items && Array.isArray(order.items) && order.items.some(it => (it.name || '').toLowerCase().includes(p))) ||
            ((order.productTitle || '').toLowerCase().includes(p));
        if (!matchesProduct) return false;
    }
    if (activeFilters.seller && activeFilters.seller !== '') {
        if ((order.assignedSeller || '') !== activeFilters.seller) return false;
    }
    if (activeFilters.motor && activeFilters.motor !== '') {
        if ((order.assignedMotor || '') !== activeFilters.motor) return false;
    }
    if (activeFilters.status && activeFilters.status !== '') {
        const st = String(order.shippingStatus || order.status || order.orderStatus || '').toLowerCase();
        if (!st.includes(activeFilters.status.toLowerCase())) return false;
    }
    if (activeFilters.search && activeFilters.search.trim()) {
        const s = activeFilters.search.toLowerCase();
        const client = ((order.customerData && (order.customerData.Customname || order.customerData.name || order.customerData.email || order.customerData.phone)) || order.customerName || '').toLowerCase();
        if (!(client.includes(s) || (order.id || '').toLowerCase().includes(s))) return false;
    }
    return true;
}

/* Rendering: table rows + mobile cards */
function render() {
    if (!ordersBody || !ordersCards) return;
    // filter
    const visible = ordersCache.filter(applyActiveFilters);

    // pagination
    const perVal = perPageSelect?.value || '10';
    const per = perVal === 'all' ? visible.length || 1e9 : parseInt(perVal, 10) || 10;
    const total = visible.length;
    const totalPages = Math.max(1, Math.ceil(total / per));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * per;
    const pageItems = visible.slice(start, start + per);

    // table
    ordersBody.innerHTML = '';
    if (pageItems.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="11" style="text-align:center;padding:18px;">No hay pedidos para mostrar</td>`;
        ordersBody.appendChild(tr);
    } else {
        pageItems.forEach(o => {
            const tr = document.createElement('tr');

            const idTd = document.createElement('td'); idTd.textContent = o.id || ''; tr.appendChild(idTd);

            const clientTd = document.createElement('td');
            const cname = (o.customerData && (o.customerData.Customname || o.customerData.name)) || o.customerName || 'Sin nombre';
            clientTd.innerHTML = `<div style="font-weight:700">${escapeHtml(cname)}</div><div class="small-muted">${escapeHtml((o.customerData && (o.customerData.email || o.customerData.phone)) || '')}</div>`;
            tr.appendChild(clientTd);

            const productTd = document.createElement('td');
            const productTitle = (o.items && Array.isArray(o.items) && o.items.length) ? o.items.map(it => it.name || it.title).join(', ') : (o.productTitle || '');
            productTd.textContent = productTitle;
            tr.appendChild(productTd);

            const qtyTd = document.createElement('td');
            const qty = (o.items && Array.isArray(o.items)) ? o.items.reduce((s, it) => s + (Number(it.quantity || it.qty || 1) || 0), 0) : (o.quantity || o.qty || 0);
            qtyTd.textContent = String(qty); tr.appendChild(qtyTd);

            const dateTd = document.createElement('td'); dateTd.textContent = formatDate(o.orderDate || o.createdAt); tr.appendChild(dateTd);

            const totalTd = document.createElement('td'); totalTd.textContent = money(o.total || o.amount || 0); tr.appendChild(totalTd);

            const payTd = document.createElement('td');
            const payStatus = (o.paymentStatus || '').toString().toLowerCase();
            payTd.innerHTML = `<span class="badge ${payStatus.includes('paid') || payStatus.includes('pagad') ? 'paid' : 'pending'}">${escapeHtml(o.paymentStatus || 'pendiente')}</span>`;
            tr.appendChild(payTd);

            const shipTd = document.createElement('td');
            const shipStatus = (o.shippingStatus || o.status || '').toString().toLowerCase();
            shipTd.innerHTML = `<span class="badge ${shipStatus.includes('entreg') || shipStatus.includes('delivered') ? 'delivered' : 'pending'}">${escapeHtml(o.shippingStatus || o.status || '')}</span>`;
            tr.appendChild(shipTd);

            // seller, motor columns depend on page (some pages hide via CSS/DOM)
            const sellerTd = document.createElement('td'); sellerTd.textContent = o.assignedSellerName || o.assignedSeller || '—'; tr.appendChild(sellerTd);
            const motorTd = document.createElement('td'); motorTd.textContent = o.assignedMotorName || o.assignedMotor || '—'; tr.appendChild(motorTd);

            // actions
            const actionsTd = document.createElement('td');
            actionsTd.className = 'actions';
            const viewBtn = document.createElement('button'); viewBtn.className = 'icon-btn view-btn'; viewBtn.title = 'Ver pedido';
            viewBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';
            viewBtn.addEventListener('click', () => openView(o.id));
            actionsTd.appendChild(viewBtn);

            // chat button
            const chatBtn = document.createElement('button'); chatBtn.className = 'icon-btn chat-btn'; chatBtn.title = 'Chat';
            chatBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 15.999.001L16 16l-4-1.333A7.967 7.967 0 0 1 0 8z"/></svg>';
            chatBtn.addEventListener('click', () => openChat(o.id));
            actionsTd.appendChild(chatBtn);

            // cobranza button (open payment modal) - always visible unless already paid
            const paid = (o.paymentStatus || '').toString().toLowerCase().includes('paid') || (o.paymentStatus || '').toString().toLowerCase().includes('pagad');
            if (!paid) {
                const payBtn = document.createElement('button'); payBtn.className = 'icon-btn pay-btn'; payBtn.title = 'Registrar cobranza';
                payBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M1 3v10h14V3H1zm2 2h10v2H3V5z"/></svg>';
                payBtn.addEventListener('click', async () => {
                    // ensure we have complete order object to pass to payment modal
                    const full = await fetchOrderById(o.id);
                    openPaymentModal(full);
                });
                actionsTd.appendChild(payBtn);
            } else {
                const paidLabel = document.createElement('span'); paidLabel.style.fontSize = '12px'; paidLabel.style.color = 'var(--muted)'; paidLabel.textContent = 'Cobrado'; actionsTd.appendChild(paidLabel);
            }

            // mark as enviado if motorizado assigned (and not delivered already)
            const motAssigned = o.assignedMotor || o.assignedMotorName;
            const delivered = (o.shippingStatus || '').toString().toLowerCase().includes('deliver') || (o.shippingStatus || '').toString().toLowerCase().includes('entreg');
            if (motAssigned && !delivered) {
                const sendBtn = document.createElement('button'); sendBtn.className = 'icon-btn send-btn'; sendBtn.title = 'Marcar como enviado';
                sendBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M2 2l12 6-12 6V2z"/></svg>';
                sendBtn.addEventListener('click', () => markAsSent(o.id));
                actionsTd.appendChild(sendBtn);
            }

            tr.appendChild(actionsTd);
            ordersBody.appendChild(tr);
        });
    }

    // mobile cards
    ordersCards.innerHTML = '';
    pageItems.forEach(o => {
        const card = document.createElement('div'); card.className = 'order-card';
        const cname = (o.customerData && (o.customerData.Customname || o.customerData.name)) || o.customerName || 'Sin nombre';
        const items = (o.items && Array.isArray(o.items) ? o.items.map(it => `${it.name || it.title} x${it.quantity || it.qty || 1}`).join(', ') : '');
        card.innerHTML = `
      <div class="order-card-header">
        <div class="order-card-avatar"><img src="assets/img/avatar-placeholder.png" alt=""></div>
        <div class="order-card-cust">
          <div class="order-card-cust-name">${escapeHtml(cname)}</div>
          <div class="order-card-cust-address small-muted">${escapeHtml((o.customerData && o.customerData.address) || '')}</div>
        </div>
        <div class="order-card-info">
          <div class="order-card-total">${money(o.total || o.amount || 0)}</div>
        </div>
      </div>
      <div class="order-card-prod small-muted"><strong>Productos:</strong> ${escapeHtml(items || '')}</div>
      <div class="order-card-status"><span class="badge">${escapeHtml(o.shippingStatus || o.status || '')}</span></div>
      <div class="order-card-actions" style="display:flex;gap:8px;margin-top:8px;"></div>
    `;
        const actionsDiv = card.querySelector('.order-card-actions');
        const btnView = document.createElement('button'); btnView.className = 'order-card-btn btn-view'; btnView.innerHTML = 'Ver';
        btnView.addEventListener('click', () => openView(o.id));
        actionsDiv.appendChild(btnView);
        const chatBtn = document.createElement('button'); chatBtn.className = 'order-card-btn'; chatBtn.innerHTML = 'Chat';
        chatBtn.addEventListener('click', () => openChat(o.id));
        actionsDiv.appendChild(chatBtn);
        if (!paid) {
            const payBtn = document.createElement('button'); payBtn.className = 'order-card-btn'; payBtn.innerHTML = 'Cobrar';
            payBtn.addEventListener('click', async () => openPaymentModal(await fetchOrderById(o.id)));
            actionsDiv.appendChild(payBtn);
        }
        if (motAssigned && !delivered) {
            const sendBtn = document.createElement('button'); sendBtn.className = 'order-card-btn'; sendBtn.innerHTML = 'Marcar enviado';
            sendBtn.addEventListener('click', () => markAsSent(o.id));
            actionsDiv.appendChild(sendBtn);
        }
        ordersCards.appendChild(card);
    });

    // pagination controls
    pageInfo.textContent = `${currentPage} / ${Math.max(1, Math.ceil(total / (perVal === 'all' ? total || 1 : per)))} (${total} pedidos)`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= Math.ceil(total / (perVal === 'all' ? total || 1 : per));
}

/* Fetch single order */
async function fetchOrderById(id) {
    try {
        const ref = doc(db, 'orders', id);
        const snap = await getDoc(ref);
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch (err) {
        console.error('fetchOrderById error', err);
        return null;
    }
}

/* Open view modal (renders basic timeline & order info) */
async function openView(orderId) {
    try {
        const data = await fetchOrderById(orderId);
        if (!data) { showToast('Pedido no encontrado', true); return; }
        // populate modal body
        viewModalBody.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.style.display = 'grid'; wrap.style.gap = '10px';
        const customer = data.customerData || data.customer || {};
        const custName = customer.Customname || customer.name || data.customerName || '—';
        const header = document.createElement('div');
        header.innerHTML = `<div style="display:flex;justify-content:space-between;"><div><strong>${escapeHtml(custName)}</strong><div class="small-muted">${escapeHtml(customer.phone || customer.email || '')}</div></div><div>${money(data.total || data.amount || 0)}<div class="small-muted">${formatDate(data.orderDate || data.createdAt)}</div></div></div>`;
        wrap.appendChild(header);
        // items
        const itemsWrap = document.createElement('div');
        itemsWrap.innerHTML = `<h4>Productos</h4>`;
        const table = document.createElement('table'); table.style.width = '100%';
        table.innerHTML = `<thead><tr><th>Producto</th><th style="text-align:center">Cant.</th><th style="text-align:right">Precio</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        (data.items || []).forEach(it => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${escapeHtml(it.name || it.title || '')}</td><td style="text-align:center">${escapeHtml(String(it.quantity || it.qty || 1))}</td><td style="text-align:right">${money(it.price || 0)}</td>`;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        itemsWrap.appendChild(table);
        wrap.appendChild(itemsWrap);

        // timeline
        const timeline = document.createElement('div');
        timeline.innerHTML = `<h4>Estado / Timeline</h4><div class="small-muted">Estado envío: ${escapeHtml(data.shippingStatus || '—')}</div><div class="small-muted">Estado pago: ${escapeHtml(data.paymentStatus || '—')}</div>`;
        if (data.deliveryConfirmedAt) timeline.innerHTML += `<div class="small-muted">Entregado: ${formatDate(data.deliveryConfirmedAt)}</div>`;
        wrap.appendChild(timeline);

        viewModalBody.appendChild(wrap);
        viewModal.classList.remove('hidden'); viewModal.setAttribute('aria-hidden', 'false');
    } catch (err) {
        console.error('openView error', err);
    }
}

/* Chat: simplistic implementation using orders/{id}/messages collection */
let currentChatOrderId = null;
let chatUnsubscribe = null;

function openChat(orderId) {
    currentChatOrderId = orderId;
    chatMessagesWrap.innerHTML = '<div class="small-muted">Cargando mensajes...</div>';
    chatModal.classList.remove('hidden'); chatModal.setAttribute('aria-hidden', 'false');
    // subscribe
    try {
        if (chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; }
        const msgsCol = collection(db, 'orders', orderId, 'messages');
        const q = query(msgsCol, orderBy('ts', 'asc'));
        chatUnsubscribe = onSnapshot(q, snap => {
            chatMessagesWrap.innerHTML = '';
            snap.forEach(s => {
                const d = s.data();
                const bubble = document.createElement('div');
                bubble.className = d.from === currentUser?.uid ? 'msg-bubble msg-own' : 'msg-bubble msg-other';
                bubble.textContent = d.text || '';
                chatMessagesWrap.appendChild(bubble);
            });
            chatMessagesWrap.scrollTop = chatMessagesWrap.scrollHeight;
        }, err => {
            console.error('chat subscribe err', err);
            chatMessagesWrap.innerHTML = '<div class="small-muted">No se pudieron cargar los mensajes.</div>';
        });
    } catch (err) {
        console.error('openChat error', err);
    }
}

async function sendChatMessage() {
    const text = (chatInput?.value || '').trim();
    if (!text || !currentChatOrderId || !currentUser) return;
    try {
        const msgsCol = collection(db, 'orders', currentChatOrderId, 'messages');
        await getDocs(msgsCol); // ensure path exists (not strictly needed)
        // addDoc not imported to avoid import bloat; use update on order doc sending a lastMessage subfield as fallback
        // But prefer addDoc to create subcollection:
        const addModule = await import("https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js");
        const { addDoc, serverTimestamp } = addModule;
        await addDoc(collection(db, 'orders', currentChatOrderId, 'messages'), { text, from: currentUser.uid, fromName: currentUser.email || '', ts: serverTimestamp() });
        // update "lastMessage" in order root for preview
        const orderRef = doc(db, 'orders', currentChatOrderId);
        await updateDoc(orderRef, { lastMessage: text, lastMessageAt: serverTimestamp() });
        chatInput.value = '';
        showToast('Mensaje enviado');
    } catch (err) {
        console.error('sendChatMessage error', err);
        showToast('No se pudo enviar el mensaje', true);
    }
}

/* Mark as sent */
async function markAsSent(orderId) {
    const ok = window.confirm('Marcar este pedido como ENVIADO?');
    if (!ok) return;
    try {
        const orderRef = doc(db, 'orders', orderId);
        await updateDoc(orderRef, { shippingStatus: 'enviado', shippingUpdatedAt: serverTimestamp() });
        showToast('Pedido marcado como enviado.');
    } catch (err) {
        console.error('markAsSent error', err);
        showToast('No se pudo marcar como enviado', true);
    }
}

/* CSV export */
function exportVisibleCsv() {
    const visible = ordersCache.filter(applyActiveFilters);
    if (!visible.length) { showToast('No hay datos para exportar.'); return; }
    const headers = ['id', 'client', 'products', 'date', 'total', 'paymentStatus', 'shippingStatus', 'seller', 'motor'];
    const rows = visible.map(o => {
        const client = (o.customerData && (o.customerData.Customname || o.customerData.name)) || o.customerName || '';
        const products = (o.items || []).map(i => i.name || i.title).join('; ');
        const date = formatDate(o.orderDate || o.createdAt);
        return headers.map(h => {
            if (h === 'id') return `"${o.id || ''}"`;
            if (h === 'client') return `"${String(client).replace(/"/g, '""')}"`;
            if (h === 'products') return `"${String(products).replace(/"/g, '""')}"`;
            if (h === 'date') return `"${String(date)}"`;
            if (h === 'total') return `"${String(o.total || o.amount || 0)}"`;
            if (h === 'paymentStatus') return `"${String(o.paymentStatus || '')}"`;
            if (h === 'shippingStatus') return `"${String(o.shippingStatus || o.status || '')}"`;
            if (h === 'seller') return `"${String(o.assignedSellerName || o.assignedSeller || '')}"`;
            if (h === 'motor') return `"${String(o.assignedMotorName || o.assignedMotor || '')}"`;
            return '""';
        }).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

/* Event wiring */
applyFiltersBtn?.addEventListener('click', () => {
    activeFilters = {
        product: filterProduct?.value || '',
        seller: filterSeller?.value || '',
        motor: filterMotor?.value || '',
        status: filterStatus?.value || '',
        search: filterClient?.value || ''
    };
    currentPage = 1;
    render();
});
clearFiltersBtn?.addEventListener('click', () => {
    filterProduct.value = '';
    filterSeller.value = '';
    filterMotor.value = '';
    filterStatus.value = '';
    filterClient.value = '';
    activeFilters = {};
    currentPage = 1;
    render();
});
perPageSelect?.addEventListener('change', () => { currentPage = 1; render(); });
prevPageBtn?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; render(); } });
nextPageBtn?.addEventListener('click', () => { currentPage++; render(); });
refreshBtn?.addEventListener('click', () => { listenOrders(); showToast('Sincronizando pedidos...'); });
exportCsv?.addEventListener('click', (e) => { e.preventDefault(); exportVisibleCsv(); });

viewModalClose?.addEventListener('click', () => { viewModal.classList.add('hidden'); viewModal.setAttribute('aria-hidden', 'true'); });
viewCloseBtn?.addEventListener('click', () => { viewModal.classList.add('hidden'); viewModal.setAttribute('aria-hidden', 'true'); });

chatModalCloseBtn?.addEventListener('click', () => { chatModal.classList.add('hidden'); chatModal.setAttribute('aria-hidden', 'true'); if (chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; } });
chatSendBtn?.addEventListener('click', sendChatMessage);
chatInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });

/* Authorization & start */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // Not authenticated - redirect to login or attempt to show public data
        console.warn('Usuario no autenticado. Redirigiendo a login...');
        window.location.href = '/index.html';
        return;
    }
    currentUser = user;

    try {
        // fetch user role
        const udoc = await getDoc(doc(db, 'users', user.uid));
        currentRole = udoc.exists() ? (udoc.data().role || 'vendedor') : 'vendedor';
    } catch (err) {
        console.error('Error leyendo rol:', err);
        currentRole = 'vendedor';
    }

    // UI adjustments per role
    // hide seller filter for vendedor
    if (currentRole === 'vendedor' && document.getElementById('filterSellerWrap')) {
        document.getElementById('filterSellerWrap').style.display = 'none';
    }
    // hide motor filter for motorizado
    if (currentRole === 'motorizado' && document.getElementById('filterMotorWrap')) {
        document.getElementById('filterMotorWrap').style.display = 'none';
    }

    // load selectors and then subscribe to orders
    await loadSelectors();
    listenOrders();

    // show export CSV only for admin
    if (exportCsv) exportCsv.style.display = (currentRole === 'administrador' ? '' : 'none');
});