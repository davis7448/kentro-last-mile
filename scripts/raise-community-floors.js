/**
 * Pasada unica: eleva al piso real los precios de comunidad que ya estaban por debajo (spec 004, RF_14).
 *
 * POR QUE EXISTE
 * --------------
 * El trigger `onSettingsFloorRaise` (RF_13) solo actua cuando la base SUBE al guardar los ajustes.
 * Un precio de comunidad que ya estaba por debajo de la base real ANTES de desplegar la 004 no lo
 * toca nadie: la tienda seguiria pagando menos de lo que le cuesta a Kentro, sin fecha de
 * caducidad. Esta pasada aplica UNA vez la misma elevacion, con el mismo aviso (`floorRaisedAt`) y
 * el mismo historial (`priceHistory`, firmado `system:floor`) que el trigger.
 *
 * No calcula ni escribe nada por su cuenta: los pisos salen de
 * `communityBase(resolveTariffs(settings/global))` (la base que cobra el cierre, los tres
 * conceptos), el plan de `planRaiseToFloors` y la escritura de `writeFloorRaise`, el MISMO writer que
 * usa el trigger. Todo compilado desde `functions/lib`, asi que no puede divergir de produccion.
 *
 * COMO SE USA
 * -----------
 *   cd functions && npm run build                     # antes: el script lee functions/lib
 *   node scripts/raise-community-floors.js            # en seco: imprime el plan y no escribe
 *   node scripts/raise-community-floors.js --apply    # escribe
 *
 * CUANDO
 * ------
 * Despues de desplegar functions (plan 004 §7, paso 4): la base que se lee aqui tiene que ser la
 * misma que ya cobra el cierre en produccion. Con E-master tal como esta hoy (sin precios propios)
 * se espera "0 cambios".
 *
 * IDEMPOTENTE
 * -----------
 * Solo se eleva lo que esta ESTRICTAMENTE por debajo del piso. Tras una pasada con --apply, todo
 * queda igual al piso y la segunda pasada da 0 cambios: no repite ni el aviso ni el historial.
 */
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");

const WRITER_COMPILADO = path.join(__dirname, "..", "functions", "lib", "community-floor-writer.js");
if (!fs.existsSync(WRITER_COMPILADO)) {
  console.error(`No existe ${WRITER_COMPILADO}.`);
  console.error("Hay que compilar functions antes: cd functions && npm run build");
  process.exit(1);
}

const admin = require("../functions/node_modules/firebase-admin");
const { planRaiseToFloors } = require("../functions/lib/community-pricing");
const { communityBase, resolveTariffs } = require("../functions/lib/seller-charges");
const { writeFloorRaise } = require("../functions/lib/community-floor-writer");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

(async () => {
  const settingsSnap = await db.collection("settings").doc("global").get();
  if (!settingsSnap.exists) {
    // Sin ajustes, resolveTariffs caeria a los valores por defecto y se elevaria contra un piso
    // que no es el que cobra nadie. Mejor pararse.
    console.error("settings/global no existe: no hay base real contra la que elevar. No se hace nada.");
    process.exit(1);
  }
  const settingsDoc = settingsSnap.data() ?? {};

  const floors = communityBase(resolveTariffs(settingsDoc));
  const communitiesSnap = await db.collection("communities").get();
  const communities = communitiesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const names = new Map(communitiesSnap.docs.map((doc) => [doc.id, doc.data()?.name ?? ""]));

  const nowIso = new Date().toISOString();
  const changes = planRaiseToFloors({ floors, communities, nowIso });

  console.log("Pisos (base real, settings/global):");
  console.table(floors);
  console.log(`comunidades leidas: ${communitiesSnap.size}`);

  if (changes.length === 0) {
    console.log("0 cambios: ningun precio de comunidad esta por debajo de la base real.");
    return;
  }

  console.log(`${changes.length} comunidad(es) a elevar:`);
  for (const change of changes) {
    console.log(`\n  ${change.communityId} (${names.get(change.communityId) || "sin nombre"})`);
    console.table(
      change.historyEntries.map((entry) => ({
        concepto: entry.field,
        de: entry.fromCop,
        a: entry.toCop,
        rigeDesde: entry.effectiveAt,
        aviso: change.communityUpdate[`floorRaisedAt.${entry.field}`] ? "si (floorRaisedAt)" : "NO"
      }))
    );
    if (change.deleteFields.length > 0) {
      console.log(`  programadas que el piso rebasa y se borran: ${change.deleteFields.join(", ")}`);
    }
  }

  if (APPLY) {
    for (const change of changes) {
      await writeFloorRaise(db, change, nowIso);
      console.log(`escrito ${change.communityId}: ${change.fields.join(", ")}`);
    }
    console.log(`\nListo: ${changes.length} comunidad(es) elevadas. Una segunda pasada debe dar 0 cambios.`);
    return;
  }

  console.log("\nEn seco. No se escribio nada. Repite con --apply para escribir este plan.");
})().catch((error) => {
  console.error("FALLO:", error.message);
  process.exit(1);
});
