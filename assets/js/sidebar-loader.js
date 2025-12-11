const SIDEBAR_URL = new URL('../components/sidebar.html', import.meta.url).href;
const SIDEBAR_MODULE = new URL('./sidebar-user.js', import.meta.url).href;
const SIDEBAR_CONTAINER_ID = 'app-sidebar';

async function loadSidebar() {
    const placeholder = document.getElementById(SIDEBAR_CONTAINER_ID);
    const navToggle = document.getElementById('nav-toggle');

    try {
        const res = await fetch(SIDEBAR_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Error ${res.status} al cargar ${SIDEBAR_URL}`);
        const html = await res.text();

        // Si existe input#nav-toggle, insertamos el sidebar inmediatamente después
        // para preservar selectores CSS que usan el "checkbox hack" (input ~ aside)
        if (navToggle) {
            // Evitar múltiples insertados: si ya existe aside.sidebar en el DOM no insertar
            if (!document.querySelector('aside.sidebar')) {
                navToggle.insertAdjacentHTML('afterend', html);
                // si había placeholder, eliminarlo
                if (placeholder) placeholder.remove();
            }
        } else if (placeholder) {
            // Fallback: insertar en el placeholder
            placeholder.innerHTML = html;
        } else {
            // último recurso: añadir al body
            if (!document.querySelector('aside.sidebar')) {
                document.body.insertAdjacentHTML('afterbegin', html);
            }
        }

        // Permitir reflow y luego importar el módulo que controla la lógica del sidebar
        await import(SIDEBAR_MODULE);

    } catch (err) {
        console.error('sidebar-loader: fallo cargando sidebar:', err);
    }
}

loadSidebar();
