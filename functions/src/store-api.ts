import crypto from "crypto";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { buildSellerBalanceInput, computeSellerBalance } from "./seller-balance";
import {
  buildCodReceivedSet,
  isSellerEntryEligible,
  type OrderDoc,
  type SettlementDoc,
  type WalletEntryDoc
} from "./seller-ledger";
import { resolveStoreCredentials } from "./store-api-auth";
import { computeKpis, inRange } from "./store-api-orders";
import {
  buildErrorBody,
  isValidShopifyOrderId,
  routeStoreApiRequest,
  STORE_API_ERROR_HTTP,
  validateQueryParameters
} from "./store-api-request";
import { listStoreOrdersByShopifyOrderId, readStoreOrder, storeOrderItem } from "./store-api-write";
import { buildStoreSummary, STORE_BALANCE_NOTICE } from "./store-summary";

/**
 * API de solo lectura para tiendas (sellers).
 *
 * - Autenticación: API key por tienda (colección storeApiConfigs, sin acceso cliente),
 *   mismo patrón que storeOrderWebhook (query key + comparación timing-safe).
 * - Alcance: cada key solo ve los datos de SU tienda (pedidos, KPIs y liquidaciones).
 * - Los KPIs replican EXACTAMENTE el cálculo de LogisticsKpis en la UI
 *   (src/components/operations-app.tsx): mismo filtro de fecha (createdAt||updatedAt),
 *   mismas fórmulas de tomados por líder / despachables / % despacho / % terminación.
 * - El estado de pago por pedido se deriva de walletEntries.settlementId + estado del
 *   settlement, igual que la zona de liquidaciones del admin.
 */

const createStoreApiKeySchema = z.object({
  sellerId: z.string().min(1),
  rotate: z.boolean().optional()
});

export const createStoreApiKey = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can create API keys.");
  }
  const parsed = createStoreApiKeySchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid API key data.", parsed.error.flatten());
  const input = parsed.data;
  if (role === "seller" && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only manage their own API key.");
  }

  const db = getFirestore();
  const sellerSnap = await db.collection("sellers").doc(input.sellerId).get();
  if (!sellerSnap.exists) throw new HttpsError("not-found", "Seller not found.");
  const now = new Date().toISOString();
  const ref = db.collection("storeApiConfigs").doc(input.sellerId);
  const existing = await ref.get();
  const keepKey = !input.rotate && typeof existing.data()?.apiKey === "string";
  const apiKey = keepKey ? String(existing.data()?.apiKey) : crypto.randomBytes(24).toString("hex");
  const config = {
    id: ref.id,
    sellerId: input.sellerId,
    sellerName: String(sellerSnap.data()?.name ?? input.sellerId),
    apiKey,
    status: "active",
    createdAt: typeof existing.data()?.createdAt === "string" ? String(existing.data()?.createdAt) : now,
    updatedAt: now
  };
  await ref.set(config, { merge: true });
  // ID autogenerado: `audit-storeapi-${Date.now()}` colisionaba entre llamadas del mismo
  // milisegundo, y las dos invocaciones separadas de Date.now() podian dejar el campo `id`
  // sin coincidir con el ID del documento.
  const auditRef = db.collection("auditEvents").doc();
  await auditRef.set({
    id: auditRef.id,
    actorId: request.auth?.uid,
    actorRole: role,
    action: keepKey ? "store_api_key.viewed" : "store_api_key.created",
    entity: "seller",
    entityId: input.sellerId,
    summary: `API key de tienda ${keepKey ? "consultada" : "generada"} para ${config.sellerName}`,
    createdAt: now
  });
  const baseUrl = "https://us-central1-kentro-last-mile.cloudfunctions.net/storeApi";
  return {
    config: { ...config, apiKey },
    usage: {
      kpis: `${baseUrl}/kpis?sellerId=${encodeURIComponent(input.sellerId)}&key=${apiKey}&from=YYYY-MM-DD&to=YYYY-MM-DD`,
      orders: `${baseUrl}/orders?sellerId=${encodeURIComponent(input.sellerId)}&key=${apiKey}&from=YYYY-MM-DD&to=YYYY-MM-DD`,
      settlements: `${baseUrl}/settlements?sellerId=${encodeURIComponent(input.sellerId)}&key=${apiKey}`
    }
  };
});


type StoreApiHttpRequest = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  get(name: string): string | undefined;
};

type StoreApiHttpResponse = {
  status(code: number): StoreApiHttpResponse;
  json(body: unknown): unknown;
  set(name: string, value: string): unknown;
};

export type StoreApiDeps = { db: Firestore; now?: () => Date };

/**
 * Handler de `storeApi` con el `db` inyectable (spec 029 T10). Orden de la precedencia (plan 2.1): ruta y
 * metodo → credenciales (`resolveStoreCredentials`, unica regla de keys) → parametros → recurso.
 */
export async function handleStoreApiRequest(
  request: StoreApiHttpRequest,
  response: StoreApiHttpResponse,
  deps: StoreApiDeps
): Promise<void> {
  // Paso 0: ruta y metodo. Las rutas de hoy conservan su 405 con la forma vieja.
  const match = routeStoreApiRequest({ method: request.method, path: request.path || "/" });
  if (!match.ok) {
    if (match.allow) response.set("Allow", match.allow);
    response.status(match.httpStatus).json(match.body);
    return;
  }
  // Rutas nuevas que llegan en tareas posteriores (historial, escrituras): aun no existen.
  if (match.kind === "new" && match.route !== "order_read") {
    response.status(STORE_API_ERROR_HTTP.route_not_found).json(buildErrorBody("route_not_found"));
    return;
  }

  const db = deps.db;
  // Pasos 1-2. Como hoy, la key de query manda sobre la Bearer (`query ?? bearer`).
  const rawSellerId = String(request.query.sellerId ?? "");
  const sellerIdForLookup = rawSellerId.trim();
  const configSnap = sellerIdForLookup ? await db.collection("storeApiConfigs").doc(sellerIdForLookup).get() : null;
  const config = (configSnap?.exists ? configSnap.data() : null) ?? null;
  const credentials = resolveStoreCredentials({
    route: match.access,
    querySellerId: rawSellerId,
    queryKey: request.query.key == null ? undefined : String(request.query.key),
    bearer: request.get("authorization")?.replace(/^Bearer\s+/i, ""),
    config
  });
  if (!credentials.ok) {
    response.status(credentials.httpStatus).json(credentials.body);
    return;
  }
  const sellerId = credentials.sellerId;
  const sellerName = config?.sellerName ?? sellerId;

  // Paso 3 (solo rutas nuevas; las viejas no validan parametros).
  const parameters = validateQueryParameters(match, request.query);
  if (!parameters.ok) {
    response.status(parameters.httpStatus).json(parameters.body);
    return;
  }

  if (match.kind === "new") {
    const reply = await readStoreOrder(db, { sellerId, orderId: match.orderId });
    response.status(reply.httpStatus).json(reply.body);
    return;
  }

  const resource = match.resource;
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();

  const from = String(request.query.from ?? "").trim();
  const to = String(request.query.to ?? "").trim();
  const statusFilter = String(request.query.status ?? "").trim();
  const limit = Math.min(Math.max(Number(request.query.limit ?? 500) || 500, 1), 1000);

  if (resource === "docs") {
    response.status(200).json({
      ok: true,
      tienda: sellerName,
      endpoints: {
        "GET /resumen": "Saldo consolidado autoritativo: pendiente por bucket (disponibleCop, retenidoCop por pedidos en la calle, enLiquidacionCop, bloqueadoCodCop; ver avisos), totales (COD, cobros, costo producto, abonado, liquidado), y el historial de pagos recibidos (liquidaciones + abonos con fecha). Usa este numero, no lo reconstruyas.",
        "GET /kpis?from=YYYY-MM-DD&to=YYYY-MM-DD": "KPIs operativos del rango, calculados igual que el dashboard (tomados por domiciliario, despachables, % despacho, entregados, fallidos por categoria).",
        "GET /orders?from=&to=&status=&limit=": "Pedidos de la tienda con clasificacion operativa, estado de pago y desglose financiero real por pedido (cod, flete, costo producto, neto).",
        "GET /settlements": "Liquidaciones de la tienda con sus pedidos, montos y estado (pending/paid/reconciled)."
      },
      autenticacion: "sellerId y key por query string, o header Authorization: Bearer <key>.",
      avisos: [STORE_BALANCE_NOTICE]
    });
    return;
  }

  // RF_02: GET /orders?shopifyOrderId= busca solo ese numero en la tienda de la key (carga dirigida).
  if (resource === "orders" && request.query.shopifyOrderId !== undefined) {
    const shopifyOrderId = request.query.shopifyOrderId;
    if (!isValidShopifyOrderId(shopifyOrderId)) {
      response.status(400).json({ ok: false, error: "invalid_shopify_order_id" });
      return;
    }
    const reply = await listStoreOrdersByShopifyOrderId(db, {
      sellerId,
      sellerName,
      shopifyOrderId: String(shopifyOrderId),
      statusFilter,
      limit
    });
    response.status(reply.httpStatus).json(reply.body);
    return;
  }

  // Pedidos de la tienda (scoping duro por sellerId).
  const ordersSnap = await db.collection("orders").where("sellerId", "==", sellerId).get();
  const allOrders = ordersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as OrderDoc);
  const rangeOrders = allOrders.filter((order) => inRange(order, from, to));

  if (resource === "kpis") {
    response.status(200).json({
      ok: true,
      tienda: sellerName,
      rango: { desde: from || null, hasta: to || null },
      kpis: computeKpis(rangeOrders)
    });
    return;
  }

  if (resource === "orders" || resource === "settlements" || resource === "resumen") {
    const [entriesSnap, settlementsSnap] = await Promise.all([
      db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", sellerId).get(),
      db.collection("settlements").get()
    ]);
    const sellerEntries = entriesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc);
    const allSettlements = settlementsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SettlementDoc);
    const settlementsById = new Map(allSettlements.map((settlement) => [String(settlement.id), settlement]));
    const codReceived = buildCodReceivedSet(allSettlements);

    if (resource === "resumen") {
      const sellerSettlements = allSettlements.filter((s) => s.kind === "seller" && s.ownerId === sellerId);
      // Spec 018 RF_25: el mismo saldo que ve la tienda en la app. Hace falta la tarifa (ajustes y
      // zonas) para saber cuanto retener por los pedidos en la calle.
      const zoneIds = [...new Set(allOrders.map((order) => String(order.zoneId ?? "")).filter(Boolean))];
      const [settingsSnap, zoneSnaps] = await Promise.all([
        db.collection("settings").doc("global").get(),
        zoneIds.length ? db.getAll(...zoneIds.map((zoneId) => db.collection("zones").doc(zoneId))) : Promise.resolve([])
      ]);
      const balance = computeSellerBalance(buildSellerBalanceInput({
        sellerId,
        wallet: sellerEntries,
        orders: allOrders,
        settlements: allSettlements,
        settings: (settingsSnap.data() ?? {}) as Record<string, unknown>,
        zones: zoneSnaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...snap.data() })),
        now: nowIso
      }));
      // RF_22: con asientos que no se pueden atribuir a un pedido no se devuelve una cifra parcial;
      // la app muestra error en ese caso y la API tiene que decir lo mismo.
      if (balance.unreadableEntryIds.length > 0) {
        response.status(409).json({ ok: false, error: "incomplete_balance", hint: "Hay movimientos sin pedido legible; Kentro debe revisarlos antes de dar el saldo." });
        return;
      }
      response.status(200).json({
        ok: true,
        tienda: sellerName,
        ...buildStoreSummary(sellerEntries, settlementsById, balance, sellerSettlements)
      });
      return;
    }

    if (resource === "orders") {
      const filtered = rangeOrders
        .filter((order) => !statusFilter || order.status === statusFilter)
        .sort((left, right) => String(right.createdAt || right.updatedAt).localeCompare(String(left.createdAt || left.updatedAt)))
        .slice(0, limit);
      response.status(200).json({
        ok: true,
        tienda: sellerName,
        rango: { desde: from || null, hasta: to || null },
        total: filtered.length,
        pedidos: filtered.map((order) => storeOrderItem(order, sellerEntries, settlementsById, codReceived))
      });
      return;
    }

    // settlements
    const ordersById = new Map(allOrders.map((order) => [String(order.id), order]));
    const sellerSettlements = allSettlements
      .filter((settlement) => settlement.kind === "seller" && settlement.ownerId === sellerId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    response.status(200).json({
      ok: true,
      tienda: sellerName,
      total: sellerSettlements.length,
      significado: {
        netoCop: "Valor liquidado del corte segun los pedidos incluidos.",
        pagadoCop: "Valor realmente transferido por ese corte.",
        saldoDelCorteCop: "Diferencia entre el neto y lo transferido. Si es 0, el corte quedo saldado.",
        nota: "Aclaracion del corte cuando el pago no fue en un solo giro."
      },
      liquidaciones: sellerSettlements.map((settlement) => ({
        id: settlement.id,
        status: settlement.status,
        desde: settlement.startDate,
        hasta: settlement.endDate,
        netoCop: Math.round(Number(settlement.netCop || 0)),
        // Lo realmente transferido. Si un corte se cerro pagando menos que su neto,
        // aqui se ve la diferencia en vez de dar por hecho que salio el neto completo.
        pagadoCop: Math.round(Number(typeof settlement.paidAmountCop === "number" ? settlement.paidAmountCop : settlement.netCop) || 0),
        saldoDelCorteCop: Math.max(0, Math.round(Number(settlement.netCop || 0)) - Math.round(Number(typeof settlement.paidAmountCop === "number" ? settlement.paidAmountCop : settlement.netCop) || 0)),
        codCop: Math.round(Number(settlement.codCop || 0)),
        cobrosCop: Math.round(Number(settlement.feesCop || 0)),
        costoProductoCop: Math.round(Number(settlement.productCostCop || 0)),
        nota: settlement.note ?? null,
        createdAt: settlement.createdAt ?? null,
        paidAt: settlement.paidAt ?? null,
        reconciledAt: settlement.reconciledAt ?? null,
        pedidos: (settlement.orderIds ?? []).map((orderId: string) => ({
          orderId,
          trackingCode: ordersById.get(String(orderId))?.trackingCode ?? null,
          status: ordersById.get(String(orderId))?.status ?? null
        }))
      }))
    });
    return;
  }

  response.status(404).json({ ok: false, error: "unknown_resource", recursos: ["/resumen", "/kpis", "/orders", "/settlements"] });
}

export const storeApi = onRequest((request, response) => handleStoreApiRequest(request, response, { db: getFirestore() }));
