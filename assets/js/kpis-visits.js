import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const URL_CARRITO = "http://localhost/refact-varius/carrito.html";

async function cargarVisitasCarrito() {
  const q = query(collection(db, "visits"), where("url_pagina", "==", URL_CARRITO));
  const snapshot = await getDocs(q);
  const count = snapshot.size;
  document.getElementById("kpi-visitas-carrito-value").textContent = count;

  window.__visitasCarrito = [];
  snapshot.forEach(doc => window.__visitasCarrito.push(doc.data()));
}

function abrirModalVisitasCarrito() {
  const modal = document.getElementById("modal-visitas-carrito");
  const visitas = window.__visitasCarrito || [];

  if (visitas.length === 0) {
    document.getElementById("modalVisitasCarritoBody").innerHTML = "<p>Sin visitas.</p>";
    modal.classList.remove("hidden");
    return;
  }

  // Campos principales + los de screen
  const campos = [
    "ip", "nombre", "navegador", "plataforma", "memoria_dispositivo", "idioma",
    "idiomas_preferidos", "cookies", "online", "referrer", "fecha_registro", "hora_local", "zona_horaria",
    "soporte_tactil",
    "screen.width", "screen.height", "screen.colorDepth", "screen.pixelRatio"
  ];

  // Headers bonitos
  const headers = {
    ip: "IP",
    nombre: "Nombre",
    navegador: "Navegador",
    plataforma: "Plataforma",
    memoria_dispositivo: "Memoria (GB)",
    idioma: "Idioma",
    idiomas_preferidos: "Idiomas",
    cookies: "Cookies",
    online: "Online",
    referrer: "Referrer",
    fecha_registro: "Fecha Registro",
    hora_local: "Hora Local",
    zona_horaria: "Zona Horaria",
    soporte_tactil: "Touch",
    "screen.width": "Screen W",
    "screen.height": "Screen H",
    "screen.colorDepth": "ColorDepth",
    "screen.pixelRatio": "Ratio"
  };

  let html = `
    <div style="overflow-x:auto;max-width:100vw;">
      <table class="visitas-table-responsive">
        <thead>
          <tr>
            ${campos.map(c => `<th>${headers[c]||c}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${visitas.map(v => `
            <tr>
              ${campos.map(c => {
                if(c.startsWith("screen.")){
                  // Desglose screen.[prop]
                  const prop = c.split(".")[1];
                  return `<td>${v.screen && v.screen[prop] !== undefined ? v.screen[prop] : "-"}</td>`;
                } else if(typeof v[c] === "boolean"){
                  return `<td>${v[c] ? "✔️" : "✖️"}</td>`;
                } else if(v[c] !== undefined && v[c] !== null){
                  return `<td>${v[c]}</td>`;
                } else {
                  return `<td>-</td>`;
                }
              }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
      <style>
      .visitas-table-responsive {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        background: #ffffff;
        min-width: 880px;
      }
      .visitas-table-responsive th, .visitas-table-responsive td {
        padding: 7px 12px;
        border: 1px solid #e8e9ee;
        text-align: left;
      }
      .visitas-table-responsive th {
        background: #f0f4fa;
        position: sticky;
        top: 0;
        z-index: 2;
        font-weight: bold;
        color: #324295;
      }
      .visitas-table-responsive tr:nth-child(even) {
        background: #fafcfe;
      }
      .visitas-table-responsive tr:hover td {
        background: #eafaff;
      }
      @media (max-width: 900px) {
        .visitas-table-responsive th, .visitas-table-responsive td {
          font-size: 11px;
          padding: 6px 4px;
        }
        .visitas-table-responsive {
          min-width: 620px;
        }
      }
      @media (max-width: 650px) {
        .visitas-table-responsive th, .visitas-table-responsive td {
          font-size: 10px;
          padding: 4px 2px;
        }
        .visitas-table-responsive {
          min-width: 440px;
        }
      }
      </style>
    </div>
    <div style="margin-top:10px;color:#6b7280;font-size:12px;">
      <span>Se muestran <b>${visitas.length}</b> registros; puedes hacer scroll horizontal si hay muchas columnas.</span>
    </div>
  `;
  document.getElementById("modalVisitasCarritoBody").innerHTML = html;
  modal.classList.remove("hidden");
}

// Cerrar modal
document.getElementById("closeModalVisitasCarrito")?.addEventListener("click", () => {
  document.getElementById("modal-visitas-carrito").classList.add("hidden");
});
document.getElementById("modalVisitasCarritoOk")?.addEventListener("click", () => {
  document.getElementById("modal-visitas-carrito").classList.add("hidden");
});

cargarVisitasCarrito();
setInterval(cargarVisitasCarrito, 60_000);

window.abrirModalVisitasCarrito = abrirModalVisitasCarrito;