// assets/js/product-admin.js
// Versión completa revisada con paginación cliente y data-labels para vista responsive (tarjetas)
// Actualizaciones principales:
// - Precio: entrada tipo "enteros primero, decimales solo si se presiona ','".
//   - Campo inicia en "0,00".
//   - Al escribir dígitos se construye la parte entera (izquierda de la coma) y se mantiene ",00" hasta que el usuario presione ','.
//   - Si el usuario presiona ',' entra en modo decimal y los dígitos siguientes rellenan la fracción (se permiten varios decimales).
//   - Backspace elimina en decimal si hay decimales, si no hay decimales elimina la parte entera.
//   - Pegado intenta parsear un número (acepta formatos con '.' y ','), y establece buffers apropiados.
// - `stock` y `discount` siguen sanitizados como enteros; `discount` permanece deshabilitado hasta activar `onOffer`.
// - Formateo mostrado usa miles con '.' y decimales con ',' (locale es-ES).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, query, orderBy, onSnapshot,
    addDoc, doc, updateDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

import { optimizarImagen } from './image-utils.js';
import { applyUiRestrictions } from './rbac.js';

// Init
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// UI elements
const productsBody = document.getElementById('productsBody');
const searchInput = document.getElementById('searchInput');
const stateFilter = document.getElementById('stateFilter');
const offerFilter = document.getElementById('offerFilter');

const productModal = document.getElementById('productModal');
const openAddBtn = document.getElementById('openAddBtn');
const closeModalBtn = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');

const productForm = document.getElementById('productForm');
const modalTitle = document.getElementById('modalTitle');
const toast = document.getElementById('toast');

const productIdField = document.getElementById('productId');
const nameField = document.getElementById('name');
const descriptionField = document.getElementById('description');
const priceField = document.getElementById('price');
const categoryField = document.getElementById('category');
const statusField = document.getElementById('status');
const onOfferField = document.getElementById('onOffer');
const discountField = document.getElementById('discount');
const stockField = document.getElementById('stock');
const imageFileField = document.getElementById('imageFile'); // multiple
const skuField = document.getElementById('sku');

const imageDropZone = document.getElementById('imageDropZone');
const imagePreviewSlider = document.getElementById('imagePreviewSlider');
const slideTrack = document.getElementById('slideTrack');
const prevSlideBtn = document.getElementById('prevSlide');
const nextSlideBtn = document.getElementById('nextSlide');

let productsLocal = [];
let filteredProducts = [];
let currentUser = null;
let currentUserRole = null;
let isEditing = false;
let editingId = null;
let currentPreviewFiles = [];
let currentPreviewUrls = [];
let currentSavedImageObjs = []; // [{url, path}]
let pendingDeletePaths = [];

const productsCol = collection(db, 'product');

const CATEGORY_PREFIX = {
    "Ropa": "ROP",
    "Electrónica": "ELE",
    "Hogar": "HOG",
    "Accesorios": "ACC"
};

/* ---------------- PAGINACIÓN ---------------- */
let pageSize = 10;
let currentPage = 1;
const PAGE_SIZES = [10, 50, 100, 500];

let paginationContainer = null;
let pageSizeSelect = null;
let prevPageBtn = null;
let nextPageBtn = null;
let pageInfoEl = null;
let totalCountEl = null;

function ensurePaginationUi() {
    if (paginationContainer) return;
    const tableCard = document.querySelector('.table-card');
    if (!tableCard) return;

    paginationContainer = document.createElement('div');
    paginationContainer.className = 'pagination-controls';

    // page size
    const sizeWrap = document.createElement('div');
    sizeWrap.className = 'page-size';
    sizeWrap.innerHTML = `<label for="pageSizeSelect">Mostrar</label>`;
    pageSizeSelect = document.createElement('select');
    pageSizeSelect.id = 'pageSizeSelect';
    PAGE_SIZES.forEach(s => {
        const o = document.createElement('option'); o.value = String(s); o.textContent = String(s);
        if (s === pageSize) o.selected = true;
        pageSizeSelect.appendChild(o);
    });
    sizeWrap.appendChild(pageSizeSelect);
    paginationContainer.appendChild(sizeWrap);

    // pager controls
    const pager = document.createElement('div');
    pager.className = 'pager';
    prevPageBtn = document.createElement('button'); prevPageBtn.type = 'button'; prevPageBtn.className = 'pager-btn prev'; prevPageBtn.textContent = '«';
    nextPageBtn = document.createElement('button'); nextPageBtn.type = 'button'; nextPageBtn.className = 'pager-btn next'; nextPageBtn.textContent = '»';
    pageInfoEl = document.createElement('span'); pageInfoEl.className = 'page-info';
    totalCountEl = document.createElement('span'); totalCountEl.className = 'total-info';
    pager.appendChild(prevPageBtn);
    pager.appendChild(pageInfoEl);
    pager.appendChild(nextPageBtn);
    paginationContainer.appendChild(pager);

    // total
    const totalWrap = document.createElement('div');
    totalWrap.className = 'page-total';
    totalWrap.appendChild(totalCountEl);
    paginationContainer.appendChild(totalWrap);

    // append after table-card
    tableCard.parentNode.insertBefore(paginationContainer, tableCard.nextSibling);

    // events
    pageSizeSelect.addEventListener('change', () => {
        pageSize = Number(pageSizeSelect.value) || 10;
        currentPage = 1;
        paginateAndRender(filteredProducts);
    });
    prevPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; paginateAndRender(filteredProducts); } });
    nextPageBtn.addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil((filteredProducts?.length || 0) / pageSize));
        if (currentPage < totalPages) { currentPage += 1; paginateAndRender(filteredProducts); }
    });
}

/* ---------------- Helpers ---------------- */
function showToast(msg, ms = 3000) {
    if (!toast) { console.log('TOAST:', msg); return; }
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('hidden');
    }, ms);
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '=': '&#x3D;', '`': '&#x60;' }[c]));
}

/* Price formatting/parsing using locale that uses '.' thousands and ',' decimals (es-ES) */
function formatPriceDisplay(num) {
    if (num === undefined || num === null || num === '') return '';
    const n = Number(num);
    if (Number.isNaN(n)) return '';
    // use 2 decimal places, thousands '.' and decimal ','
    return new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function parseFormattedPrice(str) {
    if (str === undefined || str === null) return NaN;
    const s = String(str).trim();
    if (!s) return NaN;
    // Remove thousand separators '.' and replace decimal ',' with '.'
    const cleaned = s.replace(/\./g, '').replace(/,/g, '.').replace(/\s+/g, '');
    const v = parseFloat(cleaned);
    return Number.isNaN(v) ? NaN : v;
}
function formatIntegerWithThousands(intStr) {
    // intStr: digits only string
    if (!intStr) return '0';
    const n = Number(intStr);
    if (Number.isNaN(n)) return intStr;
    return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(n);
}
function calculateOfferPrice(price, discount) {
    if (price === undefined || price === null) return null;
    if (discount === undefined || discount === null) return null;
    return Math.round(Number(price) * (1 - Number(discount) / 100));
}
function generateSKUForCategory(category) {
    const prefix = CATEGORY_PREFIX[category] || (category ? category.slice(0, 3).toUpperCase() : 'PRD');
    const timePortion = String(Date.now()).slice(-6);
    const rnd = Math.random().toString(36).slice(-4).toUpperCase();
    return `${prefix}-${timePortion}${rnd}`;
}

/* ---------------- Inline field error helpers ---------------- */
function setFieldError(fieldOrId, message) {
    const el = typeof fieldOrId === 'string' ? document.getElementById(fieldOrId) : fieldOrId;
    if (!el) return;
    clearFieldError(el);
    el.classList.add('input-error');
    const wrapper = document.createElement('div');
    wrapper.className = 'field-error';
    wrapper.style.color = '#dc2626';
    wrapper.style.fontSize = '13px';
    wrapper.style.marginTop = '6px';
    wrapper.textContent = message;
    const parentRow = el.closest('.form-row') || el.parentNode;
    parentRow.appendChild(wrapper);
}

function clearFieldError(fieldOrId) {
    const el = typeof fieldOrId === 'string' ? document.getElementById(fieldOrId) : fieldOrId;
    if (!el) return;
    el.classList.remove('input-error');
    const parentRow = el.closest('.form-row') || el.parentNode;
    const prev = parentRow.querySelector('.field-error');
    if (prev) parentRow.removeChild(prev);
}

function clearAllFieldErrors(formEl) {
    const els = (formEl || document).querySelectorAll('.field-error');
    els.forEach(e => e.remove());
    (formEl || document).querySelectorAll('.input-error').forEach(i => i.classList.remove('input-error'));
}

/* ---------------- Input sanitizers and handlers ---------------- */
function sanitizeIntegerInputValue(v) {
    // remove everything except digits
    return (String(v || '')).replace(/\D+/g, '');
}
function sanitizeNumericFieldValue(v) {
    // allow digits, dots and commas; remove letters and other chars
    return (String(v || '')).replace(/[^0-9\.,]+/g, '');
}

// prevent paste of invalid characters
function handlePasteSanitize(e, type = 'numeric') {
    const paste = (e.clipboardData || window.clipboardData).getData('text') || '';
    if (!paste) return;
    let cleaned = paste;
    if (type === 'integer') cleaned = sanitizeIntegerInputValue(cleaned);
    else cleaned = sanitizeNumericFieldValue(cleaned);
    // replace selection with cleaned text
    e.preventDefault();
    const el = e.target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const newVal = el.value.slice(0, start) + cleaned + el.value.slice(end);
    el.value = newVal;
    el.dispatchEvent(new Event('input'));
}

// Setup handlers for stock and discount (integers)
if (stockField) {
    stockField.addEventListener('input', () => {
        const v = sanitizeIntegerInputValue(stockField.value);
        stockField.value = v;
        clearFieldError(stockField);
    });
    stockField.addEventListener('paste', (e) => handlePasteSanitize(e, 'integer'));
    stockField.addEventListener('keydown', (e) => {
        // allow control/navigation keys and digits only
        const allowed = ['Backspace', 'ArrowLeft', 'ArrowRight', 'Delete', 'Tab', 'Home', 'End'];
        if (allowed.includes(e.key)) return;
        if (/^\d$/.test(e.key)) return;
        e.preventDefault();
    });
}

if (discountField) {
    // initially disabled; will be toggled by onOffer
    discountField.addEventListener('input', () => {
        const v = sanitizeIntegerInputValue(discountField.value);
        let n = v === '' ? '' : String(Number(v));
        // clamp 0-100
        if (n !== '') {
            let ni = Number(n);
            if (ni > 100) ni = 100;
            if (ni < 0) ni = 0;
            n = String(ni);
        }
        discountField.value = n;
        clearFieldError(discountField);
    });
    discountField.addEventListener('paste', (e) => handlePasteSanitize(e, 'integer'));
    discountField.addEventListener('keydown', (e) => {
        const allowed = ['Backspace', 'ArrowLeft', 'ArrowRight', 'Delete', 'Tab', 'Home', 'End'];
        if (allowed.includes(e.key)) return;
        if (/^\d$/.test(e.key)) return;
        e.preventDefault();
    });
}

/* ---------------- Price field: integer-first with explicit decimal mode ---------------- */
/*
 Behavior:
 - Field shows formatted price with thousands (.) and decimals (,).
 - Default mode: integerMode. Digits typed go to integer part (left of comma). ",00" shown but decimals are zero until user enters decimal mode.
 - If user presses ',' or '.' key, switch to decimalMode and subsequent digits go to decimal part.
 - Backspace removes last decimal digit if in decimalMode and decimal part non-empty; if decimal empty, exit decimalMode; otherwise delete last integer digit.
 - Paste will parse numeric strings and set both buffers.
 - On openEditModal the buffers are loaded from the product value.
*/

let priceIntegerBuffer = ''; // digits for integer part, without thousand separators
let priceDecimalBuffer = ''; // digits for decimal fractional part (can be 0..n)
let priceDecimalMode = false;
const PRICE_DECIMAL_MAX = 6; // max decimals allowed for entry (configurable)

function priceBuffersToDisplay() {
    const intPart = priceIntegerBuffer ? Number(priceIntegerBuffer) : 0;
    const intFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(intPart);
    const dec = priceDecimalBuffer || '00';
    // ensure at least two decimals displayed for consistency
    const decDisplay = priceDecimalMode ? (priceDecimalBuffer === '' ? '' : priceDecimalBuffer) : (dec.length ? dec.padStart(2, '0').slice(0, 2) : '00');
    // when in decimalMode and decimal buffer empty show trailing comma to indicate mode
    if (priceDecimalMode) {
        return decDisplay === '' ? `${intFmt},` : `${intFmt},${decDisplay}`;
    } else {
        return `${intFmt},${(decDisplay || '00').slice(0, 2)}`;
    }
}

function updatePriceFieldFromBuffers() {
    if (!priceField) return;
    priceField.value = priceBuffersToDisplay();
    // attach data-cents for potential machine use
    const cents = Number((priceIntegerBuffer || '0')) * 100 + Number((priceDecimalBuffer || '0').padEnd(2, '0').slice(0, 2));
    priceField.setAttribute('data-cents', String(cents));
    clearFieldError(priceField);
}

function resetPriceBuffersToZero() {
    priceIntegerBuffer = '0';
    priceDecimalBuffer = '';
    priceDecimalMode = false;
    updatePriceFieldFromBuffers();
}

function setPriceBuffersFromNumber(n) {
    if (!Number.isFinite(n)) { priceIntegerBuffer = '0'; priceDecimalBuffer = ''; priceDecimalMode = false; updatePriceFieldFromBuffers(); return; }
    const cents = Math.round(Number(n) * 100);
    const intPart = Math.floor(cents / 100);
    const decPart = String(cents % 100).padStart(2, '0');
    priceIntegerBuffer = String(intPart);
    priceDecimalBuffer = decPart;
    priceDecimalMode = false;
    updatePriceFieldFromBuffers();
}

function setPriceBuffersFromFormattedString(s) {
    const parsed = parseFormattedPrice(s);
    if (!Number.isNaN(parsed)) {
        setPriceBuffersFromNumber(parsed);
        return;
    }
    // fallback: extract digits around comma
    const parts = String(s || '').trim().split(/[,\.]/);
    if (parts.length === 0) { resetPriceBuffersToZero(); return; }
    priceIntegerBuffer = (parts[0] || '').replace(/\D+/g, '') || '0';
    priceDecimalBuffer = (parts[1] || '').replace(/\D+/g, '');
    priceDecimalMode = false;
    updatePriceFieldFromBuffers();
}

// Append integer digit
function priceAddIntegerDigit(d) {
    if (!/^\d$/.test(String(d))) return;
    // prevent leading zeros unless user wants them
    if (priceIntegerBuffer === '0') priceIntegerBuffer = d;
    else priceIntegerBuffer = (priceIntegerBuffer || '') + d;
    updatePriceFieldFromBuffers();
}

// Remove last integer digit
function priceRemoveIntegerDigit() {
    if (!priceIntegerBuffer) { priceIntegerBuffer = '0'; updatePriceFieldFromBuffers(); return; }
    priceIntegerBuffer = priceIntegerBuffer.slice(0, -1);
    if (priceIntegerBuffer === '') priceIntegerBuffer = '0';
    updatePriceFieldFromBuffers();
}

// Append decimal digit (only in decimalMode)
function priceAddDecimalDigit(d) {
    if (!/^\d$/.test(String(d))) return;
    if (priceDecimalBuffer.length >= PRICE_DECIMAL_MAX) return;
    priceDecimalBuffer = priceDecimalBuffer + d;
    updatePriceFieldFromBuffers();
}

// Remove last decimal digit
function priceRemoveDecimalDigit() {
    if (!priceDecimalBuffer) {
        // if nothing in decimal buffer, exit decimal mode
        priceDecimalMode = false;
    } else {
        priceDecimalBuffer = priceDecimalBuffer.slice(0, -1);
    }
    updatePriceFieldFromBuffers();
}

// Handle paste into price
function priceHandlePaste(text) {
    if (!text) return;
    const parsed = parseFormattedPrice(text);
    if (!Number.isNaN(parsed)) {
        setPriceBuffersFromNumber(parsed);
        return;
    }
    // fallback: try to pull digits left and right of comma if present
    const t = String(text || '').trim();
    const match = t.match(/^([\d\.\s]+)[,\.]?(\d*)$/);
    if (match) {
        priceIntegerBuffer = (match[1] || '').replace(/\D+/g, '') || '0';
        priceDecimalBuffer = (match[2] || '').replace(/\D+/g, '');
        priceDecimalMode = !!(match[2] && match[2].length > 0);
        updatePriceFieldFromBuffers();
    }
}

// Price field keyboard handling
if (priceField) {
    // Ensure buffers exist
    if (!priceIntegerBuffer) { priceIntegerBuffer = '0'; priceDecimalBuffer = ''; priceDecimalMode = false; }

    priceField.addEventListener('focus', () => {
        // Keep display up-to-date; caret placed at end
        updatePriceFieldFromBuffers();
        setTimeout(() => {
            try { priceField.selectionStart = priceField.selectionEnd = priceField.value.length; } catch (e) { }
        }, 0);
    });

    priceField.addEventListener('keydown', (e) => {
        // allow navigation and editing handled below
        const navAllowed = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'];
        if (navAllowed.includes(e.key)) return;

        if (e.key === 'Backspace') {
            e.preventDefault();
            if (priceDecimalMode) {
                if (priceDecimalBuffer.length > 0) priceRemoveDecimalDigit();
                else priceDecimalMode = false; // exit decimal mode if buffer empty
            } else {
                // remove integer digit
                priceRemoveIntegerDigit();
            }
            return;
        }

        // Enter decimal mode on comma or dot
        if (e.key === ',' || e.key === '.') {
            e.preventDefault();
            priceDecimalMode = true;
            // keep current decimalBuffer unchanged
            updatePriceFieldFromBuffers();
            return;
        }

        // Digits
        if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            if (priceDecimalMode) {
                priceAddDecimalDigit(e.key);
            } else {
                priceAddIntegerDigit(e.key);
            }
            return;
        }

        // prevent everything else (letters, symbols)
        e.preventDefault();
    });

    priceField.addEventListener('paste', (e) => {
        const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
        e.preventDefault();
        priceHandlePaste(txt);
    });

    // blur: ensure consistent formatting (two decimals shown)
    priceField.addEventListener('blur', () => {
        // If decimalMode and decimalBuffer empty, show trailing comma is removed and ",00" displayed
        priceDecimalMode = false;
        // Normalize decimalBuffer to two digits for display (but keep full decimal buffer internally)
        if (!priceDecimalBuffer) priceDecimalBuffer = '00';
        // Update display
        // Compose number from buffers to get consistent rounding when necessary
        const intVal = Number(priceIntegerBuffer || '0');
        const decVal = Number((priceDecimalBuffer || '00').slice(0, 2).padEnd(2, '0'));
        const finalNumber = intVal + decVal / 100;
        setPriceBuffersFromNumber(finalNumber);
        updatePriceFieldFromBuffers();
    });
}

/* Offer toggle: enable/disable discount input */
function setDiscountEnabled(enabled) {
    if (!discountField) return;
    discountField.disabled = !enabled;
    discountField.setAttribute('aria-disabled', String(!enabled));
    if (!enabled) {
        discountField.value = '0';
        clearFieldError(discountField);
    } else {
        // focus for quick entry
        discountField.focus();
        // ensure value is a number string
        if (!discountField.value) discountField.value = '0';
    }
}
if (onOfferField) {
    // initialize discount state on load
    setDiscountEnabled(!!onOfferField.checked);
    onOfferField.addEventListener('change', () => {
        setDiscountEnabled(!!onOfferField.checked);
    });
}

/* ---------------- Render products ----------------
   Usa data-label en cada td para permitir la vista responsive tipo tarjetas.
   La fila se marca visualmente cuando el stock es menor a 5.
*/
function renderProducts(list) {
    productsBody.innerHTML = '';
    if (!list.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.style.padding = '28px';
        td.style.textAlign = 'center';
        td.style.color = '#6b7280';
        td.textContent = 'No hay productos';
        tr.appendChild(td);
        productsBody.appendChild(tr);
        document.dispatchEvent(new CustomEvent('products:rendered'));
        return;
    }

    list.forEach(prod => {
        if ((prod.status || '').toLowerCase() === 'suspendido' && currentUserRole !== 'administrador') return;

        const tr = document.createElement('tr');

        // Determine stock and low-stock state
        const stockNum = Number(prod.stock ?? 0);
        const isLowStock = Number.isFinite(stockNum) && stockNum < 5;

        // If low stock, visually highlight the whole row (red tint + left red border)
        if (isLowStock) {
            tr.style.backgroundColor = '#fff5f5'; // very light red/pink
            tr.style.borderLeft = '4px solid #ef4444'; // red left accent
            tr.setAttribute('data-low-stock', 'true');
            tr.setAttribute('aria-label', `Stock bajo: ${stockNum}`);
        }

        // Images mini-slider cell
        const tdImg = document.createElement('td');
        tdImg.className = 'mini-slider-cell';
        tdImg.setAttribute('data-label', 'Imagen');
        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'mini-slider';
        const track = document.createElement('div');
        track.className = 'mini-track';

        const images = Array.isArray(prod.imageUrls) && prod.imageUrls.length ? prod.imageUrls : (prod.imageUrl ? [prod.imageUrl] : []);
        if (images.length) {
            images.slice(0, 6).forEach(url => {
                const item = document.createElement('div');
                item.className = 'mini-slide';
                const img = document.createElement('img');
                img.src = url;
                img.alt = prod.name;
                img.loading = 'lazy';
                item.appendChild(img);
                track.appendChild(item);
            });
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'thumb';
            placeholder.textContent = 'IMG';
            sliderWrap.appendChild(placeholder);
        }
        sliderWrap.appendChild(track);
        tdImg.appendChild(sliderWrap);
        tr.appendChild(tdImg);

        // Name & category
        const tdName = document.createElement('td'); tdName.className = 'product-name';
        tdName.setAttribute('data-label', 'Nombre');
        tdName.innerHTML = `<div>${escapeHtml(prod.name)}</div><div style="font-size:12px;color:#6b7280">${escapeHtml(prod.category || '')}</div>`;
        tr.appendChild(tdName);

        // Price
        const tdPrice = document.createElement('td'); tdPrice.textContent = formatPriceDisplay(prod.price); tdPrice.setAttribute('data-label', 'Precio'); tr.appendChild(tdPrice);

        // Offer badge
        const tdOffer = document.createElement('td'); tdOffer.setAttribute('data-label', 'Oferta');
        const offerBadge = document.createElement('span');
        offerBadge.className = 'badge offer-badge';
        if (prod.onOffer) { offerBadge.classList.add('offer-yes'); offerBadge.textContent = 'En oferta'; }
        else { offerBadge.classList.add('offer-no'); offerBadge.textContent = 'No'; }
        tdOffer.appendChild(offerBadge);
        tr.appendChild(tdOffer);

        // Discount
        const tdDiscount = document.createElement('td'); tdDiscount.setAttribute('data-label', 'Descuento');
        tdDiscount.textContent = prod.onOffer ? `-${(prod.discount || 0)}%` : '-';
        tr.appendChild(tdDiscount);

        // Offer price
        const tdOfferPrice = document.createElement('td'); tdOfferPrice.setAttribute('data-label', 'Precio Oferta');
        const op = prod.onOffer ? calculateOfferPrice(prod.price, prod.discount) : null;
        tdOfferPrice.textContent = op !== null ? formatPriceDisplay(op) : '-';
        tr.appendChild(tdOfferPrice);

        // Stock
        const tdStock = document.createElement('td'); tdStock.setAttribute('data-label', 'Stock');
        tdStock.textContent = prod.stock ?? 0;
        // If low stock, set clearer color on the stock cell
        if (isLowStock) {
            tdStock.style.color = '#991b1b'; // dark red text
            tdStock.style.fontWeight = '700';
        }
        tr.appendChild(tdStock);

        // State badge
        const tdState = document.createElement('td'); tdState.setAttribute('data-label', 'Estado');
        const stateBadge = document.createElement('span');
        stateBadge.className = 'badge-state state-badge';
        const st = (prod.status || 'Activo').toLowerCase();
        if (st === 'activo' || st === 'active') { stateBadge.classList.add('state-active'); stateBadge.textContent = 'Activo'; }
        else if (st === 'inactivo' || st === 'inactive') { stateBadge.classList.add('state-inactive'); stateBadge.textContent = 'Inactivo'; }
        else if (st === 'suspendido' || st === 'suspended') { stateBadge.classList.add('state-suspended'); stateBadge.textContent = 'Suspendido'; }
        else { stateBadge.textContent = prod.status || '—'; }
        tdState.appendChild(stateBadge);
        tr.appendChild(tdState);

        // Actions
        const tdActions = document.createElement('td'); tdActions.className = 'actions'; tdActions.setAttribute('data-label', 'Acciones');
        const actions = document.createElement('div'); actions.className = 'actions';

        // Copy link - always visible
        const btnCopy = document.createElement('button');
        btnCopy.className = 'btn-small btn-view';
        btnCopy.title = 'Copiar Enlace';
        btnCopy.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-link-45deg" viewBox="0 0 16 16">
                                <path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"/>
                                <path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243z"/>
                            </svg>`;
        btnCopy.addEventListener('click', () => copyProductLink(prod.id));
        actions.appendChild(btnCopy);

        // Admin actions: edit and soft-delete
        if (currentUserRole === 'administrador') {
            const btnEdit = document.createElement('button');
            btnEdit.className = 'btn-small btn-assign';
            btnEdit.title = 'Editar';
            btnEdit.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-pencil-square" viewBox="0 0 16 16">
                                    <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
                                    <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/>
                                </svg>`;
            btnEdit.addEventListener('click', () => openEditProduct(prod.id));
            actions.appendChild(btnEdit);

            const btnDelete = document.createElement('button');
            btnDelete.className = 'btn-small btn-suspender';
            btnDelete.title = 'Suspender';
            btnDelete.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                                        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                                    </svg>`;
            btnDelete.addEventListener('click', () => softDeleteProduct(prod.id));
            actions.appendChild(btnDelete);
        }

        tdActions.appendChild(actions);
        tr.appendChild(tdActions);

        productsBody.appendChild(tr);
    });

    // notify for mini-rotator
    document.dispatchEvent(new CustomEvent('products:rendered'));
}

/* ---------------- Copy link ---------------- */
function buildAddLinkForPublic(productId) {
    const origin = window.location.origin;
    const publicPath = '/carrito.html';
    const params = new URLSearchParams({ add: productId, openCart: '1', hideProducts: '1' });
    return `${origin}${publicPath}?${params.toString()}`;
}
async function copyProductLink(id) {
    const link = buildAddLinkForPublic(id);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(link);
        } else {
            const ta = document.createElement('textarea');
            ta.value = link;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showToast('Enlace copiado al portapapeles');
    } catch (err) {
        console.error('copy error', err);
        showToast('No se pudo copiar enlace');
    }
}

/* ---------------- Soft-delete (mark suspendido) ---------------- */
async function softDeleteProduct(id) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }
    const ok = confirm('¿Suspender este producto? (no se eliminará permanentemente)');
    if (!ok) return;
    try {
        const ref = doc(db, 'product', id);
        await updateDoc(ref, { status: 'suspendido', updatedAt: serverTimestamp() });
        showToast('Producto suspendido');
    } catch (err) {
        console.error('softDeleteProduct error', err);
        showToast('Error al suspender producto');
    }
}

/* ---------------- Filters & realtime ---------------- */
function applyFilters() {
    const search = (searchInput.value || '').trim().toLowerCase();
    const stateVal = stateFilter.value;
    const offerVal = offerFilter.value;
    let filtered = productsLocal.slice();
    if (search) filtered = filtered.filter(p => (p.name_lower || '').includes(search));
    if (stateVal) filtered = filtered.filter(p => (p.status || '') === stateVal);
    if (offerVal) {
        if (offerVal === 'en_oferta') filtered = filtered.filter(p => !!p.onOffer);
        if (offerVal === 'no_oferta') filtered = filtered.filter(p => !p.onOffer);
    }
    filteredProducts = filtered;
    currentPage = 1;
    ensurePaginationUi();
    paginateAndRender(filteredProducts);
}

function paginateAndRender(list) {
    ensurePaginationUi();
    const total = list.length || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const slice = list.slice(start, end);
    renderProducts(slice);

    // update pagination UI
    if (paginationContainer) {
        pageInfoEl.textContent = `Página ${currentPage} / ${totalPages}`;
        totalCountEl.textContent = `Total: ${total}`;
        prevPageBtn.disabled = currentPage <= 1;
        nextPageBtn.disabled = currentPage >= totalPages;
        // hide paginador si no hay paginación necesaria
        if (total <= pageSize) {
            paginationContainer.style.display = 'none';
        } else {
            paginationContainer.style.display = 'flex';
        }
    }
}

function startRealtimeListener() {
    const q = query(productsCol, orderBy('name_lower', 'asc'));
    onSnapshot(q, snapshot => {
        productsLocal = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFilters();
    }, err => {
        console.error('Error listening products', err);
        showToast('Error cargando productos: ' + (err.message || err));
    });
}

/* ---------------- Modal open/edit/submit (simplified) ---------------- */
function clearModalPreviews() {
    currentPreviewFiles = [];
    currentPreviewUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { } });
    currentPreviewUrls = [];
    currentSavedImageObjs = [];
    pendingDeletePaths = [];
    slideTrack.innerHTML = '';
    imagePreviewSlider.classList.add('hidden');
    imagePreviewSlider.setAttribute('aria-hidden', 'true');
    clearAllFieldErrors(productForm);
}

/* ---------- Drag & Drop reordering helpers & style injection ---------- */
// Inject minimal CSS for drag feedback (once)
(function injectDragStyles() {
    if (document.getElementById('product-admin-drag-styles')) return;
    const style = document.createElement('style');
    style.id = 'product-admin-drag-styles';
    style.textContent = `
    #slideTrack .slide-item { cursor: grab; user-select: none; }
    #slideTrack .slide-item.dragging { opacity: 0.45; }
    #slideTrack .slide-item.drop-target { outline: 2px dashed rgba(79,70,229,0.9); outline-offset: -6px; }
    #slideTrack .slide-item img { display:block; width:100%; height:auto; }
    `;
    document.head.appendChild(style);
})();

// Return combined list of items in the currently displayed order
function getCombinedItems() {
    const saved = Array.isArray(currentSavedImageObjs) ? currentSavedImageObjs.map((o, i) => ({ type: 'saved', url: o.url, path: o.path || '', savedIndex: i })) : [];
    const previews = Array.isArray(currentPreviewUrls) ? currentPreviewUrls.map((u, i) => ({ type: 'preview', url: u, file: currentPreviewFiles[i], previewIndex: i })) : [];
    return saved.concat(previews);
}

// Apply a combined-ordered list back into the separate arrays used elsewhere
function applyCombinedItems(items) {
    const newSaved = [];
    const newPreviewUrls = [];
    const newPreviewFiles = [];
    for (const it of items) {
        if (it.type === 'saved') {
            newSaved.push({ url: it.url, path: it.path || '' });
        } else if (it.type === 'preview') {
            newPreviewUrls.push(it.url);
            newPreviewFiles.push(it.file);
        }
    }
    currentSavedImageObjs = newSaved;
    // Revoke old preview objectURLs that were removed (already revoked in removePreviewImage but keep safe)
    currentPreviewUrls.forEach(u => { try { if (!newPreviewUrls.includes(u)) URL.revokeObjectURL(u); } catch (e) { } });
    currentPreviewUrls = newPreviewUrls;
    currentPreviewFiles = newPreviewFiles;
}

/* ---------------- Show modal slider for files (with drag & drop reordering) ---------------- */
function showModalSliderForFiles() {
    slideTrack.innerHTML = '';
    const combined = getCombinedItems();
    const combinedLen = combined.length;

    if (!combinedLen) {
        imagePreviewSlider.classList.add('hidden');
        imagePreviewSlider.setAttribute('aria-hidden', 'true');
        return;
    }

    imagePreviewSlider.classList.remove('hidden');
    imagePreviewSlider.setAttribute('aria-hidden', 'false');

    // Create slide items for each combined entry (saved first then previews per combined list)
    combined.forEach((item, idx) => {
        const node = document.createElement('div');
        node.className = 'slide-item';
        node.style.position = 'relative';
        node.setAttribute('draggable', 'true');
        node.dataset.combinedIndex = String(idx);

        const img = document.createElement('img');
        img.src = item.url;
        img.alt = 'preview';
        img.loading = 'lazy';
        img.style.display = 'block';
        img.style.maxWidth = '100%';
        node.appendChild(img);

        // Remove button
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'img-remove';
        btn.title = 'Eliminar imagen';
        btn.dataset.type = item.type;
        // For saved items compute the index in currentSavedImageObjs; for previews compute index in currentPreviewUrls
        if (item.type === 'saved') {
            // index within saved array after reordering
            btn.dataset.index = String(currentSavedImageObjs.length ? currentSavedImageObjs.length + idx /* placeholder; not read */ : idx);
            // We'll instead compute indexes when clicking by looking for dataset.combinedIndex on parent; keep type only for delegated handler
            btn.dataset.index = '';
        } else {
            btn.dataset.index = '';
        }
        // basic inline styles so funciona sin CSS adicional
        btn.style.position = 'absolute';
        btn.style.top = '6px';
        btn.style.right = '6px';
        btn.style.width = '28px';
        btn.style.height = '28px';
        btn.style.borderRadius = '50%';
        btn.style.border = 'none';
        btn.style.background = 'rgba(0,0,0,0.55)';
        btn.style.color = '#fff';
        btn.style.cursor = 'pointer';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.fontSize = '16px';
        btn.textContent = '×';
        node.appendChild(btn);

        // Drag handlers
        node.addEventListener('dragstart', (e) => {
            node.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            // store source index
            e.dataTransfer.setData('text/plain', String(idx));
            try { if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(node, 20, 20); } catch (er) { }
        });
        node.addEventListener('dragend', () => {
            node.classList.remove('dragging');
            // cleanup any drop-target classes
            slideTrack.querySelectorAll('.slide-item.drop-target').forEach(n => n.classList.remove('drop-target'));
        });

        node.addEventListener('dragover', (e) => {
            e.preventDefault();
            node.classList.add('drop-target');
            e.dataTransfer.dropEffect = 'move';
        });
        node.addEventListener('dragleave', () => {
            node.classList.remove('drop-target');
        });
        node.addEventListener('drop', (e) => {
            e.preventDefault();
            node.classList.remove('drop-target');
            const srcIdxStr = e.dataTransfer.getData('text/plain');
            const srcIdx = Number.isFinite(Number(srcIdxStr)) ? Number(srcIdxStr) : null;
            const tgtIdx = Number(node.dataset.combinedIndex);
            if (srcIdx === null || Number.isNaN(tgtIdx)) return;
            if (srcIdx === tgtIdx) return;
            // Reorder combined array
            const copy = combined.slice();
            const [moved] = copy.splice(srcIdx, 1);
            // If dropping after an element and source < target, adjust insertion index
            copy.splice(tgtIdx, 0, moved);
            // Apply reordering back to arrays
            applyCombinedItems(copy);
            // Re-render slider with new order
            showModalSliderForFiles();
        });

        slideTrack.appendChild(node);
    });

    slideTrack.scrollLeft = 0;
}

/* ---------------- Remove helpers (updated to calculate index from combined list) ---------------- */
// Remove selected preview image (before upload)
function removePreviewImage(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= currentPreviewUrls.length) return;
    // Revoke object URL
    try { URL.revokeObjectURL(currentPreviewUrls[idx]); } catch (e) { }
    // Remove file and url in same index
    currentPreviewFiles.splice(idx, 1);
    currentPreviewUrls.splice(idx, 1);
    showModalSliderForFiles();
}

// Mark saved image for deletion (during edit). It will be removed from UI and path added to pendingDeletePaths.
// Actual deletion from storage/doc happens when the product is updated (updateProduct).
function removeSavedImage(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= currentSavedImageObjs.length) return;
    const imgObj = currentSavedImageObjs[idx];
    if (imgObj && imgObj.path) {
        pendingDeletePaths.push(imgObj.path);
    }
    // remove image from saved array
    currentSavedImageObjs.splice(idx, 1);
    showModalSliderForFiles();
}

// delegated click handler for remove buttons inside slideTrack
slideTrack.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.img-remove');
    if (!btn) return;
    // identify which slide-item contains this button
    const itemNode = btn.closest('.slide-item');
    if (!itemNode) return;
    const combinedIndex = Number(itemNode.dataset.combinedIndex);
    const combined = getCombinedItems();
    const clicked = combined[combinedIndex];
    if (!clicked) return;
    if (clicked.type === 'preview') {
        // find preview index in currentPreviewUrls
        const pIdx = currentPreviewUrls.indexOf(clicked.url);
        if (pIdx !== -1) removePreviewImage(pIdx);
    } else if (clicked.type === 'saved') {
        // find saved index in currentSavedImageObjs by matching url and path
        const sIdx = currentSavedImageObjs.findIndex(s => s.url === clicked.url && (s.path || '') === (clicked.path || ''));
        if (sIdx !== -1) {
            const c = confirm('Eliminar esta imagen del producto? Se quitará al guardar los cambios.');
            if (c) removeSavedImage(sIdx);
        }
    }
});

/* ---------------- Image upload / drag-drop: allow multiple (min 4 recommended) ---------------- */
// ... (rest unchanged)
imageFileField.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).slice(0, 8);
    currentPreviewFiles = currentPreviewFiles.concat(files);
    const urls = files.map(f => URL.createObjectURL(f));
    currentPreviewUrls = currentPreviewUrls.concat(urls);
    showModalSliderForFiles();
});

imageDropZone.addEventListener('click', () => imageFileField.click());
imageDropZone.addEventListener('dragover', (e) => { e.preventDefault(); imageDropZone.classList.add('dragover'); });
imageDropZone.addEventListener('dragleave', () => imageDropZone.classList.remove('dragover'));
imageDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    imageDropZone.classList.remove('dragover');
    const dtFiles = Array.from(e.dataTransfer.files || []).slice(0, 8);
    currentPreviewFiles = currentPreviewFiles.concat(dtFiles);
    const urls = dtFiles.map(f => URL.createObjectURL(f));
    currentPreviewUrls = currentPreviewUrls.concat(urls);
    showModalSliderForFiles();
});

/* ---------- Upload images helper with optimization & resumable progress ---------- */
async function uploadImagesToProductFolder(productId, files = [], baseName = 'product', maxFiles = 8, onProgress = null) {
    if (!files || !files.length) return [];
    const arr = Array.from(files).slice(0, maxFiles);

    const optimizedBlobs = [];
    for (const f of arr) {
        try {
            const b = await optimizarImagen(f, { maxWidth: 1400, maxHeight: 1400, quality: 0.8 });
            optimizedBlobs.push({ blob: b, originalName: f.name });
        } catch (e) {
            optimizedBlobs.push({ blob: f, originalName: f.name });
        }
    }

    const totalBytes = optimizedBlobs.reduce((s, it) => s + (it.blob.size || 0), 0);
    let uploadedBytes = 0;
    const uploaded = [];

    for (let i = 0; i < optimizedBlobs.length; i++) {
        const { blob, originalName } = optimizedBlobs[i];
        const safeName = `${Date.now()}_${baseName.replace(/\s+/g, '_')}_${i}_${originalName.replace(/\s+/g, '_')}`;
        const path = `products/${productId}/${safeName}`;
        const ref = storageRef(storage, path);
        const uploadTask = uploadBytesResumable(ref, blob);

        const urlObj = await new Promise((resolve, reject) => {
            uploadTask.on('state_changed',
                (snapshot) => {
                    const bytesSoFar = uploadedBytes + (snapshot.bytesTransferred || 0);
                    const overallPct = totalBytes ? (bytesSoFar / totalBytes) * 100 : 0;
                    if (onProgress) try { onProgress(overallPct); } catch (e) { }
                },
                (err) => { reject(err); },
                async () => {
                    try {
                        const durl = await getDownloadURL(uploadTask.snapshot.ref);
                        uploadedBytes += (blob.size || 0);
                        if (onProgress) try { onProgress(totalBytes ? (uploadedBytes / totalBytes) * 100 : 100); } catch (e) { }
                        resolve({ url: durl, path: uploadTask.snapshot.ref.fullPath || path });
                    } catch (gErr) { reject(gErr); }
                }
            );
        });
        uploaded.push(urlObj);
    }
    return uploaded;
}

/* ---------- Add / Update product (use image uploading) ---------- */
async function addProduct(data, files) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }

    clearAllFieldErrors(productForm);

    if (!data.name || !data.name.trim()) { setFieldError(nameField, 'El nombre es requerido'); nameField.focus(); return; }
    if (!data.description || !data.description.trim()) { setFieldError(descriptionField, 'La descripción es requerida'); descriptionField.focus(); return; }
    const priceParsed = parseFormattedPrice(String(data.price));
    if (Number.isNaN(priceParsed) || priceParsed <= 0) { setFieldError(priceField, 'Precio inválido (debe ser mayor que 0)'); priceField.focus(); return; }
    if (!data.category) { setFieldError(categoryField, 'La categoría es requerida'); categoryField.focus(); return; }
    if (!data.status) { setFieldError(statusField, 'El estado es requerido'); statusField.focus(); return; }
    if (data.stock === '' || data.stock === null || Number.isNaN(Number(data.stock)) || Number(data.stock) < 0 || !Number.isInteger(Number(data.stock))) { setFieldError(stockField, 'Stock inválido (entero ≥ 0)'); stockField.focus(); return; }

    // discount validation when onOffer
    if (data.onOffer) {
        const d = Number(data.discount || 0);
        if (Number.isNaN(d) || d < 0 || d > 100) { setFieldError(discountField, 'Descuento inválido (0-100)'); discountField.focus(); return; }
    } else {
        data.discount = 0;
    }

    const minImages = 1;
    const filesCount = (files && files.length) ? files.length : 0;
    if (filesCount < minImages) {
        setFieldError(imageFileField, `Se requiere al menos ${minImages} imagen(es) (seleccionadas: ${filesCount})`);
        return;
    }

    try {
        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        const newDoc = {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: priceParsed,
            currency: 'CLP',
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrls: [],
            imagePaths: [],
            sku: data.sku || '',
            ownerId: currentUser.uid,
            salesCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        const docRef = await addDoc(productsCol, newDoc);
        const productId = docRef.id;

        createModalProgressUI();
        const uploaded = await uploadImagesToProductFolder(productId, files, data.name, 8, (pct) => updateModalProgress(pct));
        removeModalProgressUI();

        const urls = uploaded.map(x => x.url);
        const paths = uploaded.map(x => x.path);

        await updateDoc(doc(db, 'product', productId), { imageUrls: urls, imagePaths: paths, updatedAt: serverTimestamp() });

        clearAllFieldErrors(productForm);
        showToast('Producto agregado con éxito');
    } catch (err) {
        removeModalProgressUI();
        console.error('addProduct error', err);
        showToast('Error al agregar producto');
    }
}

async function updateProduct(id, data, newFiles = []) {
    if (!currentUser) { showToast('No autenticado'); return; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return; }

    clearAllFieldErrors(productForm);

    if (!data.name || !data.name.trim()) { setFieldError(nameField, 'El nombre es requerido'); nameField.focus(); return; }
    if (!data.description || !data.description.trim()) { setFieldError(descriptionField, 'La descripción es requerida'); descriptionField.focus(); return; }
    const priceParsed = parseFormattedPrice(String(data.price));
    if (Number.isNaN(priceParsed) || priceParsed <= 0) { setFieldError(priceField, 'Precio inválido (debe ser mayor que 0)'); priceField.focus(); return; }
    if (!data.category) { setFieldError(categoryField, 'La categoría es requerida'); categoryField.focus(); return; }
    if (!data.status) { setFieldError(statusField, 'El estado es requerido'); statusField.focus(); return; }
    if (data.stock === '' || data.stock === null || Number.isNaN(Number(data.stock)) || Number(data.stock) < 0 || !Number.isInteger(Number(data.stock))) { setFieldError(stockField, 'Stock inválido (entero ≥ 0)'); stockField.focus(); return; }

    // discount validation when onOffer
    if (data.onOffer) {
        const d = Number(data.discount || 0);
        if (Number.isNaN(d) || d < 0 || d > 100) { setFieldError(discountField, 'Descuento inválido (0-100)'); discountField.focus(); return; }
    } else {
        data.discount = 0;
    }

    try {
        const prodRef = doc(db, 'product', id);
        const snap = await getDoc(prodRef);
        if (!snap.exists()) { showToast('Producto no encontrado'); return; }
        const docData = snap.data();

        // Start from arrays present in DB but filtered by pending deletions later.
        let imageUrlsFromDb = Array.isArray(docData.imageUrls) ? docData.imageUrls.slice() : [];
        let imagePathsFromDb = Array.isArray(docData.imagePaths) ? docData.imagePaths.slice() : [];

        // If there are pendingDeletePaths (images the user removed in the modal), attempt to delete them from storage (best-effort)
        if (pendingDeletePaths.length) {
            for (const p of pendingDeletePaths) {
                try {
                    const ref = storageRef(storage, p);
                    await deleteObject(ref).catch(() => { /* ignore deletion errors */ });
                } catch (err) {
                    console.warn('Error deleting storage path', p, err);
                }
            }
            // remove from db arrays
            imagePathsFromDb = imagePathsFromDb.filter(p => !pendingDeletePaths.includes(p));
            // rebuild urls from imagePathsFromDb using original mapping from docData
            const pathToUrl = {};
            if (Array.isArray(docData.imagePaths)) {
                docData.imagePaths.forEach((p, idx) => { if (docData.imageUrls && docData.imageUrls[idx]) pathToUrl[p] = docData.imageUrls[idx]; });
            }
            if (Object.keys(pathToUrl).length) {
                imageUrlsFromDb = imagePathsFromDb.map(p => pathToUrl[p]).filter(Boolean);
            } else {
                imageUrlsFromDb = imageUrlsFromDb.slice(0, imagePathsFromDb.length);
            }
            // clear pending deletes after processing
            pendingDeletePaths = [];
        }

        // We'll produce the final ordered arrays based on the current combined order in the modal.
        const combinedItems = getCombinedItems();

        // Upload new files if any. IMPORTANT: we need uploaded results in the same order as currentPreviewFiles (which should match ordering in combinedItems where type==='preview').
        let uploadedResults = [];
        if (newFiles && newFiles.length) {
            createModalProgressUI();
            uploadedResults = await uploadImagesToProductFolder(id, newFiles, data.name, 8, (pct) => updateModalProgress(pct));
            removeModalProgressUI();
        }

        // Build maps to find original saved urls/paths by url or path:
        // For saved images currently shown in modal we have currentSavedImageObjs which were built from prod data on openEdit.
        // We'll iterate through combinedItems and for each:
        // - if saved: push its url/path (from currentSavedImageObjs)
        // - if preview: push next uploaded result
        const finalUrls = [];
        const finalPaths = [];
        let uploadPointer = 0;
        for (const it of combinedItems) {
            if (it.type === 'saved') {
                // find saved item in the originally loaded saved objects (currentSavedImageObjs should already reflect the up-to-date saved list and order)
                const found = currentSavedImageObjs.find(s => s.url === it.url && (s.path || '') === (it.path || ''));
                if (found) {
                    finalUrls.push(found.url);
                    finalPaths.push(found.path || '');
                } else {
                    // If not found in currentSavedImageObjs (maybe was originally from DB but lacks path), try to match by url on db arrays
                    // fallback: try finding in imageUrlsFromDb
                    const idx = imageUrlsFromDb.indexOf(it.url);
                    if (idx !== -1) {
                        finalUrls.push(imageUrlsFromDb[idx]);
                        finalPaths.push(imagePathsFromDb[idx] || '');
                    } else {
                        // nothing: skip
                    }
                }
            } else if (it.type === 'preview') {
                // take next uploaded result (if any)
                if (uploadPointer < uploadedResults.length) {
                    finalUrls.push(uploadedResults[uploadPointer].url);
                    finalPaths.push(uploadedResults[uploadPointer].path);
                    uploadPointer++;
                } else {
                    // No uploaded result (shouldn't happen) — ignore
                }
            }
        }

        if ((!finalUrls || !finalUrls.length)) {
            setFieldError(imageFileField, 'Debe tener al menos una imagen asociada al producto');
            return;
        }

        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        await updateDoc(prodRef, {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: priceParsed,
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrls: finalUrls,
            imagePaths: finalPaths,
            sku: data.sku || '',
            updatedAt: serverTimestamp()
        });

        clearAllFieldErrors(productForm);
        showToast('Producto actualizado');
    } catch (err) {
        removeModalProgressUI();
        console.error('updateProduct error', err);
        showToast('Error al actualizar producto');
    }
}

/* ---------- Delete saved image (admin) ---------- */
async function deleteSavedImageFromProduct(productId, imageObj) {
    if (!productId || !imageObj) return false;
    if (!currentUser || currentUserRole !== 'administrador') { showToast('No autorizado'); return false; }
    const path = imageObj.path || imageObj.storagePath || null;
    try {
        if (path) {
            const ref = storageRef(storage, path);
            await deleteObject(ref).catch(() => { /* ignore */ });
        }
        const productRef = doc(db, 'product', productId);
        const snap = await getDoc(productRef);
        if (!snap.exists()) return true;
        const data = snap.data();
        const urls = Array.isArray(data.imageUrls) ? data.imageUrls.filter(u => u !== imageObj.url) : [];
        const paths = Array.isArray(data.imagePaths) ? data.imagePaths.filter(p => p !== (imageObj.path || imageObj.path)) : [];
        await updateDoc(productRef, { imageUrls: urls, imagePaths: paths, updatedAt: serverTimestamp() });
        showToast('Imagen eliminada');
        return true;
    } catch (err) {
        console.error('deleteSavedImageFromProduct error', err);
        showToast('No se pudo eliminar imagen');
        return false;
    }
}

/* ---------- Modal progress UI (insert below dropzone) ---------- */
let modalProgressEl = null;
function createModalProgressUI() {
    removeModalProgressUI();
    modalProgressEl = document.createElement('div');
    modalProgressEl.className = 'modal-progress';
    modalProgressEl.style.marginTop = '8px';
    modalProgressEl.style.display = 'flex';
    modalProgressEl.style.flexDirection = 'column';
    modalProgressEl.style.gap = '6px';

    const barWrap = document.createElement('div');
    barWrap.style.background = '#eef2ff';
    barWrap.style.borderRadius = '8px';
    barWrap.style.height = '10px';
    barWrap.style.overflow = 'hidden';
    const bar = document.createElement('div');
    bar.style.background = '#4f46e5';
    bar.style.height = '100%';
    bar.style.width = '0%';
    bar.style.transition = 'width 150ms linear';
    barWrap.appendChild(bar);

    const statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.alignItems = 'center';
    const percentText = document.createElement('div');
    percentText.textContent = '0%';
    percentText.style.fontSize = '13px';
    percentText.style.color = '#374151';
    statusRow.appendChild(percentText);

    modalProgressEl.appendChild(barWrap);
    modalProgressEl.appendChild(statusRow);

    modalProgressEl.update = (pct) => {
        bar.style.width = `${pct}%`;
        percentText.textContent = `${Math.round(pct)}%`;
    };

    const dropRow = productModal.querySelector('#imageDropZone');
    if (dropRow && dropRow.parentNode) {
        dropRow.parentNode.insertBefore(modalProgressEl, dropRow.nextSibling);
    } else {
        productModal.querySelector('.modal-content')?.appendChild(modalProgressEl);
    }
}
function updateModalProgress(pct) { if (modalProgressEl && typeof modalProgressEl.update === 'function') modalProgressEl.update(pct); }
function removeModalProgressUI() { if (modalProgressEl && modalProgressEl.parentNode) modalProgressEl.parentNode.removeChild(modalProgressEl); modalProgressEl = null; }

/* ---------- Event listeners ---------- */
openAddBtn?.addEventListener('click', openAddModal);
closeModalBtn?.addEventListener('click', () => { productModal.classList.add('hidden'); productModal.setAttribute('aria-hidden', 'true'); clearModalPreviews(); });
cancelBtn?.addEventListener('click', () => { productModal.classList.add('hidden'); productModal.setAttribute('aria-hidden', 'true'); clearModalPreviews(); });

searchInput.addEventListener('input', applyFilters);
stateFilter.addEventListener('change', applyFilters);
offerFilter.addEventListener('change', applyFilters);

// Clear field errors on input
[nameField, descriptionField, priceField, categoryField, statusField, discountField, stockField, imageFileField].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => clearFieldError(el));
});

/* ---------- Form submit ---------- */
productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAllFieldErrors(productForm);

    const name = (nameField.value || '').trim();
    const priceRaw = priceField.value;
    const category = categoryField.value;
    const description = (descriptionField.value || '').trim();
    const status = statusField.value;
    const stockVal = stockField.value;

    if (!name) { setFieldError(nameField, 'El nombre es requerido'); nameField.focus(); return; }
    if (!description) { setFieldError(descriptionField, 'La descripción es requerida'); descriptionField.focus(); return; }
    const priceParsed = parseFormattedPrice(String(priceRaw));
    if (Number.isNaN(priceParsed) || priceParsed <= 0) { setFieldError(priceField, 'Precio inválido (debe ser mayor que 0)'); priceField.focus(); return; }
    if (!category) { setFieldError(categoryField, 'La categoría es requerida'); categoryField.focus(); return; }
    if (!status) { setFieldError(statusField, 'El estado es requerido'); statusField.focus(); return; }
    if (stockVal === '' || Number.isNaN(Number(stockVal)) || Number(stockVal) < 0 || !Number.isInteger(Number(stockVal))) { setFieldError(stockField, 'Stock inválido (entero ≥ 0)'); stockField.focus(); return; }

    if (!isEditing && !skuField.value) skuField.value = generateSKUForCategory(category);

    const data = {
        name,
        description,
        price: priceParsed,
        category,
        status,
        onOffer: onOfferField.checked,
        discount: Number(discountField.value) || 0,
        stock: Number(stockField.value) || 0,
        sku: skuField.value || ''
    };

    // Use the combined order when preparing filesToUpload and saved image arrays.
    const combined = getCombinedItems();
    // For add: all items will be previews (since no saved). For edit: combined may interleave saved + preview.
    // Build filesToUpload in the order they appear in combined (only preview items).
    const filesToUpload = [];
    combined.forEach(it => { if (it.type === 'preview' && it.file) filesToUpload.push(it.file); });

    if (isEditing && editingId) {
        const hasSaved = currentSavedImageObjs && currentSavedImageObjs.length;
        if (!hasSaved && (!filesToUpload || !filesToUpload.length)) {
            setFieldError(imageFileField, 'Debe agregar al menos una imagen');
            return;
        }
        await updateProduct(editingId, data, filesToUpload);
    } else {
        if (!filesToUpload || !filesToUpload.length) {
            setFieldError(imageFileField, 'Se requiere al menos 1 imagen');
            return;
        }
        await addProduct(data, filesToUpload);
    }

    productModal.classList.add('hidden');
    productModal.setAttribute('aria-hidden', 'true');
    clearModalPreviews();
});

/* ---------- Auth & start ---------- */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = new URL('../index.html', window.location.href).toString();
        return;
    }
    currentUser = user;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
        applyUiRestrictions(currentUserRole);
        // ensure discount state reflects onOffer checkbox on start
        setDiscountEnabled(!!onOfferField?.checked);
        // initialize price buffers to zero if empty
        if (!priceIntegerBuffer) { priceIntegerBuffer = '0'; priceDecimalBuffer = ''; priceDecimalMode = false; updatePriceFieldFromBuffers(); }
        startRealtimeListener();
    } catch (err) {
        console.error('Error checking role', err);
        window.location.href = new URL('../index.html', window.location.href).toString();
    }
});

// Modal open/edit functions (moved further down to keep flow consistent)
function openAddModal() {
    if (currentUserRole !== 'administrador') { setFieldError(openAddBtn, 'No autorizado'); return; }
    isEditing = false;
    editingId = null;
    currentSavedImageObjs = [];
    clearModalPreviews();
    modalTitle.textContent = 'Agregar Producto';
    productForm.reset();
    productIdField.value = '';
    skuField.value = '';
    skuField.placeholder = 'Se generará al seleccionar categoría';
    // initialize price buffers to zero
    priceIntegerBuffer = '0';
    priceDecimalBuffer = '';
    priceDecimalMode = false;
    updatePriceFieldFromBuffers();
    if (priceField) { priceField.type = 'text'; priceField.setAttribute('inputmode', 'numeric'); }
    setDiscountEnabled(!!onOfferField?.checked);
    productModal.classList.remove('hidden');
    productModal.setAttribute('aria-hidden', 'false');
}

async function openEditProduct(id) {
    try {
        const snap = await getDoc(doc(db, 'product', id));
        if (!snap.exists()) { showToast('Producto no encontrado'); return; }
        const prod = { id: snap.id, ...snap.data() };
        if (currentUserRole !== 'administrador') { setFieldError(openAddBtn, 'No autorizado'); return; }
        isEditing = true;
        editingId = id;
        modalTitle.textContent = 'Editar Producto';
        productIdField.value = id;
        nameField.value = prod.name || '';
        descriptionField.value = prod.description || '';
        // set price buffers from stored number
        setPriceBuffersFromNumber(Number(prod.price || 0));
        categoryField.value = prod.category || '';
        statusField.value = prod.status || 'Activo';
        onOfferField.checked = !!prod.onOffer;
        discountField.value = prod.discount || 0;
        stockField.value = prod.stock || 0;
        skuField.value = prod.sku || '';
        imageFileField.value = '';

        setDiscountEnabled(!!onOfferField?.checked);

        currentSavedImageObjs = [];
        if (Array.isArray(prod.imageUrls) && prod.imageUrls.length) {
            const urls = prod.imageUrls;
            const paths = Array.isArray(prod.imagePaths) ? prod.imagePaths : [];
            for (let i = 0; i < urls.length; i++) currentSavedImageObjs.push({ url: urls[i], path: paths[i] || '' });
        } else if (prod.imageUrl) {
            currentSavedImageObjs.push({ url: prod.imageUrl, path: '' });
        }
        currentPreviewFiles = [];
        currentPreviewUrls = [];
        pendingDeletePaths = [];
        // render combined slider using internal arrays
        showModalSliderForFiles();
        if (priceField) { priceField.type = 'text'; priceField.setAttribute('inputmode', 'numeric'); }
        productModal.classList.remove('hidden');
        productModal.setAttribute('aria-hidden', 'false');
    } catch (err) {
        console.error('openEdit error', err);
        showToast('Error abriendo producto');
    }
}