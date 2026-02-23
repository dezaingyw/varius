import { firebaseConfig } from "./firebase-config.js";

// Importa los módulos desde el CDN
const { initializeApp } = await import(
  "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js"
);
const {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  onSnapshot
} = await import(
  "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js"
);

// Inicializar Firebase y Firestore
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Referencia a las colecciones
const categoriesCol = collection(db, "category");
const productsCol = collection(db, "product");

// Guardaremos las categorías aquí localmente
let categories = [];
let filteredCategories = [];

// ----------- NUEVO: Contar productos por categoría -----------
async function countProductsByCategory(categories) {
  // Trae todos los productos una sola vez
  const productsSnapshot = await getDocs(productsCol);
  const products = productsSnapshot.docs.map((doc) => doc.data());

  // Cuenta productos agrupados por campo 'category'
  const counts = {};
  products.forEach((prod) => {
    const catName = prod.category;
    if (!counts[catName]) counts[catName] = 0;
    counts[catName]++;
  });

  // Agrega el conteo a cada categoría localmente
  return categories.map((cat) => ({
    ...cat,
    count: counts[cat.name] || 0 // count real, usa 0 si ninguno
  }));
}
// -------------------------------------------------------------

// Escuchar cambios en la colección y refrescar la UI
function loadCategoriesAndListen() {
  onSnapshot(categoriesCol, async (snapshot) => {
    let tmpCategories = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));
    // Calcula el count real
    tmpCategories = await countProductsByCategory(tmpCategories);
    categories = tmpCategories;
    applyFilter(); // Filtrar y renderizar
    // ---- OPCIONAL: Si quieres guardar el "count" en Firestore:
    // (Quita comentarios de las 3 líneas de abajo si lo deseas)
    // tmpCategories.forEach(async cat => {
    //   if (cat.count !== undefined) await updateDoc(doc(db, "category", cat.id), { count: cat.count });
    // });
  });
}

// Renderizar tarjetas
function renderCategories(list = categories) {
  const grid = document.getElementById("categoriesGrid");
  grid.innerHTML = "";
  list.forEach((cat) => {
    const card = document.createElement("div");
    card.className =
      "bg-white rounded-3xl p-6 card-shadow border-t-4 flex flex-col transition-all hover:shadow-xl hover:-translate-y-1 cursor-pointer group";
    card.style.borderTopColor = cat.color;
    card.onclick = () => window.openModal("edit", cat.id);

    card.innerHTML = `
      <div class="flex justify-between items-start mb-4">
        <div class="bg-slate-50 px-3 py-1 rounded-full text-xs font-bold text-slate-500 flex items-center gap-1.5">
          ${cat.count ?? 0} 🔖
        </div>
        ${
          !cat.active
            ? '<span class="bg-red-50 text-red-500 text-[10px] font-black px-2 py-1 rounded-md tracking-wider">INACTIVO</span>'
            : ""
        }
      </div>
      <h3 class="text-xl font-bold text-slate-800 mb-2 group-hover:text-emerald-600 transition-colors">${
        cat.name
      }</h3>
      <p class="text-sm text-slate-500 mb-6 leading-relaxed flex-grow">${cat.desc}</p>
      <div class="flex justify-between items-center pt-4 border-t border-slate-50">
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full" style="background-color: ${
            cat.color
          }"></span>
          <span class="text-xs font-mono text-slate-400 uppercase">${
            cat.color
          }</span>
        </div>
        <span class="text-emerald-500 text-sm font-bold sm:opacity-0 group-hover:opacity-100 transition-opacity">Editar ✏️</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

// ----- FILTRO EN TIEMPO REAL -----
function applyFilter() {
  const filterValue = document
    .getElementById("filter-client")
    .value.trim()
    .toLowerCase();
  if (!filterValue) {
    filteredCategories = categories;
  } else {
    filteredCategories = categories.filter(
      (cat) =>
        cat.name.toLowerCase().includes(filterValue) ||
        (cat.desc && cat.desc.toLowerCase().includes(filterValue))
    );
  }
  renderCategories(filteredCategories);
}

// ----- VALIDACIÓN DE DUPLICADOS -----
const catNameInput = document.getElementById("catName");
let catNameError = null;

if (!document.getElementById("catNameError")) {
  catNameError = document.createElement("div");
  catNameError.id = "catNameError";
  catNameError.style.display = "none";
  catNameError.style.color = "red";
  catNameError.style.marginTop = "4px";
  catNameInput.parentNode.appendChild(catNameError);
} else {
  catNameError = document.getElementById("catNameError");
}

// Función para validar duplicados
function checkDuplicateCategory(name, ignoreId = null) {
  const normalized = name.trim().toLowerCase();
  return categories.some(
    (c) =>
      c.name.trim().toLowerCase() === normalized &&
      (!ignoreId || c.id !== ignoreId)
  );
}

catNameInput.addEventListener("input", () => {
  const exists = checkDuplicateCategory(catNameInput.value, window.currentEditId);
  if (exists) {
    catNameInput.classList.add("border", "border-red-500");
    catNameError.textContent = "El nombre de la categoría ya fue creado.";
    catNameError.style.display = "block";
  } else {
    catNameInput.classList.remove("border", "border-red-500");
    catNameError.style.display = "none";
  }
});

// Función global para abrir modal de crear/editar
function openModal(mode, id = null) {
  const modal = document.getElementById("categoryModal");
  const form = document.getElementById("categoryForm");
  window.currentEditId = id;

  if (mode === "edit") {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return alert("Categoría no encontrada");
    document.getElementById("modalTitle").innerText = "Editar Categoría";
    document.getElementById("catName").value = cat.name ?? "";
    document.getElementById("catDesc").value = cat.desc ?? "";
    document.getElementById("catColor").value = cat.color ?? "#10b981";
    document.getElementById("catHex").value = (cat.color ?? "#10b981").toUpperCase();
    document.getElementById("catStatus").checked = !!cat.active;
  } else {
    document.getElementById("modalTitle").innerText = "Nueva Categoría";
    form.reset();
    document.getElementById("catHex").value = "#10B981";
    document.getElementById("catColor").value = "#10b981";
    document.getElementById("catStatus").checked = true;
  }
  catNameInput.classList.remove("border", "border-red-500");
  catNameError.style.display = "none";
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("categoryModal").classList.add("hidden");
  document.body.style.overflow = "auto";
}

// Hacemos globales las funciones para que funcionen con los onclick HTML
window.openModal = openModal;
window.closeModal = closeModal;

// Manejar el envío del formulario
document.getElementById("categoryForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = catNameInput.value;
  const exists = checkDuplicateCategory(name, window.currentEditId);
  if (exists) {
    catNameInput.classList.add("border", "border-red-500");
    catNameError.textContent = "El nombre de la categoría ya fue creado.";
    catNameError.style.display = "block";
    catNameInput.focus();
    return;
  }

  const data = {
    name: name,
    desc: document.getElementById("catDesc").value,
    color: document.getElementById("catColor").value,
    active: document.getElementById("catStatus").checked
    // count SE CALCULA automáticamente, no lo necesitas aquí
  };
  if (window.currentEditId) {
    // EDITAR documento existente:
    await updateDoc(doc(db, "category", window.currentEditId), data);
  } else {
    // NUEVO:
    await addDoc(categoriesCol, data);
  }
  closeModal();
};

// Actualizar visualización del color hexadecimal en el input
document.getElementById("catColor").oninput = (e) => {
  document.getElementById("catHex").value = e.target.value.toUpperCase();
};

// ----- BUSCADOR EN TIEMPO REAL -----
document.getElementById("filter-client").addEventListener("input", () => {
  applyFilter();
});
document.getElementById("btnClear").onclick = () => {
  document.getElementById("filter-client").value = "";
  applyFilter();
};
document.getElementById("btnFilter").onclick = () => {
  applyFilter();
};

// Inicializa y escucha los cambios de categorías
loadCategoriesAndListen();
