// assets/js/admin-product-quick.js
// Quick "Crear producto" action for administrador.html (con validaciones inline y precio > 0)
// - Inserta modal de creación en admin, preview/drag-drop, optimiza y sube imágenes.
// - Validaciones inline: nombre, descripción, precio (>0), categoría, estado, stock (entero >=0), y al menos 1 foto.
// - Precio se formatea con miles y decimales (ej. 9,014.66). Input forzado a text + inputmode decimal.
// - Muestra modal de confirmación con resumen y slider tras creación.
//
// Requiere: firebase-config.js, image-utils.js, storage rules.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, addDoc, doc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

import { optimizarImagen } from './image-utils.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let currentUser = null;
let currentUserRole = null;

// Helpers
function showToast(msg, ms = 3000) {
    const toast = document.getElementById('toast');
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
function formatPriceDisplay(num) {
    if (num === undefined || num === null || num === '') return '';
    const n = Number(num);
    if (Number.isNaN(n)) return '';
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function parseFormattedPrice(str) {
    if (str === undefined || str === null) return NaN;
    const withoutCommas = String(str).replace(/,/g, '');
    const v = parseFloat(withoutCommas);
    return Number.isNaN(v) ? NaN : v;
}
const CATEGORY_PREFIX = {
    "Ropa": "ROP",
    "Electrónica": "ELE",
    "Hogar": "HOG",
    "Accesorios": "ACC"
};
function generateSKUForCategory(category) {
    const prefix = CATEGORY_PREFIX[category] || (category ? category.slice(0, 3).toUpperCase() : 'PRD');
    const timePortion = String(Date.now()).slice(-6);
    const rnd = Math.random().toString(36).slice(-4).toUpperCase();
    return `${prefix}-${timePortion}${rnd}`;
}

/* ---------- Inline field error helpers (DOM) ---------- */
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

/* ---------- DOM insertion: product modal ---------- */
const PRODUCT_MODAL_ID = 'adminQuick_productModal';
function ensureProductModalExists() {
    if (document.getElementById(PRODUCT_MODAL_ID)) return;

    const container = document.createElement('div');
    container.innerHTML = `
    <div id="${PRODUCT_MODAL_ID}" class="modal hidden" aria-hidden="true" role="dialog" aria-modal="true">
        <div class="modal-content modal-lg">
            <header class="modal-header">
                <h2 id="modalTitle">Agregar Producto</h2>
                <button id="closeModalQuick" class="close-btn" aria-label="Cerrar">&times;</button>
            </header>

            <form id="productFormQuick" class="modal-form" novalidate>
                <input type="hidden" id="productIdQuick" />
                <div class="form-row">
                    <label>Nombre <span class="required">*</span></label>
                    <input id="nameQuick" type="text" required />
                </div>

                <div class="form-row">
                    <label>Descripción</label>
                    <textarea id="descriptionQuick" rows="3"></textarea>
                </div>

                <div class="form-row">
                    <label>Precio <span class="required">*</span></label>
                    <input id="priceQuick" type="text" inputmode="decimal" placeholder="0.00" />
                </div>

                <div class="form-row inline">
                    <div>
                        <label>Categoría <span class="required">*</span></label>
                        <select id="categoryQuick" required>
                            <option value="">Seleccionar categoría</option>
                            <option>Ropa</option>
                            <option>Electrónica</option>
                            <option>Hogar</option>
                            <option>Accesorios</option>
                        </select>
                    </div>

                    <div>
                        <label>Estado</label>
                        <select id="statusQuick">
                            <option>Activo</option>
                            <option>Inactivo</option>
                        </select>
                    </div>
                </div>

                <div class="form-row inline">
                    <label class="checkbox-row">
                        <input id="onOfferQuick" type="checkbox" />
                        <span>En oferta</span>
                    </label>

                    <div>
                        <label>Descuento (%)</label>
                        <input id="discountQuick" type="number" min="0" max="100" value="0" />
                    </div>

                    <div>
                        <label>Stock</label>
                        <input id="stockQuick" type="number" min="0" value="0" />
                    </div>
                </div>

                <div class="form-row">
                    <label>Imágenes (arrastra o selecciona hasta 8) <span class="muted"
                            style="font-weight:400">mínimo 1, ideal 4</span></label>

                    <div id="imageDropZoneQuick" class="image-dropzone" aria-label="Arrastra imágenes aquí">
                        <input id="imageFileQuick" type="file" accept="image/*" multiple />
                        <div class="dz-instructions">
                            Arrastra imágenes o haz click para seleccionar (máx. 8)
                        </div>
                    </div>

                    <div id="imagePreviewSliderQuick" class="image-slider hidden" aria-hidden="true">
                        <button type="button" id="prevSlideQuick" class="slide-btn">‹</button>
                        <div class="slide-track" id="slideTrackQuick"></div>
                        <button type="button" id="nextSlideQuick" class="slide-btn">›</button>
                    </div>
                </div>

                <div class="form-row">
                    <label>SKU <small>(generado automáticamente según categoría)</small></label>
                    <input id="skuQuick" type="text" readonly placeholder="Se generará al seleccionar categoría" />
                </div>

                <div class="form-actions">
                    <button type="submit" class="btn-primary">Guardar</button>
                    <button type="button" id="cancelBtnQuick" class="btn-secondary">Cancelar</button>
                </div>
            </form>
        </div>
    </div>
    `;
    document.body.appendChild(container);
}

/* ---------- Confirmation modal after create ---------- */
const CREATED_MODAL_ID = 'adminQuick_createdModal';
function createCreatedModal() {
    const existing = document.getElementById(CREATED_MODAL_ID);
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
    <div id="${CREATED_MODAL_ID}" class="modal hidden" aria-hidden="true" role="dialog" aria-modal="true">
        <div class="modal-content modal-md">
            <header class="modal-header">
                <h2 id="createdModalTitle">Producto creado</h2>
                <button id="closeCreatedModal" class="close-btn" aria-label="Cerrar">&times;</button>
            </header>
            <div class="modal-body" style="padding:12px;">
                <div id="createdSummary" style="display:flex;gap:12px;align-items:flex-start;">
                    <div id="createdSliderWrap" style="width:40%;max-width:180px;"></div>
                    <div style="flex:1;">
                        <table id="createdTable" style="width:100%;border-collapse:collapse;">
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px;">
                <button id="viewAllProductsBtn" class="btn-secondary">Ver todos los productos</button>
                <button id="closeCreatedBtn" class="btn-primary">Cerrar</button>
            </div>
        </div>
    </div>
    `;
    document.body.appendChild(wrapper);
}

/* ---------- Image preview / slider (modal) ---------- */
let currentPreviewFiles = [];
let currentPreviewUrls = [];

function clearQuickPreviews() {
    currentPreviewFiles = [];
    currentPreviewUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { } });
    currentPreviewUrls = [];
    const track = document.getElementById('slideTrackQuick');
    if (track) track.innerHTML = '';
    const slider = document.getElementById('imagePreviewSliderQuick');
    if (slider) { slider.classList.add('hidden'); slider.setAttribute('aria-hidden', 'true'); }
    clearAllFieldErrors(document.getElementById('productFormQuick'));
}

function showQuickModalSlider(urls) {
    const track = document.getElementById('slideTrackQuick');
    if (!track) return;
    track.innerHTML = '';
    const slider = document.getElementById('imagePreviewSliderQuick');
    if (!urls || !urls.length) {
        slider.classList.add('hidden');
        slider.setAttribute('aria-hidden', 'true');
        return;
    }
    slider.classList.remove('hidden');
    slider.setAttribute('aria-hidden', 'false');
    urls.forEach(u => {
        const node = document.createElement('div');
        node.className = 'slide-item';
        node.style.display = 'inline-block';
        node.style.width = '96px';
        node.style.height = '96px';
        node.style.marginRight = '6px';
        node.style.overflow = 'hidden';
        node.style.borderRadius = '6px';
        const img = document.createElement('img');
        img.src = u;
        img.alt = 'preview';
        img.loading = 'lazy';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        node.appendChild(img);
        track.appendChild(node);
    });
    track.scrollLeft = 0;
}

/* ---------- Upload helper ---------- */
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

/* ---------- Modal progress UI ---------- */
let modalProgressElQuick = null;
function createModalProgressUIQuick() {
    removeModalProgressUIQuick();
    modalProgressElQuick = document.createElement('div');
    modalProgressElQuick.className = 'modal-progress';
    modalProgressElQuick.style.marginTop = '8px';
    modalProgressElQuick.style.display = 'flex';
    modalProgressElQuick.style.flexDirection = 'column';
    modalProgressElQuick.style.gap = '6px';

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

    modalProgressElQuick.appendChild(barWrap);
    modalProgressElQuick.appendChild(statusRow);

    modalProgressElQuick.update = (pct) => {
        bar.style.width = `${pct}%`;
        percentText.textContent = `${Math.round(pct)}%`;
    };

    const dropRow = document.getElementById('imageDropZoneQuick');
    if (dropRow && dropRow.parentNode) {
        dropRow.parentNode.insertBefore(modalProgressElQuick, dropRow.nextSibling);
    } else {
        document.querySelector('body')?.appendChild(modalProgressElQuick);
    }
}
function updateModalProgressQuick(pct) { if (modalProgressElQuick && typeof modalProgressElQuick.update === 'function') modalProgressElQuick.update(pct); }
function removeModalProgressUIQuick() { if (modalProgressElQuick && modalProgressElQuick.parentNode) modalProgressElQuick.parentNode.removeChild(modalProgressElQuick); modalProgressElQuick = null; }

/* ---------- Add product logic ---------- */
const productsCol = collection(db, 'product');

async function addProductQuick(data, files) {
    if (!currentUser) { showToast('No autenticado'); return null; }
    if (currentUserRole !== 'administrador') { showToast('No autorizado'); return null; }

    clearAllFieldErrors(document.getElementById('productFormQuick'));

    // Required validation
    if (!data.name || !data.name.trim()) { setFieldError('nameQuick', 'El nombre es requerido'); return null; }
    if (!data.description || !data.description.trim()) { setFieldError('descriptionQuick', 'La descripción es requerida'); return null; }
    const priceParsed = parseFormattedPrice(String(data.price));
    if (Number.isNaN(priceParsed) || priceParsed <= 0) { setFieldError('priceQuick', 'Precio inválido (debe ser mayor que 0)'); return null; }
    if (!data.category) { setFieldError('categoryQuick', 'La categoría es requerida'); return null; }
    if (!data.status) { setFieldError('statusQuick', 'El estado es requerido'); return null; }
    if (data.stock === '' || data.stock === null || Number.isNaN(Number(data.stock)) || Number(data.stock) < 0 || !Number.isInteger(Number(data.stock))) { setFieldError('stockQuick', 'Stock inválido (entero ≥ 0)'); return null; }

    const minImages = 1;
    const filesCount = (files && files.length) ? files.length : 0;
    if (filesCount < minImages) {
        setFieldError('imageFileQuick', `Se requiere al menos ${minImages} imagen(es) (seleccionadas: ${filesCount})`);
        return null;
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

        // upload
        createModalProgressUIQuick();
        const uploaded = await uploadImagesToProductFolder(productId, files, data.name, 8, (pct) => updateModalProgressQuick(pct));
        removeModalProgressUIQuick();

        const urls = uploaded.map(x => x.url);
        const paths = uploaded.map(x => x.path);

        await updateDoc(doc(db, 'product', productId), { imageUrls: urls, imagePaths: paths, updatedAt: serverTimestamp() });

        clearAllFieldErrors(document.getElementById('productFormQuick'));
        return { id: productId, ...newDoc, imageUrls: urls, imagePaths: paths };
    } catch (err) {
        removeModalProgressUIQuick();
        console.error('addProductQuick error', err);
        showToast('Error al agregar producto');
        return null;
    }
}

/* ---------- Wire up interactions ---------- */
function wireQuickModalLogic() {
    const modal = document.getElementById(PRODUCT_MODAL_ID);
    const form = document.getElementById('productFormQuick');
    const closeBtn = document.getElementById('closeModalQuick');
    const cancelBtn = document.getElementById('cancelBtnQuick');

    const nameField = document.getElementById('nameQuick');
    const descriptionField = document.getElementById('descriptionQuick');
    const priceField = document.getElementById('priceQuick');
    const categoryField = document.getElementById('categoryQuick');
    const statusField = document.getElementById('statusQuick');
    const onOfferField = document.getElementById('onOfferQuick');
    const discountField = document.getElementById('discountQuick');
    const stockField = document.getElementById('stockQuick');
    const skuField = document.getElementById('skuQuick');

    const imageFileField = document.getElementById('imageFileQuick');
    const imageDropZone = document.getElementById('imageDropZoneQuick');

    // open/close
    function openModal() {
        if (currentUserRole !== 'administrador') { setFieldError('nameQuick', 'No autorizado'); return; }
        clearQuickPreviews();
        form.reset();
        skuField.value = '';
        // ensure price input accepts formatted value
        if (priceField) { priceField.type = 'text'; priceField.setAttribute('inputmode', 'decimal'); }
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    }
    function closeModal() {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        clearQuickPreviews();
    }

    // attach to quick-action button
    const quickBtn = document.querySelector('[data-action="crear-producto"]');
    if (quickBtn) quickBtn.addEventListener('click', (e) => { e.preventDefault(); openModal(); });

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // category -> sku generation
    categoryField?.addEventListener('change', () => {
        if (!skuField.value) skuField.value = generateSKUForCategory(categoryField.value);
    });

    // price format: on focus remove format, on blur apply format
    priceField?.addEventListener('focus', () => {
        const raw = priceField.value;
        if (!raw) return;
        const n = parseFormattedPrice(raw);
        if (!Number.isNaN(n)) priceField.value = n.toString();
        clearFieldError(priceField);
    });
    priceField?.addEventListener('blur', () => {
        const raw = priceField.value;
        if (raw === '' || raw === null) { priceField.value = ''; return; }
        const n = parseFormattedPrice(raw);
        if (!Number.isNaN(n)) priceField.value = formatPriceDisplay(n);
        else setFieldError(priceField, 'Precio inválido');
    });

    // clear errors on input
    [nameField, descriptionField, priceField, categoryField, statusField, discountField, stockField, imageFileField].forEach(el => {
        if (!el) return;
        el.addEventListener('input', () => clearFieldError(el));
    });

    // preview handling
    imageFileField?.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []).slice(0, 8);
        currentPreviewFiles = currentPreviewFiles.concat(files);
        const urls = files.map(f => URL.createObjectURL(f));
        currentPreviewUrls = currentPreviewUrls.concat(urls);
        showQuickModalSlider(currentPreviewUrls);
    });

    imageDropZone?.addEventListener('click', () => imageFileField.click());
    imageDropZone?.addEventListener('dragover', (e) => { e.preventDefault(); imageDropZone.classList.add('dragover'); });
    imageDropZone?.addEventListener('dragleave', () => imageDropZone.classList.remove('dragover'));
    imageDropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        imageDropZone.classList.remove('dragover');
        const dtFiles = Array.from(e.dataTransfer.files || []).slice(0, 8);
        currentPreviewFiles = currentPreviewFiles.concat(dtFiles);
        const urls = dtFiles.map(f => URL.createObjectURL(f));
        currentPreviewUrls = currentPreviewUrls.concat(urls);
        showQuickModalSlider(currentPreviewUrls);
    });

    // slider nav (scroll left/right)
    document.getElementById('prevSlideQuick')?.addEventListener('click', () => {
        const t = document.getElementById('slideTrackQuick'); if (t) t.scrollLeft -= 120;
    });
    document.getElementById('nextSlideQuick')?.addEventListener('click', () => {
        const t = document.getElementById('slideTrackQuick'); if (t) t.scrollLeft += 120;
    });

    // submit
    form?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearAllFieldErrors(form);

        const name = (nameField.value || '').trim();
        const priceRaw = priceField.value;
        const priceParsed = parseFormattedPrice(String(priceRaw));
        const category = categoryField.value;
        const description = (descriptionField.value || '').trim();
        const status = statusField.value;
        const stockVal = stockField.value;

        // Basic validation
        if (!name) { setFieldError(nameField, 'El nombre es requerido'); nameField.focus(); return; }
        if (!description) { setFieldError(descriptionField, 'La descripción es requerida'); descriptionField.focus(); return; }
        if (priceRaw === '' || Number.isNaN(priceParsed) || priceParsed <= 0) { setFieldError(priceField, 'Precio inválido (debe ser mayor que 0)'); priceField.focus(); return; }
        if (!category) { setFieldError(categoryField, 'La categoría es requerida'); categoryField.focus(); return; }
        if (!status) { setFieldError(statusField, 'El estado es requerido'); statusField.focus(); return; }
        if (stockVal === '' || Number.isNaN(Number(stockVal)) || Number(stockVal) < 0 || !Number.isInteger(Number(stockVal))) { setFieldError(stockField, 'Stock inválido (entero ≥ 0)'); stockField.focus(); return; }

        if (!skuField.value) skuField.value = generateSKUForCategory(category);

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

        const filesToUpload = currentPreviewFiles.slice();

        const created = await addProductQuick(data, filesToUpload);
        if (!created) return;

        // hide add modal
        closeModal();

        // show created modal with summary
        createCreatedModal();
        const cm = document.getElementById(CREATED_MODAL_ID);
        const closeCreated = document.getElementById('closeCreatedModal');
        const closeCreatedBtn = document.getElementById('closeCreatedBtn');
        const viewAllBtn = document.getElementById('viewAllProductsBtn');

        // build table
        const tbody = document.querySelector('#createdTable tbody');
        tbody.innerHTML = '';
        const rows = [
            ['Nombre', escapeHtml(created.name)],
            ['Precio', formatPriceDisplay(created.price)],
            ['Categoría', escapeHtml(created.category)],
            ['SKU', escapeHtml(created.sku)],
            ['Stock', String(created.stock || 0)],
            ['Estado', escapeHtml(created.status || '')],
            ['En oferta', created.onOffer ? 'Sí' : 'No'],
            ['Descuento', created.onOffer ? `${created.discount || 0}%` : '-']
        ];
        rows.forEach(r => {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.style.textAlign = 'left';
            th.style.padding = '4px 6px';
            th.style.width = '36%';
            th.textContent = r[0];
            const td = document.createElement('td');
            td.style.padding = '4px 6px';
            td.textContent = r[1];
            tr.appendChild(th);
            tr.appendChild(td);
            tbody.appendChild(tr);
        });

        // slider (use simple large preview)
        const sliderWrap = document.getElementById('createdSliderWrap');
        sliderWrap.innerHTML = '';
        if (Array.isArray(created.imageUrls) && created.imageUrls.length) {
            const img = document.createElement('img');
            img.src = created.imageUrls[0];
            img.alt = created.name;
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.borderRadius = '8px';
            img.style.objectFit = 'cover';
            sliderWrap.appendChild(img);

            // small dots / mini-thumbs
            if (created.imageUrls.length > 1) {
                const mini = document.createElement('div');
                mini.style.display = 'flex';
                mini.style.gap = '6px';
                mini.style.marginTop = '8px';
                created.imageUrls.slice(0, 4).forEach(u => {
                    const d = document.createElement('div');
                    d.style.width = '40px'; d.style.height = '40px'; d.style.overflow = 'hidden'; d.style.borderRadius = '6px';
                    const im = document.createElement('img'); im.src = u; im.style.width = '100%'; im.style.height = '100%'; im.style.objectFit = 'cover';
                    d.appendChild(im); mini.appendChild(d);
                });
                sliderWrap.appendChild(mini);
            }
        }

        // show created modal
        if (cm) {
            cm.classList.remove('hidden');
            cm.setAttribute('aria-hidden', 'false');
        }

        const closeCreatedCommon = () => {
            cm?.classList.add('hidden'); cm?.setAttribute('aria-hidden', 'true');
            setTimeout(() => { const el = document.getElementById(CREATED_MODAL_ID); if (el) el.remove(); }, 300);
        };
        closeCreated?.addEventListener('click', closeCreatedCommon);
        closeCreatedBtn?.addEventListener('click', closeCreatedCommon);
        viewAllBtn?.addEventListener('click', () => { window.location.href = new URL('product.html', window.location.href).toString(); });
    });
}

/* ---------- Auth & startup ---------- */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        currentUser = null;
        currentUserRole = null;
        return;
    }
    currentUser = user;
    try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        currentUserRole = userDoc.exists() ? (userDoc.data().role || 'vendedor') : 'vendedor';
    } catch (err) {
        console.error('Error checking role (quick)', err);
        currentUserRole = 'vendedor';
    }
});

// initialize modal & event wiring after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    ensureProductModalExists();
    wireQuickModalLogic();
});