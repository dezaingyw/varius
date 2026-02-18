// Archivo actualizado: Elimina todo lo relacionado con productsGrid y con el listado de productos en ofertas del carrito.

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

function toTitleCase(str) {
    if (!str) return '';
    return String(str).trim().split(/\s+/).map(word => {
        return word.split(/([-'])/).map(seg => {
            if (seg === '-' || seg === "'") return seg;
            return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
        }).join('');
    }).join(' ');
}

function normalizeProduct(doc) {
    const data = doc.data();
    const price = Number(data.price) || 0;
    let discountPrice = null;
    if (data.discountPrice !== undefined && data.discountPrice !== null && data.discountPrice !== '') {
        const dp = Number(data.discountPrice);
        if (isFinite(dp)) discountPrice = dp;
    } else if (data.discount !== undefined && data.discount !== null && data.discount !== '') {
        const d = Number(data.discount);
        if (isFinite(d)) {
            if (d > 0 && d <= 1) {
                discountPrice = Math.max(0, price * (1 - d));
            } else if (d > 1 && d <= 100) {
                discountPrice = Math.max(0, price * (1 - d / 100));
            } else {
                discountPrice = Math.max(0, price - d);
            }
        }
    }
    if (discountPrice !== null) {
        discountPrice = Number(discountPrice);
        if (!isFinite(discountPrice) || discountPrice <= 0 || discountPrice >= price) {
            discountPrice = null;
        }
    }
    const isOnSale = !!(data.onOffer || data.isOnSale || data.onoffer || (discountPrice && discountPrice < price));
    const images = Array.isArray(data.imageUrls) && data.imageUrls.length ? data.imageUrls.slice()
        : (data.imageUrl ? [data.imageUrl] : (data.image ? [data.image] : (Array.isArray(data.imagePaths) ? data.imagePaths.slice() : [])));
    const rawName = data.name || data.title || '';
    const name = toTitleCase(rawName);

    return {
        id: doc.id,
        name,
        price,
        discountPrice: (discountPrice && Number(discountPrice) > 0) ? discountPrice : null,
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
function formatCurrency(n) {
    if (n === null || typeof n === 'undefined' || n === '') return '';
    const num = Number(n);
    if (!isFinite(num)) return String(n);
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
    if (s === 'suspendido' || s === 'suspended' || s === 'inactivo' || s === 'inactive') return false;
    if (typeof p.stock === 'number' && p.stock <= 0) return false;
    return true;
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

/* ---------------------- Operaciones sobre carrito ---------------------- */
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
function getCartQuantity(productId) {
    const it = CART.items.find(i => i.productId === productId);
    return it ? it.quantity : 0;
}

/* ---------------------- Confirm modal ---------------------- */
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

/* ---------------------- Render carrito inline ---------------------- */
let SELECTED_PRODUCT_ID = null;
function renderCartCount() {
    const count = CART.items.reduce((s, i) => s + i.quantity, 0);
    const c1 = document.getElementById('cartCount');
    if (c1) c1.textContent = count;
}

function renderCartPanel() {
    const selectedEl = document.getElementById('selectedProducts');
    const subtotalEl = document.getElementById('cartSubtotalInline');
    const totalEl = document.getElementById('cartTotalInline');
    const checkoutTotalHeader = document.getElementById('checkoutTotalHeader');
    const continueBtn = document.getElementById('continueWithData');
    if (!selectedEl) return;

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
            const p = PRODUCTS_BY_ID.get(it.productId);
            const isOffer = !!(p && (p.isOnSale || (p.discountPrice && p.discountPrice < p.price)));
            const badgeHtml = isOffer ? `<div class="offer-badge-small" aria-hidden="true">🎁 Oferta</div>` : '';

            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
              <div class="cart-item-product" style="width:100%;text-align:left;">
                <img src="${escapeHtml(it.image || '')}" alt="${escapeHtml(it.name)}" style="display:block;margin:0 0 1rem 0;width:100%;max-width:400px;height:170px;object-fit:contain;border-radius:18px;box-shadow:0 8px 24px #0001;">
                <div class="product-title-row">
                  <div class="left">
                    <div style="font-weight:700;font-size:1.1rem;margin-top:0.6rem;text-align:left;">${escapeHtml(it.name)}</div>
                    ${badgeHtml}
                  </div>
                  <div style="color:#8c99a6;font-size:1.05rem;margin-left:12px;text-align:right;">
                    ${formatCurrency(it.price)} x ${it.quantity} = <strong style="color:#222">${formatCurrency(it.subtotal)}</strong>
                  </div>
                </div>

                <div class="qty-controls" style="justify-content:flex-start;gap:0.35rem;margin:0.6rem 0 0 0;">
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

    const subtotal = CART.total || 0;
    subtotalEl.textContent = formatCurrency(subtotal);
    totalEl.textContent = formatCurrency(subtotal);
    if (checkoutTotalHeader) checkoutTotalHeader.textContent = `Total: ${formatCurrency(subtotal)}`;

    renderCartCount();
}

/* ---------------------- Carousel: desactivado (no eliminar para mantener compatibilidad) ---------------------- */
async function setupCarousel() {
    const carousel = document.getElementById('carousel');
    if (carousel && carousel.parentElement) {
        carousel.parentElement.removeChild(carousel);
    }
    return;
}

/* ---------------------- Product modal ---------------------- */
/* (misma implementación que antes, no se modifica aquí) */
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

    try {
        if (qtyEl) {
            let wrapper = qtyEl.closest('.modal-qty-wrapper');
            let minusBtn = null;
            let plusBtn = null;

            if (!wrapper) {
                wrapper = document.createElement('div');
                wrapper.className = 'modal-qty-wrapper';
                wrapper.style.display = 'inline-flex';
                wrapper.style.alignItems = 'center';
                wrapper.style.gap = '8px';

                minusBtn = document.createElement('button');
                minusBtn.type = 'button';
                minusBtn.className = 'modal-qty-decr';
                minusBtn.setAttribute('aria-label', 'Disminuir cantidad');
                minusBtn.textContent = '−';
                minusBtn.style.padding = '8px 12px';
                minusBtn.style.borderRadius = '10px';
                minusBtn.style.background = '#e9d5ff';
                minusBtn.style.border = 'none';
                minusBtn.style.cursor = 'pointer';

                plusBtn = document.createElement('button');
                plusBtn.type = 'button';
                plusBtn.className = 'modal-qty-incr';
                plusBtn.setAttribute('aria-label', 'Aumentar cantidad');
                plusBtn.textContent = '+';
                plusBtn.style.padding = '8px 12px';
                plusBtn.style.borderRadius = '10px';
                plusBtn.style.background = '#c8f7ee';
                plusBtn.style.border = 'none';
                plusBtn.style.cursor = 'pointer';

                const parent = qtyEl.parentElement;
                const next = qtyEl.nextSibling;
                parent.insertBefore(wrapper, next);
                wrapper.appendChild(minusBtn);
                wrapper.appendChild(qtyEl);
                wrapper.appendChild(plusBtn);
            } else {
                minusBtn = wrapper.querySelector('.modal-qty-decr');
                plusBtn = wrapper.querySelector('.modal-qty-incr');
            }

            wrapper.dataset.productId = product.id;

            qtyEl.type = 'number';
            qtyEl.min = '0';
            qtyEl.max = '999';
            qtyEl.style.width = '70px';
            qtyEl.style.padding = '8px';
            qtyEl.style.borderRadius = '8px';
            qtyEl.style.textAlign = 'center';

            qtyEl.value = String(getCartQuantity(product.id) || 0);

            if (addBtn) addBtn.style.display = 'none';

            if (minusBtn && !minusBtn.dataset.listener) {
                minusBtn.addEventListener('click', (ev) => {
                    const w = ev.currentTarget.closest('.modal-qty-wrapper');
                    const pid = w?.dataset?.productId || _productModalCurrentProduct?.id;
                    if (!pid) return;
                    const current = getCartQuantity(pid);
                    if (!current || current <= 0) {
                        showToast('No hay unidades en el carrito para este producto');
                        qtyEl.value = '0';
                        return;
                    }
                    updateQuantity(pid, Math.max(0, current - 1));
                    renderCartPanel();
                    qtyEl.value = String(getCartQuantity(pid));
                });
                minusBtn.dataset.listener = '1';
            }

            if (plusBtn && !plusBtn.dataset.listener) {
                plusBtn.addEventListener('click', (ev) => {
                    const w = ev.currentTarget.closest('.modal-qty-wrapper');
                    const pid = w?.dataset?.productId || _productModalCurrentProduct?.id;
                    if (!pid) return;
                    addToCart(pid, 1);
                    renderCartPanel();
                    qtyEl.value = String(getCartQuantity(pid));
                });
                plusBtn.dataset.listener = '1';
            }

            if (!qtyEl.dataset.listener) {
                qtyEl.addEventListener('change', (ev) => {
                    const w = ev.currentTarget.closest('.modal-qty-wrapper');
                    const pid = w?.dataset?.productId || _productModalCurrentProduct?.id;
                    if (!pid) return;
                    let q = parseInt(ev.currentTarget.value, 10);
                    if (isNaN(q) || q < 0) q = 0;
                    const existing = getCartQuantity(pid);
                    if (q === 0) {
                        removeItem(pid);
                    } else {
                        if (existing === 0) {
                            addToCart(pid, q);
                        } else {
                            updateQuantity(pid, q);
                        }
                    }
                    renderCartPanel();
                    qtyEl.value = String(getCartQuantity(pid));
                });
                qtyEl.dataset.listener = '1';
            }
        }
    } catch (err) {
        console.warn('Error al init controles de cantidad del modal', err);
    }

    if (addBtn) {
        addBtn.onclick = () => {
            const q = Math.max(1, Math.min(999, parseInt(qtyEl.value, 10) || 1));
            const added = addToCart(product.id, q);
            if (added) {
                renderCartPanel();
                showToast('Producto agregado');
                closeProductModal();
            }
        };
    }

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
    if (hideProducts) {
        document.documentElement.classList.add('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = 'none';
    } else {
        document.documentElement.classList.remove('hide-products-mode');
        const pg = document.getElementById('productsGrid'); if (pg) pg.style.display = '';
    }

    if (openCart) {
        setTimeout(() => { renderCartPanel(); const cp = document.getElementById('cartPanel'); if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 160);
    }
}

const GOOGLE_API_KEY = "AIzaSyCHl0E0UvFmyLJooH2e1tHZLr7DDt7C3WA";

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

const VENEZUELA_OPERATORS = [
    { value: '0414', label: '0414' },
    { value: '0424', label: '0424' },
    { value: '0412', label: '0412' },
    { value: '0422', label: '0422' },
    { value: '0416', label: '0416' },
    { value: '0426', label: '0426' }
];
const COMMON_EMAIL_DOMAINS = [
    'gmail.com',
    'hotmail.com',
    'yahoo.com',
    'outlook.com',
    'live.com'
];

function transformContactFields() {
    const phoneInput = document.getElementById('cust_phone');
    if (phoneInput && !document.getElementById('cust_operator')) {
        const select = document.createElement('select');
        select.id = 'cust_operator';
        select.name = 'operator';
        select.style.width = '92px';
        select.style.padding = '8px';
        select.style.borderRadius = '8px';
        select.style.marginRight = '8px';
        select.setAttribute('aria-label', 'Operadora');
        VENEZUELA_OPERATORS.forEach(op => {
            const opt = document.createElement('option');
            opt.value = op.value;
            opt.textContent = op.label;
            select.appendChild(opt);
        });
        phoneInput.parentElement.insertBefore(select, phoneInput);
    }

    const emailInput = document.getElementById('cust_email');
    if (emailInput && !document.getElementById('cust_email_domain')) {
        const select = document.createElement('select');
        select.id = 'cust_email_domain';
        select.name = 'email_domain';
        select.style.width = '140px';
        select.style.padding = '8px';
        select.style.borderRadius = '8px';
        select.style.marginLeft = '8px';
        select.setAttribute('aria-label', 'Extensión de correo');
        COMMON_EMAIL_DOMAINS.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            select.appendChild(opt);
        });
        emailInput.parentElement.insertBefore(select, emailInput.nextSibling);
    }
}

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
    const domain = document.getElementById('cust_email_domain');
    const err = document.getElementById('cust_email_err');
    if (!el) return true;
    const user = el.value.trim();
    if (!user) { if (err) err.textContent = ''; return true; }
    if (!/^[A-Za-z0-9._-]+$/.test(user)) {
        if (err) err.textContent = 'Caracteres inválidos en usuario. Solo letras, números, ., - y _';
        return false;
    }
    if (!domain || !domain.value) {
        if (err) err.textContent = 'Selecciona una extensión de correo.'; return false;
    }
    const email = `${user}@${domain.value}`;
    const re = /^\S+@\S+\.\S+$/;
    if (!re.test(email)) {
        if (err) err.textContent = 'Correo inválido.'; return false;
    }
    if (err) err.textContent = '';
    return true;
}
function validateAge() {
    const el = document.getElementById('cust_age');
    const err = document.getElementById('cust_age_err');
    if (!el) return true;
    const v = el.value.trim();
    if (v && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 120)) {
        if (err) err.textContent = 'Edad inválida.'; return false;
    }
    if (err) err.textContent = '';
    return true;
}
function validatePhone() {
    const op = document.getElementById('cust_operator');
    const el = document.getElementById('cust_phone');
    const err = document.getElementById('cust_phone_err');
    if (!el) return false;
    const v = el.value.trim();
    if (!v) {
        if (err) err.textContent = 'El teléfono es obligatorio.'; return false;
    }
    if (!/^\d{7}$/.test(v)) {
        if (err) err.textContent = 'Teléfono inválido. Debe contener exactamente 7 dígitos.'; return false;
    }
    if (!op || !op.value) {
        if (err) err.textContent = 'Selecciona una operadora.'; return false;
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
        validateFormAll();
    });
}
function validateFormAll() {
    const ok = validateName() && validatePhone() && validateAddress() && validateEmail() && validateAge();
    const submitBtn = document.getElementById('checkoutSubmitBtn');
    if (submitBtn) submitBtn.disabled = !ok;
    return ok;
}

function submitHandler(e) {
    e.preventDefault();
    const name = document.getElementById('cust_name').value.trim();
    const emailUser = document.getElementById('cust_email').value.trim();
    const emailDomain = document.getElementById('cust_email_domain')?.value || '';
    const emailFull = emailUser ? `${emailUser}@${emailDomain}` : '';
    const operator = document.getElementById('cust_operator')?.value || '';
    const phoneRaw = document.getElementById('cust_phone').value.trim();
    const phoneFull = operator && phoneRaw ? `${operator}${phoneRaw}` : phoneRaw;
    const age = document.getElementById('cust_age')?.value.trim() || "";
    const address = document.getElementById('cust_address').value.trim();
    const lat = document.getElementById('cust_lat')?.value || "";
    const lng = document.getElementById('cust_lng')?.value || "";
    const msg = document.getElementById('checkoutMsg');
    if (!validateFormAll()) {
        if (msg) { msg.textContent = 'Corrige los campos indicados antes de enviar.'; msg.style.color = '#ef4444'; }
        return;
    }
    submitOrder({ name, email: emailFull, phone: phoneFull, age, address, lat, lng });
}

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

/* Eventos y boot */
function attachGlobalEvents() {
    transformContactFields();

    const nameEl = document.getElementById('cust_name');
    const emailEl = document.getElementById('cust_email');
    const emailDomainEl = document.getElementById('cust_email_domain');
    const phoneOpEl = document.getElementById('cust_operator');
    const phoneEl = document.getElementById('cust_phone');
    const addrEl = document.getElementById('cust_address');
    const ageEl = document.getElementById('cust_age');

    if (nameEl) { nameEl.addEventListener('input', () => { validateName(); validateFormAll(); }); nameEl.addEventListener('blur', validateName); }
    if (emailEl) {
        emailEl.addEventListener('input', (e) => {
            const v = e.currentTarget.value;
            const cleaned = v.replace(/[^A-Za-z0-9._-]/g, '');
            if (cleaned !== v) e.currentTarget.value = cleaned;
            validateEmail();
            validateFormAll();
        });
        emailEl.addEventListener('blur', validateEmail);
    }
    if (emailDomainEl) {
        emailDomainEl.addEventListener('change', () => { validateEmail(); validateFormAll(); });
    }
    if (phoneOpEl) {
        phoneOpEl.addEventListener('change', () => { validatePhone(); validateFormAll(); });
    }
    if (phoneEl) {
        phoneEl.addEventListener('input', (e) => {
            const v = e.currentTarget.value;
            const cleaned = v.replace(/\D+/g, '').slice(0, 7);
            if (cleaned !== v) e.currentTarget.value = cleaned;
            validatePhone();
            validateFormAll();
        });
        phoneEl.addEventListener('blur', validatePhone);
    }
    if (addrEl) { addrEl.addEventListener('input', () => { validateAddress(); validateFormAll(); }); addrEl.addEventListener('blur', validateAddress); }
    if (ageEl) {
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

    document.getElementById('clearCartBtn')?.addEventListener('click', async () => {
        const ok = await showConfirm('Vaciar el carrito?');
        if (ok) clearCart();
    });
}

/* Eventos y boot */
async function boot() {
    loadCartFromCookie();
    attachGlobalEvents();
    setupGeolocationButton();
    renderCartCount();
    try {
        await fetchAllProductsFromFirestore();
        if (typeof setupCarousel === 'function') setupCarousel();
        await Promise.all(PRODUCTS.map(p => resolveProductImages(p)));
        await handleUrlAddParams();
        renderCartPanel();
        validateFormAll();
    } catch (err) {
        showToast('Error cargando productos (ver consola).', 4000);
    }
}

window.addEventListener('load', boot);

export { };
// FIN DEL ARCHIVO
