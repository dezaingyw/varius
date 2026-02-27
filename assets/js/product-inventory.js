import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-storage.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const auth = getAuth(app);
signInAnonymously(auth)
    .then(() => {
        console.log("Usuario autenticado anónimamente");
    })
    .catch((error) => {
        console.error("Error autenticando:", error);
    });

let productos = [];
let paginaActual = 1;
const itemsPorPagina = 20;
let sliderInterval;

// --- DROPZONE MANEJO DE IMÁGENES ---
let currentImages = []; // {file, url, isUploaded, progress, storageUrl}

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewContainer = document.getElementById('previewContainer');

if (dropzone && fileInput && previewContainer) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => {
        e.preventDefault();
        dropzone.classList.add('dropzone-active');
    });
    dropzone.addEventListener('dragleave', e => {
        e.preventDefault();
        dropzone.classList.remove('dropzone-active');
    });
    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dropzone-active');
        processFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => processFiles(fileInput.files));
}

async function processFiles(fileList) {
    for (let file of fileList) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > 10 * 1024 * 1024) {
            alert('La imagen es muy grande (máx 10MB).');
            continue;
        }
        const compressedFile = await imageCompression(file, {
            maxSizeMB: 0.2,
            maxWidthOrHeight: 1280,
            useWebWorker: true
        });
        const localUrl = URL.createObjectURL(compressedFile);
        currentImages.push({ file: compressedFile, url: localUrl, isUploaded: false, progress: 0, storageUrl: null });
    }
    renderPreviewImages();
}

function renderPreviewImages() {
    previewContainer.innerHTML = '';
    currentImages.forEach((imgObj, idx) => {
        const div = document.createElement('div');
        div.className = 'image-preview-card relative w-24 h-24 flex-shrink-0 rounded-lg overflow-hidden shadow border border-slate-200 flex items-center justify-center group';

        // Imagen
        const image = document.createElement('img');
        image.className = 'object-cover w-full h-full';
        image.src = imgObj.url;
        div.appendChild(image);

        // Remove button
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Eliminar';
        btn.className = 'remove-btn absolute top-0 right-0 flex items-center justify-center w-7 h-7 rounded-br-lg rounded-tl-lg bg-red-600 bg-opacity-80 text-white text-xs z-10';
        btn.innerHTML = '<i class="fas fa-times"></i>';
        btn.onclick = () => {
            URL.revokeObjectURL(imgObj.url);
            currentImages.splice(idx, 1);
            renderPreviewImages();
        };
        div.appendChild(btn);

        // Barra de carga
        if (imgObj.progress && imgObj.progress < 100) {
            const progress = document.createElement('div');
            progress.className = 'absolute bottom-0 left-0 h-2 bg-blue-500';
            progress.style.width = `${imgObj.progress}%`;
            div.appendChild(progress);
        }
        previewContainer.appendChild(div);
    });

    // Drag & drop para reorganizar
    if (currentImages.length > 1) {
        Sortable.create(previewContainer, {
            animation: 180,
            onEnd: (e) => {
                const moved = currentImages.splice(e.oldIndex, 1)[0];
                currentImages.splice(e.newIndex, 0, moved);
                renderPreviewImages();
            }
        });
    }
}

async function subirTodasLasImagenes(productSkuOrId) {
    let urlsFinales = [];
    if (!auth.currentUser) {
        await signInAnonymously(auth);
    }
    for (let i = 0; i < currentImages.length; i++) {
        let imgObj = currentImages[i];
        if (!imgObj.isUploaded) {
            const imgRef = storageRef(storage, `products/${productSkuOrId}/${Date.now()}_${i}.jpg`);
            await new Promise((resolve, reject) => {
                const uploadTask = uploadBytesResumable(imgRef, imgObj.file);
                uploadTask.on('state_changed', (snap) => {
                    imgObj.progress = Math.floor((snap.bytesTransferred / snap.totalBytes) * 100);
                    renderPreviewImages();
                }, reject, async () => {
                    imgObj.isUploaded = true;
                    imgObj.progress = 100;
                    imgObj.storageUrl = await getDownloadURL(uploadTask.snapshot.ref);
                    urlsFinales[i] = imgObj.storageUrl;
                    renderPreviewImages();
                    resolve();
                });
            });
        } else {
            urlsFinales[i] = imgObj.storageUrl || imgObj.url;
        }
    }
    return urlsFinales;
}

// --- FUNCIONES DE COPIADO ---
function buildAddLinkForPublic(productId) {
    const origin = window.location.origin;
    const publicPath = '/carrito.html';
    const params = new URLSearchParams({
        add: productId,
        openCart: '1',
        hideProducts: '1',
        utm_source: 'instagram'
    });
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
        mostrarModalExito("¡Enlace copiado!", "El enlace ha sido copiado al portapapeles.");
    } catch (err) {
        console.error('copy error', err);
        alert('No se pudo copiar enlace');
    }
}

// Obtiene productos desde Firestore
async function cargarProductosFirebase() {
    try {
        const col = collection(db, "product");
        const snapshot = await getDocs(col);
        const productosData = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            productosData.push({
                id: doc.id,
                name: data.name || "Sin nombre",
                sku: data.sku || "N/A",
                category: data.category || "General",
                price: data.price || 0,
                stock: data.stock || 0,
                status: (data.status || "Activo").toUpperCase(),
                offer: data.offer || data.discount || 0,
                images: (data.imageUrls && data.imageUrls.length > 0) ? data.imageUrls : ["https://via.placeholder.com/400x300"],
                description: data.description || ""
            });
        });
        return productosData;
    } catch (error) {
        console.error("Error cargando Firebase:", error);
        return [];
    }
}

// -- NUEVO: Cargar sólo categorías activas --
async function cargarCategoriasDesdeFirebase() {
    try {
        const categoriaRef = collection(db, "category");
        const snapshot = await getDocs(categoriaRef);
        const categorias = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.active) {
                categorias.push({
                    id: doc.id,
                    name: data.name || "Sin nombre",
                    color: data.color || "",
                    desc: data.desc || ""
                });
            }
        });
        return categorias;
    } catch (error) {
        console.error("Error cargando categorías:", error);
        return [];
    }
}

// -- Poblar selects de categorías (filtro y form) --
async function poblarCategorias() {
    const categorias = await cargarCategoriasDesdeFirebase();

    // Para filtro
    const selectFiltro = document.getElementById('categoryFilter');
    if (selectFiltro) {
        selectFiltro.innerHTML = '<option value="">Todas las Categorías</option>';
        categorias.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat.name;
            option.textContent = cat.name;
            selectFiltro.appendChild(option);
        });
    }

    // Para formulario
    const selectForm = document.querySelector('#productForm select[name="category"]');
    if (selectForm) {
        selectForm.innerHTML = '';
        categorias.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat.name;
            option.textContent = cat.name;
            selectForm.appendChild(option);
        });
        // Valor inicial
        if (!selectForm.value || !categorias.some(cat => cat.name === selectForm.value)) {
            selectForm.value = categorias[0]?.name || "";
        }
    }
}

function renderizarTabla(datos = productos) {
    const tbody = document.getElementById('productTableBody');
    if (!tbody) return;

    clearInterval(sliderInterval);

    const inicio = (paginaActual - 1) * itemsPorPagina;
    const fin = inicio + itemsPorPagina;
    const dataPagina = datos.slice(inicio, fin);

    tbody.innerHTML = '';
    dataPagina.forEach(p => {
        let claseFila = '';
        const statusU = p.status.toUpperCase();
        if (['SUSPENDED', 'PAUSADO', 'SUSPENDIDO'].includes(statusU)) claseFila = 'row-suspended';
        else if (p.stock === 0) claseFila = 'row-out-of-stock';
        else if (p.stock < 5) claseFila = 'row-low-stock';

        const fotosHTML = p.images.map((img, idx) =>
            `<img src="${img}" class="${idx === 0 ? 'active' : ''} w-12 h-12 rounded-lg object-cover absolute top-0 left-0 transition-opacity duration-1000">`
        ).join('');

        tbody.innerHTML += `
            <tr class="border-b border-slate-50 transition-all ${claseFila}">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-4">
                        <div class="img-slider relative w-12 h-12 flex-shrink-0 cursor-pointer overflow-hidden rounded-lg shadow-sm" 
                             onclick='abrirGaleria(${JSON.stringify(p.images)})'>
                            ${fotosHTML}
                        </div>
                        <div>
                            <div class="font-medium text-slate-800">${p.name}</div>
                            <div class="text-[10px] text-slate-400 font-bold uppercase">${p.sku}</div>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4 text-slate-500 text-sm font-medium">${p.category}</td>
                <td class="px-6 py-4">
                    <div class="font-bold text-slate-800">$ ${(typeof p.price === 'number' ? p.price : 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}</div>
                    ${p.offer ? `<span class="text-[10px] font-bold text-emerald-500">-${p.offer}% Rebajado</span>` : ''}
                </td>
                <td class="px-6 py-4">
                    <span class="font-bold ${p.stock === 0 ? 'text-red-500' : 'text-slate-700'}">${p.stock} Und</span>
                </td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-[10px] font-extrabold ${getEstiloEstado(p.status)}">
                        ${traducirEstado(p.status)}
                    </span>
                </td>
                <td class="px-6 py-4">
                    <div class="flex justify-center gap-2">
                        <button onclick="copyProductLink('${p.id}')" title="Copiar enlace" class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all"><i class="fas fa-link text-xs"></i></button>
                        <button onclick="abrirModal('edit', '${p.id}')" class="w-8 h-8 rounded-lg bg-blue-50 text-blue-500 hover:bg-blue-500 hover:text-white transition-all"><i class="fas fa-pen text-xs"></i></button>
                        <button onclick="suspender('${p.id}')" class="w-8 h-8 rounded-lg bg-red-50 text-red-400 hover:bg-red-500 hover:text-white transition-all"><i class="fas fa-ban text-xs"></i></button>
                    </div>
                </td>
            </tr>
        `;
    });

    iniciarAutoplaySliders();
    actualizarPaginacion(datos.length);
    actualizarMetricas(datos);
}

function iniciarAutoplaySliders() {
    sliderInterval = setInterval(() => {
        document.querySelectorAll('.img-slider').forEach(slider => {
            const imgs = slider.querySelectorAll('img');
            if (imgs.length <= 1) return;
            let activeIdx = Array.from(imgs).findIndex(img => img.classList.contains('active'));
            imgs[activeIdx].classList.remove('active');
            imgs[activeIdx].style.opacity = "0";
            let nextIdx = (activeIdx + 1) % imgs.length;
            imgs[nextIdx].classList.add('active');
            imgs[nextIdx].style.opacity = "1";
        });
    }, 3000);
}

function aplicarFiltros() {
    const busqueda = document.getElementById('searchInput').value.toLowerCase();
    const categoria = document.getElementById('categoryFilter').value;

    const filtrados = productos.filter(p => {
        const coincideNombre = p.name.toLowerCase().includes(busqueda) || p.sku.toLowerCase().includes(busqueda);
        const coincideCategoria = categoria === "" || p.category === categoria;
        return coincideNombre && coincideCategoria;
    });

    paginaActual = 1;
    renderizarTabla(filtrados);
}

function limpiarFiltros() {
    document.getElementById('searchInput').value = '';
    document.getElementById('categoryFilter').value = '';
    paginaActual = 1;
    renderizarTabla(productos);
}

// --- FUNCIONES DE MODAL ---
function abrirModal(tipo, id = null) {
    const m = document.getElementById('productModal');
    const form = document.getElementById('productForm');
    form.reset();
    currentImages = [];
    renderPreviewImages();
    form.removeAttribute('data-type');
    form.removeAttribute('data-id');
    document.getElementById('previewContainer').innerHTML = '';
    m.classList.remove('hidden');
    poblarCategorias().then(() => {
        if (tipo === 'edit' && id) {
            const p = productos.find(pr => pr.id === id);
            if (!p) return;
            form.name.value = p.name;
            form.description.value = p.description;
            form.category.value = p.category;
            form.status.value = p.status || 'ACTIVE';
            form.sku.value = p.sku;
            form.price.value = p.price.toLocaleString('de-DE', { minimumFractionDigits: 2 });
            form.stock.value = p.stock;
            if (p.offer > 0) {
                form.isOffer.checked = true;
                document.getElementById('offerInputContainer').style.display = 'block';
                form.discount.value = p.offer;
            } else {
                form.isOffer.checked = false;
                document.getElementById('offerInputContainer').style.display = 'none';
                form.discount.value = '';
            }
            if (p.images && p.images.length > 0) {
                for (let imgUrl of p.images) {
                    currentImages.push({ file: null, url: imgUrl, isUploaded: true, progress: 100, storageUrl: imgUrl });
                }
                renderPreviewImages();
            }
            form.setAttribute('data-type', 'edit');
            form.setAttribute('data-id', id);
            document.getElementById('modalTitle').innerText = "Editar este producto";
        } else {
            actualizarSKU(); // genera SKU sólo en modo "add"
            document.getElementById('modalTitle').innerText = "Meter Producto Nuevo";
        }
    });
}

function cerrarModal() {
    document.getElementById('productModal').classList.add('hidden');
    currentImages.forEach(img => img.file && URL.revokeObjectURL(img.url));
    currentImages = [];
    renderPreviewImages();
    document.getElementById('productForm').reset();
    document.getElementById('offerInputContainer').style.display = 'none';
}

// Guardar producto (Nuevo + Editar) ★★★★★
document.getElementById('productForm').onsubmit = async function (e) {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());

    // SKU SIEMPRE del input (así no se pierde)
    data.sku = document.getElementById('skuInput').value;

    // Campo oferta
    data.offer = form.isOffer?.checked ? parseInt(data.discount || "0") : 0;
    delete data.isOffer;
    delete data.discount;

    // Numéricos bien
    data.stock = parseInt(data.stock || "0");
    data.price = parseFloat((data.price || "0").replace(/\./g, "").replace(",", "."));

    let productId = data.sku || (Math.random() + '').slice(2);
    let imageUrls = await subirTodasLasImagenes(productId);
    data.imageUrls = imageUrls;

    try {
        if (form.getAttribute('data-type') === 'edit') {
            const id = form.getAttribute('data-id');
            await updateDoc(doc(db, "product", id), data);
            mostrarModalExito("¡Actualización exitosa!", "El producto se ha actualizado correctamente.");
        } else {
            await addDoc(collection(db, "product"), data);
            mostrarModalExito("¡Guardado exitoso!", "El producto se ha guardado correctamente.");
        }
        cerrarModal();
        productos = await cargarProductosFirebase();
        await poblarCategorias();
        renderizarTabla();
        currentImages = [];
        renderPreviewImages();
    } catch (err) {
        alert("Error guardando producto: " + (err?.message ?? err));
    }
};

// --- MODAL DE ÉXITO ---
function mostrarModalExito(titulo = "¡Guardado exitoso!", mensaje = "El producto se ha guardado correctamente.") {
    document.getElementById('modal-success-title').innerText = titulo;
    document.getElementById('modal-success-body').innerText = mensaje;
    document.getElementById('modal-success').classList.remove('hidden');
}
function ocultarModalExito() {
    document.getElementById('modal-success').classList.add('hidden');
}

// --- OTROS HELPERS ---
function actualizarSKU() {
    const select = document.querySelector('#productForm select[name="category"]');
    let cat = select?.value?.trim() || "";
    if (!cat) {
        document.getElementById('skuInput').value = "";
        return;
    }
    // SKU: 3 letras mayúsculas de categoría sin tildes, -número 6 cifras, 4 random mayúsculas/números
    let prefix = cat.normalize("NFD").replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
    if (prefix.length < 3) prefix = (prefix + 'XXX').slice(0, 3);
    const num = Math.floor(100000 + Math.random() * 900000); // 6 cifras
    const sufijo = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 caracteres
    document.getElementById('skuInput').value = `${prefix}-${num}${sufijo}`;
}

function traducirEstado(est) {
    const m = { 'ACTIVE': 'ACTIVO', 'ACTIVO': 'ACTIVO', 'INACTIVE': 'INACTIVO', 'INACTIVO': 'INACTIVO', 'SUSPENDED': 'PAUSADO', 'PAUSADO': 'PAUSADO', 'SUSPENDIDO': 'PAUSADO' };
    return m[est.toUpperCase()] || est;
}

function getEstiloEstado(est) {
    const u = est.toUpperCase();
    if (['ACTIVE', 'ACTIVO'].includes(u)) return 'bg-emerald-100 text-emerald-600';
    if (['INACTIVE', 'INACTIVO'].includes(u)) return 'bg-slate-100 text-slate-400';
    return 'bg-red-100 text-red-600';
}

function formatearPrecio(input) {
    let valor = input.value.replace(/\D/g, "");
    let n = parseFloat(valor) / 100;
    if (isNaN(n)) n = 0;
    input.value = n.toLocaleString('de-DE', { minimumFractionDigits: 2 });
}

function toggleOferta(check) {
    document.getElementById('offerInputContainer').style.display = check.checked ? 'block' : 'none';
}

function suspender(id) {
    const p = productos.find(x => x.id === id);
    if (p) {
        const u = p.status.toUpperCase();
        p.status = ['SUSPENDED', 'PAUSADO', 'SUSPENDIDO'].includes(u) ? 'ACTIVE' : 'SUSPENDED';
        renderizarTabla();
    }
}

function abrirGaleria(images) {
    const lightbox = document.getElementById('lightbox');
    const mainImg = document.getElementById('lightboxImg');
    const thumbsContainer = document.getElementById('lightboxThumbs');

    mainImg.src = images[0];
    thumbsContainer.innerHTML = '';
    images.forEach((imgUrl, idx) => {
        const thumb = document.createElement('img');
        thumb.src = imgUrl;
        thumb.className = `w-16 h-16 object-cover rounded-lg cursor-pointer transition-all border-2 ${idx === 0 ? 'border-emerald-500 scale-110' : 'border-transparent opacity-60 hover:opacity-100'}`;
        thumb.onclick = (e) => {
            e.stopPropagation();
            mainImg.src = imgUrl;
            thumbsContainer.querySelectorAll('img').forEach(t => t.classList.remove('border-emerald-500', 'scale-110'));
            thumb.classList.add('border-emerald-500', 'scale-110');
        };
        thumbsContainer.appendChild(thumb);
    });
    lightbox.classList.remove('hidden');
}

function cambiarPagina(p) { paginaActual = p; aplicarFiltros(); }

function actualizarMetricas(data = productos) {
    document.getElementById('kpi-total').innerText = data.length;
    document.getElementById('kpi-active').innerText = data.filter(p => ['ACTIVE', 'ACTIVO'].includes(p.status.toUpperCase())).length;
    document.getElementById('kpi-offer').innerText = data.filter(p => p.offer > 0).length;
    document.getElementById('kpi-stock').innerText = data.filter(p => p.stock === 0).length;
}

function actualizarPaginacion(total) {
    const paginas = Math.ceil(total / itemsPorPagina);
    const cont = document.getElementById('paginationControls');
    if (!cont) return;
    cont.innerHTML = '';
    for (let i = 1; i <= paginas; i++) {
        cont.innerHTML += `<button onclick="cambiarPagina(${i})" class="w-10 h-10 rounded-xl font-bold ${paginaActual === i ? 'bg-emerald-500 text-white' : 'text-slate-400 hover:bg-slate-50'}">${i}</button>`;
    }
}

// --- EXPOSICIÓN GLOBAL (CRÍTICO PARA LOS ONCLICK EN EL HTML) ---
window.copyProductLink = copyProductLink;
window.abrirModal = abrirModal;
window.cerrarModal = cerrarModal;
window.aplicarFiltros = aplicarFiltros;
window.limpiarFiltros = limpiarFiltros;
window.formatearPrecio = formatearPrecio;
window.toggleOferta = toggleOferta;
window.actualizarSKU = actualizarSKU;
window.abrirGaleria = abrirGaleria;
window.suspender = suspender;
window.cambiarPagina = cambiarPagina;
window.ocultarModalExito = ocultarModalExito;

// --- CARGA INICIAL ---
window.onload = async () => {
    productos = await cargarProductosFirebase();
    await poblarCategorias();
    renderizarTabla();

    // LISTENERS PARA FILTRO EN TIEMPO REAL
    const searchInput = document.getElementById('searchInput');
    const categoryFilter = document.getElementById('categoryFilter');
    if (searchInput) searchInput.addEventListener('input', aplicarFiltros);
    if (categoryFilter) categoryFilter.addEventListener('change', aplicarFiltros);
};