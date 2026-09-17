/**
 * Spec 018 — el saldo de una tienda calculado en el servidor.
 *
 * La tienda no puede leer los cortes de los domiciliarios (reglas de Firestore), y sin ellos no se
 * sabe que efectivo ya llego. Por eso su cifra se calcula aqui, con la misma regla pura que usan el
 * cierre del admin, la solicitud de liquidacion, el corte y la API para tiendas
 * (`seller-balance.ts`). Este archivo solo LEE documentos y delega.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { buildSellerBalanceInput, computeSellerBalance, type SellerBalanceInput } from "./seller-balance";
import type { OrderDoc, SettlementDoc, WalletEntryDoc } from "./seller-ledger";

/** Estados abiertos que pueden estar en la calle. `imported` nunca lleva marca de recogida (medido en T1). */
const STREET_CANDIDATE_STATUSES = ["address_risk", "ready_to_assign", "assigned", "call_pending", "scheduled", "pickup_pending", "picked_up", "in_route", "retry_pending"];

const withId = <T,>(doc: { id: string; data: () => unknown }) => ({ id: doc.id, ...(doc.data() as object) }) as T;

/**
 * Lecturas acotadas a UNA tienda (RNF_03): sus asientos sin cortar, los pedidos de esos asientos,
 * sus pedidos abiertos, los asientos de manejo de esos pedidos, los cortes de domiciliario, los
 * ajustes y las zonas. `compare` de `scripts/verify-018.js` comprueba contra produccion que esto da
 * lo mismo que las colecciones enteras.
 */
export async function loadSellerBalanceInput(db: Firestore, sellerId: string, now: string): Promise<SellerBalanceInput> {
  const [entriesSnap, candidatesSnap, settlementsSnap, settingsSnap] = await Promise.all([
    db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", sellerId).where("settlementId", "==", "").get(),
    db.collection("orders").where("sellerId", "==", sellerId).where("status", "in", STREET_CANDIDATE_STATUSES).get(),
    db.collection("settlements").where("kind", "==", "driver").get(),
    db.collection("settings").doc("global").get()
  ]);
  const openEntries = entriesSnap.docs.map((doc) => withId<WalletEntryDoc>(doc));
  const candidates = candidatesSnap.docs.map((doc) => withId<OrderDoc>(doc));

  const candidateIds = new Set(candidates.map((order) => String(order.id)));
  const missingOrderIds = [...new Set(openEntries.map((entry) => String(entry.orderId ?? "")).filter((id) => id && !candidateIds.has(id)))];
  const warehouseCandidates = candidates.filter((order) => order.fulfillmentMode === "warehouse");
  const zoneIds = [...new Set(candidates.map((order) => String(order.zoneId ?? "")).filter(Boolean))];

  const [entryOrderSnaps, fulfillmentSnaps, zoneSnaps] = await Promise.all([
    missingOrderIds.length ? db.getAll(...missingOrderIds.map((id) => db.collection("orders").doc(id))) : Promise.resolve([]),
    warehouseCandidates.length ? db.getAll(...warehouseCandidates.map((order) => db.collection("walletEntries").doc(`we-${order.id}-fulfillment-fee`))) : Promise.resolve([]),
    zoneIds.length ? db.getAll(...zoneIds.map((id) => db.collection("zones").doc(id))) : Promise.resolve([])
  ]);

  const orders = [...candidates, ...entryOrderSnaps.filter((snap) => snap.exists).map((snap) => withId<OrderDoc>(snap))];
  // Solo hace falta que el asiento de manejo EXISTA; si ademas esta abierto ya viene en openEntries.
  const fulfillmentEntries = fulfillmentSnaps.filter((snap) => snap.exists).map((snap) => ({ ...withId<WalletEntryDoc>(snap), settlementId: "charged" }));

  return buildSellerBalanceInput({
    sellerId,
    wallet: [...openEntries, ...fulfillmentEntries],
    orders,
    settlements: settlementsSnap.docs.map((doc) => withId<SettlementDoc>(doc)),
    settings: (settingsSnap.data() ?? {}) as Record<string, unknown>,
    zones: zoneSnaps.filter((snap) => snap.exists).map((snap) => withId<Record<string, unknown>>(snap)),
    now
  });
}

// 512 MiB no es por memoria sino por CPU: en Cloud Functions va atada a la memoria y acorta el
// arranque en frio, que es lo que la tienda nota al abrir la app (RNF_04).
export const getSellerBalance = onCall({ memory: "512MiB" }, async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : "";
  // El logistico de tienda NO ve dinero: solo tienda y administrador.
  if (!request.auth || (role !== "seller" && role !== "admin")) {
    throw new HttpsError("permission-denied", "Tu usuario no puede consultar saldos.");
  }
  const requested = typeof request.data?.sellerId === "string" ? request.data.sellerId : "";
  const sellerId = role === "seller" ? sellerClaim : requested;
  if (!sellerId) {
    throw new HttpsError("invalid-argument", role === "seller" ? "Tu usuario no tiene una tienda asociada." : "Indica la tienda.");
  }

  const db = getFirestore();
  const balance = computeSellerBalance(await loadSellerBalanceInput(db, sellerId, new Date().toISOString()));
  // RF_22: una cifra parcial es peor que ninguna.
  if (balance.unreadableEntryIds.length > 0) {
    throw new HttpsError("failed-precondition", "No se pudo calcular el saldo completo de la tienda.", { unreadableEntryIds: balance.unreadableEntryIds });
  }
  return balance;
});
