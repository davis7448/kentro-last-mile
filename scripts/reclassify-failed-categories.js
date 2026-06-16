#!/usr/bin/env node
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function latestFailedEvidence(order) {
  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  return [...evidence].reverse().find((item) => item.type === "failed") ?? evidence.at(-1) ?? {};
}

function classify(order) {
  const evidence = latestFailedEvidence(order);
  const text = normalize([
    order.failedReason,
    evidence.reason,
    evidence.note,
    evidence.photoLabel
  ].filter(Boolean).join(" "));
  const hasPhoto = Boolean(evidence.photoUrl || evidence.storagePath);

  if (/(sin cobertura|cobertura|fuera de cobertura|fuera del area|fuera de del area|zona no cubierta|no cubre|fuera de ruta|sin ruta|alto riesgo|zona roja|zona de riesgo|sector riesgo|sector peligroso|no se ingresa|no ingresar|peligroso|peligrosa)/.test(text)) {
    return { failedCategory: "no_coverage", failedCategoryConfidence: 0.95 };
  }
  if (/(no contesta|no responde|no contacto|telefono malo|numero malo|datos malos|pedido malo|cliente no confirma|no confirma)/.test(text)) {
    return { failedCategory: "bad_order_or_no_contact", failedCategoryConfidence: 0.85 };
  }
  if (/(no recibe|rechaza|direccion incorrecta|cliente no sale|visit|fachada|porteria|entregado fallido|en sitio|llegue|llego)/.test(text) || hasPhoto) {
    return { failedCategory: "failed_visit", failedCategoryConfidence: hasPhoto ? 0.8 : 0.7 };
  }
  return { failedCategory: "pending_review", failedCategoryConfidence: 0.2 };
}

(async () => {
  const snap = await db.collection("orders").where("status", "==", "failed").get();
  const rows = [];
  const counts = {};
  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    const order = { id: doc.id, ...doc.data() };
    const next = classify(order);
    counts[next.failedCategory] = (counts[next.failedCategory] ?? 0) + 1;
    rows.push({
      id: order.id,
      trackingCode: order.trackingCode,
      shopifyOrderId: order.shopifyOrderId,
      current: order.failedCategory ?? null,
      next: next.failedCategory,
      confidence: next.failedCategoryConfidence,
      reason: order.failedReason ?? latestFailedEvidence(order).reason ?? ""
    });
    if (apply && order.failedCategory !== next.failedCategory) {
      batch.set(doc.ref, {
        failedCategory: next.failedCategory,
        failedCategorySource: "auto_reclassification",
        failedCategoryConfidence: next.failedCategoryConfidence,
        updatedAt: order.updatedAt ?? new Date().toISOString()
      }, { merge: true });
      writes += 1;
    }
  }

  if (apply && writes > 0) await batch.commit();
  console.log(JSON.stringify({ apply, total: snap.size, writes, counts, sample: rows.slice(0, 25) }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
