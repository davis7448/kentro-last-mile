/**
 * Verificacion de la spec 017 contra produccion (DoD 4).
 *
 * Comprueba lo unico que las pruebas no pueden: que con datos reales una reimportacion no cambie
 * ningun dato protegido. **Lo lanza una persona, nunca un agente** (principio 7).
 *
 * El punto de recuperacion de Firestore esta DESACTIVADO (retencion de una hora, comprobado el
 * 2026-09-15): la copia que hace `--backup` es la unica vuelta atras que va a existir. Por eso
 * `--compare` se niega a correr sin ella.
 *
 * NO reutilizar `scripts/restore-orders-from-backup.js`: su cabecera dice que omite el pedido si ya
 * existe, y el escenario de aqui es justo ese — un pedido que sigue existiendo y quedo pisado.
 * Usarlo no restauraria nada y pareceria que si.
 *
 * Uso:
 *   node scripts/verify-017.js --backup 2026-09-15
 *   node scripts/verify-017.js --compare 2026-09-15
 *   node scripts/verify-017.js --restore 2026-09-15
 */
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");

const EVIDENCE_DIR = path.join(__dirname, "..", ".sdd", "evidence", "017");

/** Los grupos que la spec protege. Si alguno cambia, el arreglo esta incompleto. */
const PROTECTED_FIELDS = [
  "driverId", "messengerId", "pickupBatchId",
  "customerName", "customerPhone", "addressRaw", "normalizedAddress", "geoProvider",
  "addressRisk",
  "communityId",
  "lineItems", "productName", "sku", "quantity", "totalCop", "productId",
  "source",
  "pickupPointName", "pickupAddress", "paymentMethod", "fulfillmentMode",
  "status", "trackingCode", "createdAt", "evidence"
];

function backupPath(day) {
  return path.join(EVIDENCE_DIR, `backup-${day}.json`);
}

function requireBackup(day) {
  const file = backupPath(day);
  if (!fs.existsSync(file)) {
    console.error(`FALTA LA COPIA: ${file}`);
    console.error("Sin copia no se sigue: el punto de recuperacion de Firestore esta desactivado.");
    console.error(`Corre primero:  node scripts/verify-017.js --backup ${day}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function ordersOfDay(db, day) {
  const snap = await db.collection("orders").where("createdAt", ">=", day).where("createdAt", "<", `${day}`).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function main() {
  const [flag, day] = [process.argv[2], process.argv[3]];
  if (!flag || !day) {
    console.error("Uso: node scripts/verify-017.js --backup|--compare|--restore <YYYY-MM-DD>");
    process.exit(1);
  }
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const db = admin.firestore();

  if (flag === "--backup") {
    const orders = await ordersOfDay(db, day);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(backupPath(day), JSON.stringify(orders, null, 2));
    console.log(`Copia de ${orders.length} pedidos de ${day} en ${backupPath(day)}`);
    return;
  }

  if (flag === "--compare") {
    const before = requireBackup(day);
    const after = await ordersOfDay(db, day);
    const byId = new Map(after.map((order) => [order.id, order]));
    const changes = [];
    for (const previous of before) {
      const current = byId.get(previous.id);
      if (!current) {
        changes.push({ pedido: previous.trackingCode ?? previous.id, campo: "(el pedido desaparecio)" });
        continue;
      }
      for (const field of PROTECTED_FIELDS) {
        const a = JSON.stringify(previous[field] ?? null);
        const b = JSON.stringify(current[field] ?? null);
        if (a !== b) changes.push({ pedido: previous.trackingCode ?? previous.id, campo: field, antes: a.slice(0, 60), despues: b.slice(0, 60) });
      }
    }
    if (changes.length === 0) {
      console.log(`OK: ninguno de los ${before.length} pedidos de ${day} cambio un dato protegido.`);
      return;
    }
    console.table(changes);
    console.error(`FALLA: ${changes.length} cambios en datos protegidos. Restaura con --restore ${day} y no cierres la spec.`);
    process.exit(1);
  }

  if (flag === "--restore") {
    const before = requireBackup(day);
    for (let index = 0; index < before.length; index += 400) {
      const batch = db.batch();
      // `set` sin merge y con el documento entero: restaurar es dejarlo COMO ESTABA, no fusionar.
      for (const order of before.slice(index, index + 400)) {
        const { id, ...data } = order;
        batch.set(db.collection("orders").doc(id), data);
      }
      await batch.commit();
      console.log(`Restaurados ${Math.min(index + 400, before.length)}/${before.length}`);
    }
    console.log("RESTAURADO.");
    return;
  }

  console.error(`Opcion desconocida: ${flag}`);
  process.exit(1);
}

main().catch((error) => {
  console.error("FALLO:", error.message);
  process.exit(1);
});
