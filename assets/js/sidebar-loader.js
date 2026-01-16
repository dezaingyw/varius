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

function injectSidebarCollapseStyles() {
    // Inject CSS that allows collapsing the sidebar on desktop by toggling the class `sidebar-collapsed`
    // We inject rules so you don't have to edit app.css directly.
    if (document.getElementById('sidebar-collapse-styles')) return;
    const css = `
/* Desktop collapse: when html.sidebar-collapsed is present hide sidebar and expand main */
html.sidebar-collapsed .sidebar {
  transform: translateX(-108%);
  box-shadow: none;
  /* keep same transition defined in app.css */
}

/* Move main content to full width */
html.sidebar-collapsed .main {
  margin-left: 0 !important;
}

/* If there's an explicit overlay element, keep it hidden on desktop collapse */
html.sidebar-collapsed .overlay {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

/* Keep mobile behaviour intact (mobile uses .nav-toggle:checked ~ .sidebar / overlay).
   On small screens the overlay logic from the loader remains in effect. */
@media (max-width: 900px) {
  /* don't override mobile rules here */
}
`;
    const s = document.createElement('style');
    s.id = 'sidebar-collapse-styles';
    s.textContent = css;
    document.head.appendChild(s);
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

        // Inject collapse styles (so desktop toggle works without changing app.css)
        injectSidebarCollapseStyles();

        // Helper to sync a class on the root element so we can control layout on desktop
        function syncBodyCollapsed() {
            // If checked -> collapse; if not checked -> show
            const root = document.documentElement;
            if (navToggle.checked) root.classList.add('sidebar-collapsed');
            else root.classList.remove('sidebar-collapsed');
        }
        // initialize collapsed state
        syncBodyCollapsed();

        // Ensure overlay and body-class are kept in sync when the checkbox changes.
        navToggle.addEventListener('change', () => {
            syncOverlay();
            syncBodyCollapsed();
        });

        // Close sidebar when clicking overlay (works with nav-toggle checkbox)
        overlay.addEventListener('click', () => { navToggle.checked = false; navToggle.dispatchEvent(new Event('change')); });

        // Keep behaviour consistent on resize: if the viewport becomes small, remove the html.sidebar-collapsed
        // so mobile rules take over. If it becomes large, keep whatever state checkbox is in.
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // On very small screens, ensure collapsed class is removed (mobile overlay will be used)
                if (window.innerWidth <= 900) {
                    document.documentElement.classList.remove('sidebar-collapsed');
                } else {
                    // on larger screens, respect the checkbox state
                    syncBodyCollapsed();
                }
                // allow overlay positioning code in sidebar-user to update if open
                const ev = new Event('resize');
                window.dispatchEvent(ev);
            }, 120);
        });

    } catch (err) {
        console.error('sidebar-loader: fallo cargando sidebar:', err);
    }
}

loadSidebar();