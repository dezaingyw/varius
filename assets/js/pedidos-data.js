// Archivo JavaScript proporcionado por el usuario
// Mejorado: Geolocalización, edad, teléfono limpio, lat/lng y dirección legible

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getFirestore, collection, getDocs, getDoc, doc, addDoc, serverTimestamp, query, orderBy, where, limit
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

/* ---------------------- Inicializa Firebase ---------------------- */
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

/* ---------------------- Helpers cookies/cart ---------------------- */
function generateCartToken() {
    const rnds = crypto.getRandomValues(new Uint8Array(16));
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;
    const toHex = (b) => b.toString(16).padStart(2, '0');
    const uuid = [...rnds].map(toHex).join('');
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}
function setCookieJSON(name, value, days = 14) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(JSON.stringify(value))}; expires=${expires}; path=/; samesite=strict`;
}
function getCookieJSON(name) {
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const c of cookies) {
        const [k, v] = c.split('=');
        if (decodeURIComponent(k) === name) {
            try { return JSON.parse(decodeURIComponent(v)); } catch (err) { return null; }
        }
    }
    return null;
}

/* ---------------------- Cart structure ---------------------- */
const CART_COOKIE = 'mi_tienda_cart_v1';
let CART = null;
function createEmptyCart() {
    const token = generateCartToken();
    return { cartToken: token, items: [], total: 0, timestamp: new Date().toISOString() };
}
function loadCartFromCookie() {
    const c = getCookieJSON(CART_COOKIE);
    if (!c) { CART = createEmptyCart(); persistCart(); return; }
    if (!c.cartToken || !Array.isArray(c.items)) { CART = createEmptyCart(); persistCart(); return; }
    CART = c;
    recalcCart();
}
function persistCart() { setCookieJSON(CART_COOKIE, CART, 14); renderCartCount(); try { renderCartPanel(); } catch (e) { /* ignore if not ready */ } }
function recalcCart() {
    let total = 0;
    CART.items.forEach(it => { it.subtotal = it.quantity * it.price; total += it.subtotal; });
    CART.total = total;
    CART.timestamp = new Date().toISOString();
}

/* ---------------------- Productos: fetch + normalize ---------------------- */
let PRODUCTS = [];
let PRODUCTS_BY_ID = new Map();
function normalizeProduct(doc) {
    const data = doc.data();
    const price = Number(data.price) || 0;
    const discountPrice = (data.discountPrice !== undefined && data.discountPrice !== null)
        ? Number(data.discountPrice)
        : (data.discount ? Math.max(0, price - Number(data.discount)) : null);
    const isOnSale = !!(data.onOffer || data.isOnSale || data.onoffer || (discountPrice && discountPrice < price));
    const images = Array.isArray(data.imageUrls) && data.imageUrls.length ? data.imageUrls.slice()
        : (data.imageUrl ? [data.imageUrl] : (data.image ? [data.image] : (Array.isArray(data.imagePaths) ? data.imagePaths.slice() : [])));
    return {
        id: doc.id,
        name: data.name || data.title || '',
        price,
        discountPrice: (discountPrice && discountPrice > 0) ? discountPrice : null,
        isOnSale,
        images,
        image: images && images.length ? images[0] : '',
        description: data.description || '',
        category: data.category || '',
        slug: data.slug || '',
        status: data.status || 'Activo',
        stock: (typeof data.stock !== 'undefined') ? Number(data.stock) : null,
        raw: data
    };
}
async function fetchAllProductsFromFirestore() {
    try {
        const col = collection(db, 'product');
        const q = query(col, orderBy('name', 'asc'));
        const snap = await getDocs(q);
        const arr = snap.docs.map(normalizeProduct);
        PRODUCTS = arr;
        PRODUCTS_BY_ID = new Map(arr.map(p => [p.id, p]));
        for (const p of arr) {
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            const nlower = (p.name || '').toLowerCase();
            if (nlower) PRODUCTS_BY_ID.set(nlower, p);
        }
        return arr;
    } catch (err) {
        console.error('Error cargando products desde Firestore:', err);
        throw err;
    }
}
async function fetchProductByIdOrSlug(param) {
    if (PRODUCTS_BY_ID.has(param)) return PRODUCTS_BY_ID.get(param);
    try {
        const docRef = doc(db, 'product', param);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            const p = normalizeProduct(snap);
            PRODUCTS.push(p);
            PRODUCTS_BY_ID.set(p.id, p);
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            PRODUCTS_BY_ID.set((p.name || '').toLowerCase(), p);
            return p;
        }
    } catch (err) { console.error('Error buscando product por id:', err); }
    try {
        const col = collection(db, 'product');
        const q = query(col, where('slug', '==', param), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
            const p = normalizeProduct(snap.docs[0]);
            PRODUCTS.push(p);
            PRODUCTS_BY_ID.set(p.id, p);
            if (p.slug) PRODUCTS_BY_ID.set(p.slug, p);
            PRODUCTS_BY_ID.set((p.name || '').toLowerCase(), p);
            return p;
        }
    } catch (err) { console.error('Error buscando product por slug:', err); }
    return null;
}

/* ---------------------- Storage resolver (caching) ---------------------- */
const _resolvedImageCache = new Map();
async function resolveImagePath(pathOrUrl) {
    if (!pathOrUrl) return null;
    if (_resolvedImageCache.has(pathOrUrl)) return _resolvedImageCache.get(pathOrUrl);
    if (/^https?:\/\//i.test(pathOrUrl)) { _resolvedImageCache.set(pathOrUrl, pathOrUrl); return pathOrUrl; }
    try {
        const ref = storageRef(storage, pathOrUrl);
        const url = await getDownloadURL(ref);
        _resolvedImageCache.set(pathOrUrl, url);
        return url;
    } catch (err) {
        console.warn('No se pudo resolver storage path:', pathOrUrl, err);
        _resolvedImageCache.set(pathOrUrl, null);
        return null;
    }
}
async function resolveProductImages(product) {
    if (!product) return [];
    if (product.__resolvedImages) return product.__resolvedImages;
    const imgs = Array.isArray(product.images) ? product.images : (product.image ? [product.image] : []);
    const promises = imgs.map(p => resolveImagePath(p));
    const urls = (await Promise.all(promises)).filter(Boolean);
    product.__resolvedImages = urls;
    if (!product.image && urls.length) product.image = urls[0];
    return urls;
}

/* ---------------------- Utilidades UI ---------------------- */
// Formateador actualizado: dólares, formato venezolano (coma decimal), siempre mostrar decimales:
// - si el número es entero se muestran 2 decimales (,00)
// - si tiene decimales se respetan (hasta 6 decimales)
function formatCurrency(n) {
    if (n === null || typeof n === 'undefined' || n === '') return '';
    const num = Number(n);
    if (!isFinite(num)) return String(n);

    // Intentamos detectar la cantidad de decimales "reales" del valor original
    let s = (typeof n === 'string') ? n.trim() : String(num);
    let decimals = 0;
    if (s.indexOf('.') >= 0) {
        decimals = s.split('.')[1].length;
    } else {
        if (num !== Math.trunc(num)) {
            const fracStr = String(num).split('.')[1] || '';
            decimals = Math.min(6, fracStr.length || 6);
        } else {
            decimals = 0;
        }
    }

    const fractionDigits = Math.max(2, Math.min(6, decimals));

    try {
        // Usamos Intl para formatear número con configuración de Venezuela (coma decimal),
        // pero no usamos la opción 'currency' directamente para evitar el prefijo "US$" en algunos navegadores.
        const nf = new Intl.NumberFormat('es-VE', {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits
        }).format(num);
        return `$${nf}`;
    } catch (err) {
        const fixed = num.toFixed(fractionDigits);
        return `$${fixed.replace('.', ',')}`;
    }
}

function isProductVisible(p) {
    if (!p || !p.status) return true;
    const s = String(p.status).toLowerCase().trim();
    return !(s === 'suspendido' || s === 'suspended' || s === 'inactivo' || s === 'inactive');
}
const toastEl = document.getElementById('toast');
let toastTimeout = null;
function showToast(msg, ms = 2200) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

/* ----------------------
   Operaciones sobre carrito
   ---------------------- */
function addToCart(productIdOrSlug, qty = 1) {
    const p = PRODUCTS_BY_ID.get(productIdOrSlug);
    if (!p) { showToast('Producto no encontrado. Recarga la página.'); return false; }
    if (!isProductVisible(p)) { showToast('Producto no disponible'); return false; }
    if (typeof p.stock === 'number' && p.stock <= 0) { showToast('Producto sin stock'); return false; }
    const price = (p.discountPrice && Number(p.discountPrice) > 0) ? Number(p.discountPrice) : Number(p.price);
    const existing = CART.items.find(i => i.productId === p.id);
    if (existing) { existing.quantity = Math.min(999, existing.quantity + qty); }
    else {
        CART.items.push({ productId: p.id, name: p.name, price, quantity: Math.max(1, Math.min(999, qty)), subtotal: price * qty, image: (p.image || (p.__resolvedImages && p.__resolvedImages[0]) || '') });
    }
    recalcCart(); persistCart(); showToast('Producto agregado al carrito'); return true;
}
function updateQuantity(productId, qty) {
    const item = CART.items.find(i => i.productId === productId);
    if (!item) return;
    const q = Math.max(0, Math.min(999, Math.floor(qty)));
    if (q === 0) { removeItem(productId); return; }
    item.quantity = q; recalcCart(); persistCart();
}
function removeItem(productId) {
    CART.items = CART.items.filter(i => i.productId !== productId); recalcCart(); persistCart();
}
function clearCart() { CART = createEmptyCart(); persistCart(); showToast('Carrito vaciado'); }

/* ----------------------
   Confirm modal (mejor estilo) - retorna Promise<boolean>
   ---------------------- */
function showConfirm(message = '¿Estás seguro?') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const msg = document.getElementById('confirmMessage');
        const btnAccept = document.getElementById('confirmAccept');
        const btnCancel = document.getElementById('confirmCancel');
        if (!modal || !msg || !btnAccept || !btnCancel) {
            const r = window.confirm(message);
            return resolve(r);
        }
        msg.textContent = message;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        btnAccept.focus();

        function cleanup() {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            btnAccept.removeEventListener('click', onAccept);
            btnCancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
        }
        function onAccept() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(false); } }

        btnAccept.addEventListener('click', onAccept);
        btnCancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

/* ----------------------
   Render carrito inline
   ---------------------- */
let SELECTED_PRODUCT_ID = null;
function renderCartCount() {
    const count = CART.items.reduce((s, i) => s + i.quantity, 0);
    const c1 = document.getElementById('cartCount');
    if (c1) c1.textContent = count;
}

function renderCartPanel() {
    const selectedEl = document.getElementById('selectedProducts');
    const availableEl = document.getElementById('availableProducts');
    const subtotalEl = document.getElementById('cartSubtotalInline');
    const totalEl = document.getElementById('cartTotalInline');
    const checkoutTotalHeader = document.getElementById('checkoutTotalHeader');
    const continueBtn = document.getElementById('continueWithData');
    if (!selectedEl || !availableEl) return;

    const hasItems = CART.items && CART.items.length > 0;
    if (continueBtn) {
        continueBtn.disabled = !hasItems;
        if (!hasItems) continueBtn.setAttribute('aria-disabled', 'true'); else continueBtn.removeAttribute('aria-disabled');
    }

    const items = CART.items.slice().filter(i => i.quantity > 0);
    items.sort((a, b) => {
        if (a.productId === SELECTED_PRODUCT_ID) return -1;
        if (b.productId === SELECTED_PRODUCT_ID) return 1;
        return 0;
    });

    selectedEl.innerHTML = '';
    if (!items.length) {
        selectedEl.innerHTML = '<div style="padding:12px;color:#64748b">No hay artículos seleccionados.</div>';
    } else {
        for (const it of items) {
            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
          <div class="cart-item-product" style="width:100%;text-align:left;">
            <img src="${escapeHtml(it.image || '')}" alt="${escapeHtml(it.name)}" style="display:block;margin:0 0 1rem 0;width:100%;max-width:400px;height:170px;object-fit:contain;border-radius:18px;box-shadow:0 8px 24px #0001;">
            <div style="font-weight:700;font-size:1.1rem;margin-top:0.6rem;text-align:left;">${escapeHtml(it.name)}</div>
            <div style="color:#8c99a6;font-size:1.05rem;margin:4px 0 8px 0;text-align:left;">
              ${formatCurrency(it.price)} x ${it.quantity} = <strong style="color:#222">${formatCurrency(it.subtotal)}</strong>
            </div>
            <div class="qty-controls" style="justify-content:flex-start;gap:0.35rem;margin:0.1rem 0 0 0;">
              <button class="qty-decr" data-id="${it.productId}" aria-label="Disminuir" style="background:#cdb4ff;color:#222;font-weight:700;">−</button>
              <input class="qty-input" data-id="${it.productId}" type="number" min="0" max="999" value="${it.quantity}" style="width:56px;border-radius:10px;padding:8px 0 8px 0;text-align:center;">
              <button class="qty-incr" data-id="${it.productId}" aria-label="Aumentar" style="background:#cdb4ff;color:#222;font-weight:700;">+</button>
              <button class="btn-secondary remove-item" data-id="${it.productId}" style="margin-left:18px;border-radius:9px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor"
                class="bi bi-trash" viewBox="0 0 16 16">
                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                    <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                </svg>
              </button>
              <button class="btn-secondary view-btn" data-id="${it.productId}" style="margin-left:10px;border-radius:9px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor"
                class="bi bi-eye" viewBox="0 0 16 16">
                  <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
                  <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
                </svg>
              </button>
            </div>
          </div>
        `;
            selectedEl.appendChild(div);
        }

        // Eventos controles cantidad
        selectedEl.querySelectorAll('.qty-incr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) return;
                updateQuantity(id, item.quantity + 1);
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.qty-decr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) return;
                updateQuantity(id, Math.max(0, item.quantity - 1));
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.qty-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                let q = parseInt(e.currentTarget.value, 10);
                if (isNaN(q) || q < 0) q = 0;
                updateQuantity(id, q);
                renderCartPanel();
            });
        });
        selectedEl.querySelectorAll('.remove-item').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                const ok = await showConfirm('Eliminar artículo del carrito?');
                if (!ok) return;
                removeItem(id);
                renderCartPanel();
            });
        });
        // Evento para botón de ver (modal)
        selectedEl.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                let p = PRODUCTS_BY_ID.get(id);
                if (!p) p = await fetchProductByIdOrSlug(id);
                if (!p) { showToast('Producto no encontrado'); return; }
                await resolveProductImages(p);
                openProductModal(p);
            });
        });
    }

    const inCartIds = new Set(CART.items.map(i => i.productId));
    const availProducts = PRODUCTS.filter(p => isProductVisible(p) && (typeof p.stock !== 'number' || p.stock > 0) && !inCartIds.has(p.id));
    availableEl.innerHTML = '';
    if (!availProducts.length) {
        availableEl.innerHTML = '<div style="padding:12px;color:#64748b">No hay productos disponibles.</div>';
    } else {
        for (const p of availProducts) {
            const resolved = (p.__resolvedImages && p.__resolvedImages[0]) || p.image || '';
            const div = document.createElement('div');
            div.className = 'avail-item';

            // Construir HTML de precio con estilo claro (antes) y nuevo más grande (descuento)
            let priceHtml = '';
            if (p.discountPrice && Number(p.discountPrice) < Number(p.price)) {
                priceHtml = `
                  <span class="price-old" style="font-size:0.9rem;color:#9aa1ab;text-decoration:line-through;margin-right:6px;">
                    ${formatCurrency(p.price)}
                  </span>
                  <span style="color:#9aa1ab;margin-right:6px;">→</span>
                  <span class="price-new" style="font-size:1.05rem;color:#111;font-weight:700;">
                    ${formatCurrency(p.discountPrice)}
                  </span>
                `;
            } else {
                priceHtml = `<span class="price-new" style="font-size:1.03rem;color:#111;font-weight:700;">${formatCurrency(p.price)}</span>`;
            }

            div.innerHTML = `
              <img src="${escapeHtml(resolved)}" alt="${escapeHtml(p.name)}">
              <div style="flex:1">
                <div style="font-weight:700">${escapeHtml(p.name)}</div>
                <div style="color:#94a3b8">${priceHtml}</div>
                <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                  <div class="qty-controls" style="align-items:center">
                    <button class="qty-decr avail-decr" data-id="${escapeHtml(p.id)}" aria-label="Disminuir">−</button>
                    <input class="avail-qty qty-input" data-id="${escapeHtml(p.id)}" type="number" min="0" max="999" value="0" style="width:70px;padding:6px;border-radius:8px;border:1px solid #e6eef6">
                    <button class="qty-incr avail-incr" data-id="${escapeHtml(p.id)}" aria-label="Aumentar">+</button>
                  </div>
                  <button class="btn-secondary view-btn" data-id="${escapeHtml(p.id)}" style="margin-left:8px">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
                        <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
                        <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
                    </svg>
                  </button>
                </div>
              </div>
            `;
            availableEl.appendChild(div);
        }

        availableEl.querySelectorAll('.avail-qty').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                let q = parseInt(e.currentTarget.value, 10);
                if (isNaN(q) || q < 0) q = 0;
                if (q === 0) { e.currentTarget.value = 0; return; }
                const added = addToCart(id, q);
                if (added) { renderCartPanel(); e.currentTarget.value = 0; }
                else { e.currentTarget.value = 0; }
            });
        });

        availableEl.querySelectorAll('.avail-incr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                addToCart(id, 1);
                renderCartPanel();
            });
        });

        availableEl.querySelectorAll('.avail-decr').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const item = CART.items.find(x => x.productId === id);
                if (!item) { showToast('No hay unidades en el carrito para este producto'); return; }
                updateQuantity(id, Math.max(0, item.quantity - 1));
                renderCartPanel();
            });
        });

        availableEl.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                let p = PRODUCTS_BY_ID.get(id);
                if (!p) p = await fetchProductByIdOrSlug(id);
                if (!p) { showToast('Producto no encontrado'); return; }
                await resolveProductImages(p);
                openProductModal(p);
            });
        });
    }

    const subtotal = CART.total || 0;
    subtotalEl.textContent = formatCurrency(subtotal);
    totalEl.textContent = formatCurrency(subtotal);
    if (checkoutTotalHeader) checkoutTotalHeader.textContent = `Total: ${formatCurrency(subtotal)}`;

    renderCartCount();
}

/* ----------------------
   Product cards + carousel
   ---------------------- */
function createProductCardHtml(p, resolvedImages = []) {
    const isOffer = !!(p.isOnSale || (p.discountPrice && p.discountPrice < p.price));
    let priceHtml = '';
    if (isOffer) {
        priceHtml = `
          <span class="price-old" aria-hidden="true" style="font-size:0.9rem;color:#9aa1ab;text-decoration:line-through;margin-right:6px;">
            ${formatCurrency(p.price)}
          </span>
          <span style="color:#9aa1ab;margin-right:6px;">→</span>
          <span class="price-new" style="font-size:1.05rem;color:#111;font-weight:700;">
            ${formatCurrency(p.discountPrice)}
          </span>
        `;
    } else {
        priceHtml = `<span class="price-new" style="font-size:1.03rem;color:#111;font-weight:700;">${formatCurrency(p.price)}</span>`;
    }
    const sliderHtml = `<div class="card-slider" role="img" aria-label="${escapeHtml(p.name)}">${resolvedImages.length ? resolvedImages.map((u, i) => `<img src="${escapeHtml(u)}" alt="${escapeHtml(p.name)} ${i + 1}" style="opacity:${i === 0 ? 1 : 0}">`).join('') : `<img src="${escapeHtml(p.image || '')}" alt="${escapeHtml(p.name)}">`}</div>`;
    return `
      ${isOffer ? `<div class="offer-badge" aria-hidden="true">Oferta</div>` : ''}
      ${sliderHtml}
      <div class="product-info">
        <div class="product-title">${escapeHtml(p.name)}</div>
        <div class="product-meta">${escapeHtml(p.category || '')}</div>
        <div class="product-price">${priceHtml}</div>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
          <button class="btn-secondary view-btn" data-id="${escapeHtml(p.id)}" style="margin-right:8px" aria-label="Ver producto ${escapeHtml(p.name)}">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
                <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
                <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
            </svg>
          </button>
          <button class="btn-primary add-btn" data-id="${escapeHtml(p.id)}" aria-label="Agregar ${escapeHtml(p.name)}">Agregar</button>
        </div>
      </div>
    `;
}
function initCardSliderDOM(cardEl) {
    const imgs = Array.from(cardEl.querySelectorAll('.card-slider img'));
    if (!imgs.length) return;
    if (imgs.length <= 1) return;
    let idx = 0;
    setInterval(() => {
        const prev = idx;
        idx = (idx + 1) % imgs.length;
        imgs[prev].style.opacity = '0';
        imgs[idx].style.opacity = '1';
    }, 2400);
}
async function renderProductsGrid() {
    const el = document.getElementById('productsGrid');
    if (!el) return;
    el.innerHTML = '';
    const visibleProducts = PRODUCTS.filter(isProductVisible);
    if (!visibleProducts.length) { el.innerHTML = '<div class="spinner">No hay productos para mostrar.</div>'; return; }
    await Promise.all(visibleProducts.map(async (p) => { try { await resolveProductImages(p); } catch (err) { console.warn('Error resolving images for', p.id, err); } }));
    for (const p of visibleProducts) {
        const resolved = p.__resolvedImages && p.__resolvedImages.length ? p.__resolvedImages : (p.image ? [p.image] : []);
        const card = document.createElement('article');
        card.className = 'product-card';
        card.innerHTML = createProductCardHtml(p, resolved);
        el.appendChild(card);
        initCardSliderDOM(card);
    }
    el.querySelectorAll('.add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const p = PRODUCTS_BY_ID.get(id);
            if (!p || !isProductVisible(p)) { showToast('Producto no disponible'); return; }
            addToCart(id, 1);
            renderCartPanel();
        });
    });

    el.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            let p = PRODUCTS_BY_ID.get(id);
            if (!p) p = await fetchProductByIdOrSlug(id);
            if (!p) { showToast('Producto no encontrado'); return; }
            await resolveProductImages(p);
            openProductModal(p);
        });
    });
}

/* Carousel: versión infinito mediante clones de los slides */
async function setupCarousel() {
    const track = document.getElementById('carouselTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prevBtn = document.getElementById('carouselPrev');
    const nextBtn = document.getElementById('carouselNext');
    if (!track) return;

    const slidesData = PRODUCTS.filter(p => isProductVisible(p) && (p.isOnSale || (p.discountPrice && Number(p.discountPrice) < Number(p.price))));
    if (!slidesData.length) { track.innerHTML = '<div style="padding:12px">No hay ofertas disponibles.</div>'; if (indicators) indicators.innerHTML = ''; return; }

    await Promise.all(slidesData.map(p => resolveProductImages(p)));

    // Crear elementos slide originales
    const originalSlideEls = slidesData.map((s) => {
        const imgUrl = (s.__resolvedImages && s.__resolvedImages[0]) || s.image || '';
        const isOffer = !!(s.isOnSale || (s.discountPrice && s.discountPrice < s.price));
        let priceHtml = '';
        if (isOffer) {
            priceHtml = `
              <span class="price-old" style="font-size:0.9rem;color:#9aa1ab;text-decoration:line-through;margin-right:6px;">
                ${formatCurrency(s.price)}
              </span>
              <span style="color:#9aa1ab;margin-right:6px;">→</span>
              <span class="price-new" style="font-size:1.05rem;color:#111;font-weight:700;">
                ${formatCurrency(s.discountPrice)}
              </span>
            `;
        } else {
            priceHtml = `<span class="price-new" style="font-size:1.03rem;color:#111;font-weight:700;">${formatCurrency(s.price)}</span>`;
        }

        const slide = document.createElement('div');
        slide.className = 'carousel-slide';
        slide.dataset.productId = s.id;
        slide.innerHTML = `
          ${isOffer ? `<div class="offer-badge">Oferta</div>` : ''}
          <div class="card-slider" aria-hidden="false">
            <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(s.name)} 1">
            ${(s.__resolvedImages && s.__resolvedImages.length > 1) ? s.__resolvedImages.slice(1).map((u, i) => `<img src="${escapeHtml(u)}" alt="${escapeHtml(s.name)} ${i + 2}" style="opacity:0">`).join('') : ''}
          </div>
          <div class="carousel-info">
            <div class="product-title">${escapeHtml(s.name)}</div>
            <div class="product-meta">${escapeHtml(s.category || '')}</div>
            <div class="product-price">${priceHtml}</div>
            <div class="carousel-controls" style="margin-top:8px;display:flex;gap:8px;align-items:center">
              <button class="btn-primary add-btn" data-id="${escapeHtml(s.id)}" aria-label="Agregar ${escapeHtml(s.name)}">Agregar</button>
              <button class="btn-secondary view-btn" data-id="${escapeHtml(s.id)}" aria-label="Ver ${escapeHtml(s.name)}">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
                    <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/>
                    <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>
                </svg>
              </button>
            </div>
          </div>
        `;
        return slide;
    });

    // Limpiar track y armar clones antes+originales+clones despues
    track.innerHTML = '';
    const total = originalSlideEls.length;
    const clonesBefore = originalSlideEls.map(el => el.cloneNode(true));
    const clonesAfter = originalSlideEls.map(el => el.cloneNode(true));

    // Append: clonesBefore, originals, clonesAfter
    for (const c of clonesBefore) track.appendChild(c);
    for (const s of originalSlideEls) track.appendChild(s);
    for (const c of clonesAfter) track.appendChild(c);

    // indicadores (si aplica)
    if (indicators) {
        indicators.innerHTML = '';
        for (let i = 0; i < total; i++) {
            const ind = document.createElement('button');
            ind.className = 'indicator';
            ind.dataset.index = i;
            ind.addEventListener('click', () => {
                // llevar al slide central + index
                carouselIndex = baseIndex + i;
                update();
            });
            indicators.appendChild(ind);
        }
    }

    // delegación para botones dentro del track (funciona también con clones)
    track.addEventListener('click', (e) => {
        const addBtn = e.target.closest('.add-btn');
        if (addBtn) {
            const id = addBtn.dataset.id;
            addToCart(id, 1);
            renderCartPanel();
            return;
        }
        const viewBtn = e.target.closest('.view-btn');
        if (viewBtn) {
            (async () => {
                const id = viewBtn.dataset.id;
                let p = PRODUCTS_BY_ID.get(id);
                if (!p) p = await fetchProductByIdOrSlug(id);
                if (!p) { showToast('Producto no encontrado'); return; }
                await resolveProductImages(p);
                openProductModal(p);
            })();
            return;
        }
    });

    // Preparar lógica de index y animación: arrancamos en la "tercera" sección central
    const slideElSample = track.querySelector('.carousel-slide');
    if (!slideElSample) return;
    track.style.display = 'flex';
    track.style.willChange = 'transform';
    track.style.transition = 'transform 400ms ease';

    let baseIndex = total; // la "primera" original en el conjunto central
    let carouselIndex = baseIndex; // actual index dentro del track (0..(total*3-1))
    const fullCount = total * 3;

    function getGapPx() {
        const style = getComputedStyle(track);
        return parseFloat(style.gap || 16) || 0;
    }

    function update() {
        // calcular ancho del slide (considerando gap)
        const slideWidth = slideElSample.clientWidth + getGapPx();
        const offset = -carouselIndex * slideWidth;
        track.style.transition = track.style.transition || 'transform 400ms ease';
        track.style.transform = `translateX(${offset}px)`;
        // actualizar indicadores
        if (indicators) {
            const idx = ((carouselIndex - baseIndex) % total + total) % total;
            Array.from(indicators.children).forEach((el, i) => el.classList.toggle('active', i === idx));
        }
    }

    // Después de transicionar, "teletransportar" si estamos en clones
    track.addEventListener('transitionend', () => {
        if (carouselIndex >= total * 2) {
            // saltó al bloque de clones final -> reposicionar al bloque central equivalente
            track.style.transition = 'none';
            carouselIndex = baseIndex + ((carouselIndex - baseIndex) % total);
            update();
            // restaurar transition en el siguiente frame
            requestAnimationFrame(() => { requestAnimationFrame(() => { track.style.transition = 'transform 400ms ease'; }); });
        } else if (carouselIndex < total) {
            // saltó al bloque de clones inicial -> reposicionar al bloque central equivalente
            track.style.transition = 'none';
            carouselIndex = baseIndex + ((carouselIndex - baseIndex + total) % total);
            update();
            requestAnimationFrame(() => { requestAnimationFrame(() => { track.style.transition = 'transform 400ms ease'; }); });
        }
    });

    function prevSlide() { carouselIndex = Math.max(0, carouselIndex - 1); update(); }
    function nextSlide() { carouselIndex = Math.min(fullCount - 1, carouselIndex + 1); update(); }
    function goToSlide(i) { carouselIndex = baseIndex + (i % total); update(); }

    window.goToSlide = goToSlide;
    prevBtn?.addEventListener('click', prevSlide);
    nextBtn?.addEventListener('click', nextSlide);

    // autoplay
    let carouselTimer = null;
    function startAuto() { stopAuto(); carouselTimer = setInterval(() => { nextSlide(); }, 3600); }
    function stopAuto() { if (carouselTimer) clearInterval(carouselTimer); carouselTimer = null; }
    track.parentElement?.addEventListener('mouseenter', stopAuto);
    track.parentElement?.addEventListener('mouseleave', startAuto);

    // touch / pointer drag to swipe
    let startX = 0, deltaX = 0, isDown = false;
    track.addEventListener('pointerdown', (e) => { isDown = true; startX = e.clientX; stopAuto(); });
    window.addEventListener('pointermove', (e) => { if (!isDown) return; deltaX = e.clientX - startX; });
    window.addEventListener('pointerup', () => {
        if (!isDown) return;
        isDown = false;
        if (Math.abs(deltaX) > 40) { if (deltaX < 0) nextSlide(); else prevSlide(); }
        deltaX = 0; startAuto();
    });

    // iniciar en la posición central
    update();
    startAuto();
}

/* ----------------------
   Product modal implementation
   ---------------------- */
let _productModalCurrentIndex = 0;
let _productModalImages = [];
let _productModalCurrentProduct = null;

function openProductModal(product) {
    const modal = document.getElementById('productModal');
    if (!modal) return;
    const title = document.getElementById('productModalTitle');
    const category = document.getElementById('productModalCategory');
    const desc = document.getElementById('productModalDescription');
    const prices = document.getElementById('productModalPrices');
    const thumbs = document.getElementById('productModalThumbs');
    const slider = document.getElementById('productModalSlider');
    const ribbon = document.getElementById('productRibbon');
    const addBtn = document.getElementById('productModalAdd');
    const qtyEl = document.getElementById('productModalQty');
    const viewFull = document.getElementById('productModalViewFull');

    _productModalImages = product.__resolvedImages && product.__resolvedImages.length ? product.__resolvedImages.slice() : (product.image ? [product.image] : []);
    _productModalCurrentIndex = 0;
    _productModalCurrentProduct = product;

    if (title) title.textContent = product.name || '';
    if (category) category.textContent = product.category || '';
    if (desc) desc.textContent = product.description || '';
    if (ribbon) {
        if (product.isOnSale || (product.discountPrice && product.discountPrice < product.price)) {
            ribbon.setAttribute('aria-hidden', 'false');
            ribbon.style.display = '';
        } else {
            ribbon.setAttribute('aria-hidden', 'true');
            ribbon.style.display = 'none';
        }
    }
    if (prices) {
        const isOffer = (product.isOnSale || (product.discountPrice && product.discountPrice < product.price));
        if (isOffer) {
            prices.innerHTML = `
              <span class="price-old" style="font-size:0.95rem;color:#9aa1ab;text-decoration:line-through;margin-right:6px;">
                ${formatCurrency(product.price)}
              </span>
              <span style="color:#9aa1ab;margin-right:6px;">→</span>
              <strong class="price-new" style="font-size:1.05rem;color:#111;font-weight:700;">
                ${formatCurrency(product.discountPrice)}
              </strong>
            `;
        } else {
            prices.innerHTML = `<strong class="price-new" style="font-size:1.03rem;color:#111;font-weight:700;">${formatCurrency(product.price)}</strong>`;
        }
    }

    slider.innerHTML = '';
    thumbs.innerHTML = '';
    _productModalImages.forEach((u, i) => {
        const img = document.createElement('img');
        img.src = u;
        img.alt = `${product.name} ${i + 1}`;
        img.dataset.index = String(i);
        if (i === 0) img.classList.add('active');
        slider.appendChild(img);

        const t = document.createElement('img');
        t.src = u;
        t.alt = `${product.name} thumb ${i + 1}`;
        t.dataset.index = String(i);
        if (i === 0) t.classList.add('active');
        t.addEventListener('click', () => { setProductModalIndex(i); });
        thumbs.appendChild(t);
    });

    addBtn.onclick = () => {
        const q = Math.max(1, Math.min(999, parseInt(qtyEl.value, 10) || 1));
        const added = addToCart(product.id, q);
        if (added) {
            renderCartPanel();
            showToast('Producto agregado');
            closeProductModal();
        }
    };

    viewFull.style.display = 'none';
    viewFull.onclick = () => { window.location.href = `product.html?product=${encodeURIComponent(product.id)}`; };

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    document.getElementById('productModalPrev')?.addEventListener('click', productModalPrev);
    document.getElementById('productModalNext')?.addEventListener('click', productModalNext);

    document.getElementById('productModalClose')?.addEventListener('click', closeProductModal);
    modal.addEventListener('click', onProductModalOutsideClick);
    document.addEventListener('keydown', onProductModalKeydown);

    const firstFocusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) firstFocusable.focus();
}

function setProductModalIndex(i) {
    _productModalCurrentIndex = Math.max(0, Math.min(_productModalImages.length - 1, i));
    const slider = document.getElementById('productModalSlider');
    const thumbs = document.getElementById('productModalThumbs');
    if (!slider) return;
    Array.from(slider.querySelectorAll('img')).forEach(img => img.classList.remove('active'));
    Array.from(thumbs.querySelectorAll('img')).forEach(img => img.classList.remove('active'));
    slider.querySelector(`img[data-index="${_productModalCurrentIndex}"]`)?.classList.add('active');
    thumbs.querySelector(`img[data-index="${_productModalCurrentIndex}"]`)?.classList.add('active');
}

function productModalPrev() { setProductModalIndex(_productModalCurrentIndex - 1); }
function productModalNext() { setProductModalIndex(_productModalCurrentIndex + 1); }

function closeProductModal() {
    const modal = document.getElementById('productModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.getElementById('productModalPrev')?.removeEventListener('click', productModalPrev);
    document.getElementById('productModalNext')?.removeEventListener('click', productModalNext);
    modal.removeEventListener('click', onProductModalOutsideClick);
    document.removeEventListener('keydown', onProductModalKeydown);
}

function onProductModalOutsideClick(e) {
    const modal = document.getElementById('productModal');
    if (!modal) return;
    if (e.target === modal) closeProductModal();
}
function onProductModalKeydown(e) {
    if (e.key === 'Escape') closeProductModal();
    if (e.key === 'ArrowLeft') productModalPrev();
    if (e.key === 'ArrowRight') productModalNext();
}

/* ----------------------
   URL-handling
   ---------------------- */
async function handleUrlAddParams() {
    const params = new URLSearchParams(window.location.search);
    const addParam = params.get('add');
    const openCart = params.get('openCart');
    const hideProducts = params.get('hideProducts');
    if (!addParam && !hideProducts && !openCart) return;

    const waitFor = (selector, timeout = 2000) => new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const obs = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) { obs.disconnect(); resolve(found); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(document.querySelector(selector)); }, timeout);
    });

    let added = false;
    if (addParam) {
        if (!PRODUCTS_BY_ID.size) {
            try {
                const p = await fetchProductByIdOrSlug(addParam);
                if (p && isProductVisible(p)) { added = addToCart(p.id, 1); if (added) SELECTED_PRODUCT_ID = p.id; }
            } catch (e) { console.warn('Error fetchProductByIdOrSlug', e); }
        } else {
            added = addToCart(addParam, 1);
            if (!added) {
                try {
                    const p = await fetchProductByIdOrSlug(addParam);
                    if (p && isProductVisible(p)) { added = addToCart(p.id, 1); if (added) SELECTED_PRODUCT_ID = p.id; }
                } catch (e) { }
            } else SELECTED_PRODUCT_ID = addParam;
        }
        if (!added) showToast('No se pudo agregar el producto desde el enlace.');
    }

    const gridEl = await waitFor('#productsGrid', 2000);
    const carouselEl = document.getElementById('carousel');
    if (hideProducts) {
        document.documentElement.classList.add('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = 'none';
        if (carouselEl) { const carSection = carouselEl.closest('.carousel') || carouselEl.parentElement; if (carSection) carSection.style.display = ''; }
    } else {
        document.documentElement.classList.remove('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = '';
    }

    if (openCart) {
        setTimeout(() => { renderCartPanel(); const cp = document.getElementById('cartPanel'); if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 160);
    }
}

/* ----------------------
   Prevención de double-submit y confirm duplicados
   ---------------------- */
const GOOGLE_API_KEY = "AIzaSyCHl0E0UvFmyLJooH2e1tHZLr7DDt7C3WA"; // tu verdadera KEY

function geoError(msg) {
    const geoErr = document.getElementById('geo_error');
    if (geoErr) { geoErr.textContent = msg; geoErr.style.display = 'block'; }
}
function geoClearError() {
    const geoErr = document.getElementById('geo_error');
    if (geoErr) { geoErr.textContent = ''; geoErr.style.display = 'none'; }
}
function hideGeoButton() {
    const geoBtn = document.getElementById('btnGeoLocation');
    if (geoBtn) geoBtn.style.display = 'none';
}

function showGeoButton() {
    const geoBtn = document.getElementById('btnGeoLocation');
    if (geoBtn) geoBtn.style.display = '';
}
function geoSetFields(address, lat, lng) {
    const addr = document.getElementById('cust_address');
    const latf = document.getElementById('cust_lat');
    const lngf = document.getElementById('cust_lng');
    if (addr) {
        addr.value = address;
        // No disables! addr.disabled = true; 
        // Dispatch input event for validation:
        addr.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (latf) latf.value = lat || '';
    if (lngf) lngf.value = lng || '';
    geoClearError();
    hideGeoButton();
}
function geoEnableManual() {
    const addr = document.getElementById('cust_address');
    if (addr) { addr.disabled = false; addr.focus(); }
    geoClearError();
}

function setupGeolocationButton() {
    const geoBtn = document.getElementById('btnGeoLocation');
    if (!geoBtn) return;
    geoBtn.addEventListener('click', async () => {
        if (!navigator.geolocation) {
            geoError('Tu navegador no soporta geolocalización');
            return;
        }
        geoBtn.textContent = '⌛ Ubicando...';
        geoBtn.disabled = true;
        try {
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
            });
            const { latitude, longitude } = position.coords;
            const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_API_KEY}&language=es`;
            const resp = await fetch(url);
            const data = await resp.json();
            if (data.status === "OK" && data.results[0]) {
                geoSetFields(data.results[0].formatted_address, latitude, longitude);
                // Oculta el botón de ubicación
                hideGeoButton();
            } else {
                geoError('No se pudo traducir tu ubicación a dirección.');
            }
        } catch (e) {
            geoError('No se pudo obtener ubicación. Puedes ingresar la dirección manualmente.');
        }
        geoBtn.textContent = '📍 Ubicación';
        geoBtn.disabled = false;
    });
}
window.addEventListener('DOMContentLoaded', setupGeolocationButton);

/* ---------------------- Form validation (tiempo real) ---------------------- */
function validateName() {
    const el = document.getElementById('cust_name');
    const err = document.getElementById('cust_name_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = 'El nombre es obligatorio.'; return false; }
    if (v.length < 2) { if (err) err.textContent = 'Nombre demasiado corto.'; return false; }
    if (err) err.textContent = '';
    return true;
}
function validateEmail() {
    const el = document.getElementById('cust_email');
    const err = document.getElementById('cust_email_err');
    if (!el) return true; // opcional
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = ''; return true; }
    const re = /^\S+@\S+\.\S+$/;
    if (!re.test(v)) { if (err) err.textContent = 'Formato de correo inválido (ejemplo@ejemplo.com).'; return false; }
    if (err) err.textContent = '';
    return true;
}
function validateAge() {
    const el = document.getElementById('cust_age');
    const err = document.getElementById('cust_age_err');
    if (!el) return true;
    const v = el.value.trim();
    if (v && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 120)) {
        if (err) err.textContent = 'Edad inválida.';
        return false;
    }
    if (err) err.textContent = '';
    return true;
}
function validatePhone() {
    const el = document.getElementById('cust_phone');
    const err = document.getElementById('cust_phone_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) {
        if (err) err.textContent = 'El teléfono es obligatorio.';
        return false;
    }
    // Solo dígitos, sin +, sin espacios, 8 a 15 dígitos
    if (!/^\d{8,15}$/.test(v.replace(/\s/g, ""))) {
        if (err) err.textContent = 'Número inválido. Ejemplo: "04121234567".';
        return false;
    }
    if (err) err.textContent = '';
    return true;
}
function validateAddress() {
    const el = document.getElementById('cust_address');
    const err = document.getElementById('cust_address_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) { if (err) err.textContent = 'La dirección es obligatoria.'; return false; }
    if (v.length < 6) { if (err) err.textContent = 'Describe la dirección con más detalle.'; return false; }
    if (err) err.textContent = '';
    return true;
}
const addressInput = document.getElementById('cust_address');
if (addressInput) {
    addressInput.addEventListener('input', function () {
        if (!addressInput.value.trim()) {
            showGeoButton();
        }
        // Validar de nuevo para que reaccione el botón de confirmar pedido
        validateFormAll();
    });
}
function validateFormAll() {
    const ok = validateName() && validatePhone() && validateAddress() && validateEmail() && validateAge();
    const submitBtn = document.getElementById('checkoutSubmitBtn');
    if (submitBtn) submitBtn.disabled = !ok;
    return ok;
}

/* ---------------------- Submit handler ---------------------- */
function submitHandler(e) {
    e.preventDefault();
    const name = document.getElementById('cust_name').value.trim();
    const email = document.getElementById('cust_email').value.trim();
    const phoneRaw = document.getElementById('cust_phone').value.trim();
    const age = document.getElementById('cust_age')?.value.trim() || "";
    const address = document.getElementById('cust_address').value.trim();
    const lat = document.getElementById('cust_lat')?.value || "";
    const lng = document.getElementById('cust_lng')?.value || "";
    const msg = document.getElementById('checkoutMsg');
    if (!validateFormAll()) {
        if (msg) { msg.textContent = 'Corrige los campos indicados antes de enviar.'; msg.style.color = '#ef4444'; }
        return;
    }
    // No se añade + ni nada. Solo el número puro.
    submitOrder({ name, email, phone: phoneRaw, age, address, lat, lng });
}

/* ---------------------- Enviar order a Firebase con DATOS NUEVOS ---------------------- */
let IS_SUBMITTING = false;
let ORDER_CONFIRM_SHOWN = false;
function hideAllOrderConfirmations() {
    const inline = document.getElementById('orderConfirmInline');
    if (inline) inline.classList.add('hidden');
    const oldModal = document.getElementById('orderConfirmModal');
    if (oldModal) oldModal.classList.add('hidden');
    document.querySelectorAll('.order-confirm').forEach(n => n.classList.add('hidden'));
    ORDER_CONFIRM_SHOWN = false;
}
function openConfirmInline(msg) {
    hideAllOrderConfirmations();
    const modal = document.getElementById('orderConfirmInline');
    if (!modal) return;
    const txt = document.getElementById('orderConfirmText');
    if (txt) txt.textContent = msg || 'Su pedido será atendido pronto. Gracias por comprar con nosotros.';
    modal.classList.remove('hidden');
    modal.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ORDER_CONFIRM_SHOWN = true;

    // Solución: cerrar modal pedido enviado con el botón
    document.getElementById('closeConfirm')?.addEventListener('click', function () {
        document.getElementById('orderConfirmInline').classList.add('hidden');
    });
}



async function submitOrder(customerData) {
    if (!CART.items.length) { showToast('El carrito está vacío'); return; }
    if (IS_SUBMITTING) { console.warn('Intento de envío duplicado bloqueado'); return; }
    IS_SUBMITTING = true;
    const checkoutForm = document.getElementById('checkoutForm');
    const submitBtn = document.getElementById('checkoutSubmitBtn') || (checkoutForm ? checkoutForm.querySelector('button[type="submit"]') : null);
    if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('aria-disabled', 'true'); }
    const msgEl = document.getElementById('checkoutMsg');
    if (msgEl) { msgEl.textContent = 'Enviando pedido…'; msgEl.style.color = '#64748b'; }
    const orderData = {
        cartToken: CART.cartToken,
        customerData: {
            Customname: customerData.name,
            email: customerData.email,
            phone: customerData.phone || "",
            address: customerData.address,
            age: customerData.age || "",
            lat: customerData.lat || "",
            lng: customerData.lng || "",
            readable_address: customerData.address
        },
        items: CART.items.map(i => ({ productId: i.productId, name: i.name, price: i.price, quantity: i.quantity, subtotal: i.subtotal })),
        total: CART.total,
        status: "pendiente",
        timestamp: serverTimestamp(),
        orderDate: new Date().toISOString()
    };
    try {
        const ordersCol = collection(db, 'orders');
        const docRef = await addDoc(ordersCol, orderData);

        hideAllOrderConfirmations();
        openConfirmInline('Su pedido será atendido pronto. Número: ' + docRef.id);

        clearCart();
        document.getElementById('checkoutPanel')?.classList.add('hidden');
        document.getElementById('cartPanel')?.classList.remove('minimized');
        renderCartPanel();
    } catch (err) {
        console.error('Error guardando pedido:', err);
        if (msgEl) { msgEl.textContent = 'Error al enviar pedido. Intente nuevamente.'; msgEl.style.color = '#ef4444'; }
        showToast('Error guardando pedido en servidor');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.removeAttribute('aria-disabled'); }
        IS_SUBMITTING = false;
    }
}

/* ---------------------- Global events & interactions ---------------------- */
// ... permanece igual, pero después de attachGlobalEvents agrega geo y focus ...
function attachGlobalEvents() {
    // ... igual ...
    const nameEl = document.getElementById('cust_name');
    const emailEl = document.getElementById('cust_email');
    const phoneEl = document.getElementById('cust_phone');
    const addrEl = document.getElementById('cust_address');
    const ageEl = document.getElementById('cust_age');

    if (nameEl) { nameEl.addEventListener('input', () => { validateName(); validateFormAll(); }); nameEl.addEventListener('blur', validateName); }
    if (emailEl) { emailEl.addEventListener('input', () => { validateEmail(); validateFormAll(); }); emailEl.addEventListener('blur', validateEmail); }
    if (phoneEl) {
        // sanitizar: solo dígitos en tiempo real
        phoneEl.addEventListener('input', (e) => {
            const v = e.currentTarget.value;
            const cleaned = v.replace(/\D+/g, '');
            if (cleaned !== v) e.currentTarget.value = cleaned;
            validatePhone();
            validateFormAll();
        });
        phoneEl.addEventListener('blur', validatePhone);
    }
    if (addrEl) { addrEl.addEventListener('input', () => { validateAddress(); validateFormAll(); }); addrEl.addEventListener('blur', validateAddress); }
    if (ageEl) {
        // sanitizar edad: solo dígitos y máximo 3 caracteres
        ageEl.addEventListener('input', (e) => {
            const v = e.currentTarget.value;
            const cleaned = v.replace(/\D+/g, '').slice(0, 3);
            if (cleaned !== v) e.currentTarget.value = cleaned;
            validateAge();
            validateFormAll();
        });
        ageEl.addEventListener('blur', validateAge);
    }

    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
        try { checkoutForm.removeEventListener('submit', submitHandler); } catch (e) { }
        checkoutForm.addEventListener('submit', submitHandler);
    }
    // ...
}

/* ---------------------- Bootstrapping ---------------------- */
async function boot() {
    loadCartFromCookie();
    attachGlobalEvents();
    setupGeolocationButton(); // <-- INICIA Botón de ubicación
    renderCartCount();
    try {
        await fetchAllProductsFromFirestore();
        if (document.getElementById('productsGrid')) {
            const spinner = document.getElementById('productsSpinner'); spinner?.remove();
            renderProductsGrid();
            setupCarousel();
        }
        if (document.getElementById('productArea')) await renderProductPage();
        await Promise.all(PRODUCTS.map(p => resolveProductImages(p)));
        await handleUrlAddParams();
        renderCartPanel();
        validateFormAll();
    } catch (err) {
        const productsGrid = document.getElementById('productsGrid');
        if (productsGrid) { productsGrid.innerHTML = `<div style="padding:16px;color:#ef4444">No se pudieron cargar los productos. Revisa la conexión o la colección "product" en Firestore.</div>`; }
        showToast('Error cargando productos (ver consola).', 4000);
    }
}

window.addEventListener('load', boot);
export { };
// FIN