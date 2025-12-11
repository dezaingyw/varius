import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const ordersTodayEl = document.getElementById('kpi-orders-today');
const salesEl = document.getElementById('kpi-sales');

const kpiModal = document.getElementById('kpiModal');
const kpiModalBody = document.getElementById('kpiModalBody');
const kpiModalClose = document.getElementById('kpiModalClose');
const kpiModalCloseBtn = document.getElementById('kpiModalCloseBtn');

function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatMoney(n) {
  try { return Number(n || 0).toLocaleString(); } catch (e) { return String(n || 0); }
}

function parseDate(raw) {
  if (!raw) return null;
  // Firestore Timestamp
  if (typeof raw.toDate === 'function') {
    try { return raw.toDate(); } catch (e) { /* fallthrough */ }
  }
  // ISO string
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  // JS Date
  if (raw instanceof Date) return raw;
  // numeric epoch
  if (typeof raw === 'number') {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function formatDateDisplay(raw) {
  const d = parseDate(raw);
  if (!d) return '—';
  return d.toLocaleString();
}

function safeText(v) {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

function showModal(title, htmlContent) {
  if (!kpiModal) return;
  const titleEl = document.getElementById('kpiModalTitle');
  if (titleEl) titleEl.textContent = title;
  if (kpiModalBody) kpiModalBody.innerHTML = htmlContent;
  kpiModal.classList.remove('hidden');
  kpiModal.setAttribute('aria-hidden', 'false');
}

function hideModal() {
  if (!kpiModal) return;
  kpiModal.classList.add('hidden');
  kpiModal.setAttribute('aria-hidden', 'true');
  if (kpiModalBody) kpiModalBody.innerHTML = '';
}
if (kpiModalClose) kpiModalClose.addEventListener('click', hideModal);
if (kpiModalCloseBtn) kpiModalCloseBtn.addEventListener('click', hideModal);

function renderOrdersTable(docSnaps) {
  if (!docSnaps || docSnaps.length === 0) {
    return `<p>No hay pedidos para mostrar.</p>`;
  }

  let html = `<div class="table-scroll" style="max-height:420px; overflow:auto;">
    <table class="products-table orders-table small" role="table" aria-label="Lista de pedidos">
      <thead>
        <tr>
          <th>ID</th>
          <th>CLIENTE</th>
          <th>PRODUCTOS</th>
          <th>CANT.</th>
          <th>FECHA</th>
          <th>TOTAL</th>
          <th>ESTADO PAGO</th>
          <th>ESTADO ENVÍO</th>
          <th>MOTORIZADO</th>
        </tr>
      </thead>
      <tbody>`;

  docSnaps.forEach(docSnap => {
    // docSnap may be a DocumentSnapshot or a plain object (from testing). Support both.
    const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
    const id = safeText((typeof docSnap.id === 'string' && docSnap.id) || data.id || data.orderId);
    const cliente = safeText(
      data.customerData?.Customname ||
      data.customerData?.CustomName ||
      data.customer?.name ||
      data.customerName ||
      data.clientName ||
      data.Customname ||
      (data.customer && (data.customer.name || data.customer.fullName)) ||
      '—'
    );

    let productsText = '—';
    let qtyTotal = 0;
    if (Array.isArray(data.items) && data.items.length) {
      productsText = data.items.map(it => safeText(it.name || it.title || it.product || it.productName || '—')).join(', ');
      qtyTotal = data.items.reduce((acc, it) => acc + (Number(it.quantity || it.qty || it.quantityOrdered || 0) || 0), 0);
    } else if (data.productName) {
      productsText = safeText(data.productName);
      qtyTotal = Number(data.quantity || data.qty || 1) || 1;
    }

    const fecha = formatDateDisplay(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);

    let totalVal = null;
    if (typeof data.total === 'number' || typeof data.total === 'string') totalVal = Number(data.total);
    else if (typeof data.totalUSD === 'number' || typeof data.totalUSD === 'string') totalVal = Number(data.totalUSD);
    else if (typeof data.totalReceivedUSD === 'number' || typeof data.totalReceivedUSD === 'string') totalVal = Number(data.totalReceivedUSD);
    else if (typeof data.amount === 'number' || typeof data.amount === 'string') totalVal = Number(data.amount);
    else if (Array.isArray(data.items)) {
      totalVal = data.items.reduce((acc, it) => {
        const p = Number(it.price || it.unitPrice || 0) || 0;
        const q = Number(it.quantity || it.qty || 0) || 0;
        return acc + (p * q);
      }, 0);
    }
    const totalDisplay = (totalVal === null) ? '—' : formatMoney(totalVal);

    const estadoPago = safeText(data.paymentStatus || data.payment_state || data.payment?.status || '—');
    const estadoEnvio = safeText(data.shippingStatus || data.shipping_state || data.shipping?.status || '—');
    const motorizado = safeText(
      data.assignedMotorName ||
      data.assignedRiderName ||
      data.rider?.name ||
      data.motorizadoName ||
      data.assignedMotor ||
      '—'
    );

    html += `<tr>
      <td>${id}</td>
      <td>${cliente}</td>
      <td>${productsText}</td>
      <td style="text-align:center">${qtyTotal || '—'}</td>
      <td>${fecha}</td>
      <td style="text-align:right">$ ${totalDisplay}</td>
      <td>${estadoPago}</td>
      <td>${estadoEnvio}</td>
      <td>${motorizado}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  return html;
}

/*
  Helper: from an array of DocumentSnapshot, return up to `count` most recent docs (by parsed timestamp)
  Optionally accept a predicate to filter (e.g. isPaidAndDelivered).
  We avoid server-side orderBy to prevent "requires an index" errors; instead we fetch a reasonable batch and sort locally.
*/
function getMostRecentDocs(snapshotDocs, predicate = () => true, count = 5) {
  const enriched = snapshotDocs.map(docSnap => {
    const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
    const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
    return { doc: docSnap, date: d || new Date(0) }; // missing date => epoch (will sort last)
  });

  // apply predicate on original data
  const filtered = enriched.filter(x => {
    const data = (typeof x.doc.data === 'function') ? x.doc.data() : x.doc;
    try {
      return predicate(data);
    } catch (e) {
      return false;
    }
  });

  // sort desc by date
  filtered.sort((a, b) => b.date.getTime() - a.date.getTime());

  return filtered.slice(0, count).map(x => x.doc);
}

// Usamos queries simples (solo equality + limit) y filtramos/ordenamos en cliente para evitar requerir índices compuestos.
// Pedimos más docs (limitBatch) y luego tomamos los 5 que cumplan la condición localmente.
function attachKpiClickHandlers(user) {
  const ordersCard = document.getElementById('kpi-card-orders');
  const salesCard = document.getElementById('kpi-card-sales');
  const ordersCol = collection(db, 'orders');

  // how many docs to fetch to have good chance to find the 5 latest today => adjust if you need more
  const limitBatch = 200;

  if (ordersCard) {
    ordersCard.addEventListener('click', async () => {
      const todayStart = startOfTodayLocal();
      try {
        // avoid orderBy to not require composite index; we sort locally instead
        const q = query(ordersCol, where('assignedSeller', '==', user.uid), limit(limitBatch));
        const snapshot = await getDocs(q);
        // predicate: date is today (>= todayStart)
        const docs = getMostRecentDocs(snapshot.docs, (data) => {
          const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
          return d && d >= todayStart;
        }, 5);
        const html = renderOrdersTable(docs);
        showModal('Pedidos de hoy (últimos 5)', html);
      } catch (err) {
        console.error('Error fetching today orders for modal:', err);
        showModal('Pedidos de hoy (últimos 5)', `<p>Error al cargar los pedidos: ${safeText(err && err.message)}</p>`);
      }
    });
  }

  if (salesCard) {
    salesCard.addEventListener('click', async () => {
      const todayStart = startOfTodayLocal();
      try {
        const q = query(ordersCol, where('assignedSeller', '==', user.uid), limit(limitBatch));
        const snapshot = await getDocs(q);
        // predicate: date today AND paymentStatus indicates paid AND shippingStatus indicates delivered
        const docs = getMostRecentDocs(snapshot.docs, (data) => {
          const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
          if (!d || d < todayStart) return false;
          const pay = String(data.paymentStatus || data.payment_state || data.payment?.status || '').toLowerCase();
          const ship = String(data.shippingStatus || data.shipping_state || data.shipping?.status || '').toLowerCase();
          const paid = pay === 'pagado' || pay.includes('pagad') || pay === 'paid' || pay.includes('paid');
          const delivered = ship === 'entregado' || ship.includes('entreg') || ship === 'delivered' || ship.includes('deliver');
          return paid && delivered;
        }, 5);
        const html = renderOrdersTable(docs);
        showModal('Ventas hoy (pagadas y entregadas, últimos 5)', html);
      } catch (err) {
        console.error('Error fetching sales orders for modal:', err);
        showModal('Ventas hoy (pagadas y entregadas, últimos 5)', `<p>Error al cargar las ventas: ${safeText(err && err.message)}</p>`);
      }
    });
  }
}

// Suscripción en tiempo real para KPIs (conteo y suma) — mantengo la lógica previa pero robustecida con parseDate
onAuthStateChanged(auth, (user) => {
  if (!user) return;
  attachKpiClickHandlers(user);

  const ordersCol = collection(db, 'orders');
  const q = query(ordersCol, where('assignedSeller', '==', user.uid));
  onSnapshot(q, (snapshot) => {
    const todayStart = startOfTodayLocal();
    let ordersToday = 0;
    let salesToday = 0;
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
      if (d && d >= todayStart) {
        ordersToday++;
        let total = 0;
        if (typeof data.total === 'number') total = data.total;
        else if (typeof data.totalUSD === 'number') total = data.totalUSD;
        else if (typeof data.amount === 'number') total = data.amount;
        else if (Array.isArray(data.items)) {
          total = data.items.reduce((acc, it) => {
            const p = Number(it.price || it.unitPrice || 0), q = Number(it.quantity || it.qty || 1);
            return acc + (p * q);
          }, 0);
        }
        salesToday += (total || 0);
      }
    });
    if (ordersTodayEl) ordersTodayEl.textContent = ordersToday;
    if (salesEl) salesEl.textContent = formatMoney(salesToday);
  }, err => {
    console.error('KPIs snapshot error:', err);
    if (ordersTodayEl) ordersTodayEl.textContent = '—';
    if (salesEl) salesEl.textContent = '—';
  });
});