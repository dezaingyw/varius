// assets/js/orders-admin.js
// Página de administración de pedidos (mejorada): modal de detalle con miniaturas resueltas desde Storage,
// imágenes cached, cartilla detallada de items (cantidad, precio unitario, subtotal), y control por roles.
//
// Requiere: assets/js/firebase-config.js (exporta firebaseConfig), y colecciones Firestore:
// - orders, users, product (para fallback de imágenes). También Storage para subir comprobantes.
// - Este archivo asume Firebase v12 modular imports.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  getDoc,
  updateDoc,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

// Initialize Firebase app
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

/* ---------------- UI elements ---------------- */
const ordersBody = document.getElementById('ordersBody');
const pageInfo = document.getElementById('pageInfo');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const perPageSelect = document.getElementById('perPageSelect');
const searchInput = document.getElementById('searchInput');
const paymentFilter = document.getElementById('paymentFilter');
const shippingFilter = document.getElementById('shippingFilter');
const sellerFilter = document.getElementById('sellerFilter');
const motorFilter = document.getElementById('motorFilter');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');
const refreshBtn = document.getElementById('refreshBtn');

const orderModal = document.getElementById('orderModal');
const orderModalTitle = document.getElementById('orderModalTitle');
const closeOrderModalBtn = document.getElementById('closeOrderModal');
const orderDetailsEl = document.getElementById('orderDetails');
const assignSection = document.getElementById('assignSection');
const assignSellerSelect = document.getElementById('assignSellerSelect');
const assignMotorSelect = document.getElementById('assignMotorSelect');
const saveAssignBtn = document.getElementById('saveAssignBtn');
const confirmDeliveryForm = document.getElementById('confirmDeliveryForm');
const deliveryPaymentMethod = document.getElementById('deliveryPaymentMethod');
const deliveryObs = document.getElementById('deliveryObs');
const deliveryProof = document.getElementById('deliveryProof');
const confirmDeliveryBtn = document.getElementById('confirmDeliveryBtn');

const toastEl = document.getElementById('toast');

/* ---------------- State ---------------- */
let currentUser = null;
let currentUserRole = null;
let unsubscribeOrders = null;
let ordersCache = []; // filtered set stored client-side
let currentPage = 1;
let currentViewedOrder = null;

/* ---------------- Helpers ---------------- */
function showToast(msg, timeout = 3500) {
  if (!toastEl) {
    console.log('TOAST:', msg);
    return;
  }
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.classList.add('hidden');
  }, timeout);
}

function escapeHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/[&<>"'`=\/]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '=': '&#x3D;', '`': '&#x60;' }[s]));
}

function capitalize(str) {
  if (!str) return '';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatCurrency(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch (e) {
    return `${amount} ${currency}`;
  }
}

/* ---------------- Traducción de estatus a español ---------------- */
function translateStatus(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim().toLowerCase();
  const map = {
    // pagos
    'paid': 'Pagado',
    'pagado': 'Pagado',
    'partial': 'Parcial',
    'partial_payment': 'Parcial',
    'pending': 'Pendiente',
    'pendiente': 'Pendiente',
    'refunded': 'Reembolsado',
    'reembolsado': 'Reembolsado',
    'failed': 'Fallido',
    'fallido': 'Fallido',
    // envíos / delivery
    'delivered': 'Entregado',
    'entregado': 'Entregado',
    'in_transit': 'En tránsito',
    'in transit': 'En tránsito',
    'in_transit': 'En tránsito',
    'assigned': 'Asignado',
    'asignado': 'Asignado',
    'cancelled': 'Cancelado',
    'cancelado': 'Cancelado',
    'sin-asignar': 'Sin asignar',
    'pending_shipment': 'Pendiente',
    // estados de pedido genéricos
    'suspended': 'Suspendido',
    'suspendido': 'Suspendido',
    'assigned': 'Asignado'
  };
  if (map[s]) return map[s];
  // fallback: capitalizar la palabra
  return String(raw).charAt(0).toUpperCase() + String(raw).slice(1);
}

/* ---------------- Build history URL helper (robusta) ---------------- */
function buildHistoryUrlFromOrder(o) {
  try {
    const od = o || {};
    // soporta estructura donde cliente está en customerData o customer o campos sueltos
    const cust = od.customerData || od.customer || {};
    const custId = cust.uid || od.customerId || cust.customerId || od.customerId || '';
    const custName = cust.name || cust.Customname || od.customerName || od.customer_name || '';
    const custPhone = cust.phone || cust.telefono || cust.mobile || od.customerPhone || '';
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

/* ---------------- Image resolution caches & helpers (shared with vendedor) ---------------- */
const urlCache = new Map(); // storagePath or gs:// -> downloadURL
const productImagesCache = new Map(); // productId -> [urls]

// Fetch product document and resolve its imageUrls or imagePaths (cached)
async function fetchProductImages(productId) {
  if (!productId) return [];
  if (productImagesCache.has(productId)) return productImagesCache.get(productId);
  try {
    const pSnap = await getDoc(doc(db, 'product', productId));
    if (!pSnap.exists()) {
      productImagesCache.set(productId, []);
      return [];
    }
    const pdata = pSnap.data();
    // Prefer imageUrls (already downloadable URLs)
    if (Array.isArray(pdata.imageUrls) && pdata.imageUrls.length) {
      productImagesCache.set(productId, pdata.imageUrls.slice());
      return pdata.imageUrls.slice();
    }
    // If imagePaths array present -> resolve each with getDownloadURL
    const pathCandidates = Array.isArray(pdata.imagePaths) && pdata.imagePaths.length ? pdata.imagePaths.slice() : (pdata.imagePath ? [pdata.imagePath] : []);
    if (pathCandidates.length) {
      const resolved = await Promise.all(pathCandidates.map(async p => {
        try {
          if (!p) return '';
          if (urlCache.has(p)) return urlCache.get(p);
          const ref = storageRef(storage, p.startsWith('/') ? p.slice(1) : p);
          const durl = await getDownloadURL(ref);
          urlCache.set(p, durl);
          return durl;
        } catch (e) {
          console.warn('fetchProductImages: no se pudo resolver path', p, e);
          return '';
        }
      }));
      const filtered = resolved.filter(Boolean);
      productImagesCache.set(productId, filtered);
      return filtered;
    }
    // If single imageUrl field exists
    if (pdata.imageUrl) {
      productImagesCache.set(productId, [pdata.imageUrl]);
      return [pdata.imageUrl];
    }
    productImagesCache.set(productId, []);
    return [];
  } catch (err) {
    console.error('fetchProductImages error', err);
    productImagesCache.set(productId, []);
    return [];
  }
}

// Resolve an image reference into a usable HTTP URL with caching and fallbacks.
// imgRefOrUrl: can be http(s) URL, gs://..., storage path, or filename.
// productId: optional fallback to read product doc images
async function resolveImageUrl(imgRefOrUrl, productId) {
  try {
    if (imgRefOrUrl && /^https?:\/\//i.test(imgRefOrUrl)) return imgRefOrUrl;
    const v = (imgRefOrUrl || '').toString().trim();
    if (!v && productId) {
      // fallback: use product main image
      const pimgs = await fetchProductImages(productId);
      return pimgs[0] || '';
    }
    if (!v) return '';

    // gs://bucket/path -> remove prefix and use path
    if (/^gs:\/\//i.test(v)) {
      const path = v.replace(/^gs:\/\/[^\/]+\//i, '');
      if (!path) return '';
      if (urlCache.has(v)) return urlCache.get(v);
      try {
        const ref = storageRef(storage, path);
        const durl = await getDownloadURL(ref);
        urlCache.set(v, durl);
        return durl;
      } catch (e) {
        console.warn('resolveImageUrl gs:// failed', v, e);
        if (productId) {
          const pimgs = await fetchProductImages(productId);
          return pimgs[0] || '';
        }
        return '';
      }
    }

    // If looks like a storage path (contains products/ or has an extension)
    let pathCandidate = v;
    if (pathCandidate.startsWith('/')) pathCandidate = pathCandidate.slice(1);

    const looksLikePath = /products\//i.test(pathCandidate) || /\.[a-zA-Z0-9]{2,5}$/.test(pathCandidate);
    if (looksLikePath) {
      if (urlCache.has(pathCandidate)) return urlCache.get(pathCandidate);
      try {
        const ref = storageRef(storage, pathCandidate);
        const durl = await getDownloadURL(ref);
        urlCache.set(pathCandidate, durl);
        return durl;
      } catch (e) {
        console.warn('resolveImageUrl path failed', pathCandidate, e);
        if (productId) {
          const pimgs = await fetchProductImages(productId);
          return pimgs[0] || '';
        }
        return '';
      }
    }

    // If it's likely a bare filename (e.g. "imagen_1.jpg") try product doc if productId provided
    if (productId) {
      const pimgs = await fetchProductImages(productId);
      const match = pimgs.find(u => u.endsWith(pathCandidate) || u.includes(pathCandidate));
      if (match) return match;
      return pimgs[0] || '';
    }

    return '';
  } catch (err) {
    console.error('resolveImageUrl unexpected error', err);
    return '';
  }
}

/* ---------------- Populate user selects ---------------- */
async function populateUserSelectors() {
  assignSellerSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  assignMotorSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  sellerFilter.innerHTML = '<option value="">Todos</option>';
  motorFilter.innerHTML = '<option value="">Todos</option>';

  try {
    const usersCol = collection(db, 'users');
    const usersSnap = await getDocs(usersCol);
    usersSnap.forEach(snap => {
      const u = { id: snap.id, ...snap.data() };
      if (u.role === 'vendedor') {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.email || u.name || u.id;
        assignSellerSelect.appendChild(opt);
        sellerFilter.appendChild(opt.cloneNode(true));
      }
      if (u.role === 'motorizado') {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.email || u.name || u.id;
        assignMotorSelect.appendChild(opt);
        motorFilter.appendChild(opt.cloneNode(true));
      }
    });
  } catch (err) {
    console.error('Error cargando usuarios:', err);
  }
}

/* ---------------- Build Firestore query by role & filters ---------------- */
function buildOrdersQuery() {
  const ordersCol = collection(db, 'orders');

  // Admin: optional where clauses if filters selected
  if (currentUserRole === 'administrador') {
    const clauses = [];
    if (paymentFilter && paymentFilter.value) clauses.push(where('paymentStatus', '==', paymentFilter.value));
    if (shippingFilter && shippingFilter.value) clauses.push(where('shippingStatus', '==', shippingFilter.value));
    if (sellerFilter && sellerFilter.value) clauses.push(where('assignedSeller', '==', sellerFilter.value));
    if (motorFilter && motorFilter.value) clauses.push(where('assignedMotor', '==', motorFilter.value));
    if (clauses.length) return query(ordersCol, ...clauses, orderBy('orderDate', 'desc'));
    return query(ordersCol, orderBy('orderDate', 'desc'));
  }

  // Vendedor: only assigned to them
  if (currentUserRole === 'vendedor') {
    return query(ordersCol, where('assignedSeller', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  }

  // Motorizado: only assigned to them
  if (currentUserRole === 'motorizado') {
    return query(ordersCol, where('assignedMotor', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  }

  // Default: admin-like
  return query(ordersCol, orderBy('orderDate', 'desc'));
}

/* ---------------- Subscribe to orders (real-time) ---------------- */
function subscribeOrders() {
  if (unsubscribeOrders) {
    unsubscribeOrders();
    unsubscribeOrders = null;
  }

  const q = buildOrdersQuery();

  unsubscribeOrders = onSnapshot(q, snapshot => {
    const items = [];
    snapshot.forEach(docSnap => items.push({ id: docSnap.id, ...docSnap.data() }));

    // client-side filters: search (id/name/phone/email) and date range
    const s = (searchInput && searchInput.value || '').trim().toLowerCase();
    const from = dateFrom && dateFrom.value ? new Date(dateFrom.value) : null;
    const to = dateTo && dateTo.value ? new Date(dateTo.value) : null;

    let filtered = items.filter(o => {
      // search
      if (s) {
        const idMatch = (o.id || '').toLowerCase().includes(s);
        const name = (o.customerData && (o.customerData.name || o.customerData.Customname || '')) || '';
        const email = (o.customerData && (o.customerData.email || '')) || '';
        const phone = (o.customerData && (o.customerData.phone || '')) || '';
        if (!(idMatch || name.toLowerCase().includes(s) || email.toLowerCase().includes(s) || phone.toLowerCase().includes(s))) return false;
      }

      // date
      if (from || to) {
        if (!o.orderDate) return false;
        const od = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
        if (from && od < from) return false;
        if (to && od > new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59)) return false;
      }

      return true;
    });

    ordersCache = filtered;
    currentPage = 1;
    renderPage();
  }, err => {
    console.error('Snapshot error:', err);
    showToast('Error recibiendo pedidos en tiempo real. Revisa la consola.');
  });
}

/* ---------------- Render page (client-side pagination) ---------------- */
function renderPage() {
  // ------- Tabla tradicional para escritorio -------
  const perPageVal = perPageSelect ? perPageSelect.value : '10';
  const per = perPageVal === 'all' ? ordersCache.length || 1e9 : parseInt(perPageVal, 10) || 10;
  const total = ordersCache.length;
  const totalPages = Math.max(1, Math.ceil(total / per));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * per;
  const end = start + per;
  const pageItems = ordersCache.slice(start, end);

  ordersBody.innerHTML = '';
  pageItems.forEach(o => {
    const tr = document.createElement('tr');

    // ID
    const tdId = document.createElement('td');
    tdId.setAttribute('data-label', 'ID');
    tdId.textContent = o.id;
    tr.appendChild(tdId);

    // Cliente
    const tdCust = document.createElement('td');
    tdCust.setAttribute('data-label', 'Cliente');
    const name = o.customerData && (o.customerData.name || o.customerData.Customname || o.customerData.email || '');
    const email = o.customerData && (o.customerData.email || '');
    const phone = o.customerData && (o.customerData.phone || '');
    tdCust.innerHTML = `<div style="font-weight:600">${escapeHtml(name || email || '—')}</div><div style="color:#6b7280;font-size:12px">${escapeHtml(email || phone || '')}</div>`;
    tr.appendChild(tdCust);

    // Producto
    const tdItems = document.createElement('td');
    tdItems.setAttribute('data-label', 'Producto');
    const itemsCount = Array.isArray(o.items) ? o.items.length : 0;
    tdItems.textContent = `${itemsCount} item(s)`;
    tr.appendChild(tdItems);

    // Fecha
    const tdDate = document.createElement('td');
    tdDate.setAttribute('data-label', 'Fecha');
    if (o.orderDate) {
      const d = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
      tdDate.textContent = d.toLocaleString();
    } else tdDate.textContent = '—';
    tr.appendChild(tdDate);

    // Total
    const tdTotal = document.createElement('td');
    tdTotal.setAttribute('data-label', 'Total');
    tdTotal.textContent = o.total ? formatCurrency(o.total, o.currency || 'USD') : '—';
    tr.appendChild(tdTotal);

    // Estado Pago
    const tdPay = document.createElement('td');
    tdPay.setAttribute('data-label', 'Pago');
    const payStatus = o.paymentStatus || 'pending';
    const payBadge = document.createElement('span');
    payBadge.className = `badge ${payStatus === 'paid' || payStatus === 'pagado' ? 'paid' : 'pending'}`;
    // show status in Spanish
    payBadge.textContent = translateStatus(payStatus);
    tdPay.appendChild(payBadge);
    tr.appendChild(tdPay);

    // Estado Envío
    const tdShip = document.createElement('td');
    tdShip.setAttribute('data-label', 'Envío');
    const shipStatus = o.shippingStatus || 'pending';
    const shipBadge = document.createElement('span');
    shipBadge.className = `badge ${shipStatus === 'delivered' || shipStatus === 'entregado' ? 'delivered' : shipStatus === 'in_transit' || shipStatus === 'enviado' ? 'in_transit' : ''}`;
    shipBadge.textContent = translateStatus(shipStatus);
    tdShip.appendChild(shipBadge);
    tr.appendChild(tdShip);

    // Vendedor
    const tdSeller = document.createElement('td');
    tdSeller.setAttribute('data-label', 'Vendedor');
    tdSeller.textContent = (o.assignedSellerName || o.assignedSeller || '—');
    tr.appendChild(tdSeller);

    // Motorizado
    const tdMotor = document.createElement('td');
    tdMotor.setAttribute('data-label', 'Motorizado');
    tdMotor.textContent = (o.assignedMotorName || o.assignedMotor || '—');
    tr.appendChild(tdMotor);

    // Acciones
    const tdActions = document.createElement('td');
    tdActions.setAttribute('data-label', 'Acciones');
    tdActions.className = 'actions';

    // Botón Ver
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn-small btn-view';
    viewBtn.setAttribute('aria-label', 'Ver pedido');
    viewBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#24784a" stroke-width="2"
      viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8Z" stroke="#24784a"/><circle cx="8" cy="8" r="3" stroke="#24784a"/></svg>`;
    viewBtn.addEventListener('click', () => openOrderModal(o));
    tdActions.appendChild(viewBtn);

    // Botón Asignar
    if (currentUserRole === 'administrador' || currentUserRole === 'vendedor') {
      const assignBtn = document.createElement('button');
      assignBtn.className = 'btn-small btn-assign';
      assignBtn.setAttribute('aria-label', 'Asignar pedido');
      assignBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#2477b8" stroke-width="2"
      viewBox="0 0 16 16"><circle cx="8" cy="5" r="3"/><path d="M8 13c3 0 5.5-1.5 5.5-3v-1A1.5 1.5 0 0 0 12 7.5H4A1.5 1.5 0 0 0 1.5 9V10c0 1.5 2.5 3 5.5 3Z"/></svg>`;
      assignBtn.addEventListener('click', () => openOrderModal(o, { openAssign: true }));
      tdActions.appendChild(assignBtn);
    }

    // Botón historial de cliente
    const custId = (o.customerData && (o.customerData.uid || o.customerId || o.customerData.customerId)) || '';
    const custName = (o.customerData && (o.customerData.name || o.customerData.Customname || '')) || '';
    const custPhone = (o.customerData && (o.customerData.phone || '')) || '';
    const histBtn = document.createElement('button');
    histBtn.className = 'btn-small btn-history';
    histBtn.setAttribute('title', 'Historial del cliente');
    histBtn.setAttribute('aria-label', 'Historial del cliente');
    histBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#7a4b3b" stroke-width="2"
      viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 7h12"/></svg>`;
    histBtn.addEventListener('click', () => {
      // use robust helper to build URL
      const url = buildHistoryUrlFromOrder(o);
      window.location.href = url;
    });
    tdActions.appendChild(histBtn);

    tr.appendChild(tdActions);
    ordersBody.appendChild(tr);
  });

  pageInfo.textContent = `${currentPage} / ${Math.max(1, Math.ceil(ordersCache.length / (perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10)))} (${ordersCache.length} pedidos)`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= Math.ceil(ordersCache.length / (perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10));

  // ------- Cards para mobile -------
  const ordersCards = document.getElementById('ordersCards');
  if (ordersCards) {
    ordersCards.innerHTML = '';
    pageItems.forEach(order => {
      const customer = order.customerData || {};
      const avatarUrl = "assets/img/user-default.png";
      const itemsList =
        (order.items || [])
          .map(it => `<li>• ${escapeHtml(it.name)} x${it.quantity || 1}</li>`).join('');
      const isDelivered =
        (order.shippingStatus === 'delivered' || order.shippingStatus === 'entregado');
      const isPaid =
        (order.paymentStatus === 'paid' || order.paymentStatus === 'pagado');

      const card = document.createElement('div');
      card.className = 'order-card';

      card.innerHTML = `
        <div class="order-card-header">
          <div class="order-card-avatar">
            <img src="${avatarUrl}" alt="">
          </div>
          <div class="order-card-cust">
            <div class="order-card-cust-name">${escapeHtml(customer.name || customer.Customname || customer.email || '—')}</div>
            <div class="order-card-cust-address">${escapeHtml(customer.address || customer.addressLine1 || '')}</div>
          </div>
          <div class="order-card-info">
            <div class="order-card-total">${formatCurrency(order.total || 0, order.currency || 'USD')}</div>
            <div class="order-card-code">#${order.id}</div>
          </div>
        </div>
        <div class="order-card-prod">
          <div><b>Productos:</b></div>
          <div class="order-card-prod-list">
            <div style="text-align:right;">${order.items?.length || 0} items</div>
            <ul>${itemsList}</ul>
          </div>
        </div>
        <div class="order-card-status">
          <span>Envío:</span>
          <span class="badge ${isDelivered ? 'badge-ok' : 'badge-pending'}">${escapeHtml(translateStatus(order.shippingStatus || 'Pendiente'))}</span>
          <span>Pago:</span>
          <span class="badge ${isPaid ? 'badge-ok' : 'badge-pending'}">${escapeHtml(translateStatus(order.paymentStatus || 'Pendiente'))}</span>
        </div>
        <div class="order-card-actions"></div>
      `;
      ordersCards.appendChild(card);

      // --------- Botones mobile (idénticos visualmente a los de la tabla) ---------
      const actionsDiv = card.querySelector('.order-card-actions');
      actionsDiv.innerHTML = generateOrderCardButtonsMobile(order);
      // Listeners
      actionsDiv.querySelector('.btn-view').onclick = () => openOrderModal(order);
      const assignBtn = actionsDiv.querySelector('.btn-assign');
      if (assignBtn) assignBtn.onclick = () => openOrderModal(order, { openAssign: true });
      actionsDiv.querySelector('.btn-history').onclick = () => {
        const url = buildHistoryUrlFromOrder(order);
        window.location.href = url;
      };
    });
  }
}

// ----- Botones para los cards en mobile -----
function generateOrderCardButtonsMobile(order) {
  let buttons = '';
  buttons += `<button class="btn-small btn-view" aria-label="Ver pedido" type="button" style="height:15%; width:10%;margin-bottom:7px;">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#24784a" stroke-width="2"
      viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8Z" stroke="#24784a"/><circle cx="8" cy="8" r="3" stroke="#24784a"/></svg>
  </button>`;

  if (currentUserRole === 'administrador' || currentUserRole === 'vendedor') {
    buttons += `<button class="btn-small btn-assign" aria-label="Asignar pedido" type="button" style="height:15%; width:10%;margin-bottom:7px;">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#2477b8" stroke-width="2"
        viewBox="0 0 16 16"><circle cx="8" cy="5" r="3"/><path d="M8 13c3 0 5.5-1.5 5.5-3v-1A1.5 1.5 0 0 0 12 7.5H4A1.5 1.5 0 0 0 1.5 9V10c0 1.5 2.5 3 5.5 3Z"/></svg>
    </button>`;
  }

  buttons += `<button class="btn-small btn-history" aria-label="Historial del cliente" type="button" style="height:15%; width:10%; margin-bottom:7px;">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#7a4b3b" stroke-width="2"
      viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 7h12"/></svg>
  </button>`;
  return buttons;
}

/* ---------------- Ownership helper ---------------- */
function isOrderOwnedByCurrentUser(order) {
  if (!order || !currentUser) return false;
  const uid = currentUser.uid;
  if (order.assignedSeller === uid) return true;
  if (Array.isArray(order.vendedorIds) && order.vendedorIds.includes(uid)) return true;
  if (order.createdBy === uid) return true;
  // allow email match fallback
  if (order.assignedSellerName && order.assignedSellerName === currentUser.email) return true;
  return false;
}
/* ---------------- Modal: open / close / assign / confirm delivery ---------------- */
// openOrderModal ahora es async para resolver imágenes antes de renderizar
async function openOrderModal(order, opts = {}) {
  currentViewedOrder = order;
  orderModalTitle.textContent = `Pedido ${order.id}`;

  // Normalize items to ensure consistent keys
  const rawItems = Array.isArray(order.items) ? order.items.map(it => ({
    id: it.id || it.productId || it.product_id || '',
    name: it.name || it.title || it.productName || 'Producto',
    qty: Number(it.quantity || it.qty || 1),
    price: Number(it.price || it.unitPrice || it.totalPrice || 0),
    imageRef: it.image || it.imageUrl || it.thumbnail || it.imagePath || it.storagePath || it.path || '',
    productId: it.productId || it.product_id || it.product || ''
  })) : [];

  // Resolve images in parallel
  const resolved = await Promise.all(rawItems.map(it => resolveImageUrl(it.imageRef, it.productId)));
  const items = rawItems.map((it, i) => ({ ...it, imageUrl: resolved[i] || '' }));

  // Build detailed HTML (cartilla)
  const container = document.createElement('div');
  container.style.display = 'grid';
  container.style.gridTemplateColumns = '1fr';
  container.style.gap = '12px';

  // Customer info block
  const cust = order.customerData || order.customer || {};
  const custName = cust.name || cust.Customname || cust.customName || order.customerName || '';
  const custEmail = cust.email || '';
  const custPhone = cust.phone || cust.telefono || '';
  const custAddress = (cust.address && (cust.address.line1 || cust.address)) || order.address || '';

  const custCard = document.createElement('div');
  custCard.style.display = 'flex';
  custCard.style.gap = '12px';
  custCard.style.alignItems = 'center';
  custCard.style.padding = '12px';
  custCard.className = 'card customer-card';

  const avatar = document.createElement('div');
  avatar.className = 'thumb';
  avatar.style.width = '72px';
  avatar.style.height = '72px';
  avatar.style.borderRadius = '8px';
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.fontWeight = '700';
  avatar.style.background = '#f3f4f6';
  avatar.textContent = (custName ? custName.slice(0,2).toUpperCase() : 'CL');

  const meta = document.createElement('div');
  meta.style.flex = '1';
  meta.innerHTML = `<div style="font-weight:700;font-size:15px;">${escapeHtml(custName || '—')}</div>
                    <div style="font-size:13px;color:#6b7280;margin-top:6px;">${escapeHtml(custAddress || '')}</div>
                    <div style="margin-top:8px;font-size:13px;"><strong>Tel:</strong> ${escapeHtml(custPhone || '—')} &nbsp; <strong>Email:</strong> ${escapeHtml(custEmail || '—')}</div>`;

  custCard.appendChild(avatar);
  custCard.appendChild(meta);
  container.appendChild(custCard);

  // Products table (detailed)
  const productsWrap = document.createElement('div');
  productsWrap.className = 'card';
  productsWrap.style.padding = '12px';

  const title = document.createElement('h3');
  title.style.margin = '0 0 8px 0';
  title.textContent = `Productos (${items.reduce((s,it)=>s+(it.qty||0),0)})`;
  productsWrap.appendChild(title);

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.innerHTML = `<thead>
    <tr style="text-align:left;color:#6b7280;font-size:13px;">
      <th style="padding:8px 6px;">Imagen</th>
      <th style="padding:8px 6px;">Producto</th>
      <th style="padding:8px 6px;">Cant.</th>
      <th style="padding:8px 6px;">Precio unit.</th>
      <th style="padding:8px 6px;">Subtotal</th>
    </tr>
  </thead>`;

  const tbody = document.createElement('tbody');
  items.forEach(it => {
    const tr = document.createElement('tr');
    tr.style.borderTop = '1px solid #e5e7eb';

    // image cell
    const imgTd = document.createElement('td');
    imgTd.style.padding = '8px 6px';
    imgTd.style.width = '72px';
    if (it.imageUrl) {
      const img = document.createElement('img');
      img.src = it.imageUrl;
      img.alt = it.name;
      img.style.width = '64px';
      img.style.height = '64px';
      img.style.objectFit = 'cover';
      img.loading = 'lazy';
      imgTd.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.style.width = '64px';
      ph.style.height = '64px';
      ph.style.background = '#f3f4f6';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.style.color = '#9aa0a6';
      ph.style.fontWeight = '700';
      ph.textContent = (it.name ? it.name.slice(0,2).toUpperCase() : 'IMG');
      imgTd.appendChild(ph);
    }

    // name
    const nameTd = document.createElement('td');
    nameTd.style.padding = '8px 6px';
    nameTd.innerHTML = `<div style="font-weight:600">${escapeHtml(it.name)}</div>`;

    // qty
    const qtyTd = document.createElement('td');
    qtyTd.style.padding = '8px 6px';
    qtyTd.textContent = String(it.qty || 0);

    // unit price
    const priceTd = document.createElement('td');
    priceTd.style.padding = '8px 6px';
    priceTd.textContent = formatCurrency(it.price || 0, order.currency || 'USD');

    // subtotal
    const subTd = document.createElement('td');
    subTd.style.padding = '8px 6px';
    const subtotal = (it.price || 0) * (it.qty || 0);
    subTd.textContent = formatCurrency(subtotal, order.currency || 'USD');

    tr.appendChild(imgTd);
    tr.appendChild(nameTd);
    tr.appendChild(qtyTd);
    tr.appendChild(priceTd);
    tr.appendChild(subTd);
    tbody.appendChild(tr);
  });

  // If no items
  if (items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.style.padding = '12px';
    td.style.textAlign = 'center';
    td.textContent = 'No hay productos listados en esta orden';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  productsWrap.appendChild(table);

  // Totals and order meta
  const metaWrap = document.createElement('div');
  metaWrap.style.display = 'flex';
  metaWrap.style.justifyContent = 'flex-end';
  metaWrap.style.marginTop = '12px';
  metaWrap.style.gap = '16px';

  const totals = document.createElement('div');
  totals.style.minWidth = '220px';
  totals.style.textAlign = 'right';
  totals.innerHTML = `
    <div style="font-size:13px;color:#6b7280">Subtotal: <span style="font-weight:700">${formatCurrency(order.subtotal || order.total || 0, order.currency || 'USD')}</span></div>
    <div style="font-size:13px;color:#6b7280;margin-top:6px">Envío: <span style="font-weight:700">${order.shippingFee ? formatCurrency(order.shippingFee, order.currency || 'USD') : '—'}</span></div>
    <div style="font-size:15px;margin-top:8px">Total: <span style="font-weight:900">${formatCurrency(order.total || order.amount || 0, order.currency || 'USD')}</span></div>
    <div style="font-size:13px;color:#6b7280;margin-top:8px">Pago: <strong>${escapeHtml(translateStatus(order.paymentStatus || 'pending'))}</strong></div>
    <div style="font-size:13px;color:#6b7280;margin-top:4px">Envío: <strong>${escapeHtml(translateStatus(order.shippingStatus || 'pending'))}</strong></div>
  `;
  metaWrap.appendChild(totals);

  // Append parts
  container.appendChild(productsWrap);
  container.appendChild(metaWrap);

  // Inject into modal body
  orderDetailsEl.innerHTML = '';
  orderDetailsEl.appendChild(container);

  // Configure assignSection visibility & fields by role (existing logic)
  try {
    if (currentUserRole === 'administrador') {
      assignSection.style.display = 'block';
      assignSellerSelect.style.display = '';
      assignSellerSelect.value = order.assignedSeller || '';
      assignMotorSelect.style.display = '';
      assignMotorSelect.value = order.assignedMotor || '';
      saveAssignBtn.style.display = '';
      saveAssignBtn.disabled = false;
    } else if (currentUserRole === 'vendedor') {
      assignSection.style.display = 'block';
      // hide seller selector (can't change seller)
      assignSellerSelect.style.display = 'none';
      assignMotorSelect.style.display = '';
      assignMotorSelect.value = order.assignedMotor || '';
      // only allow assign if owner
      if (!isOrderOwnedByCurrentUser(order)) {
        saveAssignBtn.disabled = true;
        saveAssignBtn.title = 'No autorizado para asignar este pedido';
      } else {
        saveAssignBtn.disabled = false;
        saveAssignBtn.title = '';
      }
      saveAssignBtn.style.display = '';
    } else {
      assignSection.style.display = 'none';
    }
  } catch (err) {
    console.error('Error configuring assignSection', err);
    assignSection.style.display = 'none';
  }

  // Show confirm delivery form for motorizado assigned to this order
  if (currentUserRole === 'motorizado' && (order.assignedMotor === currentUser.uid || order.assignedMotorName === currentUser.email)) {
    confirmDeliveryForm.classList.remove('hidden');
  } else {
    confirmDeliveryForm.classList.add('hidden');
  }

  // Reset delivery inputs
  deliveryPaymentMethod.value = 'pago_movil';
  deliveryObs.value = '';
  if (deliveryProof) deliveryProof.value = '';

  // Show modal
  orderModal.classList.remove('hidden');
  orderModal.setAttribute('aria-hidden', 'false');
}

function closeOrderModal() {
  orderModal.classList.add('hidden');
  orderModal.setAttribute('aria-hidden', 'true');
  currentViewedOrder = null;
}

/* Save assignments */
async function saveAssignments() {
  if (!currentViewedOrder) return;
  if (!currentUser) { showToast('No autenticado'); return; }

  const seller = assignSellerSelect.value || null;
  const motor = assignMotorSelect.value || null;

  try {
    const orderRef = doc(db, 'orders', currentViewedOrder.id);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) { showToast('Pedido no encontrado'); return; }
    const currentData = snap.data();

    const updates = {};

    if (currentUserRole === 'administrador') {
      if (seller !== (currentViewedOrder.assignedSeller || null)) {
        updates.assignedSeller = seller || null;
        updates.assignedSellerName = assignSellerSelect.options[assignSellerSelect.selectedIndex] ? assignSellerSelect.options[assignSellerSelect.selectedIndex].text : '';
      }
      if (motor !== (currentViewedOrder.assignedMotor || null)) {
        updates.assignedMotor = motor || null;
        updates.assignedMotorName = assignMotorSelect.options[assignMotorSelect.selectedIndex] ? assignMotorSelect.options[assignMotorSelect.selectedIndex].text : '';
      }
    } else if (currentUserRole === 'vendedor') {
      if (!isOrderOwnedByCurrentUser(currentViewedOrder)) { showToast('No autorizado para asignar este pedido.'); return; }
      if (motor) {
        if (motor !== (currentViewedOrder.assignedMotor || null)) {
          updates.assignedMotor = motor;
          updates.assignedMotorName = assignMotorSelect.options[assignMotorSelect.selectedIndex] ? assignMotorSelect.options[assignMotorSelect.selectedIndex].text : '';
        }
      } else {
        updates.assignedMotor = null;
        updates.assignedMotorName = '';
      }
    } else {
      showToast('No tienes permiso para asignar.', 4000);
      return;
    }

    if (Object.keys(updates).length === 0) { showToast('No hay cambios que guardar.'); return; }

    // If assigned, set shippingStatus assigned
    if (updates.assignedMotor || updates.assignedSeller) {
      updates.shippingStatus = 'assigned';
      updates.shippingUpdatedAt = serverTimestamp();
    }
    updates.updatedAt = serverTimestamp();

    await updateDoc(orderRef, updates);
    showToast('Asignaciones guardadas.');
    closeOrderModal();
  } catch (err) {
    console.error('Error guardando asignaciones:', err);
    showToast('Error guardando asignaciones.', 5000);
  }
}

/* Confirm delivery by motorizado (with optional proof) */
async function confirmDelivery() {
  if (!currentViewedOrder) return;
  const method = deliveryPaymentMethod.value || 'otro';
  const obs = deliveryObs.value || '';
  const file = deliveryProof.files && deliveryProof.files[0];

  if (file && file.size > 5 * 1024 * 1024) {
    showToast('El comprobante supera 5MB.');
    return;
  }

  try {
    const orderRef = doc(db, 'orders', currentViewedOrder.id);
    const updates = {
      shippingStatus: 'delivered',
      paymentStatus: 'paid',
      deliveryConfirmedAt: serverTimestamp(),
      deliveryNotes: obs,
      deliveryPaymentMethod: method,
      updatedAt: serverTimestamp()
    };

    if (file) {
      // upload to storage under proofs/{orderId}/...
      const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
      const ref = storageRef(storage, `order_proofs/${currentViewedOrder.id}/${safeName}`);
      const snap = await uploadBytes(ref, file);
      const url = await getDownloadURL(snap.ref);
      updates.deliveryProofURL = url;
      updates.deliveryProofPath = snap.ref.fullPath || `order_proofs/${currentViewedOrder.id}/${safeName}`;
    }

    await updateDoc(orderRef, updates);
    showToast('Entrega confirmada. Pedido marcado como entregado y pagado.');
    closeOrderModal();
  } catch (err) {
    console.error('Error confirmando entrega:', err);
    showToast('Error confirmando entrega.', 5000);
  }
}

/* ---------------- Event wiring ---------------- */
prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderPage();
  }
});
nextPageBtn.addEventListener('click', () => {
  const per = perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10;
  const totalPages = Math.max(1, Math.ceil(ordersCache.length / per));
  if (currentPage < totalPages) {
    currentPage++;
    renderPage();
  }
});
perPageSelect.addEventListener('change', () => {
  currentPage = 1;
  renderPage();
});
applyFiltersBtn.addEventListener('click', () => {
  subscribeOrders();
});
clearFiltersBtn.addEventListener('click', () => {
  searchInput.value = '';
  paymentFilter.value = '';
  shippingFilter.value = '';
  sellerFilter.value = '';
  motorFilter.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  perPageSelect.value = '10';
  subscribeOrders();
});
refreshBtn.addEventListener('click', () => {
  subscribeOrders();
});

closeOrderModalBtn.addEventListener('click', closeOrderModal);
saveAssignBtn.addEventListener('click', saveAssignments);
confirmDeliveryBtn.addEventListener('click', confirmDelivery);

// close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOrderModal();
});

/* Search Enter triggers */
searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') subscribeOrders();
});

/* ---------------- Auth state & initialization ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    console.warn('No user signed in.');
    // optionally redirect to login
    // window.location.href = '/index.html';
    return;
  }
  currentUser = user;
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    if (userDocSnap.exists()) {
      currentUserRole = userDocSnap.data().role || 'vendedor';
    } else {
      currentUserRole = 'vendedor';
      // create a minimal user doc if absent (non-blocking)
      try {
        await addDoc(collection(db, 'users'), { email: user.email || '', role: 'vendedor', createdAt: serverTimestamp() });
      } catch (_) { /* ignore */ }
    }

    await populateUserSelectors();
    subscribeOrders();
    showToast(`Conectado como ${currentUserRole}`, 2000);
  } catch (err) {
    console.error('Error obteniendo rol de usuario:', err);
    showToast('Error iniciando la gestión de pedidos.');
  }
});

/* ---------------- Export / public API (optional) ---------------- */
export { subscribeOrders, populateUserSelectors };