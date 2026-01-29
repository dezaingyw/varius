// Auto-initialize session timeout logic (works en cualquier página).
// Requisitos: auth.js debe exportar `logout(redirectTo = '/login.html')`.
import { logout } from './auth.js';

const WARNING_TIME = 25 * 60 * 1000; // 25 min
const LOGOUT_TIME = 60 * 60 * 1000;  // 60 min

let warningTimeout = null;
let logoutTimeout = null;
let countdownInterval = null;

const EVENTS = ['click', 'keydown', 'scroll', 'touchstart', 'mousemove'];

// --- Modal helpers ---
function createWarningModal() {
    // Evitar duplicados
    if (document.getElementById('session-timeout-modal')) return document.getElementById('session-timeout-modal');

    const modal = document.createElement('div');
    modal.id = 'session-timeout-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
    <div style="background:#fff;padding:20px;border-radius:8px;max-width:92%;width:420px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.25);">
      <h3 style="margin:0 0 8px 0;">Sesión inactiva</h3>
      <p id="session-timeout-msg" style="margin:0 0 12px 0;">Tu sesión se cerrará en <strong id="session-timeout-remaining"></strong>.</p>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button id="session-timeout-continue" style="background:#7E3FF0;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;">Continuar sesión</button>
        <button id="session-timeout-logout" style="background:#e0e0e0;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;">Cerrar sesión ahora</button>
      </div>
    </div>
  `;
    modal.style.display = 'none';
    document.body.appendChild(modal);
    return modal;
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function showWarning() {
    const modal = createWarningModal();
    const remainingEl = document.getElementById('session-timeout-remaining');
    const continueBtn = document.getElementById('session-timeout-continue');
    const logoutBtn = document.getElementById('session-timeout-logout');

    // tiempo restante entre advertencia y logout
    const remainingSeconds = Math.ceil((LOGOUT_TIME - WARNING_TIME) / 1000);
    let remaining = remainingSeconds;

    remainingEl.textContent = formatTime(remaining);
    modal.style.display = 'flex';

    // cuenta regresiva visible
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        remainingEl.textContent = formatTime(remaining);
        if (remaining <= 0) {
            clearInterval(countdownInterval);
        }
    }, 1000);

    // handlers
    continueBtn.onclick = () => {
        hideWarning();
        resetTimers();
    };
    logoutBtn.onclick = async () => {
        hideWarning();
        await doLogout();
    };

    // cerrar con Escape
    const escHandler = (e) => { if (e.key === 'Escape') { hideWarning(); resetTimers(); } };
    document.addEventListener('keydown', escHandler, { once: true });
}

function hideWarning() {
    const modal = document.getElementById('session-timeout-modal');
    if (modal) modal.style.display = 'none';
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

async function doLogout() {
    try {
        // Llamamos a logout exportado por auth.js; por defecto redirige a /login.html
        await logout('../login.html');
    } catch (err) {
        console.error('Error en logout:', err);
        // Fallback: navegar directamente
        window.location.href = '../login.html';
    }
}

// Resetea timers (llamar en cada interacción de usuario)
function resetTimers() {
    if (warningTimeout) clearTimeout(warningTimeout);
    if (logoutTimeout) clearTimeout(logoutTimeout);
    hideWarning();

    warningTimeout = setTimeout(() => {
        showWarning();
    }, WARNING_TIME);

    logoutTimeout = setTimeout(async () => {
        hideWarning();
        await doLogout();
    }, LOGOUT_TIME);
}

// Escuchar eventos de usuario para reiniciar timers
EVENTS.forEach(ev => document.addEventListener(ev, resetTimers, { capture: true, passive: true }));

// Iniciar al cargar el módulo
resetTimers();

// Export opcional si quieres exponer control manual
export { resetTimers as resetSessionTimers, doLogout as forceSessionLogout };