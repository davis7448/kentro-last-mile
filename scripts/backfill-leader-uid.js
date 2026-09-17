/**
 * Rellena `leaderUid` en las comunidades que ya existen (spec 003, T7).
 *
 * POR QUE EXISTE, Y POR QUE VA ANTES QUE LA REGLA DE PRECIO
 * --------------------------------------------------------
 * La spec 003 hace que una comunidad **sin lider** cobre tarifa base y no cause cashback (RF_20).
 * El servidor lo sabra mirando `leaderUid` en el documento de la comunidad — un campo que hasta
 * ahora **no existia**: `createCommunityLeader` escribia nueve campos y ninguno era el lider; el
 * vinculo vivia solo en los reclamos de la cuenta.
 *
 * Si la regla de precio se despliega antes de rellenar este campo, **todas las comunidades vivas
 * pasan a ser comunidades sin lider**: tarifa base y cashback cero en cada pedido nuevo, sin error
 * y sin aviso. Es literalmente la regla de oro #5 del CLAUDE.md — no falla, no avisa, solo deja de
 * pagar.
 *
 * COMO SE USA
 * -----------
 *   node scripts/backfill-leader-uid.js            # en seco: dice que haria y no escribe
 *   node scripts/backfill-leader-uid.js --apply    # escribe
 *
 * Es idempotente: una comunidad que ya tiene `leaderUid` no se toca.
 */
const admin = require("../functions/node_modules/firebase-admin");

const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const auth = admin.auth();

/**
 * Quien lidera cada comunidad, hoy, segun la unica fuente que existe: los reclamos.
 * Se recorren las cuentas una vez y se indexan por comunidad, en vez de preguntar por cada
 * comunidad: hay muchas menos cuentas que consultas ahorradas.
 */
async function leadersByCommunity() {
  const byCommunity = new Map();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const claims = user.customClaims ?? {};
      const communityId = typeof claims.communityId === "string" ? claims.communityId : "";
      if (!communityId) continue;
      // Un acreedor conserva el vinculo pero YA NO lidera: anotarlo como lider deshariaa el
      // efecto de haberlo retirado, y la comunidad seguiria cobrando sobreprecio para nadie.
      if (claims.communityStanding === "creditor") continue;
      const previous = byCommunity.get(communityId);
      if (previous) previous.push(user.uid);
      else byCommunity.set(communityId, [user.uid]);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return byCommunity;
}

(async () => {
  const byCommunity = await leadersByCommunity();
  const snapshot = await db.collection("communities").get();

  const plan = { write: [], alreadyDone: [], noLeader: [], ambiguous: [] };

  for (const doc of snapshot.docs) {
    const data = doc.data() ?? {};
    if (typeof data.leaderUid === "string" && data.leaderUid) {
      plan.alreadyDone.push(doc.id);
      continue;
    }
    const candidates = byCommunity.get(doc.id) ?? [];
    if (candidates.length === 0) {
      // Sin lider que anotar. Con RF_20 desplegado pasara a tarifa base, y es correcto: no hay
      // nadie a quien pagarle el cashback.
      plan.noLeader.push(doc.id);
    } else if (candidates.length > 1) {
      // Dos cuentas dicen liderar la misma comunidad. El guion no elige: reporta y se para.
      plan.ambiguous.push({ communityId: doc.id, uids: candidates });
    } else {
      plan.write.push({ communityId: doc.id, leaderUid: candidates[0], name: data.name ?? "" });
    }
  }

  console.log(`comunidades: ${snapshot.size}`);
  console.log(`  ya tenian leaderUid : ${plan.alreadyDone.length}`);
  console.log(`  se escribirian      : ${plan.write.length}`);
  console.log(`  sin lider           : ${plan.noLeader.length}`);
  console.log(`  ambiguas            : ${plan.ambiguous.length}`);
  for (const item of plan.write) console.log(`    + ${item.communityId} (${item.name}) -> ${item.leaderUid}`);
  for (const id of plan.noLeader) console.log(`    ! ${id} se quedara SIN LIDER: tarifa base y sin cashback`);
  for (const item of plan.ambiguous) console.log(`    ? ${item.communityId} la reclaman ${item.uids.length}: ${item.uids.join(", ")}`);

  if (!APPLY) {
    console.log("\nEn seco. Nada escrito. Repite con --apply cuando el recuento cuadre.");
    return;
  }
  if (plan.ambiguous.length > 0) {
    console.error("\nHay comunidades ambiguas. Se resuelven a mano antes de escribir: elegir quien");
    console.error("lidera de verdad y retirar el vinculo del resto.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  for (const item of plan.write) {
    await db.collection("communities").doc(item.communityId).update({
      leaderUid: item.leaderUid,
      leaderGrantedAt: now,
      updatedAt: now
    });
    console.log(`escrito ${item.communityId} -> ${item.leaderUid}`);
  }
  console.log(`\nListo: ${plan.write.length} comunidades.`);
})().catch((error) => {
  console.error("FALLO:", error.message);
  process.exit(1);
});
