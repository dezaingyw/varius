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

(function injectCardStyles() {
  const css = `
  .kpi-cards { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 8px; }
  @media(min-width:720px){ .kpi-cards { grid-template-columns: repeat(2,1fr); } }
  .order-card { border:1px solid rgba(2,6,23,0.06); border-radius:10px; padding:12px; background:var(--card-bg,#fff); box-shadow: 0 6px 18px rgba(2,6,23,0.04); cursor:pointer; }
  .order-card .header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
  .order-card .left { flex:1 1 auto; }
  .order-card .right { flex:0 0 auto; text-align:right; min-width:120px; }
  .order-card .meta { font-size:13px; color:var(--muted,#6b7280); margin-top:6px; }
  .order-card .title { font-weight:700; margin-bottom:6px; font-size:15px; }
  .order-card .small { font-size:13px; color:var(--muted,#6b7280); }
  .order-card .products-preview { margin-top:10px; color:var(--muted,#374151); font-size:13px; }
  .order-card .expand { margin-top:10px; border-top:1px dashed rgba(2,6,23,0.06); padding-top:10px; }
  .products-list { display:flex; flex-direction:column; gap:8px; }
  .product-row { display:flex; gap:12px; align-items:center; padding:8px; border-radius:8px; background:var(--surface, #fff); border:1px solid rgba(2,6,23,0.03); }
  .product-thumb { width:56px; height:56px; object-fit:cover; border-radius:8px; background:#f5f7fb; }
  .product-info { flex:1; display:flex; flex-direction:column; gap:4px; }
  .product-name { font-weight:600; font-size:14px; }
  .product-meta { font-size:13px; color:var(--muted,#6b7280); display:flex; gap:12px; align-items:center; }
  .product-price { font-weight:700; }
  .kpi-modal-footer { display:flex; justify-content:flex-end; margin-top:12px; gap:8px; }
  .kpi-count-card { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px; border-radius:10px; border:1px solid rgba(2,6,23,0.06); background:var(--card-bg,#fff); box-shadow:0 8px 20px rgba(2,6,23,0.03); }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
})();

function startOfTodayLocal() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function formatMoney(n){ try { return Number(n || 0).toLocaleString(); } catch(e){ return String(n || 0); } }
function parseDate(raw){ if(!raw) return null; if(typeof raw.toDate === 'function'){ try{ return raw.toDate(); }catch(e){} } if(typeof raw === 'string'){ const d = new Date(raw); if(!isNaN(d.getTime())) return d; } if(raw instanceof Date) return raw; if(typeof raw === 'number'){ const d = new Date(raw); if(!isNaN(d.getTime())) return d; } return null; }
function formatDateDisplay(raw){ const d = parseDate(raw); if(!d) return '—'; return d.toLocaleString(); }
function safeText(v){ if(v===undefined||v===null||v==='') return '—'; return String(v); }
function titleCase(s){ if(!s && s!=='') return s; const str = String(s).trim(); if(!str) return str; if(str.includes('@') || /^[0-9-_.]{3,}$/.test(str)) return str; return str.split(/\s+/).map(part=>part.split(/[-_]/).map(p=>p? (p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()) : '').join('-')).join(' '); }

function escapeHtml(s){ if(s===undefined||s===null) return ''; return String(s).replace(/[&<>"'`=\/]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c)); }
function escapeAttr(s){ return escapeHtml(s); }

function showModal(title, htmlContent){ if(!kpiModal) return; const titleEl = document.getElementById('kpiModalTitle'); if(titleEl) titleEl.textContent = title; if(kpiModalBody) kpiModalBody.innerHTML = htmlContent; kpiModal.classList.remove('hidden'); kpiModal.setAttribute('aria-hidden','false'); }
function hideModal(){ if(!kpiModal) return; kpiModal.classList.add('hidden'); kpiModal.setAttribute('aria-hidden','true'); if(kpiModalBody) kpiModalBody.innerHTML=''; }
if(kpiModalClose) kpiModalClose.addEventListener('click', hideModal);
if(kpiModalCloseBtn) kpiModalCloseBtn.addEventListener('click', hideModal);

/* Robust matcher: detecta si el pedido está asignado a `user` comprobando varios campos */
function matchesAssignedToUser(data, user){
  if(!data || !user) return false;
  const uid = String(user.uid || '').trim();
  const email = String((user.email || '')).toLowerCase();
  const display = String((user.displayName||'')).toLowerCase();

  // candidate values (strings or nested)
  const vals = [
    data.assignedSeller, data.assignedSellerId, data.assigned_seller,
    data.assigned_seller_id, data.assignedSellerUid, data.assignedSellerUID,
    data.assignedSellerEmail, data.assignedSellerEmailAddress, data.assignedSellerName,
    data.assignedSeller_name, data.assignedSellerEmailAddress, data.assignedSellerEmail,
    data.assignedSellerIdString, data.assignedSellerUidString
  ];

  // if assignedSeller is object, extract common props
  if(typeof data.assignedSeller === 'object' && data.assignedSeller !== null){
    vals.push(data.assignedSeller.id, data.assignedSeller.uid, data.assignedSeller.email, data.assignedSeller.name);
  }

  for(const v of vals){
    if(!v) continue;
    const s = String(v).trim();
    if(!s) continue;
    if(uid && s === uid) return true;
    if(email && s.toLowerCase() === email) return true;
    if(display && s.toLowerCase() === display) return true;
    // sometimes stored with prefix or JSON; attempt contains uid/email
    if(uid && s.includes(uid)) return true;
    if(email && s.toLowerCase().includes(email)) return true;
  }
  return false;
}

/* calcOrderTotal / helpers */
function calcOrderTotal(data){
  if(!data) return 0;
  if(typeof data.total === 'number') return data.total;
  if(typeof data.total === 'string' && !isNaN(Number(data.total))) return Number(data.total);
  if(typeof data.totalUSD === 'number') return data.totalUSD;
  if(typeof data.amount === 'number') return data.amount;
  if(Array.isArray(data.items)){
    return data.items.reduce((acc,it)=>{ const price = Number(it.price || it.unitPrice || it.unit_price || 0)||0; const qty = Number(it.quantity || it.qty || 1)||1; const subtotal = Number(it.subtotal || (price*qty)) || (price*qty); return acc+subtotal; },0);
  }
  return 0;
}
function getCustomerNameFromData(data){
  if(!data) return '—';
  const cand = data.customerData?.Customname || data.customerData?.CustomName || data.customer?.name || data.customerName || data.clientName || data.Customname || (data.customer && (data.customer.name || data.customer.fullName)) || data.email || data.customerId;
  return cand ? titleCase(cand) : '—';
}
function getMotorizadoName(data){
  if(!data) return '—';
  const cand = data.assignedMotorName || data.assignedRiderName || data.rider?.name || data.motorizadoName || data.assignedMotor || data.assignedMotorName || data.assignedMotorEmail;
  return cand ? titleCase(cand) : '—';
}

/* Render cards & details (re-usable) */
function renderOrdersCards(docSnaps){
  if(!docSnaps || docSnaps.length === 0) return `<div class="no-data">No hay pedidos para mostrar.</div>`;
  const orders = docSnaps.map((docSnap, idx) => {
    const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
    const id = (typeof docSnap.id === 'string' && docSnap.id) || data.id || data.orderId || `#${idx+1}`;
    const customer = getCustomerNameFromData(data);
    const motorizado = getMotorizadoName(data);
    const date = formatDateDisplay(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
    const total = calcOrderTotal(data);
    const items = Array.isArray(data.items) ? data.items : [];
    const productsPreview = items.slice(0,4).map(it=> safeText(it.name || it.title || it.productName || it.product || '—')).join(', ');
    return { id, data, customer, motorizado, date, total, items, productsPreview };
  });

  let html = `<div class="kpi-cards">`;
  orders.forEach((o,i)=>{
    html += `
      <div class="order-card" data-order-index="${i}" role="button" tabindex="0" aria-expanded="false">
        <div class="header">
          <div class="left">
            <div class="title">Pedido ${escapeHtml(o.id)}</div>
            <div class="meta"><strong>Cliente:</strong> ${escapeHtml(o.customer)} · <span class="small"><strong>Motorizado:</strong> ${escapeHtml(o.motorizado)}</span></div>
            <div class="products-preview">${escapeHtml(o.productsPreview || 'Sin productos')}</div>
          </div>
          <div class="right">
            <div class="small">${escapeHtml(o.date)}</div>
            <div style="margin-top:8px;font-weight:800;">$ ${escapeHtml(formatMoney(o.total || 0))}</div>
          </div>
        </div>
        <div class="expand hidden" data-expanded="false" aria-hidden="true"></div>
      </div>
    `;
  });
  html += `</div>`;
  //html += `<div class="kpi-modal-footer"><button id="kpiModalCloseInline" class="btn-secondary">Cerrar</button></div>`;
  // cache for later interactivity
  window.__vendedor_kpi_orders_cache = orders;
  return html;
}

function renderOrderDetailHTML(order){
  const items = Array.isArray(order.items) ? order.items : [];
  let html = `<div><div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;margin-bottom:8px">Productos (${items.length})</div><div style="font-weight:700">$ ${formatMoney(order.total)}</div></div>`;
  if(!items.length){ html += `<div class="no-data" style="margin-top:8px;">No hay items en este pedido.</div></div>`; return html; }
  html += `<div class="products-list" style="margin-top:8px;">`;
  items.forEach(it=>{
    const thumb = safeText(it.image || it.thumbnail || it.imageUrl || '');
    const name = safeText(it.name || it.title || it.productName || it.product || '—');
    const qty = Number(it.quantity || it.qty || it.quantityOrdered || 1) || 1;
    const unit = Number(it.price || it.unitPrice || it.unit_price || 0) || 0;
    const subtotal = Number(it.subtotal || (unit*qty)) || (unit*qty);
    html += `<div class="product-row"><img class="product-thumb" src="${escapeAttr(thumb)}" onerror="this.style.display='none'"/><div class="product-info"><div class="product-name">${escapeHtml(titleCase(name))}</div><div class="product-meta"><div>Cant. ${escapeHtml(String(qty))}</div><div>Precio unit. $ ${escapeHtml(formatMoney(unit))}</div><div>Subtotal $ ${escapeHtml(formatMoney(subtotal))}</div></div></div></div>`;
  });
  html += `</div></div>`;
  return html;
}

/* Get recent orders (limitBatch) and filter client-side for this user */
async function fetchRecentOrdersFiltered(user, limitBatch = 200){
  const ordersCol = collection(db, 'orders');
  const q = query(ordersCol, limit(limitBatch));
  const snap = await getDocs(q);
  const matches = snap.docs.filter(docSnap => {
    const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
    return matchesAssignedToUser(data, user);
  });
  return matches;
}

/* Attach handlers to KPI cards (use client-side filtering) */
function attachKpiClickHandlers(user){
  const ordersCard = document.getElementById('kpi-card-orders');
  const salesCard = document.getElementById('kpi-card-sales');
  const assignedCard = document.getElementById('kpi-card-assigned');
  const limitBatch = 200;

  if(ordersCard){
    ordersCard.addEventListener('click', async () => {
      try {
        const docs = await fetchRecentOrdersFiltered(user, limitBatch);
        // from those, keep only today's orders
        const todayStart = startOfTodayLocal();
        const todayDocs = docs.filter(d => {
          const data = (typeof d.data === 'function') ? d.data() : d.data;
          const dt = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
          return dt && dt >= todayStart;
        }).slice(0,5);
        const html = renderOrdersCards(todayDocs);
        showModal('Pedidos de hoy (últimos 5)', html);
        attachCardInteractivity();
      } catch(err){
        console.error(err);
        showModal('Pedidos de hoy (últimos 5)', `<p>Error: ${safeText(err && err.message)}</p>`);
      }
    });
  }

  if(salesCard){
    salesCard.addEventListener('click', async ()=>{
      try{
        const docs = await fetchRecentOrdersFiltered(user, limitBatch);
        const todayStart = startOfTodayLocal();
        const filtered = docs.filter(d => {
          const data = (typeof d.data === 'function') ? d.data() : d.data;
          const dt = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
          if(!dt || dt < todayStart) return false;
          const pay = String(data.paymentStatus || data.payment_state || data.payment?.status || '').toLowerCase();
          const ship = String(data.shippingStatus || data.shipping_state || data.shipping?.status || '').toLowerCase();
          const paid = pay === 'pagado' || pay.includes('pagad') || pay === 'paid' || pay.includes('paid');
          const delivered = ship === 'entregado' || ship.includes('entreg') || ship === 'delivered' || ship.includes('deliver');
          return paid && delivered;
        }).slice(0,5);
        const html = renderOrdersCards(filtered);
        showModal('Ventas hoy (pagadas y entregadas, últimos 5)', html);
        attachCardInteractivity();
      }catch(err){
        console.error(err);
        showModal('Ventas hoy', `<p>Error: ${safeText(err && err.message)}</p>`);
      }
    });
  }

  if(assignedCard){
    assignedCard.addEventListener('click', async ()=>{
      try{
        const docs = await fetchRecentOrdersFiltered(user, 200);
        const todayStart = startOfTodayLocal();
        const countAssignedToday = docs.reduce((acc, docSnap) => {
          const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
          const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
          if(d && d >= todayStart) return acc + 1;
          return acc;
        }, 0);
        const html = `<div class="kpi-count-card"><div><div class="small">Pedidos asignados hoy</div><div style="font-weight:800;font-size:24px;margin-top:6px;">${countAssignedToday}</div></div><div class="small muted">En curso</div></div>
        `;
        showModal('Pedidos asignados', html);
        const closeBtn = document.getElementById('kpiAssignedClose'); if(closeBtn) closeBtn.addEventListener('click', hideModal);
      }catch(err){
        console.error(err);
        showModal('Pedidos asignados', `<p>Error: ${safeText(err && err.message)}</p>`);
      }
    });
  }
}

/* Attach card expand interactivity */
function attachCardInteractivity(){
  if(!kpiModalBody) return;
  kpiModalBody.querySelectorAll('.order-card').forEach(card => {
    if(card.dataset._handlersAttached === '1') return;
    card.dataset._handlersAttached = '1';
    const idx = Number(card.getAttribute('data-order-index'));
    card.addEventListener('click', ()=> toggleCardExpand(card, idx));
    card.addEventListener('keydown', (e)=> { if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleCardExpand(card, idx); } });
  });
  const closeInline = document.getElementById('kpiModalCloseInline'); if(closeInline) closeInline.addEventListener('click', hideModal);
}

function toggleCardExpand(cardEl, index){
  const expandEl = cardEl.querySelector('.expand');
  if(!expandEl) return;
  const cache = window.__vendedor_kpi_orders_cache || [];
  const order = cache[index];
  if(!order){
    expandEl.innerHTML = `<div class="no-data">Detalles no disponibles.</div>`;
    expandEl.classList.toggle('hidden');
    return;
  }
  const expanded = expandEl.getAttribute('data-expanded') === 'true';
  if(expanded){
    expandEl.innerHTML = '';
    expandEl.setAttribute('data-expanded','false');
    expandEl.classList.add('hidden');
    cardEl.setAttribute('aria-expanded','false');
    return;
  }
  const detailHtml = renderOrderDetailHTML(order);
  expandEl.innerHTML = detailHtml;
  expandEl.setAttribute('data-expanded','true');
  expandEl.classList.remove('hidden');
  cardEl.setAttribute('aria-expanded','true');
  expandEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Initial KPI update using client-side filter on recent batch */
async function updateKpisForUser(user){
  try{
    const limitBatch = 300;
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, limit(limitBatch));
    const snap = await getDocs(q);

    const todayStart = startOfTodayLocal();
    let ordersToday = 0, salesToday = 0, assignedCount = 0;

    const matchingDocs = [];
    snap.docs.forEach(docSnap => {
      const data = (typeof docSnap.data === 'function') ? docSnap.data() : docSnap;
      if(matchesAssignedToUser(data, user)){
        matchingDocs.push(docSnap);
        const d = parseDate(data.timestamp || data.createdAt || data.orderDate || data.date || data.assignedAt);
        if(d && d >= todayStart){
          ordersToday++;
          assignedCount++;
          const total = calcOrderTotal(data);
          salesToday += (total || 0);
        }
      }
    });

    // Update UI
    if(ordersTodayEl) ordersTodayEl.textContent = ordersToday || '—';
    if(salesEl) salesEl.textContent = salesToday ? formatMoney(salesToday) : '—';
    const assignedEl = document.getElementById('kpi-assigned');
    if(assignedEl) assignedEl.textContent = assignedCount || '—';

    // cache latest matching docs for modal use (most recent first)
    // Sort matchingDocs by date desc
    const enriched = matchingDocs.map(ds => ({ ds, date: parseDate(((typeof ds.data === 'function')?ds.data():ds).timestamp || ((typeof ds.data==='function')?ds.data():ds).createdAt || ((typeof ds.data==='function')?ds.data():ds).orderDate || ((typeof ds.data==='function')?ds.data():ds).date || ((typeof ds.data==='function')?ds.data():ds).assignedAt) || new Date(0) }));
    enriched.sort((a,b)=>b.date.getTime()-a.date.getTime());
    window.__vendedor_kpi_matching_cache = enriched.map(x=>x.ds);

  }catch(err){
    console.error('Error updating KPIs:', err);
    if(ordersTodayEl) ordersTodayEl.textContent = '—';
    if(salesEl) salesEl.textContent = '—';
  }
}

/* Main wiring */
onAuthStateChanged(auth, (user) => {
  if(!user) return;
  attachKpiClickHandlers(user);
  // run initial update and repeat every 30s
  updateKpisForUser(user);
  window.__vendedor_kpi_refresh_interval = setInterval(()=> updateKpisForUser(user), 30000);
});