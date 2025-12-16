// assets/js/presence-ui.js
// Módulo ES que crea/actualiza un "presence pill" visual y escucha los eventos custom
// emitidos por presence.js (presence:me).
//
// Cambios clave:
// - Oculta/elimina indicadores legados (.presence-indicator, .presence-label) para evitar duplicados.
// - Crea/usa un único elemento #presence-pill que refleja el estado (online/offline/error).
// - Se auto-inicializa al cargar el DOM.

const LABELS = {
    online: 'Conectado',
    offline: 'Desconectado',
    error: 'Error'
};

let _pillEl = null;

function hideLegacyIndicators() {
    try {
        // Ocultar elementos por clase
        const legacyEls = document.querySelectorAll('.presence-indicator, .presence-label');
        legacyEls.forEach(el => {
            // preferimos remover para evitar conflictos de layout; si prefieres solo ocultar, cambia a el.style.display = 'none'
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });

        // También intentar ocultar variantes (texto suelto, spans pequeños) que algunos templates usan
        const possibleTextNodes = document.querySelectorAll('[data-presence-legacy], .presence-legacy, #presence-indicator, .rtdb-presence');
        possibleTextNodes.forEach(el => {
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });
    } catch (err) {
        console.debug('presence-ui: error hiding legacy indicators', err);
    }
}

function createPillElement() {
    hideLegacyIndicators();

    // Intenta colocar dentro de .topbar si existe, sino en body (al final)
    const container = document.querySelector('.topbar') || document.body;
    const el = document.createElement('div');
    el.id = 'presence-pill';
    el.className = 'presence-pill offline';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    // No lo hacemos tabbable para que no interfiera con navegación, pero lectores lo verán.
    el.tabIndex = -1;

    // estructura interna: dot + label
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = LABELS.offline;

    el.appendChild(dot);
    el.appendChild(label);

    // Intentar insertarlo al final del contenedor; si prefieres posicion exacta, coloca manualmente
    container.appendChild(el);
    return el;
}

function ensurePill() {
    if (_pillEl) return _pillEl;

    // Reusar si ya existe en DOM (por ejemplo si colocaste manualmente el placeholder)
    const existing = document.getElementById('presence-pill');
    if (existing) {
        _pillEl = existing;
        // Hide legacy indicators when reusing
        hideLegacyIndicators();
        return _pillEl;
    }

    _pillEl = createPillElement();
    return _pillEl;
}

function normalizeState(state) {
    if (!state) return 'offline';
    const s = String(state).toLowerCase();
    if (s === 'online' || s === 'active') return 'online';
    if (s === 'offline' || s === 'inactive') return 'offline';
    return s;
}

function updatePill(state) {
    const el = ensurePill();
    const label = el.querySelector('.label');
    const st = normalizeState(state);

    // actualizar clases
    el.classList.remove('online', 'offline', 'error');
    el.classList.add(st === 'online' ? 'online' : (st === 'offline' ? 'offline' : 'error'));

    // texto accesible
    label.textContent = LABELS[st] || state || st;
    el.setAttribute('data-state', st);
    el.setAttribute('aria-label', `Estado: ${label.textContent}`);

    // pequeña animación visual al hacerse online
    if (st === 'online') {
        el.style.transform = 'translateY(-2px)';
        el.style.transition = 'transform 180ms ease';
        setTimeout(() => {
            el.style.transform = '';
        }, 200);
    }
}

// Escucha evento custom ya definido en tu presence.js
window.addEventListener('presence:me', (ev) => {
    try {
        const state = ev?.detail?.state || 'offline';
        updatePill(state);
    } catch (err) {
        console.debug('presence-ui: error handling presence:me', err);
    }
});

// Export y exposición en window.__presence (sin sobrescribir lo que ya exista)
window.__presence = window.__presence || {};
window.__presence.updatePresencePill = updatePill;
window.__presence.ensurePresencePill = ensurePill;
window.__presence.hideLegacyPresenceIndicators = hideLegacyIndicators;

// Auto-crear el pill cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensurePill());
} else {
    ensurePill();
}

export {
    updatePill,
    ensurePill,
    hideLegacyIndicators
};