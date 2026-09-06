/**
 * Marca una cuenta como "cobra en efectivo": sus liquidaciones no retienen 4x1000.
 * Uso: node scripts/mark-pays-in-cash.js sellers seller-1779315416119 true
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const [coleccion, id, valor] = process.argv.slice(2);
if (!["sellers", "drivers", "suppliers"].includes(coleccion) || !id) {
  console.error("uso: node scripts/mark-pays-in-cash.js <sellers|drivers|suppliers> <id> <true|false>");
  process.exit(1);
}
const paysInCash = valor !== "false";

(async () => {
  const ref = db.collection(coleccion).doc(id);
  const snap = await ref.get();
  if (!snap.exists) { console.error(`No existe ${coleccion}/${id}`); process.exit(1); }
  const antes = snap.data();
  console.log(`${coleccion}/${id}  "${antes.name}"`);
  console.log(`  antes:   paysInCash = ${antes.paysInCash === undefined ? "(sin definir)" : antes.paysInCash}`);
  await ref.set({ paysInCash }, { merge: true });
  const despues = (await ref.get()).data();
  console.log(`  despues: paysInCash = ${despues.paysInCash}`);
  console.log(paysInCash ? "  -> NO se le retendra 4x1000" : "  -> SI se le retendra 4x1000");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
