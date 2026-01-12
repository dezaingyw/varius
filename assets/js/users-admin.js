// assets/js/users-admin.js
// Modificado para: email (local + extensión con prevención de '@' en local),
// phone local EXACTAMENTE 7 dígitos (y aviso si intentan pegar más),
// mejoras responsive handling en modal.
// Arreglo: botón "Editar" ahora usa la clase .btn-edit para que el event listener funcione.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    getDoc,
    doc,
    setDoc,
    updateDoc,
    serverTimestamp,
    query,
    orderBy,
    where
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa Firebase (solo si no está)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Configurables
const CREATE_USER_FUNCTION_URL = 'https://us-central1-varius-7de76.cloudfunctions.net/createUser';

// Teléfono: operador(3) + local(7) => total 10 dígitos esperado.
// Conservamos min/max por compatibilidad, pero validaremos operadora+local por separado.
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_DIGITS = 10;

// DOM elementos
const openAddBtn = document.getElementById('openAddBtn');
const userModal = document.getElementById('userModal');
const closeModalBtn = document.getElementById('closeModal');
const userForm = document.getElementById('userForm');
const cancelBtn = document.getElementById('cancelBtn');
const toastEl = document.getElementById('toast');
const usersBody = document.getElementById('usersBody');

const searchInput = document.getElementById('searchInput');
const roleFilter = document.getElementById('roleFilter');
const statusFilter = document.getElementById('statusFilter');
const perPageSelect = document.getElementById('perPageSelect');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

let allUsers = [];
let filteredUsers = [];
let currentPage = 1;
let presenceMap = {};
let modalMode = 'add'; // 'add' or 'edit'

// Toast helper
function showToast(msg, time = 2500) {
    if (!toastEl) { console.log(msg); return; }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), time);
}

// utils
function escapeHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function roleClass(role) {
    if (!role) return 'role-vendedor';
    switch (role) {
        case 'administrador': return 'role-admin';
        case 'vendedor': return 'role-vendedor';
        case 'motorizado': return 'role-motorizado';
        default: return 'role-vendedor';
    }
}
function statusClass(status) {
    switch ((status || '').toLowerCase()) {
        case 'activo': return 'status-activo';
        case 'inactivo': return 'status-inactivo';
        case 'suspendido': return 'status-suspendido';
        default: return 'status-inactivo';
    }
}

// Email regex: componente completa validación (local@domain)
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// Domain regex for custom ext (sin @)
const DOMAIN_REGEX = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Normaliza teléfono (solo dígitos)
function normalizePhone(p) { return (p || '').replace(/\D/g, ''); }

function isPhoneFormatValid(phone) {
    if (!phone) return false;
    const len = phone.length;
    return len >= PHONE_MIN_DIGITS && len <= PHONE_MAX_DIGITS;
}

// Firestore duplicate checks (como antes)
async function isEmailTaken(email, excludeId = null) {
    if (!email) return false;
    const emailLower = email.toLowerCase();
    const q = query(collection(db, 'users'), where('emailLower', '==', emailLower));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
        if (d.id !== excludeId) return true;
    }
    return false;
}

async function isPhoneTaken(phone, excludeId = null) {
    if (!phone) return false;
    const norm = normalizePhone(phone);
    const q = query(collection(db, 'users'), where('phone', '==', norm));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
        if (d.id !== excludeId) return true;
    }
    return false;
}

// Formatea Timestamp (Firestore) u otros tipos a string legible
function formatTimestamp(ts) {
    if (!ts) return '';
    let dateObj = null;
    try {
        if (typeof ts.toDate === 'function') dateObj = ts.toDate();
        else if (ts instanceof Date) dateObj = ts;
        else if (typeof ts === 'number') dateObj = new Date(ts);
        else dateObj = new Date(ts);
        return dateObj.toLocaleString();
    } catch (err) {
        return '';
    }
}

// Load users
async function loadUsers() {
    try {
        const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFiltersAndRender();
    } catch (err) {
        console.error('Error loading users', err);
        showToast('Error cargando usuarios.');
    }
}

// Filters & render (sin cambios funcionales)
function applyFiltersAndRender() {
    const q = (searchInput?.value || '').toLowerCase();
    const r = roleFilter?.value || '';
    const s = statusFilter?.value || '';
    filteredUsers = allUsers.filter(u => {
        const matchesQ = !q || (
            (u.name || '').toLowerCase().includes(q) ||
            (u.email || '').toLowerCase().includes(q) ||
            (String(u.phone || '')).toLowerCase().includes(q)
        );
        const matchesRole = !r || u.role === r;
        const matchesStatus = !s || (u.status === s);
        return matchesQ && matchesRole && matchesStatus;
    });
    currentPage = 1;
    renderTable();
}

function renderTable() {
    const perPageVal = perPageSelect?.value || '10';
    const perPage = perPageVal === 'all' ? (filteredUsers.length || 1) : parseInt(perPageVal, 10);
    const total = filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * perPage;
    const pageItems = filteredUsers.slice(start, start + perPage);

    if (pageInfo) pageInfo.textContent = `${total ? start + 1 : 0}-${Math.min(start + perPage, total)} de ${total}`;

    usersBody.innerHTML = '';
    for (const u of pageItems) {
        const state = presenceMap[u.id] || 'offline';
        const dotClass = state === 'online' ? 'online-dot' : 'offline-dot';
        const tr = document.createElement('tr');

        // Si está suspendido, marcar la fila con clase para estilo rojo
        if ((u.status || '').toLowerCase() === 'suspendido') {
            tr.classList.add('row-suspendido');
        }

        const tdName = document.createElement('td');
        tdName.innerHTML = `
            <div class="user-cell">
                <div class="${dotClass}" title="${state === 'online' ? 'Conectado' : 'Desconectado'}" aria-hidden="true"></div>
                <div class="user-meta-stack">
                    <div class="user-name">${escapeHtml(u.name || '—')}</div>
                    <div class="user-email">${escapeHtml(u.email || '')}</div>
                </div>
            </div>
        `;

        const tdRole = document.createElement('td');
        tdRole.innerHTML = `<span class="role-badge ${roleClass(u.role)}">${escapeHtml(u.role || '')}</span>`;

        const tdPhone = document.createElement('td');
        tdPhone.textContent = u.phone || '';

        // Nueva columna: Fecha -> muestra FC: (createdAt) y si existe FS: (updatedAt) cuando está suspendido
        const tdDate = document.createElement('td');
        const createdStr = u.createdAt ? formatTimestamp(u.createdAt) : '';
        const updatedStr = u.updatedAt ? formatTimestamp(u.updatedAt) : '';
        // Construimos HTML con etiquetas FC: y FS:
        let dateHtml = `<div class="date-cell"><div><strong>FC:</strong> ${escapeHtml(createdStr)}</div>`;
        if ((u.status || '').toLowerCase() === 'suspendido' && updatedStr) {
            dateHtml += `<div><strong>FS:</strong> ${escapeHtml(updatedStr)}</div>`;
        }
        dateHtml += `</div>`;
        tdDate.innerHTML = dateHtml;

        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = `<span class="status-badge ${statusClass(u.status)}">${escapeHtml(u.status || 'Activo')}</span>`;

        const tdActions = document.createElement('td');
        // IMPORTANT: usar clase btn-edit para que el listener funcione
        tdActions.innerHTML = `
            <div class="actions">
                <button class="btn-small btn-edit" data-id="${u.id}" title="Editar" aria-label="Editar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-pencil-square" viewBox="0 0 16 16">
                        <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
                        <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/>
                    </svg>
                </button>
                <button class="btn-small btn-suspender" data-id="${u.id}" title="Suspender" aria-label="Suspender">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                </button>
            </div>
        `;

        tr.appendChild(tdName);
        tr.appendChild(tdRole);
        tr.appendChild(tdPhone);
        tr.appendChild(tdDate);
        tr.appendChild(tdStatus);
        tr.appendChild(tdActions);
        usersBody.appendChild(tr);
    }

    // Attach handlers
    usersBody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const docSnap = allUsers.find(x => x.id === id);
            if (docSnap) openModal('edit', docSnap);
        });
    });

    usersBody.querySelectorAll('.btn-suspender').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('¿Suspender usuario? Esto marcará su estado como "Suspendido".')) return;
            try {
                // Ahora guardamos updatedAt para poder mostrar la fecha de suspensión (FS)
                await updateDoc(doc(db, 'users', id), { status: 'Suspendido', updatedAt: serverTimestamp() });
                showToast('Usuario suspendido.');
                await loadUsers();
            } catch (err) {
                console.error('Error suspending user', err);
                showToast('Error al suspender usuario.');
            }
        });
    });
}

// -----------------------------
// Modal helpers y validación UI
// -----------------------------
function openModal(mode = 'add', data = null) {
    modalMode = mode;
    const titleEl = document.getElementById('modalTitle');
    const userIdEl = document.getElementById('userId');
    titleEl.textContent = mode === 'add' ? 'Agregar Usuario' : 'Editar Usuario';
    userIdEl.value = data?.id || '';
    document.getElementById('u_name').value = data?.name || '';

    // email split: si trae email, separo local + dominio
    const emailLocalEl = document.getElementById('u_email_local');
    const emailExtSelect = document.getElementById('u_email_ext');
    const emailExtCustom = document.getElementById('u_email_ext_custom');
    const emailFull = data?.email || '';
    if (emailFull && emailFull.includes('@')) {
        const [local, domain] = emailFull.split('@');
        emailLocalEl.value = local || '';
        const found = Array.from(emailExtSelect.options).some(opt => opt.value === domain);
        if (found) {
            emailExtSelect.value = domain;
            emailExtCustom.style.display = 'none';
            emailExtCustom.value = '';
        } else {
            emailExtSelect.value = 'otro';
            emailExtCustom.style.display = 'block';
            emailExtCustom.value = domain || '';
        }
    } else {
        emailLocalEl.value = '';
        emailExtSelect.value = 'gmail.com';
        emailExtCustom.style.display = 'none';
        emailExtCustom.value = '';
    }

    // phone split
    const operatorEl = document.getElementById('u_operator');
    const phoneLocalEl = document.getElementById('u_phone_local');
    const phoneStored = data?.phone || '';
    if (phoneStored && phoneStored.length >= 7) {
        const norm = normalizePhone(phoneStored);
        if (norm.length >= 10) {
            const op = norm.slice(0,3);
            const local = norm.slice(3);
            operatorEl.value = op;
            phoneLocalEl.value = local;
        } else {
            operatorEl.value = '';
            phoneLocalEl.value = norm;
        }
    } else {
        operatorEl.value = '';
        phoneLocalEl.value = '';
    }

    document.getElementById('u_role').value = data?.role || '';
    document.getElementById('u_status').value = data?.status || 'Activo';
    document.getElementById('u_password').value = '';
    document.getElementById('u_password_confirm').value = '';
    ['u_name_alert','u_email_alert','u_phone_alert','u_password_alert','u_password_confirm_alert','u_role_alert'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '';
    });

    // En modo 'add' marcar campos como required; en 'edit' remover required para no bloquear la edición
    const setRequired = (id, req) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (req) el.setAttribute('required','true');
        else el.removeAttribute('required');
    };
    const addRequired = mode === 'add';
    setRequired('u_email_local', addRequired);
    setRequired('u_email_ext', addRequired);
    setRequired('u_operator', addRequired);
    setRequired('u_phone_local', addRequired);
    setRequired('u_role', addRequired);
    setRequired('u_status', addRequired);
    setRequired('u_password', addRequired);
    setRequired('u_password_confirm', addRequired);

    // si está en 'otro' y es modo add, requerir el custom
    if (emailExtSelect.value === 'otro' && addRequired) emailExtCustom.setAttribute('required','true');
    else emailExtCustom.removeAttribute('required');

    userModal.classList.remove('hidden');
    userModal.setAttribute('aria-hidden','false');
}

function closeModal() {
    userModal.classList.add('hidden');
    userModal.setAttribute('aria-hidden','true');
}

function getFullEmailFromForm() {
    const local = (document.getElementById('u_email_local').value || '').trim();
    const extSelect = document.getElementById('u_email_ext').value;
    const extCustomEl = document.getElementById('u_email_ext_custom');
    const ext = extSelect === 'otro' ? (extCustomEl.value || '').trim() : extSelect;
    if (!local || !ext) return '';
    return `${local}@${ext}`;
}

function getFullPhoneFromForm() {
    const operator = (document.getElementById('u_operator').value || '').trim(); // ej '414'
    const local = (document.getElementById('u_phone_local').value || '').trim();
    return normalizePhone((operator || '') + (local || ''));
}

function validateForm(values, isEdit = false) {
    let ok = true;
    if (!values.name || !values.name.trim()) { document.getElementById('u_name_alert').textContent = 'El nombre es requerido.'; ok = false; }
    else document.getElementById('u_name_alert').textContent = '';

    // email: verificar existencia y formato. Además validar extensión custom si aplica.
    const emailAlertEl = document.getElementById('u_email_alert');
    const emailExtSelectEl = document.getElementById('u_email_ext');
    const emailExtCustomEl = document.getElementById('u_email_ext_custom');
    if (!values.email) {
        emailAlertEl.textContent = 'Correo requerido.';
        ok = false;
    } else if (!EMAIL_REGEX.test(values.email)) {
        emailAlertEl.textContent = 'Correo inválido.';
        ok = false;
    } else {
        // si seleccionaron 'otro' validar dominio custom
        if (emailExtSelectEl && emailExtSelectEl.value === 'otro') {
            const custom = (emailExtCustomEl.value || '').trim();
            if (!custom) {
                emailAlertEl.textContent = 'Ingresa la extensión de correo.';
                ok = false;
            } else if (!DOMAIN_REGEX.test(custom)) {
                emailAlertEl.textContent = 'Dominio inválido.';
                ok = false;
            } else {
                emailAlertEl.textContent = '';
            }
        } else {
            emailAlertEl.textContent = '';
        }
    }

    // phone: require operator + local 7 dígitos -> total 10
    const operator = (document.getElementById('u_operator').value || '').trim();
    const phoneLocal = (document.getElementById('u_phone_local').value || '').trim();
    const fullPhone = values.phone || '';

    if (!operator) {
        document.getElementById('u_phone_alert').textContent = 'Selecciona la operadora.';
        ok = false;
    } else if (phoneLocal.length !== 7) {
        document.getElementById('u_phone_alert').textContent = 'El número local debe tener 7 dígitos.';
        ok = false;
    } else if (!isPhoneFormatValid(fullPhone)) {
        document.getElementById('u_phone_alert').textContent = `Teléfono inválido. Debe tener entre ${PHONE_MIN_DIGITS} y ${PHONE_MAX_DIGITS} dígitos.`;
        ok = false;
    } else {
        document.getElementById('u_phone_alert').textContent = '';
    }

    // rol: ahora mostramos alerta inline (en lugar de solo toast)
    const roleEl = document.getElementById('u_role');
    const roleAlertEl = document.getElementById('u_role_alert');
    if (!values.role || !values.role.trim()) {
        if (roleAlertEl) roleAlertEl.textContent = 'Selecciona un rol.';
        else showToast('Selecciona un rol.');
        ok = false;
    } else {
        if (roleAlertEl) roleAlertEl.textContent = '';
    }

    // estado (por seguridad)
    if (!values.status) {
        showToast('Selecciona un estado.');
        ok = false;
    }

    // Contraseña: si estamos agregando (no isEdit) o el usuario intentó cambiar password -> validar
    if (!isEdit || (values.password || values.confirm)) {
        const pw = values.password || '';
        const confirm = values.confirm || '';
        const okLen = pw.length >= 6 && pw.length <= 8;
        const okUpper = /[A-Z]/.test(pw);
        const okLower = /[a-z]/.test(pw);
        const okNumber = /[0-9]/.test(pw);
        const okSpecial = /[\W_]/.test(pw);
        if (!okLen || !okUpper || !okLower || !okNumber || !okSpecial) {
            document.getElementById('u_password_alert').textContent = 'La contraseña debe tener 6-8 caracteres e incluir mayúscula, minúscula, número y carácter especial.'; ok = false;
        } else document.getElementById('u_password_alert').textContent = '';
        if (pw !== confirm) { document.getElementById('u_password_confirm_alert').textContent = 'Las contraseñas no coinciden.'; ok = false; } else document.getElementById('u_password_confirm_alert').textContent = '';
    } else {
        document.getElementById('u_password_alert').textContent = '';
        document.getElementById('u_password_confirm_alert').textContent = '';
    }
    return ok;
}

// -----------------------------
// Password toggles (igual que antes) -----------------------------
const pwdInput = document.getElementById('u_password');
const pwdConfirmInput = document.getElementById('u_password_confirm');
let pwdToggle = null;
let pwdConfirmToggle = null;
function createToggleBtn() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn small pwd-toggle';
    btn.setAttribute('aria-pressed','false');
    btn.textContent = '👁️';
    btn.style.marginLeft = '8px';
    btn.style.padding = '4px';
    btn.style.fontSize = '14px';
    return btn;
}
function showPasswordTogglesIfNeeded() {
    if (!pwdInput || !pwdConfirmInput) return;
    const bothHaveText = (pwdInput.value && pwdInput.value.length > 0) && (pwdConfirmInput.value && pwdConfirmInput.value.length > 0);
    if (bothHaveText) {
        if (!pwdToggle) {
            pwdToggle = createToggleBtn();
            pwdToggle.addEventListener('click', () => {
                const isPwd = pwdInput.type === 'password';
                pwdInput.type = isPwd ? 'text' : 'password';
                pwdToggle.textContent = isPwd ? '🙈' : '👁️';
                pwdToggle.setAttribute('aria-pressed', String(!isPwd));
            });
            pwdInput.parentNode.appendChild(pwdToggle);
        }
        if (!pwdConfirmToggle) {
            pwdConfirmToggle = createToggleBtn();
            pwdConfirmToggle.addEventListener('click', () => {
                const isPwd = pwdConfirmInput.type === 'password';
                pwdConfirmInput.type = isPwd ? 'text' : 'password';
                pwdConfirmToggle.textContent = isPwd ? '🙈' : '👁️';
                pwdConfirmToggle.setAttribute('aria-pressed', String(!isPwd));
            });
            pwdConfirmInput.parentNode.appendChild(pwdConfirmToggle);
        }
    } else {
        if (pwdToggle) { pwdToggle.remove(); pwdToggle = null; }
        if (pwdConfirmToggle) { pwdConfirmToggle.remove(); pwdConfirmToggle = null; }
        pwdInput.type = 'password';
        pwdConfirmInput.type = 'password';
    }
}
if (pwdInput && pwdConfirmInput) {
    pwdInput.addEventListener('input', showPasswordTogglesIfNeeded);
    pwdConfirmInput.addEventListener('input', showPasswordTogglesIfNeeded);
}

// -----------------------------
// Form submit (Cloud Function) -----------------------------
userForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('userId').value;
    const name = document.getElementById('u_name').value.trim();
    const email = getFullEmailFromForm();
    const phone = getFullPhoneFromForm();
    const role = document.getElementById('u_role').value;
    const status = document.getElementById('u_status').value;
    const password = document.getElementById('u_password').value;
    const confirm = document.getElementById('u_password_confirm').value;

    const values = { name, email, phone, role, status, password, confirm };
    const isEdit = !!userId;
    if (!validateForm(values, isEdit)) return;

    // duplicados
    try {
        const emailTaken = await isEmailTaken(email, isEdit ? userId : null);
        if (emailTaken) { document.getElementById('u_email_alert').textContent = 'El correo ya está registrado.'; return; }
        if (phone) {
            const phoneTaken = await isPhoneTaken(phone, isEdit ? userId : null);
            if (phoneTaken) { document.getElementById('u_phone_alert').textContent = 'El teléfono ya está registrado.'; return; }
        }
    } catch (err) {
        console.error('Error checking duplicates', err);
        showToast('Error verificando duplicados. Intenta más tarde.');
        return;
    }

    try {
        if (!isEdit) {
            const idToken = await auth.currentUser.getIdToken(true);
            const res = await fetch(CREATE_USER_FUNCTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                body: JSON.stringify({ name, email, phone, role, status, password })
            });
            const result = await res.json();
            if (!res.ok) {
                const errMsg = result && result.error ? result.error : 'Error creando usuario.';
                showToast(errMsg);
                console.error('createUser error:', result);
                return;
            }
            showToast('Usuario creado correctamente.');
        } else {
            await updateDoc(doc(db, 'users', userId), { name, phone, role, status, updatedAt: serverTimestamp() });
            if (password) showToast('Datos actualizados. Email para restablecer contraseña enviado.');
            else showToast('Usuario actualizado.');
        }
        closeModal();
        await loadUsers();
    } catch (err) {
        console.error('Error saving user', err);
        showToast('Error guardando usuario. Revisa consola.');
    }
});

// UI wiring
openAddBtn?.addEventListener('click', () => openModal('add'));
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });
userModal?.addEventListener('click', (e) => { if (e.target === userModal) closeModal(); });

// Phone local input: only digits, max 7, show alert if attempted paste more
const phoneLocalInput = document.getElementById('u_phone_local');
if (phoneLocalInput) {
    phoneLocalInput.addEventListener('input', (e) => {
        const cleaned = normalizePhone(e.target.value);
        if (cleaned.length > 7) {
            e.target.value = cleaned.slice(0,7);
            document.getElementById('u_phone_alert').textContent = 'Máximo 7 dígitos (parte local).';
            setTimeout(() => { const el = document.getElementById('u_phone_alert'); if (el) el.textContent = ''; }, 2200);
        } else {
            e.target.value = cleaned;
            document.getElementById('u_phone_alert').textContent = '';
        }
    });
}

// Email local input: impedir '@' y si el usuario pega "local@dominio" mover dominio al select (UX)
const emailLocalInput = document.getElementById('u_email_local');
const emailExtSelectEl = document.getElementById('u_email_ext');
const emailExtCustomEl = document.getElementById('u_email_ext_custom');

if (emailLocalInput) {
    emailLocalInput.addEventListener('input', (e) => {
        const v = e.target.value;
        if (v.includes('@')) {
            // separar local y dominio
            const [local, rest] = v.split('@');
            e.target.value = local || '';
            if (rest && rest.length) {
                // check if matches known options
                const domainCandidate = rest.split('/')[0].split('?')[0];
                const found = Array.from(emailExtSelectEl.options).some(opt => opt.value === domainCandidate);
                if (found) {
                    emailExtSelectEl.value = domainCandidate;
                    emailExtCustomEl.style.display = 'none';
                    emailExtCustomEl.value = '';
                    emailExtCustomEl.removeAttribute('required');
                } else {
                    emailExtSelectEl.value = 'otro';
                    emailExtCustomEl.style.display = 'block';
                    emailExtCustomEl.value = domainCandidate;
                    if (modalMode === 'add') emailExtCustomEl.setAttribute('required','true');
                }
            }
            document.getElementById('u_email_alert').textContent = '';
        } else {
            // remove stray spaces at ends
            e.target.value = v.replace(/\s+/g, ' ').trimStart();
            document.getElementById('u_email_alert').textContent = '';
        }
    });
}

// Email extension select handling: mostrar input custom si "otro"
if (emailExtSelectEl) {
    emailExtSelectEl.addEventListener('change', () => {
        if (emailExtSelectEl.value === 'otro') {
            emailExtCustomEl.style.display = 'block';
            emailExtCustomEl.focus();
            if (modalMode === 'add') emailExtCustomEl.setAttribute('required','true');
        } else {
            emailExtCustomEl.style.display = 'none';
            emailExtCustomEl.value = '';
            emailExtCustomEl.removeAttribute('required');
        }
        document.getElementById('u_email_alert').textContent = '';
    });
}
if (emailExtCustomEl) {
    emailExtCustomEl.addEventListener('input', (e) => {
        // evitar '@' dentro del dominio custom
        const v = e.target.value;
        if (v.includes('@')) e.target.value = v.replace(/@/g, '');
        document.getElementById('u_email_alert').textContent = '';
    });
}

// Filters & pagination events
applyFiltersBtn?.addEventListener('click', () => applyFiltersAndRender());
clearFiltersBtn?.addEventListener('click', () => { searchInput.value = ''; roleFilter.value = ''; statusFilter.value = ''; perPageSelect.value = '10'; applyFiltersAndRender(); });
searchInput?.addEventListener('input', () => { currentPage = 1; applyFiltersAndRender(); });
roleFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
statusFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
perPageSelect?.addEventListener('change', () => { currentPage = 1; renderTable(); });
prevPageBtn?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
nextPageBtn?.addEventListener('click', () => {
    const perPageVal = perPageSelect?.value || '10';
    const perPage = perPageVal === 'all' ? (filteredUsers.length || 1) : parseInt(perPageVal, 10);
    const totalPages = Math.max(1, Math.ceil(filteredUsers.length / perPage));
    if (currentPage < totalPages) currentPage++;
    renderTable();
});

// Presence: listen events (presence.js should emit presence:list)
window.addEventListener('presence:list', (e) => {
    const users = (e.detail && e.detail.users) || [];
    const map = {};
    for (const u of users) map[u.uid] = (u.state === 'online' ? 'online' : 'offline');
    presenceMap = map;
    if (allUsers.length) renderTable();
});

// Auth check & initial load
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    try {
        const s = await getDoc(doc(db, 'users', user.uid));
        if (s.exists()) {
            const r = s.data().role;
            if (r !== 'administrador') { window.location.href = `/admin/${r}.html`; return; }
        } else { window.location.href = 'index.html'; return; }
    } catch (err) {
        console.error('Role check error', err);
    }
    await loadUsers();
});
