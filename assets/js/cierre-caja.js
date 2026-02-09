import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
    getFirestore,
    collection,
    query,
    where,
    getDocs,
    addDoc,
    updateDoc,
    doc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const currentUserEmail = localStorage.getItem('userEmail') || 'usuario@demo.com';
const elTotalBs = document.getElementById('total-bs');
const elTotalUsd = document.getElementById('total-usd');
const elTotalOrders = document.getElementById('total-orders');
const toastEl = document.getElementById('toast');

let ordenesDia = [];
let totalesHoy = { bs: 0, usd: 0 };

// ----------- ALERTA MODAL CENTRADA -----------
function showAlertModal(message, cbOk) {
    let modal = document.getElementById('modal-alert');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-alert';
        modal.style.cssText = `z-index:10000;position:fixed;left:0;top:0;width:100vw;height:100vh;background:#171717bb;display:flex;align-items:center;justify-content:center;`;
        modal.innerHTML = `
      <div style="background:#fff;padding:2.5em 2em;min-width:320px;max-width:94vw;margin:auto;border-radius:14px;box-shadow:0 8px 40px #0007;text-align:center;position:relative;">
        <div id="modal-message" style="font-size:1.1em;"></div>
        <button id="modal-ok" style="margin-top:1.5em;font-weight:bold;padding: 0.6em 1.3em;border-radius:7px;font-size:1em;background:#10b981;color:#fff;border:0;cursor:pointer;">OK</button>
      </div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('modal-message').innerHTML = message;
    modal.style.display = 'flex';
    document.getElementById('modal-ok').onclick = () => {
        modal.style.display = 'none';
        if (cbOk) cbOk()
    }
}

// ----------- UTILIDADES -----------
function showToast(msg, timeout = 3000) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => {
        toastEl.classList.remove('show');
        toastEl.textContent = '';
    }, timeout);
}
function formatBs(value) {
    try { return 'Bs ' + Number(value).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch (e) { return 'Bs 0,00'; }
}
function formatUsd(value) {
    try { return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch (e) { return '$0.00'; }
}
function calcularComision(tipo, valor, montoOrden) {
    if (tipo === 'amount') return Number(valor || 0);
    if (tipo === 'percent') return Number(montoOrden) * (Number(valor) / 100);
    return 0;
}
function tiempoEntrega(inicio, fin) {
    if (!inicio || !fin) return '--';
    const tIni = (inicio.seconds ? inicio.seconds * 1000 : Number(inicio)) || 0;
    const tFin = (fin.seconds ? fin.seconds * 1000 : Number(fin)) || 0;
    if (!tIni || !tFin || isNaN(tIni) || isNaN(tFin)) return '--';
    const diffMs = Math.abs(tFin - tIni);
    const minutos = Math.round(diffMs / (1000 * 60));
    return `${minutos} min`;
}
function getOrderTotalInBsAndUsd(metodos) {
    let bs = 0, usd = 0;
    for (const method of (metodos || [])) {
        const conv = method.conversion ?? {};
        const currencyRaw = (conv.currency || method.currency || '').toLowerCase();
        if (currencyRaw.includes('bs') || currencyRaw.includes('ves') || currencyRaw.includes('bolivar')) {
            bs += Number(method.bsAmount || conv.bsAmount || (conv.rate && conv.originalAmount ? conv.originalAmount * conv.rate : 0) || 0);
        } else if (currencyRaw.includes('usd') || currencyRaw.includes('dolar')) {
            usd += Number(conv.originalAmount ?? conv.usdEquivalent ?? method.originalAmount ?? 0);
        }
    }
    return { bs, usd };
}
async function getUserCommissionInfo(db, userName) {
    if (!userName) return { commissionType: "amount", commissionValue: 0 };
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('name', '==', userName));
    const snap = await getDocs(q);
    if (snap.empty) return { commissionType: "amount", commissionValue: 0 };
    return snap.docs[0].data();
}
function formatProductItem(item) {
    const total = `$${(item.quantity * item.price).toFixed(2)}`;
    return `<div class="product-item">
      <img src="https://via.placeholder.com/50" class="product-img" alt="${item.name}">
      <div style="flex-grow:1">
        <div style="font-weight:bold;">${item.name}</div>
        <div style="font-size:0.8rem; color:var(--text-muted)">Cant: ${item.quantity} x $ ${item.price.toFixed(2)}</div>
      </div>
      <div style="font-weight:bold;">${total}</div>
    </div>`;
}
function commissionBadge(label, bs, usd, color = 'blue') {
    return `<div class="badge badge-${color}"><span>${label}</span><strong>Bs ${Number(bs).toLocaleString('es-VE', { minimumFractionDigits: 2 })} / $ ${Number(usd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>`;
}
function resolveAgent(order, role) {
    if (role === "vendedor") return order.assignedSellerName || '';
    if (role === "motorizado") return order.assignedMotorizedName || '';
    return '';
}
function isoDateFromValue(v) {
    if (!v) return null;
    if (typeof v === 'string') { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
    if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (e) { return null; } }
    return null;
}
function isSameIsoDay(dateObj, compareTo = new Date()) {
    if (!dateObj) return false;
    try {
        const d1 = dateObj.toISOString().slice(0, 10);
        const d2 = compareTo.toISOString().slice(0, 10);
        return d1 === d2;
    } catch (e) {
        return false;
    }
}

// ----------- TARJETA DE ÓRDEN -----------
function buildOrderCard(order, vendedorInfo, motorizadoInfo, orderTotals, tiempoEnt) {
    vendedorInfo.comisionBs = isNaN(vendedorInfo.comisionBs) ? 0 : vendedorInfo.comisionBs;
    vendedorInfo.comisionUsd = isNaN(vendedorInfo.comisionUsd) ? 0 : vendedorInfo.comisionUsd;
    motorizadoInfo.comisionBs = isNaN(motorizadoInfo.comisionBs) ? 0 : motorizadoInfo.comisionBs;
    motorizadoInfo.comisionUsd = isNaN(motorizadoInfo.comisionUsd) ? 0 : motorizadoInfo.comisionUsd;
    orderTotals.bs = isNaN(orderTotals.bs) ? 0 : orderTotals.bs;
    orderTotals.usd = isNaN(orderTotals.usd) ? 0 : orderTotals.usd;
    const statusEntrega = (order.shippingStatus || '').toUpperCase() === 'ENTREGADO'
        ? `<span style="color:var(--green-text); font-weight:bold; font-size:0.7rem;">ENTREGADO</span>` : '';
    const iconClock = `<i class="fa-regular fa-clock"></i>`;
    return `
    <div class="order-card">
      <div class="order-header" style="cursor:pointer;">
        <div class="order-icon">📦</div>
        <div class="order-info">
          <div>
            <span class="order-id">${order.id || ''}</span>
            <span class="customer-name">• ${order.customerData?.Customname ?? ''}</span>
          </div>
          <div class="agents">
            <span class="vendedor">👤 V: ${resolveAgent(order, 'vendedor') || '<span style="color: #a1a1a1;">—</span>'}</span>
            <span class="motorizado">🛵 M: ${resolveAgent(order, 'motorizado') || '<span style="color: #a1a1a1;">—</span>'}</span>
          </div>
        </div>
        <div class="amounts-summary">
          ${commissionBadge('Cobrado', orderTotals.bs, orderTotals.usd, 'blue')}
          ${commissionBadge(`Com. Vendedor (${vendedorInfo.commissionType === 'percent' ? vendedorInfo.commissionValue + '%' : 'Fijo'})`,
        vendedorInfo.comisionBs, vendedorInfo.comisionUsd, 'purple')}
          ${commissionBadge(`Com. Motorizado (${motorizadoInfo.commissionType === 'percent' ? motorizadoInfo.commissionValue + '%' : 'Fijo'})`,
            motorizadoInfo.comisionBs, motorizadoInfo.comisionUsd, 'green')}
        </div>
        <i class="fa-solid fa-chevron-down arrow-icon"></i>
      </div>
      <div class="order-content" style="padding: 1.5rem 1rem 1rem 1rem;">
        <div style="display: flex; gap:2rem; flex-wrap:wrap;">
          <div style="flex: 1 1 220px; min-width:220px;">
            <div class="section-title"><i class="fa-solid fa-user"></i> Datos del Cliente</div>
            <div class="data-box" style="background: #f7fafc; border-radius:9px; padding: 1em 1.2em; margin-top: 0.4em;">
              <strong>${order.customerData?.Customname ?? ''}</strong><br>
              <span style="color:var(--text-muted)">${order.customerData?.phone ?? ''}</span><br>
              <span style="color:var(--text-muted)">${order.customerData?.readable_address ?? ''}</span>
              <hr style="border:0; border-top:1px solid #e2e8f0; margin:15px 0;">
              <div class="section-title" style="margin-bottom:5px;">Logística de Entrega</div>
              <div style="display:flex; justify-content:space-between;">
                <span>Motorizado:</span> <strong>${resolveAgent(order, 'motorizado') || '<span style="color: #a1a1a1;">—</span>'}</strong>
              </div>
              <div style="display:flex; justify-content:space-between; margin-top:5px;">
                <span>Tiempo:</span> <span>${iconClock} ${tiempoEnt}</span>
              </div>
              ${statusEntrega}
            </div>
          </div>
          <div style="flex: 1 1 280px; min-width:260px;">
            <div class="section-title"><i class="fa-solid fa-cubes"></i> Productos del Pedido</div>
            ${(order.items || []).map(formatProductItem).join('\n')}
          </div>
          <div style="flex: 0 1 260px; min-width:230px;">
            <div class="section-title" style="color:#fff;background:#1e293b; border-top-left-radius:13px; border-top-right-radius:13px; padding:1em 1.2em 0.7em 1.2em;">Resumen de Liquidación</div>
            <div style="background: #1e293b; color: #fff; border-radius: 0 0 13px 13px; box-shadow:0 4px 14px #0001; padding:1em 1.2em;">
              ${(order.payment?.methods || []).map(m => {
                const conv = m.conversion ?? {};
                const raw = (conv.currency || m.currency || '').toLowerCase();
                let label = m.method === "cash" && raw.includes('usd') ? "Efectivo USD"
                    : m.method === "cash" && raw.includes('bs') ? "Efectivo BS"
                        : m.method === "mobile" ? "Pago Móvil"
                            : m.method === "paypal" ? "PAYPAL"
                                : m.method;
                let value = '';
                let sym = '';
                if (raw.includes('usd')) {
                    value = (conv.originalAmount ?? conv.usdEquivalent ?? m.originalAmount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 });
                    sym = '$';
                } else {
                    value = (m.bsAmount || conv.bsAmount || (conv.originalAmount && conv.rate ? conv.originalAmount * conv.rate : 0) || 0).toLocaleString("es-VE", { minimumFractionDigits: 2 });
                    sym = 'Bs';
                }
                return `<div class="liq-row" style="display: flex; justify-content: space-between; margin-bottom:0.2em;"><span>${label}</span> <strong>${sym} ${value}</strong></div>`;
            }).join('')}
              <hr style="border:0; border-top:1px solid #fff2; margin:13px 0 7px 0;">
              <div style="color:var(--green-text); font-size:0.7rem; font-weight:bold; margin-bottom:2px;">
                GRAN TOTAL COBRADO</div>
              <div class="total-amount" style="font-weight:bold; font-size:1.1em;">$${orderTotals.usd.toLocaleString("en-US", { minimumFractionDigits: 2 })} + Bs ${orderTotals.bs.toLocaleString("es-VE", { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// --------------- RENDER AND FILTERS --------------
async function renderOrders(orders, skipFiltros = false) {
    const ordersListDiv = document.getElementById('orders-list');
    if (!ordersListDiv || !orders) return;

    // CAMBIO: Verificar si ya existe un cierre de caja en las órdenes
    const yaCerrado = orders.some(ord => ord.cierreCaja && ord.cierreCaja.fecha);

    let html = '';
    let totalComiVendBs = 0, totalComiVendUsd = 0, totalComiMotBs = 0, totalComiMotUsd = 0;

    for (const ord of orders) {
        const vendedor = resolveAgent(ord, 'vendedor');
        const motorizado = resolveAgent(ord, 'motorizado');
        let vendedorInfo = { commissionType: "amount", commissionValue: 0, comisionBs: 0, comisionUsd: 0 };
        let motorizadoInfo = { commissionType: "amount", commissionValue: 0, comisionBs: 0, comisionUsd: 0 };
        if (vendedor && vendedor.length > 1) vendedorInfo = await getUserCommissionInfo(db, vendedor);
        if (motorizado && motorizado.length > 1) motorizadoInfo = await getUserCommissionInfo(db, motorizado);
        const orderTotals = getOrderTotalInBsAndUsd((ord.payment && ord.payment.methods) || []);
        vendedorInfo.comisionBs = calcularComision(vendedorInfo.commissionType, vendedorInfo.commissionValue, orderTotals.bs);
        vendedorInfo.comisionUsd = calcularComision(vendedorInfo.commissionType, vendedorInfo.commissionValue, orderTotals.usd);
        motorizadoInfo.comisionBs = calcularComision(motorizadoInfo.commissionType, motorizadoInfo.commissionValue, orderTotals.bs);
        motorizadoInfo.comisionUsd = calcularComision(motorizadoInfo.commissionType, motorizadoInfo.commissionValue, orderTotals.usd);
        const tiempoEnt = tiempoEntrega(ord.timestamp, ord.paymentUpdatedAt);
        html += buildOrderCard(ord, vendedorInfo, motorizadoInfo, orderTotals, tiempoEnt);

        totalComiVendBs += vendedorInfo.comisionBs;
        totalComiVendUsd += vendedorInfo.comisionUsd;
        totalComiMotBs += motorizadoInfo.comisionBs;
        totalComiMotUsd += motorizadoInfo.comisionUsd;
    }
    ordersListDiv.innerHTML = html;

    // Tarjetas Conciliación & Resumen
    const bottomGrid = document.getElementById('bottom-grid');
    if (bottomGrid) {
        // CAMBIO: Si ya está cerrado, ocultamos controles y mostramos aviso
        let conciliacionHTML = '';
        if (yaCerrado) {
            conciliacionHTML = `
                <div class="card-action" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:#f0fdf4; border:1px solid #bbf7d0; min-height:180px;">
                    <i class="fa-solid fa-circle-check" style="font-size:2.5rem; color:#16a34a; margin-bottom:10px;"></i>
                    <div style="text-align:center; color:#166534; font-weight:bold;">CIERRE DE CAJA COMPLETADO</div>
                    <div style="font-size:0.85rem; color:#15803d;">Las órdenes de hoy ya fueron conciliadas.</div>
                </div>`;
        } else {
            conciliacionHTML = `
                <div class="card-action">
                    <div class="section-title" style="color: #004d40; font-weight: bold;">
                        <i class="fa-solid fa-wallet"></i> CONCILIACIÓN DE EFECTIVO
                    </div>
                    <div class="input-group-row">
                        <div class="input-field">
                            <label>FÍSICO EN BS</label>
                            <input type="number" placeholder="0.00" id="fisico-bs">
                        </div>
                        <div class="input-field">
                            <label>FÍSICO EN USD</label>
                            <input type="number" placeholder="0.00" id="fisico-usd">
                        </div>
                    </div>
                    <button class="btn-save" onclick="guardarConciliacion()">
                        <i class="fa-solid fa-floppy-disk"></i> GUARDAR CONCILIACIÓN
                    </button>
                </div>`;
        }

        bottomGrid.innerHTML = conciliacionHTML + `
          <div class="card-summary">
              <div class="summary-header">RESUMEN TOTAL DE COMISIONES</div>
              <div class="summary-grid">
                  <div class="summary-item">
                      <span class="label">VENDEDORES</span>
                      <div class="amount-bs">Bs ${totalComiVendBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      <div class="amount-usd">$${totalComiVendUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  </div>
                  <div class="summary-item">
                      <span class="label">MOTORIZADOS</span>
                      <div class="amount-bs">Bs ${totalComiMotBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      <div class="amount-usd">$${totalComiMotUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  </div>
              </div>
              <div class="total-impact">
                  <div style="display: flex; justify-content: space-between; align-items: flex-end;">
                      <span class="label">IMPACTO TOTAL</span>
                      <div style="text-align: right;">
                          <div class="total-bs">Bs ${(totalComiVendBs + totalComiMotBs).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          <div class="total-usd">$${(totalComiVendUsd + totalComiMotUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      </div>
                  </div>
              </div>
          </div>
        `;
    }

    // CAMBIO: Ocultar el botón de finalizar caja global
    const btnFinalize = document.querySelector('.btn-finalize');
    if (btnFinalize) {
        btnFinalize.style.display = yaCerrado ? 'none' : 'block';
    }

    setTimeout(() => {
        document.querySelectorAll('.order-card .order-header').forEach(header => {
            header.addEventListener('click', function () {
                this.parentNode.classList.toggle('open');
            });
        });
    }, 10);

    if (!skipFiltros) renderFiltros(orders);

    setTimeout(() => {
        if (!yaCerrado) {
            if (document.getElementById("fisico-bs")) document.getElementById("fisico-bs").value = totalesHoy.bs || 0;
            if (document.getElementById("fisico-usd")) document.getElementById("fisico-usd").value = totalesHoy.usd || 0;
        }
    }, 200);
}

// --------------- OBTENER Y MOSTRAR LISTA DE ÓRDENES ---------------
async function loadTotalsForToday() {
    let bsTotal = 0, usdTotal = 0, ordersCount = 0;
    const today = new Date();
    ordenesDia = [];
    try {
        const ordersRef = collection(db, 'orders');
        const q = query(ordersRef, where('paymentStatus', '==', 'pagado'));
        const snap = await getDocs(q);

        snap.forEach(doc => {
            const data = doc.data ? doc.data() : doc;
            const orderDateRaw = data.orderDate ?? data.createdAt ?? null;
            const orderDate = isoDateFromValue(orderDateRaw);
            if (!isSameIsoDay(orderDate, today)) return;
            const payment = data.payment ?? {}, methods = payment.methods || [];
            let sumInThisOrder = false;
            if (Array.isArray(methods) && methods.length > 0) {
                methods.forEach(method => {
                    const conv = method.conversion ?? {};
                    const currencyRaw = (conv.currency || method.currency || '').toString().trim().toLowerCase();
                    const currency = (currencyRaw === 'bs' || currencyRaw === 'ves' || currencyRaw === 'bolivar' || currencyRaw === 'bolívares') ? 'BS'
                        : (currencyRaw === 'usd' || currencyRaw === 'dolar' || currencyRaw === 'dólar') ? 'USD'
                            : (currencyRaw || '').toUpperCase();
                    if (currency === 'USD') {
                        const usd = Number(conv.originalAmount ?? conv.usdEquivalent ?? method.originalAmount ?? 0);
                        if (!isNaN(usd)) usdTotal += usd;
                        if (usd > 0) sumInThisOrder = true;
                    } else if (currency === 'BS') {
                        const bs = Number(method.bsAmount ?? conv.bsAmount ?? (conv.originalAmount && conv.rate ? conv.originalAmount * Number(conv.rate) : 0));
                        if (!isNaN(bs)) bsTotal += bs;
                        if (bs > 0) sumInThisOrder = true;
                    }
                });
                if (sumInThisOrder) ordersCount++;
                ordenesDia.push({ ...data, id: doc.id });
            }
        });

        totalesHoy.bs = bsTotal;
        totalesHoy.usd = usdTotal;

        if (elTotalBs) elTotalBs.textContent = formatBs(bsTotal);
        if (elTotalUsd) elTotalUsd.textContent = formatUsd(usdTotal);
        if (elTotalOrders) elTotalOrders.textContent = String(ordersCount);

        const headerDateRow = document.getElementById('header-date-row');
        if (headerDateRow) {
            const dias = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
            const meses = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
            const actual = new Date();
            const dayName = dias[actual.getDay()];
            const day = actual.getDate();
            const month = meses[actual.getMonth()];
            const year = actual.getFullYear();
            const fechaFormateada = `${dayName}, ${day} DE ${month} DE ${year}`;
            const pedidosTexto = `${ordersCount} PEDIDO${ordersCount === 1 ? '' : 'S'}`;
            headerDateRow.innerHTML = `
        <div style="font-weight: bold;"><i class="fa-regular fa-calendar"></i> ${fechaFormateada}</div>
        <div style="font-size: 0.8rem; background: #e2e8f0; padding: 2px 10px; border-radius: 10px;">${pedidosTexto}</div>
      `;
        }

        await renderOrders(ordenesDia);

    } catch (err) {
        console.error('Error cargando totales de cierre de caja:', err);
        showToast('Error cargando totales. Revisa la consola.');
    }
}

// --------- GUARDAR CONCILIACIÓN EN FIREBASE -----------
window.guardarConciliacion = async function () {
    // CAMBIO: Protección extra por si se llama por consola
    const yaCerrado = ordenesDia.some(ord => ord.cierreCaja && ord.cierreCaja.fecha);
    if (yaCerrado) return showAlertModal("La caja ya ha sido conciliada para estas órdenes.");

    const fisicoBs = Number(document.getElementById("fisico-bs")?.value) || 0;
    const fisicoUsd = Number(document.getElementById("fisico-usd")?.value) || 0;
    const totalBs = totalesHoy.bs;
    const totalUsd = totalesHoy.usd;
    const diferenciaBs = fisicoBs - totalBs;
    const diferenciaUsd = fisicoUsd - totalUsd;

    try {
        const conciliacionData = {
            fisicoBs, fisicoUsd, totalBs, totalUsd,
            diferenciaBs, diferenciaUsd,
            usuario: currentUserEmail,
            fecha: serverTimestamp(),
            ordenes: ordenesDia.map(o => o.id)
        };
        const colRef = collection(db, 'conciliaciones');
        const res = await addDoc(colRef, conciliacionData);

        const batch = writeBatch(db);
        ordenesDia.forEach((order) => {
            batch.update(doc(db, 'orders', order.id), {
                cierreCaja: {
                    fecha: serverTimestamp(),
                    conciliadoPor: currentUserEmail,
                    conciliacionId: res.id
                }
            });
        });
        await batch.commit();
        showAlertModal('¡Conciliación guardada correctamente!', () => window.location.reload());
    } catch (err) {
        showAlertModal('¡ERROR al guardar conciliación! ' + err);
    }
}

// ----------- FINALIZAR CAJA DEL DÍA -------------
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('.btn-finalize');
    if (btn) {
        btn.addEventListener('click', async () => {
            showAlertModal('¿Confirmar cierre y finalizar caja del día?', async () => {
                try {
                    const batch = writeBatch(db);
                    ordenesDia.forEach((order) => {
                        batch.update(doc(db, 'orders', order.id), {
                            cierreCaja: {
                                fecha: serverTimestamp(),
                                finalizadoPor: currentUserEmail
                            }
                        });
                    });
                    await batch.commit();
                    showAlertModal("¡Caja del día finalizada!", () => window.location.reload());
                } catch (e) {
                    showAlertModal("Error finalizando caja: " + e.message);
                }
            });
        });
    }
});

// ----------- FILTROS AUTOCOMPLETADOS ----------
function renderFiltros(ordenes) {
    let vendedores = [...new Set(ordenes.map(o => resolveAgent(o, 'vendedor')).filter(Boolean))];
    let motorizados = [...new Set(ordenes.map(o => resolveAgent(o, 'motorizado')).filter(Boolean))];
    let pagos = [];
    ordenes.forEach(o => (o.payment?.methods || []).forEach(m => {
        let label = m.method === "cash" && ((m.conversion?.currency || m.currency || '').toLowerCase().includes('usd')) ? "Efectivo USD"
            : m.method === "cash" && ((m.conversion?.currency || m.currency || '').toLowerCase().includes('bs')) ? "Efectivo BS"
                : m.method === 'mobile' ? "Pago Móvil" : m.method;
        if (!pagos.includes(label)) pagos.push(label);
    }));

    const selectV = document.getElementById('filter-vendedor');
    if (selectV) {
        selectV.innerHTML = `<option value="">Vendedores (Todos)</option>` + vendedores.map(v => `<option value="${v}">${v}</option>`).join('');
    }
    const selectM = document.getElementById('filter-motorizado');
    if (selectM) {
        selectM.innerHTML = `<option value="">Motorizados (Todos)</option>` + motorizados.map(m => `<option value="${m}">${m}</option>`).join('');
    }
    const selectP = document.getElementById('filter-pago');
    if (selectP) {
        selectP.innerHTML = `<option value="">Forma de Pago (Todas)</option>` + pagos.map(p => `<option value="${p}">${p}</option>`).join('');
    }
}

window.filterOrders = function () {
    const q = document.getElementById('search-input')?.value?.toLowerCase() || '';
    const v = document.getElementById('filter-vendedor')?.value || '';
    const m = document.getElementById('filter-motorizado')?.value || '';
    const mp = document.getElementById('filter-pago')?.value || '';

    let filtered = ordenesDia.filter(ord => {
        if (v && resolveAgent(ord, 'vendedor') !== v) return false;
        if (m && resolveAgent(ord, 'motorizado') !== m) return false;
        if (mp) {
            let found = false;
            (ord.payment?.methods || []).forEach(method => {
                let label = method.method === "cash" && ((method.conversion?.currency || method.currency || '').toLowerCase().includes('usd')) ? "Efectivo USD"
                    : method.method === "cash" && ((method.conversion?.currency || method.currency || '').toLowerCase().includes('bs')) ? "Efectivo BS"
                        : method.method === 'mobile' ? "Pago Móvil" : method.method;
                if (label === mp) found = true;
            });
            if (!found) return false;
        }
        const text = JSON.stringify(ord).toLowerCase();
        if (q && !text.includes(q)) return false;
        return true;
    });
    renderOrders(filtered, true);
}
window.clearFilters = function () {
    document.getElementById('search-input').value = '';
    document.getElementById('filter-vendedor').selectedIndex = 0;
    document.getElementById('filter-motorizado').selectedIndex = 0;
    document.getElementById('filter-pago').selectedIndex = 0;
    renderOrders(ordenesDia, true);
}

/* -----------------------------------
     CALENDARIO DE CIERRRES DE CAJA
----------------------------------- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
async function getCierresCajaForMonth(year, month) {
    const ini = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const fin = new Date(year, month, 0, 23, 59, 59, 999);
    let dias = {};
    try {
        const q = query(collection(db, "conciliaciones"));
        const snap = await getDocs(q);
        snap.forEach(doc => {
            const data = doc.data();
            let fechaTs = data.fecha;
            let fecha = null;
            if (fechaTs && typeof fechaTs.toDate === "function") fecha = fechaTs.toDate();
            else if (fechaTs && fechaTs.seconds) fecha = new Date(fechaTs.seconds * 1000);
            else if (typeof fechaTs === "string") fecha = new Date(fechaTs);
            if (!fecha || fecha < ini || fecha > fin) return;
            const key = fecha.toISOString().slice(0, 10);
            dias[key] = { id: doc.id, ...data, fecha };
        });
        return dias;
    } catch (e) {
        console.error("Error leyendo conciliaciones:", e);
        return {};
    }
}
async function renderCalendar(month, year, cierresDelMes, onDayClick, selectedKey) {
    const grid = document.getElementById("calendar-grid");
    const label = document.getElementById("calendar-month-label");
    grid.innerHTML = `
    <div class="day-name">D</div><div class="day-name">L</div><div class="day-name">M</div>
    <div class="day-name">M</div><div class="day-name">J</div><div class="day-name">V</div><div class="day-name">S</div>
  `;
    const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    if (label) label.textContent = `${meses[month - 1]} ${year}`;
    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let d = 0; d < firstDay; d++) grid.innerHTML += `<div></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
        const key = `${year}-${pad2(month)}-${pad2(d)}`;
        const cerrado = cierresDelMes[key] ? true : false;
        const cls = cerrado ? 'calendar-day-closed' : 'calendar-day-open';
        const selected = selectedKey === key ? 'active-day' : '';
        grid.innerHTML += `<div 
      class="calendar-day ${cls} ${selected}" 
      data-date="${key}" 
      style="padding: 7px; border-radius:8px; cursor:pointer; font-weight:bold; border:1px solid #ddd; margin:1px; text-align:center;"
    >${d}</div>`;
    }
    grid.querySelectorAll(".calendar-day").forEach(dayDiv => {
        dayDiv.onclick = () => onDayClick(dayDiv.dataset.date);
    });
}
async function getOrdersForDay(fechaIso) {
    try {
        const q = query(collection(db, 'orders'), where('paymentStatus', '==', 'pagado'));
        const snap = await getDocs(q);
        let lista = [];
        snap.forEach(doc => {
            const data = doc.data ? doc.data() : doc;
            const orderDateRaw = data.orderDate ?? data.createdAt ?? null;
            const dateObj = isoDateFromValue(orderDateRaw);
            if (isSameIsoDay(dateObj, new Date(fechaIso))) {
                lista.push({ ...data, id: doc.id });
            }
        });
        return lista;
    } catch (e) {
        console.error("Error orders for day", e); return [];
    }
}
async function renderAuditDay(fechaIso, cierresDelMes, orders) {
    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const d = new Date(fechaIso.replace(/-/g, '\/'));
    const titleEl = document.getElementById("selectedDateTitle");
    if (titleEl) {
        titleEl.textContent = `${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
    }

    const pill = document.getElementById("statusPill");
    if (pill) {
        if (cierresDelMes[fechaIso]) {
            pill.innerHTML = '<span style="color: #fff; background:#16a34a; padding:3px 9px; border-radius:7px; font-weight:bold;">● CIERRE DE CAJA REALIZADO</span>';
        } else {
            pill.innerHTML = '<span style="color: #fff; background:#dc2626; padding:3px 9px; border-radius:7px; font-weight:bold;">● CIERRE DE CAJA NO REALIZADO</span>';
        }
    }

    const listDiv = document.getElementById("audit-orders-list");
    let totV_bs = 0, totV_usd = 0, totM_bs = 0, totM_usd = 0;
    let html = '';
    for (const ord of orders) {
        const vendedor = resolveAgent(ord, 'vendedor');
        const motorizado = resolveAgent(ord, 'motorizado');
        let vendedorInfo = { commissionType: "amount", commissionValue: 0, comisionBs: 0, comisionUsd: 0 };
        let motorizadoInfo = { commissionType: "amount", commissionValue: 0, comisionBs: 0, comisionUsd: 0 };
        if (vendedor && vendedor.length > 1) vendedorInfo = await getUserCommissionInfo(db, vendedor);
        if (motorizado && motorizado.length > 1) motorizadoInfo = await getUserCommissionInfo(db, motorizado);
        const orderTotals = getOrderTotalInBsAndUsd((ord.payment && ord.payment.methods) || []);
        vendedorInfo.comisionBs = calcularComision(vendedorInfo.commissionType, vendedorInfo.commissionValue, orderTotals.bs);
        vendedorInfo.comisionUsd = calcularComision(vendedorInfo.commissionType, vendedorInfo.commissionValue, orderTotals.usd);
        motorizadoInfo.comisionBs = calcularComision(motorizadoInfo.commissionType, motorizadoInfo.commissionValue, orderTotals.bs);
        motorizadoInfo.comisionUsd = calcularComision(motorizadoInfo.commissionType, motorizadoInfo.commissionValue, orderTotals.usd);

        html += `
        <div class="order-card">
            <div class="order-header" style="cursor:pointer;">
                <div class="order-icon">📦</div>
                <div class="order-info">
                <div>
                    <span class="order-id">${ord.id || ''}</span>
                    <span class="customer-name">• ${ord.customerData?.Customname ?? ''}</span>
                </div>
                <div class="agents">
                    <span class="vendedor">👤 V: ${vendedor?.toUpperCase() || '—'}</span>
                    <span class="motorizado">🛵 M: ${motorizado?.toUpperCase() || '—'}</span>
                </div>
                </div>
                <div class="amounts-summary">
                ${commissionBadge('Cobrado', orderTotals.bs, orderTotals.usd, 'blue')}
                ${commissionBadge(`Vendedor`, vendedorInfo.comisionBs, vendedorInfo.comisionUsd, 'purple')}
                ${commissionBadge(`Motorizado`, motorizadoInfo.comisionBs, motorizadoInfo.comisionUsd, 'green')}
                </div>
            </div>
      </div>`;
        totV_bs += vendedorInfo.comisionBs;
        totV_usd += vendedorInfo.comisionUsd;
        totM_bs += motorizadoInfo.comisionBs;
        totM_usd += motorizadoInfo.comisionUsd;
    }
    if (listDiv) listDiv.innerHTML = html.length ? html : '<div style="color:#aaa;padding:1em;">No hay órdenes.</div>';

    const summaryDiv = document.getElementById("audit-summary-row");
    if (summaryDiv) {
        summaryDiv.innerHTML = `
        <div class="audit-sum-card">
          <div class="sum-label"><i class="fa-solid fa-user"></i> Total Vendedores</div>
          <div class="sum-total">Bs ${totV_bs.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</div>
          <div class="sum-sub">$${totV_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        </div>
        <div class="audit-sum-card">
          <div class="sum-label"><i class="fa-solid fa-motorcycle"></i> Total Motorizados</div>
          <div class="sum-total">Bs ${totM_bs.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</div>
          <div class="sum-sub">$${totM_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        </div>
      `;
    }

    let totalBs = totV_bs + totM_bs, totalUsd = totV_usd + totM_usd;
    const footerDiv = document.getElementById("audit-dark-footer");
    if (footerDiv) {
        footerDiv.innerHTML = `
        <div>
          <p class="label">Suma total de comisiones</p>
          <div class="footer-total" style="font-size:1.8rem; font-weight:900; color:#0284c7;">Bs ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div class="impact-val" style="font-size:1.8rem; font-weight:bold; color:#10b981;">$${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          <p class="label" style="text-align:right">Impacto en caja</p>
        </div>
      `;
    }
}

function calendarioInit() {
    const ahora = new Date();
    let stateMonth = ahora.getMonth() + 1;
    let stateYear = ahora.getFullYear();
    let stateSelected = null;
    let cierresMes = {};

    async function renderMainCalendar() {
        cierresMes = await getCierresCajaForMonth(stateYear, stateMonth);
        stateSelected = null;
        await renderCalendar(stateMonth, stateYear, cierresMes, onDayClick, null);

        const title = document.getElementById("selectedDateTitle");
        const pill = document.getElementById("statusPill");
        if (title) title.textContent = "Sin selección";
        if (pill) {
            pill.textContent = "● SELECCIONA UN DÍA";
            pill.style = '';
        }
        if (document.getElementById("audit-orders-list")) document.getElementById("audit-orders-list").innerHTML = "";
        if (document.getElementById("audit-summary-row")) document.getElementById("audit-summary-row").innerHTML = "";
        if (document.getElementById("audit-dark-footer")) document.getElementById("audit-dark-footer").innerHTML = "";
    }

    async function onDayClick(fechaIso) {
        stateSelected = fechaIso; // Ejemplo: "2026-02-09"
        await renderCalendar(stateMonth, stateYear, cierresMes, onDayClick, stateSelected);
        const orders = await getOrdersForDay(fechaIso);
        await renderAuditDay(fechaIso, cierresMes, orders);
    }

    setTimeout(() => {
        const prev = document.getElementById("prev-month");
        const next = document.getElementById("next-month");
        if (prev) prev.onclick = async () => {
            stateMonth -= 1; if (stateMonth < 1) { stateMonth = 12; stateYear--; }
            await renderMainCalendar();
        };
        if (next) next.onclick = async () => {
            stateMonth += 1; if (stateMonth > 12) { stateMonth = 1; stateYear++; }
            await renderMainCalendar();
        };
    }, 200);

    renderMainCalendar();
}

// -------------- MAIN --------------
document.addEventListener('DOMContentLoaded', async () => {
    await loadTotalsForToday();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadTotalsForToday();
    });
    calendarioInit();
});

const calendarStyles = document.createElement("style");
calendarStyles.innerHTML = `
  .calendar-day-closed { background:#f0fdf4; border:1.5px solid #16a34a; color:#166534;}
  .calendar-day-open { background:#fef2f2; border:1.5px solid #ef4444; color:#991b1b;}
  .calendar-day.active-day { background:#1e293b; color:#fff; border:2.5px solid #0284c7;}
`;
document.head.appendChild(calendarStyles);
