// Módulo Cierre de Caja (mejorado con detalles por KPI y búsqueda por rango)
// Basado en tu código original: se añaden modal de detalles, búsqueda de cierres en rango,
// y filtrado de pedidos por método. Mantiene Firebase v12 modular.

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
    getDocs,
    addDoc,
    doc,
    serverTimestamp,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Elements
const cierreDateEl = document.getElementById('cierreDate');
const dateSelect = document.getElementById('dateSelect');
const calcBtn = document.getElementById('calcBtn');
const refreshBtn = document.getElementById('refreshBtn');

const kpiTotalCard = document.getElementById('kpiTotal');
const kpiOrdersCard = document.getElementById('kpiOrders');
const kpiCashCard = document.getElementById('kpiCash');
const kpiDigitalCard = document.getElementById('kpiDigital');

const kpiTotalValue = document.getElementById('kpiTotalValue');
const kpiOrdersValue = document.getElementById('kpiOrdersValue');
const kpiCashValue = document.getElementById('kpiCashValue');
const kpiDigitalValue = document.getElementById('kpiDigitalValue');

const breakdownList = document.getElementById('breakdownList');

const reconPhysical = document.getElementById('reconPhysical');
const reconNotes = document.getElementById('reconNotes');
const reconResult = document.getElementById('reconResult');
const saveReconBtn = document.getElementById('saveReconBtn');

const closeDayBtn = document.getElementById('closeDayBtn');
const toastEl = document.getElementById('toast');

const rangeFrom = document.getElementById('rangeFrom');
const rangeTo = document.getElementById('rangeTo');
const rangeSearchBtn = document.getElementById('rangeSearchBtn');
const clearRangeBtn = document.getElementById('clearRangeBtn');
const closuresList = document.getElementById('closuresList');

// Modal
const detailModal = document.getElementById('detailModal');
const detailModalTitle = document.getElementById('detailModalTitle');
const detailModalBody = document.getElementById('detailModalBody');
const detailList = document.getElementById('detailList');
const closeDetailModal = document.getElementById('closeDetailModal');

let currentUser = null;
let currentUserRole = null;

// State holder
window.__lastCierreCalc = null;
window.__lastReconciliation = null;

// Toast helpers
function hideToast() {
    if (!toastEl) return;
    toastEl.classList.remove('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
        toastEl.classList.add('hidden');
    }, 220);
}
function showToast(msg, timeout = 3500) {
    if (!toastEl) {
        alert(msg);
        return;
    }
    toastEl.textContent = msg;
    clearTimeout(toastEl._t);
    toastEl.classList.remove('hidden');
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    toastEl.offsetHeight;
    toastEl.classList.add('show');
    toastEl._t = setTimeout(() => {
        toastEl.classList.remove('show');
        toastEl._t = setTimeout(() => {
            toastEl.classList.add('hidden');
        }, 220);
    }, timeout);
}

// Helpers formatting
function formatCurrency(n) {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n || 0);
    } catch (e) {
        return `${Number(n || 0).toFixed(2)} USD`;
    }
}
function percentOf(part, total) {
    if (!total) return '0%';
    return `${((part / total) * 100).toFixed(1)}%`;
}
function capitalizeMethod(m) {
    if (!m) return 'Otro';
    return String(m).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function methodIcon(method) {
    switch ((method || '').toLowerCase()) {
        case 'cash': case 'efectivo': return '💵';
        case 'pago_movil': case 'mobile': return '📲';
        case 'usd': return '💶';
        case 'card_debit': case 'debit': case 'card_debito': case 'tarjeta debito': case 'tarjeta_débito': return '💳';
        case 'card_credit': case 'credit': case 'tarjeta credito': case 'tarjeta_crédito': return '💳';
        case 'paypal': return '🅿️';
        default: return '💸';
    }
}

// Visibility by role (mismo que antes)
function orderVisibleForRole(orderData, uid, role) {
    if (role === 'administrador') return true;
    if (!orderData) return false;
    if (role === 'motorizado') {
        return orderData.assignedMotor === uid || orderData.communicationBy === uid || orderData.motorizadoId === uid;
    }
    if (role === 'vendedor') {
        return orderData.createdBy === uid || orderData.assignedSeller === uid || orderData.assignedSellerId === uid || orderData.sellerId === uid;
    }
    return orderData.createdBy === uid;
}

// Aggregation helpers
function addMethodToMap(map, method, amount) {
    const key = (method || 'other').toString().toLowerCase();
    if (!map[key]) map[key] = { amount: 0, transactions: 0, method: key };
    map[key].amount += Number(amount || 0);
    map[key].transactions += 1;
}

// Procesar un payment para agregar al mapa (similar al original)
function processPaymentRecordInto(p, breakdownMap) {
    if (!p) return;
    if (Array.isArray(p.methods) && p.methods.length) {
        p.methods.forEach(m => addMethodToMap(breakdownMap, m.method || m.currency || 'other', m.amount || 0));
        return;
    }
    if (Array.isArray(p.breakdown) && p.breakdown.length) {
        p.breakdown.forEach(b => addMethodToMap(breakdownMap, b.method || b.name || 'other', b.amount || 0));
        return;
    }
    if (p.amount !== undefined) {
        addMethodToMap(breakdownMap, p.method || 'other', p.amount);
        return;
    }
}

// Detección heurística si un pedido contiene un método determinado (para el detalle)
function orderHasMethod(order, methodKey) {
    const mk = (methodKey || '').toString().toLowerCase();

    function checkPaymentObj(p) {
        if (!p) return false;
        const candidates = [];

        if (Array.isArray(p.methods)) {
            p.methods.forEach(m => {
                const nm = (m.method || m.currency || '').toString().toLowerCase();
                candidates.push(nm);
            });
        }
        if (Array.isArray(p.breakdown)) {
            p.breakdown.forEach(b => {
                const nm = (b.method || b.name || '').toString().toLowerCase();
                candidates.push(nm);
            });
        }
        if (p.method) candidates.push(p.method.toString().toLowerCase());
        if (p.currency) candidates.push(p.currency.toString().toLowerCase());
        if (p.name) candidates.push(p.name.toString().toLowerCase());
        return candidates.some(c => c.includes(mk) || (mk.includes('cash') && c.includes('efectivo')) || (mk === 'other' && !c));
    }

    if (order.payment && checkPaymentObj(order.payment)) return true;

    if (Array.isArray(order.payments) && order.payments.some(p => checkPaymentObj(p))) return true;

    if (order.payments && typeof order.payments === 'object' && Object.values(order.payments).some(p => checkPaymentObj(p))) return true;

    // fallback: check paymentMethod/paymentType fields
    const pm = ((order.paymentMethod || order.paymentType) || '').toString().toLowerCase();
    if (pm && pm.includes(mk)) return true;

    // If methodKey is numeric-ish or 'other' we allow fallback
    return false;
}

// Aggregación principal para una fecha (mejorada, misma base)
async function aggregateForDate(dayISO) {
    const start = new Date(dayISO + 'T00:00:00');
    const end = new Date(dayISO + 'T23:59:59.999');

    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, orderBy('orderDate', 'desc'));
    const snap = await getDocs(q);

    const orders = [];
    snap.forEach(s => {
        const data = s.data();
        const od = data.orderDate && data.orderDate.toDate ? data.orderDate.toDate() : (data.orderDate ? new Date(data.orderDate) : null);
        if (!od) return;
        if (od >= start && od <= end) {
            orders.push({ id: s.id, ...data });
        }
    });

    const uid = currentUser ? currentUser.uid : null;
    const role = currentUserRole || null;
    const visibleOrders = orders.filter(o => orderVisibleForRole(o, uid, role));

    let total = 0;
    let ordersCount = visibleOrders.length;
    const breakdownMap = {};

    // Procesamiento similar al original pero sin bloquear en subcollections por cada pedido (mejor esfuerzo)
    for (const o of visibleOrders) {
        const amount = Number(o.total || o.amount || 0);
        total += amount;

        let handled = false;

        if (o.payment && typeof o.payment === 'object' && Object.keys(o.payment).length) {
            processPaymentRecordInto(o.payment, breakdownMap);
            handled = true;
        }

        if (!handled && Array.isArray(o.payments) && o.payments.length) {
            o.payments.forEach(p => processPaymentRecordInto(p, breakdownMap));
            handled = true;
        }

        if (!handled && o.payments && typeof o.payments === 'object' && Object.keys(o.payments).length) {
            Object.values(o.payments).forEach(p => processPaymentRecordInto(p, breakdownMap));
            handled = true;
        }

        if (!handled) {
            // try subcollection best-effort (still awaits)
            try {
                const paymentsSnap = await getDocs(collection(db, 'orders', o.id, 'payments'));
                if (!paymentsSnap.empty) {
                    paymentsSnap.forEach(ps => {
                        processPaymentRecordInto(ps.data(), breakdownMap);
                    });
                    handled = true;
                }
            } catch (err) {
                // ignore
            }
        }

        if (!handled) {
            const method = o.paymentMethod || o.paymentType || (o.paymentStatus === 'pagado' ? 'other' : 'other');
            addMethodToMap(breakdownMap, method || 'other', amount);
        }
    }

    const breakdown = Object.keys(breakdownMap).map(k => {
        const item = breakdownMap[k];
        return { method: item.method, amount: item.amount, transactions: item.transactions };
    });

    const cashKeys = ['cash', 'efectivo', 'bs', 'boleto'];
    const cashTotal = breakdown.reduce((s, b) => s + (cashKeys.includes((b.method || '').toLowerCase()) ? b.amount : 0), 0);
    const digitalTotal = Math.max(0, total - cashTotal);

    breakdown.forEach(b => b.percent = percentOf(b.amount, total));

    return { total, ordersCount, breakdown, cashTotal, digitalTotal, orders: visibleOrders };
}

// Guardar cierre (igual)
async function saveClosure(payload) {
    const col = collection(db, 'cash_closures');
    return await addDoc(col, { ...payload, createdAt: serverTimestamp() });
}

// RENDER helpers
function setKpis({ total = 0, orders = 0, cash = 0, digital = 0 }) {
    kpiTotalValue.textContent = formatCurrency(total);
    kpiOrdersValue.textContent = String(orders);
    kpiCashValue.textContent = formatCurrency(cash);
    kpiDigitalValue.textContent = formatCurrency(digital);
}

function renderBreakdown(breakdown = []) {
    breakdownList.innerHTML = '';
    if (!breakdown.length) {
        const li = document.createElement('li');
        li.className = 'breakdown-item';
        li.innerHTML = `<div style="padding:12px;color:var(--muted)">No hay transacciones para la fecha seleccionada.</div>`;
        breakdownList.appendChild(li);
        return;
    }

    breakdown.forEach(b => {
        const li = document.createElement('li');
        li.className = 'breakdown-item';
        li.dataset.method = b.method;
        li.innerHTML = `
      <div class="left">
        <div class="icon">${methodIcon(b.method)}</div>
        <div>
          <div style="font-weight:600">${capitalizeMethod(b.method)}</div>
          <div class="meta">${b.transactions || 0} transacciones</div>
        </div>
      </div>
      <div class="amount">
        <div style="font-weight:600">${formatCurrency(b.amount || 0)}</div>
        <div class="percent">${b.percent || '0%'}</div>
      </div>
    `;
        // click en cada breakdown para ver pedidos relacionados
        li.addEventListener('click', () => {
            openDetailModal(`Pagos: ${capitalizeMethod(b.method)}`, renderOrdersList(window.__lastCierreCalc.orders.filter(o => orderHasMethod(o, b.method))));
        });
        breakdownList.appendChild(li);
    });
}

// Modal helpers
function openDetailModal(title, contentEl) {
    detailModalTitle.textContent = title || 'Detalles';
    detailList.innerHTML = '';
    if (contentEl) {
        detailList.appendChild(contentEl);
    } else {
        detailList.innerHTML = '<div class="small-muted">Sin contenido</div>';
    }
    detailModal.classList.remove('hidden');
    detailModal.setAttribute('aria-hidden', 'false');
}
function closeModal() {
    detailModal.classList.add('hidden');
    detailModal.setAttribute('aria-hidden', 'true');
}
closeDetailModal.addEventListener('click', closeModal);
detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeModal();
});

// Construye una lista (tabla simple) de pedidos para mostrar en modal
function renderOrdersList(orders = []) {
    const container = document.createElement('div');
    container.className = 'orders-list';

    if (!orders || !orders.length) {
        const n = document.createElement('div');
        n.className = 'small-muted';
        n.textContent = 'No hay pedidos para mostrar.';
        container.appendChild(n);
        return container;
    }

    // tabla simple con scroll responsive
    const table = document.createElement('table');
    table.className = 'products-table';
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
        <th>ID</th><th>Cliente</th><th>Total</th><th>Pagos</th><th>Fecha</th>
    </tr>`;
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    orders.forEach(o => {
        const tr = document.createElement('tr');

        const name = (o.customer && (o.customer.name || o.customer.displayName)) || o.customerName || o.clientName || (o.customer && o.customer.phone) || '—';

        // payments summary heuristic
        const paymentsSummary = summarizeOrderPayments(o);

        const od = o.orderDate && o.orderDate.toDate ? o.orderDate.toDate() : (o.orderDate ? new Date(o.orderDate) : null);
        const dateText = od ? od.toLocaleString() : '—';

        tr.innerHTML = `
            <td data-label="ID">${o.id}</td>
            <td data-label="Cliente">${escapeHtml(name)}</td>
            <td data-label="Total">${formatCurrency(Number(o.total || o.amount || 0))}</td>
            <td data-label="Pagos">${escapeHtml(paymentsSummary)}</td>
            <td data-label="Fecha">${escapeHtml(dateText)}</td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
    return container;
}

function summarizeOrderPayments(o) {
    const parts = [];
    if (o.payment) {
        if (Array.isArray(o.payment.methods)) {
            o.payment.methods.forEach(m => parts.push(`${capitalizeMethod(m.method || m.currency || 'other')}: ${formatCurrency(m.amount || 0)}`));
        } else if (o.payment.amount !== undefined) {
            parts.push(`${capitalizeMethod(o.payment.method || 'other')}: ${formatCurrency(o.payment.amount)}`);
        }
    }
    if (Array.isArray(o.payments)) {
        o.payments.forEach(p => {
            if (Array.isArray(p.methods)) {
                p.methods.forEach(m => parts.push(`${capitalizeMethod(m.method || m.currency || 'other')}: ${formatCurrency(m.amount || 0)}`));
            } else if (p.amount !== undefined) {
                parts.push(`${capitalizeMethod(p.method || 'other')}: ${formatCurrency(p.amount)}`);
            }
        });
    }
    if (parts.length) return parts.join(' · ');
    // fallback: paymentMethod field
    if (o.paymentMethod) return capitalizeMethod(o.paymentMethod || o.paymentType || 'other');
    return '—';
}

// Escapa texto simple para evitar inyecciones en el modal
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// Event handlers for KPI cards
kpiTotalCard.addEventListener('click', () => {
    const last = window.__lastCierreCalc;
    if (!last) return showToast('Primero calcula el cierre.');
    openDetailModal(`Pedidos — Total ${formatCurrency(last.total)}`, renderOrdersList(last.orders));
});
kpiOrdersCard.addEventListener('click', () => {
    const last = window.__lastCierreCalc;
    if (!last) return showToast('Primero calcula el cierre.');
    openDetailModal(`Lista de pedidos (${last.ordersCount})`, renderOrdersList(last.orders));
});
kpiCashCard.addEventListener('click', () => {
    const last = window.__lastCierreCalc;
    if (!last) return showToast('Primero calcula el cierre.');
    // heurística: mostrar pedidos que contienen métodos de efectivo
    const cashKeys = ['cash', 'efectivo', 'bs', 'boleto'];
    const orders = last.orders.filter(o => {
        return cashKeys.some(k => orderHasMethod(o, k));
    });
    openDetailModal(`Pedidos en efectivo — Total ${formatCurrency(last.cashTotal)}`, renderOrdersList(orders));
});
kpiDigitalCard.addEventListener('click', () => {
    const last = window.__lastCierreCalc;
    if (!last) return showToast('Primero calcula el cierre.');
    const orders = last.orders.filter(o => {
        // digital: cualquiera no-cash (heurístico)
        return !['cash', 'efectivo', 'bs', 'boleto'].some(k => orderHasMethod(o, k));
    });
    openDetailModal(`Pagos digitales — Total ${formatCurrency(last.digitalTotal)}`, renderOrdersList(orders));
});

// Calc button
calcBtn.addEventListener('click', async () => {
    const dayISO = dateSelect.value || (new Date()).toISOString().slice(0, 10);
    cierreDateEl.textContent = humanDate(dayISO);
    showToast('Calculando cierre, esto puede tardar según número de pedidos...', 2500);
    try {
        const res = await aggregateForDate(dayISO);
        setKpis({ total: res.total, orders: res.ordersCount, cash: res.cashTotal, digital: res.digitalTotal });
        renderBreakdown(res.breakdown);
        window.__lastCierreCalc = { date: dayISO, ...res };
        reconResult.textContent = 'Pendiente';
        reconResult.className = 'badge';
        showToast('Cálculo completado');
    } catch (err) {
        console.error('Error calculando cierre:', err);
        showToast('Error calculando cierre (ver consola)');
    }
});
refreshBtn.addEventListener('click', () => calcBtn.click());

// Save reconciliation
saveReconBtn.addEventListener('click', async () => {
    const last = window.__lastCierreCalc;
    if (!last) {
        showToast('Primero calcula el cierre antes de conciliar.');
        return;
    }
    const physical = parseFloat(reconPhysical.value || '0');
    const diff = physical - last.total;
    if (Math.abs(diff) < 0.005) {
        reconResult.textContent = 'Conciliado';
        reconResult.className = 'badge';
    } else {
        reconResult.textContent = `Diferencia ${formatCurrency(diff)}`;
        reconResult.className = 'badge';
    }
    window.__lastReconciliation = { physical, notes: reconNotes.value || '', diff };
    showToast('Conciliación guardada localmente. Pulsa Cerrar caja del día para registrar en Firestore.');
});

// Close day
closeDayBtn.addEventListener('click', async () => {
    const last = window.__lastCierreCalc;
    if (!last) {
        showToast('Calcula el cierre antes de cerrarlo.');
        return;
    }
    if (!currentUser) { showToast('No autenticado'); return; }
    const payload = {
        date: last.date,
        totals: { total: last.total, orders: last.ordersCount, cash: last.cashTotal, digital: last.digitalTotal },
        breakdown: last.breakdown,
        reconciled: window.__lastReconciliation || null,
        createdBy: currentUser.uid,
        createdByEmail: currentUser.email || null
    };
    if ((currentUserRole === 'vendedor' || currentUserRole === 'motorizado')) {
        payload.owner = currentUser.uid;
    }
    try {
        await saveClosure(payload);
        showToast('Cierre guardado correctamente.');
    } catch (err) {
        console.error('Error guardando cierre:', err);
        showToast('Error guardando cierre (ver consola)');
    }
});

// AUTH state: load role and set default date
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        showToast('No autenticado');
        return;
    }
    currentUser = user;
    try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);
        currentUserRole = userDoc && userDoc.exists() ? userDoc.data().role || 'vendedor' : 'vendedor';
    } catch (err) {
        console.error('Error leyendo role:', err);
        currentUserRole = 'vendedor';
    }

    // Populate dateSelect with today and set default
    const todayIso = (new Date()).toISOString().slice(0, 10);
    dateSelect.value = todayIso;
    // set range defaults (last 7 days)
    const last7 = new Date();
    last7.setDate(last7.getDate() - 7);
    rangeFrom.value = last7.toISOString().slice(0, 10);
    rangeTo.value = todayIso;

    calcBtn.click();
});

// Small util: human date
function humanDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// Búsqueda de cierres en rango (colección cash_closures)
async function fetchClosuresRange(fromIso, toIso) {
    if (!fromIso || !toIso) {
        showToast('Selecciona un rango válido.');
        return;
    }
    try {
        // Asumimos que los documentos guardaron `date` como ISO yyyy-mm-dd
        const closuresCol = collection(db, 'cash_closures');
        const q = query(closuresCol, where('date', '>=', fromIso), where('date', '<=', toIso), orderBy('date', 'desc'));
        const snap = await getDocs(q);
        const arr = [];
        snap.forEach(s => {
            arr.push({ id: s.id, ...s.data() });
        });
        renderClosuresList(arr);
    } catch (err) {
        console.error('Error leyendo cierres en rango:', err);
        showToast('Error leyendo cierres (ver consola)');
    }
}

function renderClosuresList(list = []) {
    closuresList.innerHTML = '';
    if (!list.length) {
        closuresList.innerHTML = `<div class="small-muted">No se encontraron cierres en ese rango.</div>`;
        return;
    }
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.padding = '0';
    ul.style.margin = '0';
    list.forEach(item => {
        const li = document.createElement('li');
        li.style.border = '1px solid var(--border)';
        li.style.borderRadius = '8px';
        li.style.padding = '10px';
        li.style.marginBottom = '8px';
        const dateText = humanDate(item.date);
        const totalText = item.totals ? formatCurrency(item.totals.total) : formatCurrency(item.totals?.total || 0);
        li.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                <div>
                    <div style="font-weight:700">${dateText}</div>
                    <div class="small-muted">Total: ${totalText} · Pedidos: ${item.totals ? item.totals.orders : '—'}</div>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn-small view-closure" data-id="${item.id}">Ver</button>
                </div>
            </div>
            <div class="closure-expand hidden" data-id="${item.id}" style="margin-top:8px;"></div>
        `;
        ul.appendChild(li);

        // botón ver -> expandir datos inline
        li.querySelector('.view-closure').addEventListener('click', () => {
            const exp = li.querySelector('.closure-expand');
            if (!exp) return;
            if (!exp.classList.contains('hidden')) {
                exp.classList.add('hidden');
                return;
            }
            // construir contenido
            exp.innerHTML = '';
            const totals = item.totals || {};
            const breakdown = item.breakdown || [];
            const reconciled = item.reconciled || null;

            const html = document.createElement('div');
            html.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <div><strong>Totales:</strong> ${formatCurrency(totals.total || 0)} · Pedidos: ${totals.orders || 0}</div>
                    <div><strong>Efectivo:</strong> ${formatCurrency(totals.cash || 0)} · <strong>Digital:</strong> ${formatCurrency(totals.digital || 0)}</div>
                    <div><strong>Breakdown:</strong></div>
                </div>
            `;
            const bdUl = document.createElement('ul');
            bdUl.style.listStyle = 'none';
            bdUl.style.padding = '0';
            bdUl.style.margin = '6px 0 0 0';
            breakdown.forEach(b => {
                const bLi = document.createElement('li');
                bLi.style.padding = '6px 0';
                bLi.innerHTML = `<strong>${capitalizeMethod(b.method)}</strong>: ${formatCurrency(b.amount || 0)} · ${b.transactions || 0} tx`;
                // click en breakdown para abrir modal con pedidos asociados (si tengo orders en el documento)
                bLi.addEventListener('click', () => {
                    // algunos cierres guardan orders; si vienen, filtrar. Si no vienen, mensaje.
                    const orders = item.orders || [];
                    if (orders.length) {
                        openDetailModal(`Cierre ${item.date} · ${capitalizeMethod(b.method)}`, renderOrdersList(orders.filter(o => orderHasMethod(o, b.method))));
                    } else {
                        showToast('No hay pedidos embebidos en este cierre para listar.');
                    }
                });
                bdUl.appendChild(bLi);
            });
            html.appendChild(bdUl);

            if (reconciled) {
                const rec = document.createElement('div');
                rec.style.marginTop = '8px';
                rec.innerHTML = `<strong>Conciliación:</strong> Físico: ${formatCurrency(reconciled.physical || 0)} · Diferencia: ${formatCurrency(reconciled.diff || 0)}<div class="small-muted">${escapeHtml(reconciled.notes || '')}</div>`;
                html.appendChild(rec);
            }

            exp.appendChild(html);
            exp.classList.remove('hidden');
        });
    });
    closuresList.appendChild(ul);
}

// Range buttons
rangeSearchBtn.addEventListener('click', () => {
    const from = rangeFrom.value;
    const to = rangeTo.value;
    if (!from || !to) return showToast('Selecciona ambas fechas.');
    if (from > to) return showToast('Fecha desde debe ser anterior a hasta.');
    fetchClosuresRange(from, to);
});
clearRangeBtn.addEventListener('click', () => {
    rangeFrom.value = '';
    rangeTo.value = '';
    closuresList.innerHTML = '';
});

// small utility: summarize order payments (ya definida arriba)
function summarizeOrderPaymentsForDisplay(o) {
    return summarizeOrderPayments(o);
}

// small helpers used earlier are already defined

// Accessibility: open modal with Escape to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!detailModal.classList.contains('hidden')) closeModal();
    }
});

// Fin del archivo
