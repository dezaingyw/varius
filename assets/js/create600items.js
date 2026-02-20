import { initializeApp } from "firebase/app";
import { getFirestore, collection, writeBatch, doc, Timestamp } from "firebase/firestore";

// Tu configuración
const firebaseConfig = {
    apiKey: "AIzaSyDumYK72kLvZfgZJU8ZgJ_8Wlx6sk_Z0Qw",
    authDomain: "varius-7de76.firebaseapp.com",
    projectId: "varius-7de76",
    storageBucket: "varius-7de76.firebasestorage.app",
    messagingSenderId: "618912356955",
    appId: "1:618912356955:web:1e57c35d63ba39c2ea7d7e",
    databaseURL: "https://varius-7de76-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const categorias = ["Accesorios", "Cuidado Facial", "Maquillaje", "Cuidado Corporal"];
const marcas = ["Centella", "Skin1004", "Laneige", "Innisfree", "Cosrx"];

const generarSlug = (texto) => texto.toLowerCase().replace(/ /g, "-").replace(/[^\w-]+/g, "");

async function crear600Productos() {
    const productosRef = collection(db, "product");
    let batch = writeBatch(db);
    let contadorBatch = 0;

    for (let i = 1; i <= 600; i++) {
        const nombreBase = `${marcas[Math.floor(Math.random() * marcas.length)]} Producto Aleatorio ${i}`;
        const skuAleatorio = `ACC-${Math.floor(Math.random() * 1000000)}P${i}`;
        
        const nuevoDocRef = doc(productosRef); // Genera ID automático de Firestore

        const producto = {
            category: categorias[Math.floor(Math.random() * categorias.length)],
            createdAt: Timestamp.now(),
            currency: "CLP",
            description: `Descripción aleatoria para el producto ${i}. Ideal para hidratación y cuidado facial.`,
            discount: 0,
            imagePaths: ["products/placeholder.jpeg"], // Placeholder para no romper tu lógica
            imageUrls: ["https://via.placeholder.com/300"], 
            name: nombreBase.toUpperCase(),
            name_lower: nombreBase.toLowerCase(),
            onOffer: Math.random() > 0.8, // 20% de probabilidad de oferta
            ownerId: "DVXaQHblNFWGk9BNRadt1fnBHti2", // El ID de tu usuario actual
            price: Math.floor(Math.random() * (50000 - 5000) + 5000), // Precios entre 5k y 50k
            salesCount: Math.floor(Math.random() * 50),
            sku: skuAleatorio,
            slug: generarSlug(nombreBase),
            status: "Activo",
            stock: Math.floor(Math.random() * 200),
            updatedAt: Timestamp.now()
        };

        batch.set(nuevoDocRef, producto);
        contadorBatch++;

        // Firestore permite máximo 500 operaciones por batch
        if (contadorBatch === 500 || i === 600) {
            await batch.commit();
            console.log(`Lote enviado. Total procesado: ${i}`);
            batch = writeBatch(db); // Reiniciar batch
            contadorBatch = 0;
        }
    }
    console.log("¡Proceso terminado con éxito!");
}

crear600Productos();