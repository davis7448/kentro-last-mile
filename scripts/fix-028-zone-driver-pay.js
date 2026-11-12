/**
 * Spec 028: las tres zonas de Cali pagan 8.000 al domiciliario (entrega y visita fallida), igual que
 * `settings/global`. Decision del responsable del 2026-11-10 ("Si, 8.000"; "solo DANDA tiene un valor diferente").
 * Solo afecta a pedidos que se cierren desde ahora; los asientos ya escritos no se tocan.
 *
 *   node scripts/fix-028-zone-driver-pay.js          # en seco
 *   node scripts/fix-028-zone-driver-pay.js --apply  # escribe con precondicion lastUpdateTime
 */
const path = require("node:path");
const admin = require(path.join(path.resolve(__dirname, ".."), "functions/node_modules/firebase-admin"));
const APPLY = process.argv.includes("--apply");
const FIELDS = ["driverDeliveredPayCop", "driverFailedPayCop"];
const FROM_COP = 9000;
const TO_COP = 8000;
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
(async () => {
  const snap = await db.collection("zones").get();
  const batch = db.batch();
  const now = new Date().toISOString();
  const changed = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const before = Object.fromEntries(FIELDS.map((field) => [field, data[field]]));
    console.log(doc.id, data.name, JSON.stringify(before));
    const unexpected = FIELDS.filter((field) => data[field] !== FROM_COP && data[field] !== TO_COP);
    if (unexpected.length) throw new Error(`${doc.id}: valor inesperado en ${unexpected.join(", ")}; no se sigue`);
    const patch = Object.fromEntries(FIELDS.filter((field) => data[field] === FROM_COP).map((field) => [field, TO_COP]));
    if (Object.keys(patch).length === 0) continue;
    batch.update(doc.ref, { ...patch, updatedAt: now }, { lastUpdateTime: doc.updateTime });
    changed.push({ id: doc.id, before, after: { ...before, ...patch } });
  }
  console.log(JSON.stringify({ apply: APPLY, changed }, null, 2));
  if (!APPLY || changed.length === 0) return;
  const auditRef = db.collection("audit").doc();
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: "script:fix-028-zone-driver-pay",
    actorRole: "admin",
    action: "zones.driver_pay_updated",
    entity: "zone",
    entityId: changed.map((item) => item.id).join(","),
    summary: `Pago domiciliario por zona ${FROM_COP} -> ${TO_COP} en ${changed.length} zonas (spec 028, decision del responsable)`,
    createdAt: now
  });
  await batch.commit();
  console.log("aplicado", now, "auditoria", auditRef.id);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
