/**
 * Cifras de una comunidad, AGREGANDO EN EL SERVIDOR.
 *
 * Por que existe: el lider de comunidad no descarga ni un pedido. Si el panel se resolviera en
 * el navegador, el rol nacería fuera del presupuesto de carga de la plataforma y con 20 tiendas
 * bajaria decenas de miles de documentos para pintar seis numeros.
 *
 * Reparto de fuentes, y no es un detalle:
 *  - Los CONTADORES salen de `orders`. No pueden salir de los asientos de wallet: un cashback
 *    de cero no emite asiento (un lider sin margen veria cero entregas) y las reversas de
 *    correccion conservan el `type`, asi que contarian como entregas de mas.
 *  - El DINERO sale de `walletEntries` con `sum()`. Ahi las reversas SI netean bien, que es
 *    justo lo que debe pasar.
 *
 * Toda la aritmetica esta en `community-stats-math.ts`, que es puro y esta probado.
 */
import { AggregateField, getFirestore, type Query } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { canReadCommunityStats, type Actor } from "./community-access";
import { buildCommunityStats, type RawCommunityAggregates } from "./community-stats-math";

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida.");
const statsSchema = z.object({
  communityId: z.string().trim().min(1),
  startDate: z.union([isoDate, z.literal("")]).default(""),
  endDate: z.union([isoDate, z.literal("")]).default("")
});

export const getCommunityStats = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesion.");
  const actor: Actor = {
    uid: request.auth.uid,
    role: String(request.auth.token.role ?? ""),
    communityId: typeof request.auth.token.communityId === "string" ? request.auth.token.communityId : undefined
  };

  const parsed = statsSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Periodo invalido.", parsed.error.flatten());
  const { communityId, startDate, endDate } = parsed.data;

  if (!canReadCommunityStats(actor, communityId)) {
    throw new HttpsError("permission-denied", "No puedes ver las cifras de esta comunidad.");
  }

  const db = getFirestore();
  const from = startDate ? `${startDate}T00:00:00.000Z` : "";
  const to = endDate ? `${endDate}T23:59:59.999Z` : "";

  /** Un eje por campo de fecha. Rotulados en el resultado: no se mezclan en silencio. */
  const onAxis = (field: "createdAt" | "pickedUpAt" | "closedAt", sellerId?: string): Query => {
    let q: Query = db.collection("orders").where("communityId", "==", communityId);
    if (sellerId) q = q.where("sellerId", "==", sellerId);
    if (from) q = q.where(field, ">=", from);
    if (to) q = q.where(field, "<=", to);
    return q;
  };
  const countOf = async (q: Query) => (await q.count().get()).data().count;

  const sellersSnap = await db.collection("sellers").where("communityId", "==", communityId).get();
  const sellerIds = sellersSnap.docs.map((doc) => doc.id);

  const perStore = await Promise.all(
    sellerIds.map(async (sellerId) => {
      const [created, dispatched, delivered, failed] = await Promise.all([
        countOf(onAxis("createdAt", sellerId)),
        countOf(onAxis("pickedUpAt", sellerId)),
        countOf(onAxis("closedAt", sellerId).where("status", "==", "delivered")),
        // `failed_visit` en POSITIVO, igual que en order-stats: restar las no cobrables deja
        // que una categoria nueva se cuele como cobrable sin que nadie se entere.
        countOf(onAxis("closedAt", sellerId).where("status", "==", "failed"))
      ]);
      return { sellerId, created, dispatched, delivered, failed };
    })
  );

  /**
   * Solo el CAUSADO se agrega aqui: es exacto y las reversas de correccion netean solas.
   * Lo PAGADO no se puede agregar sin inventar un campo denormalizado en cada asiento, asi
   * que lo completa el cliente con los cortes del propio lider, que ya descarga. La aritmetica
   * es la misma funcion pura en los dos lados (`buildCommunityStats`), asi que no pueden
   * divergir.
   */
  let entries: Query = db
    .collection("walletEntries")
    .where("ownerType", "==", "community_leader")
    .where("ownerId", "==", communityId);
  if (from) entries = entries.where("createdAt", ">=", from);
  if (to) entries = entries.where("createdAt", "<=", to);
  const accrued = await entries.aggregate({ total: AggregateField.sum("amountCop") }).get();
  const cashbackAccruedCop = Number(accrued.data().total) || 0;

  const raw: RawCommunityAggregates = {
    storeCount: sellerIds.length,
    createdByStore: Object.fromEntries(perStore.map((s) => [s.sellerId, s.created])),
    dispatchedByStore: Object.fromEntries(perStore.map((s) => [s.sellerId, s.dispatched])),
    deliveredByStore: Object.fromEntries(perStore.map((s) => [s.sellerId, s.delivered])),
    failedByStore: Object.fromEntries(perStore.map((s) => [s.sellerId, s.failed])),
    cashbackAccruedCop,
    // Lo completa el cliente con sus cortes; ver el comentario de arriba.
    cashbackPaidCop: 0,
    ordersWithoutCashbackByZoneFloor: 0
  };

  return {
    raw,
    stats: buildCommunityStats(raw),
    sellerNames: Object.fromEntries(sellersSnap.docs.map((doc) => [doc.id, String(doc.data()?.name ?? doc.id)]))
  };
});
