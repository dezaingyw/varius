'use strict';

const functionsV2 = require('firebase-functions');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const dbRT = admin.database();
const firestore = admin.firestore();

// Twilio client (install with: npm install twilio)
let twilioClient = null;
try {
  const twilio = require('twilio');
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  if (sid && token) twilioClient = twilio(sid, token);
  else logger.warn('Twilio env vars not set (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
} catch (e) {
  logger.warn('Twilio module not available. Install "twilio" to enable WhatsApp notifications.', e);
}

/* ============================
   Helpers
   ============================ */

/**
 * getActiveVendorUids
 * - Lee /presence en RTDB (keys truthy)
 * - Valida que exista users/{uid} en Firestore con role == 'vendedor'
 * - Retorna array de UIDs activos (orden determinista según keys)
 */
async function getActiveVendorUids() {
  try {
    const presSnap = await dbRT.ref('presence').once('value');
    const presObj = presSnap.val() || {};
    const presenceKeys = Object.keys(presObj || {}).filter(k => !!presObj[k]);

    logger.debug('getActiveVendorUids: presenceKeys', { presenceKeys });

    if (!presenceKeys.length) return [];

    const active = [];
    await Promise.all(presenceKeys.map(async (uid) => {
      try {
        const userDoc = await firestore.doc(`users/${uid}`).get();
        if (!userDoc.exists) {
          logger.debug(`getActiveVendorUids: users/${uid} doc not found`);
          return;
        }
        const ud = userDoc.data() || {};
        const role = (ud.role || '').toString().toLowerCase();
        const status = (ud.status || '').toString().toLowerCase();
        if (role === 'vendedor' && status !== 'inactivo' && status !== 'suspended') {
          active.push(uid);
        } else {
          logger.debug(`getActiveVendorUids: users/${uid} skipped (role/status)`, { role, status });
        }
      } catch (e) {
        logger.warn(`getActiveVendorUids: error reading users/${uid}`, e);
      }
    }));

    logger.info('getActiveVendorUids resolved', { active });
    return active;
  } catch (err) {
    logger.error('getActiveVendorUids fatal error', err);
    return [];
  }
}

/* ============================
   Twilio / WhatsApp helpers
   ============================ */

function normalizeWhatsAppNumber(raw) {
  if (!raw) return null;
  const r = raw.toString().trim();
  // already in whatsapp:+<number> format
  if (r.startsWith('whatsapp:')) return r;
  // international with plus
  if (r.startsWith('+')) return `whatsapp:${r}`;
  // try to strip non-digits and add +
  const digits = r.replace(/[^\d]/g, '');
  if (!digits) return null;
  return `whatsapp:+${digits}`;
}

/**
 * sendWhatsAppMessage
 * - Uses Twilio messages.create with from set from env TWILIO_WHATSAPP_FROM (e.g. "whatsapp:+14155238886")
 * - Supports body text or contentSid + contentVariables (template)
 */
async function sendWhatsAppMessage(toRaw, body = '', opts = {}) {
  if (!twilioClient) {
    logger.warn('sendWhatsAppMessage: Twilio client not configured - skipping send', { toRaw });
    return null;
  }

  const from = process.env.TWILIO_WHATSAPP_FROM || '';
  if (!from) {
    logger.warn('sendWhatsAppMessage: TWILIO_WHATSAPP_FROM not configured - skipping', { toRaw });
    return null;
  }

  const to = normalizeWhatsAppNumber(toRaw);
  if (!to) {
    logger.warn('sendWhatsAppMessage: invalid "to" number, skipping', { toRaw });
    return null;
  }

  const params = { from, to };

  if (opts.contentSid) {
    params.contentSid = opts.contentSid;
    if (opts.contentVariables) {
      try {
        params.contentVariables = typeof opts.contentVariables === 'string'
          ? opts.contentVariables
          : JSON.stringify(opts.contentVariables);
      } catch (e) {
        logger.warn('sendWhatsAppMessage: invalid contentVariables, ignoring', e);
      }
    }
  } else {
    params.body = body;
  }

  if (opts.mediaUrl) params.mediaUrl = opts.mediaUrl;

  try {
    const msg = await twilioClient.messages.create(params);
    logger.info('sendWhatsAppMessage sent', { sid: msg.sid, to });
    return msg;
  } catch (err) {
    logger.error('sendWhatsAppMessage error', err);
    return null;
  }
}

/* ============================
   Message builders
   ============================ */

function buildProductsTextFromOrderItems(items) {
  if (!Array.isArray(items) || !items.length) return ' - (no hay detalle disponible)';
  return items.map(it => {
    const name = it.name || it.title || 'Producto';
    const qty = (typeof it.quantity !== 'undefined') ? it.quantity : (typeof it.qty !== 'undefined' ? it.qty : 1);
    const price = (typeof it.price !== 'undefined') ? Number(it.price) : (typeof it.subtotal !== 'undefined' ? Number(it.subtotal) : null);
    const priceStr = (price !== null && !Number.isNaN(price)) ? ` — $${(price).toFixed(2)}` : '';
    const qtyStr = qty && qty !== 1 ? ` x${qty}` : '';
    return `${name}${qtyStr}${priceStr}`;
  }).join('\n');
}

function buildCustomerConfirmationMessage(orderData, sellerName) {
  // According to user: orders store customer in customerData with fields: Customname, address, email, phone
  const customerObj = orderData.customerData || {};
  const customerName = customerObj.Customname || customerObj.customName || customerObj.name || 'Cliente';
  const phone = customerObj.phone || orderData.phone || '';
  const items = orderData.items || orderData.lineItems || orderData.products || [];
  const productsText = buildProductsTextFromOrderItems(items);
  const total = (typeof orderData.total !== 'undefined') ? Number(orderData.total).toFixed(2)
    : (typeof orderData.price !== 'undefined' ? Number(orderData.price).toFixed(2) : (orderData.subtotal ? Number(orderData.subtotal).toFixed(2) : ''));

  let body = `Hola Sr(a) ${customerName},\n\nSu pedido se ha realizado satisfactoriamente.\n\nProductos:\n${productsText}\n\nPrecio total del encargo: ${total ? `$${total}` : 'No disponible'}\n\n`;
  if (sellerName) {
    body += `Pronto será atendido por el vendedor: ${sellerName}.\n\n`;
  } else {
    body += `Pronto será atendido por un vendedor asignado. \n\n`;
  }
  body += 'Gracias por su compra.';
  return { body, phone };
}

/* ============================
   Core: asignación round-robin
   ============================ */

/**
 * assignOrderToNextVendor
 * - No sobrescribe si orden ya tiene assignedSeller (RTDB o Firestore)
 * - Usa transaction en assignmentMeta/lastAssignedSellerUid para rotar
 * - Escribe assignedSeller, assignedSellerName, assignedSellerEmail, assignedAt y status
 * - orderSource: string (ej: 'oncreate-fs', 'auto-rr', 'rtdb')
 *
 * Sends:
 *  - WhatsApp to customer (with seller name) and to seller (notify new pending order) after assignment.
 */
async function assignOrderToNextVendor(orderId, activeUids, orderSource = 'auto') {
  if (!Array.isArray(activeUids) || !activeUids.length) {
    logger.info(`assignOrderToNextVendor: no active vendors for order ${orderId}`);
    return false;
  }

  try {
    // --- 0) Verificar si ya existe asignación (RTDB preferente)
    try {
      const rtdbAssignedSnap = await dbRT.ref(`orders/${orderId}/assignedSeller`).once('value');
      const rtdbAssigned = rtdbAssignedSnap.exists() ? rtdbAssignedSnap.val() : null;
      if (rtdbAssigned) {
        logger.info(`assignOrderToNextVendor: order ${orderId} already assigned in RTDB to ${rtdbAssigned} - not overwriting`);
        return false;
      }
    } catch (e) {
      logger.debug('assignOrderToNextVendor: RTDB check failed (continuing)', e);
    }

    try {
      const fsSnap = await firestore.doc(`orders/${orderId}`).get();
      if (fsSnap.exists) {
        const data = fsSnap.data() || {};
        if (data.assignedSeller) {
          logger.info(`assignOrderToNextVendor: order ${orderId} already assigned in Firestore to ${data.assignedSeller} - not overwriting`);
          return false;
        }
      }
    } catch (e) {
      logger.debug('assignOrderToNextVendor: Firestore check failed (continuing)', e);
    }

    // --- 1) Transaction sobre assignmentMeta/lastAssignedSellerUid
    const assignmentRef = dbRT.ref('assignmentMeta/lastAssignedSellerUid');
    const trRes = await assignmentRef.transaction((current) => {
      if (!current || activeUids.indexOf(current) === -1) return activeUids[0];
      const idx = activeUids.indexOf(current);
      return activeUids[(idx + 1) % activeUids.length];
    });

    const assignedUid = trRes && trRes.snapshot ? trRes.snapshot.val() : null;
    const finalAssigned = assignedUid || activeUids[0];

    // --- 2) Obtener datos del vendedor desde Firestore (name/phone/email) si están disponibles
    let sellerName = '';
    let sellerEmail = '';
    let sellerPhone = '';
    try {
      const sellerDoc = await firestore.doc(`users/${finalAssigned}`).get();
      if (sellerDoc.exists) {
        const sd = sellerDoc.data() || {};
        sellerName = sd.name || sd.displayName || sd.email || '';
        sellerEmail = sd.email || '';
        sellerPhone = sd.phone || sd.whatsapp || sd.mobile || sd.telefono || '';
      }
    } catch (e) {
      logger.warn(`assignOrderToNextVendor: reading users/${finalAssigned} failed`, e);
    }

    // --- 2b) Leer datos de la orden para mensajes (Firestore preferente, fallback RTDB)
    let orderData = {};
    try {
      const od = await firestore.doc(`orders/${orderId}`).get();
      if (od.exists) orderData = od.data() || {};
      else {
        const rtSnap = await dbRT.ref(`orders/${orderId}`).once('value');
        if (rtSnap.exists()) orderData = rtSnap.val() || {};
      }
    } catch (e) {
      logger.warn(`assignOrderToNextVendor: error reading order ${orderId}`, e);
    }

    // Timestamps
    const timestampRT = admin.database.ServerValue.TIMESTAMP;
    const timestampFS = admin.firestore.FieldValue.serverTimestamp();

    // --- 3) Escribir en RTDB y Firestore (update/merge)
    const updatesRT = {
      assignedSeller: finalAssigned,
      assignedSellerName: sellerName || null,
      assignedSellerEmail: sellerEmail || null,
      assignedAt: timestampRT,
      status: 'assigned'
    };

    const updatesFS = {
      assignedSeller: finalAssigned,
      assignedSellerName: sellerName || null,
      assignedSellerEmail: sellerEmail || null,
      assignedAt: timestampFS,
      status: 'asignado',
      assignmentSource: orderSource
    };

    await Promise.all([
      dbRT.ref(`orders/${orderId}`).update(updatesRT).catch(err => logger.debug(`RTDB update orders/${orderId} failed`, err)),
      dbRT.ref(`sellerAssignments/${finalAssigned}`).push({
        orderId,
        assignedAt: timestampRT,
        source: orderSource,
        assignedSellerName: sellerName || null
      }).catch(err => logger.debug(`RTDB push sellerAssignments/${finalAssigned} failed`, err)),
      firestore.doc(`orders/${orderId}`).set(updatesFS, { merge: true }).catch(err => logger.debug(`Firestore set orders/${orderId} failed`, err))
    ]);

    logger.info(`Order ${orderId} assigned to seller ${finalAssigned} (${sellerName || 'no-name'})`);

    // -----------------------
    // Notificaciones WhatsApp (customer + seller)
    // -----------------------
    try {
      const notifications = { customer: null, seller: null, attemptedAt: admin.firestore.FieldValue.serverTimestamp() };

      // Build and send customer message (include sellerName now that assignment done)
      const cust = buildCustomerConfirmationMessage(orderData, sellerName);
      if (cust.phone) {
        const resCust = await sendWhatsAppMessage(cust.phone, cust.body);
        notifications.customer = resCust ? { sid: resCust.sid, to: cust.phone } : { error: 'send_failed' };
      } else {
        logger.info(`assignOrderToNextVendor: no customer phone for order ${orderId}, skipping customer WhatsApp`);
        notifications.customer = { skipped: true };
      }

      // Send seller notification
      if (sellerPhone) {
        const customerName = (orderData.customerData && (orderData.customerData.Customname || orderData.customerData.customName)) || orderData.customerName || 'Cliente';
        const sellerBody = `Tiene un nuevo pedido pendiente (ID: ${orderId}), del cliente ${customerName}, por favor revise la plataforma.`;
        const resSeller = await sendWhatsAppMessage(sellerPhone, sellerBody);
        notifications.seller = resSeller ? { sid: resSeller.sid, to: sellerPhone } : { error: 'send_failed' };
      } else {
        logger.info(`assignOrderToNextVendor: no seller phone for user ${finalAssigned}, skipping seller WhatsApp`);
        notifications.seller = { skipped: true };
      }

      // Persist notification metadata in Firestore (merge)
      try {
        await firestore.doc(`orders/${orderId}`).set({
          notificationsSent: notifications
        }, { merge: true });
      } catch (e) {
        logger.warn('assignOrderToNextVendor: could not persist notification metadata', e);
      }
    } catch (notifErr) {
      logger.error('assignOrderToNextVendor: notification step failed', notifErr);
    }

    return true;
  } catch (err) {
    logger.error(`assignOrderToNextVendor error for ${orderId}:`, err);
    try {
      await firestore.doc(`orders/${orderId}`).set({
        assignmentError: String(err),
        assignmentAttemptedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      logger.warn('assignOrderToNextVendor: could not write assignmentError to Firestore', e);
    }
    return false;
  }
}

/* ============================
   Buscar y reasignar pendientes
   ============================ */

/**
 * processPendingOrders
 * - Busca órdenes "pendientes" en Firestore (varias variantes de status)
 * - Escanea RTDB/orders para capturar órdenes sin assignedSeller
 * - Si hay vendedores activos, asigna cada orden por round-robin
 */
async function processPendingOrders(limit = 500) {
  logger.info('processPendingOrders: start');
  const pendingIds = new Set();

  // Firestore: buscar variantes comunes de status
  const variants = ['pendiente', 'pendiente_asignacion', 'pending', 'Pendiente', 'Pending'];
  try {
    for (const v of variants) {
      try {
        const q = await firestore.collection('orders').where('status', '==', v).limit(limit).get();
        q.forEach(doc => {
          const d = doc.data() || {};
          if (!d.assignedSeller) pendingIds.add(doc.id);
        });
      } catch (e) {
        logger.debug(`processPendingOrders: Firestore query status='${v}' failed`, e);
      }
    }

    // También intentar assignedSeller == null (si el campo existe)
    try {
      const q2 = await firestore.collection('orders').where('assignedSeller', '==', null).limit(limit).get();
      q2.forEach(doc => pendingIds.add(doc.id));
    } catch (e) {
      logger.debug('processPendingOrders: Firestore query assignedSeller==null failed (non-fatal)', e);
    }
  } catch (e) {
    logger.warn('processPendingOrders: Firestore stage had an error', e);
  }

  // RTDB scan: leer primeras 'limit' entradas y agregar las que no tengan assignedSeller o status pendiente
  try {
    const snap = await dbRT.ref('orders').limitToFirst(limit).once('value');
    const obj = snap.val() || {};
    Object.entries(obj).forEach(([key, val]) => {
      if (!val) return;
      const hasAssigned = (typeof val.assignedSeller !== 'undefined' && val.assignedSeller !== null && val.assignedSeller !== '');
      const status = (val.status || '').toString().toLowerCase();
      if (!hasAssigned || status.includes('pendient') || status.includes('pending')) {
        pendingIds.add(key);
      }
    });
    logger.info('processPendingOrders: RTDB scan added candidates', { total: pendingIds.size });
  } catch (e) {
    logger.warn('processPendingOrders: RTDB scan failed', e);
  }

  if (!pendingIds.size) {
    logger.info('processPendingOrders: no pending orders found');
    return { processed: 0, found: 0 };
  }

  // Obtener vendedores activos
  const activeUids = await getActiveVendorUids();
  if (!activeUids.length) {
    logger.info('processPendingOrders: no active vendors - aborting reassignment');
    return { processed: 0, found: pendingIds.size, reason: 'no_active_vendors' };
  }

  let processed = 0;
  for (const orderId of Array.from(pendingIds)) {
    try {
      const ok = await assignOrderToNextVendor(orderId, activeUids, 'auto-rr');
      if (ok) processed++;
    } catch (e) {
      logger.warn(`processPendingOrders: error assigning ${orderId}`, e);
    }
  }

  logger.info(`processPendingOrders done: processed=${processed}, found=${pendingIds.size}`);
  return { processed, found: pendingIds.size };
}

/* ============================
   Triggers
   ============================ */

/**
 * Firestore onCreate trigger (v2)
 * - Se dispara cuando se crea orders/{orderId} en Firestore
 * - Intenta asignar inmediatamente; si no hay vendedores activos marca pendiente y envía confirmación al cliente
 */
exports.assignOrderToSeller = onDocumentCreated('orders/{orderId}', async (event) => {
  const orderId = event.params?.orderId;
  logger.info('assignOrderToSeller trigger fired', { orderId });

  try {
    // Read order data
    let orderData = {};
    try {
      const od = await firestore.doc(`orders/${orderId}`).get();
      if (od.exists) orderData = od.data() || {};
      else {
        const rtSnap = await dbRT.ref(`orders/${orderId}`).once('value');
        if (rtSnap.exists()) orderData = rtSnap.val() || {};
      }
    } catch (e) {
      logger.warn('assignOrderToSeller: could not read order data', e);
    }

    const activeUids = await getActiveVendorUids();
    logger.debug('assignOrderToSeller: activeUids', { activeUids });

    if (!activeUids.length) {
      // marcar pendiente en Firestore y RTDB (no sobrescribir assignedSeller)
      await firestore.doc(`orders/${orderId}`).set({
        assignedSeller: null,
        assignedAt: null,
        status: 'pendiente'
      }, { merge: true }).catch(e => logger.debug('assignOrderToSeller: Firestore set pending failed', e));

      await dbRT.ref(`orders/${orderId}`).update({
        assignedSeller: null,
        assignedAt: null,
        status: 'pendiente'
      }).catch(e => logger.debug('assignOrderToSeller: RTDB update pending failed', e));

      // Send customer confirmation (no seller yet)
      try {
        const cust = buildCustomerConfirmationMessage(orderData, null);
        if (cust.phone) {
          const res = await sendWhatsAppMessage(cust.phone, cust.body);
          await firestore.doc(`orders/${orderId}`).set({
            notificationsSent: { customer: res ? { sid: res.sid, to: cust.phone } : { error: 'send_failed' }, pendingAssignment: true }
          }, { merge: true });
        } else {
          logger.info(`assignOrderToSeller: no customer phone for order ${orderId}, skipping initial customer WhatsApp`);
        }
      } catch (e) {
        logger.warn('assignOrderToSeller: error sending initial customer WhatsApp', e);
      }

      logger.info(`assignOrderToSeller: order ${orderId} left pending (no active vendors)`);
      return;
    }

    // Intentar asignar (la función evitará sobrescribir si ya asignada)
    const ok = await assignOrderToNextVendor(orderId, activeUids, 'oncreate-fs');
    if (!ok) logger.debug('assignOrderToSeller: assignOrderToNextVendor returned false (maybe already assigned)');
    return;
  } catch (err) {
    logger.error('assignOrderToSeller error', err);
    try {
      await firestore.doc(`orders/${orderId}`).set({
        assignmentError: String(err),
        assignmentAttemptedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) { logger.warn('assignOrderToSeller: could not write assignmentError', e); }
    return;
  }
});

/**
 * RTDB presence onWrite trigger (v2)
 * - Cuando /presence/{uid} cambia a online (transición false->true), intenta reasignar pendientes
 */
exports.onPresenceChanged = onValueWritten('/presence/{uid}', async (event) => {
  try {
    const beforeVal = event.data && event.data.before ? event.data.before.val() : null;
    const afterVal = event.data && event.data.after ? event.data.after.val() : null;
    const uid = event.params?.uid;

    logger.debug('onPresenceChanged event', { uid, beforeVal, afterVal });

    const becameOnline = (!!afterVal && ((afterVal.state && afterVal.state.toString().toLowerCase() === 'online') || afterVal === true || typeof afterVal === 'object'));
    const wasOnline = (!!beforeVal && ((beforeVal.state && beforeVal.state.toString().toLowerCase() === 'online') || beforeVal === true));

    if (!becameOnline || wasOnline) {
      logger.debug('onPresenceChanged: not a transition offline->online, ignoring', { uid, becameOnline, wasOnline });
      return;
    }

    logger.info(`onPresenceChanged: vendor ${uid} came online — attempting reassign pending orders`);
    const res = await processPendingOrders(500);
    logger.info('onPresenceChanged processPendingOrders result', { res });
    return;
  } catch (e) {
    logger.error('onPresenceChanged error', e);
    return;
  }
});

/**
 * HTTP trigger (v2) para forzar reasignación manual (protegido por secret)
 * - Protege con functions config scheduler.secret o env SCHEDULER_SECRET
 */
exports.reassignPendingOrdersHttp = onRequest(async (req, res) => {
  const cfgSecret = (functionsV2.config && functionsV2.config().scheduler && functionsV2.config().scheduler.secret) || process.env.SCHEDULER_SECRET || '';
  const provided = req.get('x-scheduler-secret') || req.query.secret || '';

  if (cfgSecret && provided !== cfgSecret) {
    logger.warn('reassignPendingOrdersHttp unauthorized call (bad secret)');
    return res.status(401).send('Unauthorized');
  }

  try {
    const result = await processPendingOrders(1000);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    logger.error('reassignPendingOrdersHttp error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ============================
   Optional: Export helpers for testing (no-op)
   ============================ */
exports._internal = {
  getActiveVendorUids,
  assignOrderToNextVendor,
  processPendingOrders,
  sendWhatsAppMessage,
  buildCustomerConfirmationMessage
};
