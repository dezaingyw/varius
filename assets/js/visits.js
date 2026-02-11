import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function getIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    return data.ip;
  } catch (e) {
    return "desconocida";
  }
}

function getUserInfo() {
  let info = {
    // Si tienes autenticación, puedes poner aquí el nombre o email del usuario
    nombre: "N/A",

    // Datos básicos del navegador
    navegador: navigator.userAgent,
    idioma: navigator.language,
    idiomas_preferidos: navigator.languages ? navigator.languages.join(', ') : '',
    plataforma: navigator.platform,
    cookies: navigator.cookieEnabled,
    memoria_dispositivo: navigator.deviceMemory || 'N/A',
    online: navigator.onLine,
    referrer: document.referrer || '',
    url_pagina: location.href,
    zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hora_local: new Date().toLocaleString(),

    // Datos de pantalla (más detallado)
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      colorDepth: window.screen.colorDepth,
      pixelRatio: window.devicePixelRatio
    },

    // Touch support
    soporte_tactil: 'ontouchstart' in window || navigator.maxTouchPoints > 0,

    fecha_registro: new Date().toISOString()
  };

  return info;
}

async function registrarVisita() {
  const info = getUserInfo();
  info.ip = await getIP();

  try {
    await addDoc(collection(db, "visits"), info);
    console.log("Visita registrada:", info);
  } catch (err) {
    console.error("Error registrando visita:", err);
  }
}

registrarVisita();