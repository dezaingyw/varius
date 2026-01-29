// Módulo para manejar el modal de comisiones y guardar en Cloud Firestore
// Ajusta la ruta de importación de firebase-config.js si la tienes en otra ubicación.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import {
    getFirestore,
    doc,
    setDoc,
    serverTimestamp,
    getDoc,
    collection,
    addDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Elementos del DOM
const modal = document.getElementById('modalComisiones');
const btnOpen = document.getElementById('btn-assign-commissions');
const btnClose = document.getElementById('closeModalBtn');
const btnDiscard = document.getElementById('discardModalBtn');
const form = document.getElementById('formComisiones');
const inputSeller = document.getElementById('commission-seller');
const inputRider = document.getElementById('commission-rider');
const toastEl = document.getElementById('toast');

// Variable para mantener el estado del documento actual (si existe)
let currentCommission = null;

// Util: obtener dateKey en formato YYYY-MM-DD usando la hora local
function getLocalDateKey(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Abrir / cerrar modal
async function openModal() {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    // Cargar comisiones del día (si existen) y rellenar inputs
    try {
        const dateKey = getLocalDateKey();
        const docRef = doc(db, 'comisiones', dateKey);
        const snap = await getDoc(docRef);

        if (snap.exists()) {
            const data = snap.data();
            currentCommission = data;
            // Asegurarse de mostrar con 2 decimales y valores numéricos
            const seller = typeof data.sellerPercent === 'number' ? data.sellerPercent : parseFloat(data.sellerPercent) || 0;
            const rider = typeof data.riderPercent === 'number' ? data.riderPercent : parseFloat(data.riderPercent) || 0;

            inputSeller.value = seller.toFixed(2);
            inputRider.value = rider.toFixed(2);
        } else {
            currentCommission = null;
            inputSeller.value = '0.00';
            inputRider.value = '0.00';
        }
    } catch (err) {
        console.error('Error al leer comisiones de hoy:', err);
        showToast('Error al cargar comisiones. Revisa la consola.', 'error');
        // En caso de error dejar valores por defecto
        currentCommission = null;
        inputSeller.value = '0.00';
        inputRider.value = '0.00';
    }

    // enfocar input después de mostrar modal
    setTimeout(() => inputSeller.focus(), 100);
}

function closeModal() {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    form.reset();
    currentCommission = null;
}

btnOpen.addEventListener('click', openModal);
btnClose.addEventListener('click', closeModal);
btnDiscard.addEventListener('click', closeModal);

// Cerrar al hacer click fuera del contenedor
window.addEventListener('click', (ev) => {
    if (ev.target === modal) closeModal();
});

// Toast simple
function showToast(message, type = 'success', timeout = 3000) {
    toastEl.textContent = message;
    toastEl.className = ''; // reset
    toastEl.classList.add(type === 'error' ? 'error' : 'success');
    toastEl.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
        toastEl.style.display = 'none';
    }, timeout);
}

// Manejo del submit: validar, auditar y guardar en Firestore
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const sellerRaw = inputSeller.value;
    const riderRaw = inputRider.value;

    const sellerPercent = parseFloat(sellerRaw);
    const riderPercent = parseFloat(riderRaw);

    if (Number.isNaN(sellerPercent) || sellerPercent < 0 || sellerPercent > 100) {
        showToast('Por favor ingresa un porcentaje válido para vendedores (0-100).', 'error');
        return;
    }
    if (Number.isNaN(riderPercent) || riderPercent < 0 || riderPercent > 100) {
        showToast('Por favor ingresa un porcentaje válido para motorizados (0-100).', 'error');
        return;
    }

    try {
        const dateKey = getLocalDateKey();
        const docRef = doc(db, 'comisiones', dateKey);

        // Preparar payload nuevo
        const payload = {
            sellerPercent: sellerPercent,
            riderPercent: riderPercent,
            date: dateKey,
            updatedAt: serverTimestamp()
        };

        // Si hay comisión previa (currentCommission) y difiere, crear registro de auditoría
        const prevSeller = currentCommission && typeof currentCommission.sellerPercent === 'number'
            ? currentCommission.sellerPercent
            : currentCommission && currentCommission.sellerPercent ? parseFloat(currentCommission.sellerPercent) : null;

        const prevRider = currentCommission && typeof currentCommission.riderPercent === 'number'
            ? currentCommission.riderPercent
            : currentCommission && currentCommission.riderPercent ? parseFloat(currentCommission.riderPercent) : null;

        const changedSeller = prevSeller === null ? (sellerPercent !== 0) : (prevSeller !== sellerPercent);
        const changedRider = prevRider === null ? (riderPercent !== 0) : (prevRider !== riderPercent);

        // Guardar (o actualizar) el documento del día
        await setDoc(docRef, payload, { merge: true });

        // Si hubo cambio en alguno de los porcentajes, añadir auditoría
        if (changedSeller || changedRider) {
            try {
                const auditPayload = {
                    dateKey: dateKey,
                    previous: {
                        sellerPercent: prevSeller,
                        riderPercent: prevRider
                    },
                    current: {
                        sellerPercent: sellerPercent,
                        riderPercent: riderPercent
                    },
                    changedAt: serverTimestamp()
                    // Puedes añadir más campos como changedBy si tienes auth disponible
                };
                const auditsCol = collection(db, 'comisiones_audits');
                await addDoc(auditsCol, auditPayload);
            } catch (auditErr) {
                console.error('Error guardando auditoría de comisiones:', auditErr);
                // No bloqueamos el flujo principal si la auditoría falla, solo notificamos
                showToast('Comisión guardada. Pero falló guardar el registro de cambio.', 'error', 4000);
                closeModal();
                return;
            }
        }

        showToast('Comisiones guardadas correctamente.', 'success');
        closeModal();
    } catch (err) {
        console.error('Error guardando comisiones:', err);
        showToast('Error al guardar. Revisa la consola.', 'error');
    }
});