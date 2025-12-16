const SIDEBAR_URL = new URL('../components/sidebar.html', import.meta.url).href;
const SIDEBAR_MODULE = new URL('./sidebar-user.js', import.meta.url).href;
const SIDEBAR_CONTAINER_ID = 'app-sidebar';

async function ensureNavToggleAndOverlay() {
    // Ensure there's a single nav-toggle checkbox and a single overlay sibling after it
    let navToggle = document.getElementById('nav-toggle');
    if (!navToggle) {
        // create hidden checkbox at top of body
        navToggle = document.createElement('input');
        navToggle.id = 'nav-toggle';
        navToggle.type = 'checkbox';
        navToggle.className = 'nav-toggle';
        navToggle.setAttribute('aria-hidden', 'true');
        document.body.insertAdjacentElement('afterbegin', navToggle);
    }

    // Overlay must be a sibling after navToggle to satisfy the CSS selector: .nav-toggle:checked ~ .overlay
    let overlay = document.querySelector('.overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.setAttribute('aria-hidden', 'true');
        // Basic styling fallback (prefer CSS rules). Keep pointer-events none by default.
        overlay.style.display = 'none';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        // Insert overlay immediately after navToggle
        navToggle.insertAdjacentElement('afterend', overlay);
    }

    return { navToggle, overlay };
}

async function loadSidebar() {
    const placeholder = document.getElementById(SIDEBAR_CONTAINER_ID);
    const { navToggle, overlay } = await ensureNavToggleAndOverlay();

    try {
        const res = await fetch(SIDEBAR_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Error ${res.status} al cargar ${SIDEBAR_URL}`);
        const html = await res.text();

        // Avoid inserting duplicate aside.sidebar
        if (!document.querySelector('aside.sidebar')) {
            // Insert sidebar after the overlay (so order: nav-toggle -> .overlay -> aside.sidebar)
            // If placeholder exists, we'll replace it; otherwise insert after overlay
            if (placeholder) {
                placeholder.insertAdjacentHTML('afterend', html);
                placeholder.remove();
            } else {
                overlay.insertAdjacentHTML('afterend', html);
            }
        }

        // Ensure overlay stays as a sibling and is available for CSS and JS
        // Slight delay to allow DOM to settle, then import module that depends on elements
        await import(SIDEBAR_MODULE);

        // sync overlay visibility with nav-toggle (so CSS + JS cooperate)
        function syncOverlay() {
            if (navToggle.checked) {
                overlay.style.display = '';
                overlay.style.opacity = '1';
                overlay.style.pointerEvents = 'auto';
                overlay.setAttribute('aria-hidden', 'false');
            } else {
                overlay.style.opacity = '0';
                overlay.style.pointerEvents = 'none';
                // keep display none after transition to avoid tab-focus behind overlay (small timeout)
                setTimeout(() => { if (!navToggle.checked) overlay.style.display = 'none'; }, 220);
                overlay.setAttribute('aria-hidden', 'true');
            }
        }
        // Initialize
        syncOverlay();
        navToggle.addEventListener('change', syncOverlay);
        // Close sidebar when clicking overlay (works with nav-toggle checkbox)
        overlay.addEventListener('click', () => { navToggle.checked = false; navToggle.dispatchEvent(new Event('change')); });

    } catch (err) {
        console.error('sidebar-loader: fallo cargando sidebar:', err);
    }
}

loadSidebar();