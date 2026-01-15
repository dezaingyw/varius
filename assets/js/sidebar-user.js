import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc as fsDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { logout } from './auth.js';
import { applyUiRestrictions } from './rbac.js';

import './presence.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function whenReady(selector, timeout = 3000) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const obs = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) {
                obs.disconnect();
                resolve(found);
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
            obs.disconnect();
            resolve(document.querySelector(selector));
        }, timeout);
    });
}

function getInitials(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function init() {
    const sidebarEl = await whenReady('aside.sidebar');
    if (!sidebarEl) {
        console.warn('sidebar-user: sidebar no encontrada en el DOM');
        return;
    }

    const nameEl = sidebarEl.querySelector('.sidebar-user .name') || document.getElementById('sidebar-name');
    const metaEl = sidebarEl.querySelector('.sidebar-user .email') || document.getElementById('sidebar-email');
    const avatarEl = sidebarEl.querySelector('.sidebar-user .avatar') || document.getElementById('sidebar-avatar');
    const logoutBtn = sidebarEl.querySelector('.sidebar-user .logout-btn, .sidebar-user #logout, #logout, .logout-btn');
    const topSearch = document.querySelector('.top-search');

    // --- NAV active highlighting ---
    function currentFileName() {
        const p = window.location.pathname || '/';
        let name = p.substring(p.lastIndexOf('/') + 1);
        if (!name) name = 'index.html';
        return name;
    }

    function markActiveNav() {
        const anchors = Array.from(sidebarEl.querySelectorAll('.nav-list a[href]'));
        const current = currentFileName();

        anchors.forEach(a => {
            const li = a.closest('.nav-item');
            if (!li) return;
            const href = a.getAttribute('href') || '';
            try {
                const resolved = new URL(href, window.location.href);
                let targetName = resolved.pathname.substring(resolved.pathname.lastIndexOf('/') + 1) || 'index.html';
                if (href === './' || href === '/' || targetName === '') targetName = 'index.html';
                const isActive = targetName === current ||
                    current.endsWith(targetName) ||
                    (resolved.hash && resolved.hash === window.location.hash) ||
                    (a.dataset && a.dataset.nav && window.location.href.includes(a.dataset.nav));
                li.classList.toggle('active', Boolean(isActive));
            } catch (err) {
                const fallbackName = href.split('/').pop();
                li.classList.toggle('active', Boolean(fallbackName && current.endsWith(fallbackName)));
            }
        });
    }

    markActiveNav();
    sidebarEl.addEventListener('click', (ev) => {
        const a = ev.target.closest && ev.target.closest('a[href]');
        if (!a) return;
        setTimeout(markActiveNav, 60);
    });
    window.addEventListener('popstate', markActiveNav);
    window.addEventListener('hashchange', markActiveNav);

    // --- Presence indicator (re-use topSearch .presence-indicator or create if missing) ---
    function ensurePresenceIndicator() {
        if (!topSearch) return null;
        let indicator = topSearch.querySelector('.presence-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'presence-indicator offline';
            indicator.setAttribute('aria-hidden', 'true');
            indicator.setAttribute('title', 'Estado de conexión: offline');
            topSearch.appendChild(indicator);

            const label = document.createElement('span');
            label.className = 'presence-label';
            label.textContent = 'offline';
            topSearch.appendChild(label);
        }
        return topSearch.querySelector('.presence-indicator');
    }

    function updatePresenceIndicator(state) {
        const indicator = ensurePresenceIndicator();
        if (!indicator) return;
        const label = topSearch.querySelector('.presence-label');
        indicator.classList.remove('online', 'offline', 'error');
        if (state === 'online') {
            indicator.classList.add('online');
            indicator.setAttribute('title', 'Conectado (online)');
            if (label) label.textContent = 'Conectado';
        } else if (state === 'offline') {
            indicator.classList.add('offline');
            indicator.setAttribute('title', 'Desconectado (offline)');
            if (label) label.textContent = 'Desconectado';
        } else {
            indicator.classList.add('error');
            indicator.setAttribute('title', 'Estado desconocido');
            if (label) label.textContent = 'Desconocido';
        }
    }

    window.addEventListener('presence:me', (e) => {
        const { state } = e.detail || {};
        updatePresenceIndicator(state);
    });

    // --- Auth state handling ---
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            setSidebar('Invitado', '');
            applyUiRestrictions('');
            setRestrictedNavVisibility('');
            updatePresenceIndicator('offline');
            return;
        }
        try {
            const userRef = fsDoc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);
            let displayName = user.displayName || user.email || 'Usuario';
            let role = '';
            if (userSnap.exists()) {
                const data = userSnap.data();
                displayName = data.name || displayName;
                role = data.role || '';
            }
            setSidebar(displayName, role);
            applyUiRestrictions(role);
            setRestrictedNavVisibility(role);
            ensurePresenceIndicator();
        } catch (err) {
            console.error('Error obtaining user doc for sidebar:', err);
            const displayName = user.displayName || user.email || 'Usuario';
            setSidebar(displayName, '');
            applyUiRestrictions('');
            setRestrictedNavVisibility('');
            ensurePresenceIndicator();
        }
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                if (window.__presence && typeof window.__presence.setUserOfflineImmediately === 'function') {
                    const currentUser = auth.currentUser;
                    if (currentUser && currentUser.uid) {
                        await window.__presence.setUserOfflineImmediately(currentUser.uid);
                    }
                }
                await logout();
            } catch (err) {
                console.error('Error logging out from sidebar:', err);
            }
        });
    } else {
        console.debug('sidebar-user: logout button not found yet');
    }

    // Overlay handling: reuse existing .overlay (created by loader) when possible
    function getOverlayElement() {
        // prefer the global overlay injected by the loader (sibling of nav-toggle)
        let ov = document.querySelector('.overlay');
        if (ov) return ov;
        // fallback: create a lightweight overlay (keeps behavior)
        ov = document.createElement('div');
        ov.className = 'overlay';
        ov.setAttribute('aria-hidden', 'true');
        ov.style.position = 'fixed';
        ov.style.inset = '0';
        ov.style.background = 'rgba(0,0,0,0.24)';
        ov.style.display = 'none';
        ov.style.opacity = '0';
        ov.style.pointerEvents = 'none';
        ov.style.zIndex = '70';
        document.body.appendChild(ov);
        return ov;
    }

    const overlay = getOverlayElement();
    const navToggle = document.getElementById('nav-toggle');
    const hamburgerButtons = Array.from(document.querySelectorAll('.hamburger, .hamburger-box, [data-sidebar-toggle]'));

    // Ensure sidebar z-index is above overlay
    const desiredSidebarZ = 80;
    sidebarEl.style.zIndex = sidebarEl.style.zIndex || String(desiredSidebarZ);
    const sidebarComputed = getComputedStyle(sidebarEl).position;
    if (!sidebarComputed || sidebarComputed === 'static') {
        sidebarEl.style.position = 'relative';
    }

    function positionOverlay() {
        const rect = sidebarEl.getBoundingClientRect();
        if (rect.width >= window.innerWidth - 2) {
            overlay.style.left = '0';
            overlay.style.right = '0';
            overlay.style.zIndex = String(desiredSidebarZ - 10);
        } else {
            overlay.style.left = Math.max(rect.right, 0) + 'px';
            overlay.style.right = '0';
            overlay.style.zIndex = String(desiredSidebarZ - 10);
        }
    }

    function openSidebar() {
        sidebarEl.classList.add('open');
        sidebarEl.setAttribute('aria-hidden', 'false');
        positionOverlay();
        overlay.style.display = '';
        // allow fade-in via CSS transition if present
        requestAnimationFrame(() => { overlay.style.opacity = '1'; overlay.style.pointerEvents = 'auto'; overlay.setAttribute('aria-hidden', 'false'); });
        if (navToggle && !navToggle.checked) navToggle.checked = true;
    }

    function closeSidebar() {
        sidebarEl.classList.remove('open');
        sidebarEl.setAttribute('aria-hidden', 'true');
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        overlay.setAttribute('aria-hidden', 'true');
        if (navToggle && navToggle.checked) navToggle.checked = false;
        // hide after transition
        setTimeout(() => { if (!navToggle || !navToggle.checked) overlay.style.display = 'none'; }, 220);
    }

    // sync checkbox -> sidebar
    if (navToggle) {
        if (navToggle.checked) openSidebar(); else closeSidebar();
        navToggle.addEventListener('change', () => {
            if (navToggle.checked) openSidebar(); else closeSidebar();
        });
    }

    // hamburger fallback for pages without checkbox
    hamburgerButtons.forEach(h => {
        h.addEventListener('click', (e) => {
            if (!navToggle) {
                e.preventDefault();
                if (sidebarEl.classList.contains('open')) closeSidebar(); else openSidebar();
            } // else allow checkbox to handle it
        });
    });

    overlay.addEventListener('click', () => closeSidebar());
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebarEl.classList.contains('open')) {
            closeSidebar();
        }
    });

    // Close menu after clicking a nav link (mobile UX)
    sidebarEl.addEventListener('click', (ev) => {
        const a = ev.target.closest && ev.target.closest('a[href]');
        if (!a) return;
        setTimeout(() => {
            if (window.innerWidth <= 900) {
                closeSidebar();
            }
        }, 80);
    });

    // Recalculate overlay position on resize / orientation change if open
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (sidebarEl.classList.contains('open')) {
                positionOverlay();
            }
        }, 80);
    });

    // RBAC helpers
    function getNavItemByHrefFragment(fragment) {
        const anchor = sidebarEl.querySelector(`.nav-list a[href$="${fragment}"], .nav-list a[href*="/${fragment}"], .nav-list a[href*="${fragment}"]`);
        if (!anchor) return null;
        return anchor.closest('.nav-item') || null;
    }

    function setNavVisibilityByFragment(fragment, visible) {
        const item = getNavItemByHrefFragment(fragment);
        if (!item) return;
        item.style.display = visible ? '' : 'none';
    }

    function setRestrictedNavVisibility(role) {
        // Normalize role to lowercase to be robust against capitalization
        const r = (role || '').toString().toLowerCase();

        const isAdmin = r === 'administrador';
        const isVendedor = r === 'vendedor';
        const isMotorizado = r === 'motorizado';

        // "Cierre de Caja" should be visible ONLY to administrador
        setNavVisibilityByFragment('cierre-caja.html', isAdmin);

        // "Productos" (product.html) visible to administrador and vendedor, hidden for motorizado/guests
        setNavVisibilityByFragment('product.html', isAdmin || isVendedor);

        // "Usuarios" remains admin-only (previous behavior)
        setNavVisibilityByFragment('usuarios.html', isAdmin);
    }

    function setSidebar(name, role) {
        if (nameEl) nameEl.textContent = name || 'Invitado';
        if (metaEl) metaEl.textContent = role ? (role.charAt(0).toUpperCase() + role.slice(1)) : '';
        if (avatarEl) avatarEl.textContent = getInitials(name || role || 'U');
    }

    window.__sidebar = {
        open: openSidebar,
        close: closeSidebar,
        toggle: () => sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar()
    };

    ensurePresenceIndicator();
}

init();