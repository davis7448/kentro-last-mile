import crypto from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";

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

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

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
  await db.collection("auditEvents").doc(`audit-storeapi-${Date.now()}`).set({
    id: `audit-storeapi-${Date.now()}`,
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

type OrderDoc = Record<string, any>;
type WalletEntryDoc = Record<string, any>;
type SettlementDoc = Record<string, any>;

// Misma semántica que orderDateValue() de la UI.
function orderDateValue(order: OrderDoc) {
  return String(order.createdAt || order.updatedAt || "").slice(0, 10);
}

function inRange(order: OrderDoc, from: string, to: string) {
  const date = orderDateValue(order);
  if (from && date && date < from) return false;
  if (to && date && date > to) return false;
  return true;
}

// Misma semántica que isChargeableFailedOrder() de src/lib/finance.ts.
function isChargeableFailed(order: OrderDoc) {
  return order.status === "failed" && String(order.failedCategory ?? "failed_visit") === "failed_visit";
}

const PICKED_BY_DRIVER_STATUSES = new Set(["call_pending", "scheduled", "picked_up", "in_route", "retry_pending", "delivered", "failed", "liquidated"]);

// Clasificación operativa por pedido, alineada con LogisticsKpis.
function classifyOrder(order: OrderDoc) {
  const takenByDriver = Boolean(order.driverId) && PICKED_BY_DRIVER_STATUSES.has(String(order.status));
  const noCoverageFailed = order.status === "failed" && order.failedCategory === "no_coverage";
  const badOrderFailed = order.status === "failed" && order.failedCategory === "bad_order_or_no_contact";
  const dispatchable = takenByDriver && !noCoverageFailed && !badOrderFailed;
  return {
    takenByDriver,
    dispatchable,
    delivered: order.status === "delivered",
    failed: order.status === "failed",
    chargeableFailed: isChargeableFailed(order),
    noCoverageFailed,
    badOrderFailed,
    closed: ["delivered", "failed", "cancelled", "liquidated"].includes(String(order.status))
  };
}

// Réplica exacta de LogisticsKpis (operations-app.tsx).
function computeKpis(orders: OrderDoc[]) {
  const total = orders.length;
  const pendingConfirm = orders.filter((o) => o.status === "imported" || o.status === "address_risk").length;
  const readyWithoutLeader = orders.filter((o) => o.status === "ready_to_assign" && !o.driverId).length;
  const assignedPendingPickup = orders.filter((o) => o.status === "assigned").length;
  const pickedWithoutMessenger = orders.filter((o) => o.status === "picked_up" && !o.messengerId).length;
  const inOperation = orders.filter((o) => ["call_pending", "scheduled", "in_route", "retry_pending"].includes(String(o.status)) || (o.status === "picked_up" && Boolean(o.messengerId))).length;
  const delivered = orders.filter((o) => o.status === "delivered").length;
  const failed = orders.filter((o) => o.status === "failed").length;
  const chargeableFailed = orders.filter(isChargeableFailed).length;
  const noCoverageFailed = orders.filter((o) => o.status === "failed" && o.failedCategory === "no_coverage").length;
  const badOrderFailed = orders.filter((o) => o.status === "failed" && o.failedCategory === "bad_order_or_no_contact").length;
  const cancelled = orders.filter((o) => o.status === "cancelled").length;
  const liquidated = orders.filter((o) => o.status === "liquidated").length;
  const pickedByDriver = orders.filter((o) => o.driverId && PICKED_BY_DRIVER_STATUSES.has(String(o.status))).length;
  const dispatchable = Math.max(0, pickedByDriver - noCoverageFailed - badOrderFailed);
  const dispatchRate = pickedByDriver > 0 ? Math.round((dispatchable / pickedByDriver) * 100) : 0;
  const closedDispatchable = delivered + chargeableFailed + liquidated;
  const openDispatchable = Math.max(0, dispatchable - closedDispatchable);
  const completionRate = dispatchable > 0 ? Math.round((closedDispatchable / dispatchable) * 100) : 0;
  const deliveryRate = dispatchable > 0 ? Math.round((delivered / dispatchable) * 100) : 0;
  const returnRate = dispatchable > 0 ? Math.round((chargeableFailed / dispatchable) * 100) : 0;
  return {
    totalPedidos: total,
    embudo: {
      pendienteConfirmar: pendingConfirm,
      listoSinLider: readyWithoutLeader,
      asignadoPendienteRecoger: assignedPendingPickup,
      recogidoSinMensajero: pickedWithoutMessenger,
      enGestionORuta: inOperation,
      entregados: delivered,
      fallidos: failed,
      cancelados: cancelled,
      liquidados: liquidated
    },
    indicadores: {
      tomadosPorDomiciliario: pickedByDriver,
      despachables: dispatchable,
      abiertosDespachables: openDispatchable,
      porcentajeDespacho: dispatchRate,
      porcentajeTerminacion: completionRate,
      porcentajeEntrega: deliveryRate,
      porcentajeDevolucion: returnRate
    },
    fallidosPorCategoria: {
      fallidoConVisita: chargeableFailed,
      sinCobertura: noCoverageFailed,
      pedidoMaloNoContesta: badOrderFailed
    },
    formulas: {
      tomadosPorDomiciliario: "pedidos con domiciliario asignado en estado llamada/agendado/recogido/en ruta/reintento/entregado/fallido/liquidado",
      despachables: "tomados por domiciliario menos fallidos sin cobertura y pedido malo/no contesta",
      porcentajeDespacho: "despachables / tomados por domiciliario",
      porcentajeTerminacion: "(entregados + fallidos con visita + liquidados) / despachables",
      porcentajeEntrega: "entregados / despachables",
      porcentajeDevolucion: "fallidos con visita / despachables"
    }
  };
}

// COD recibido del domiciliario, misma fuente autoritativa que createSettlement.
function buildCodReceivedSet(settlements: SettlementDoc[]) {
  const codReceived = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver") continue;
    if (Array.isArray(settlement.cashAllocations) && settlement.cashAllocations.length > 0) {
      for (const allocation of settlement.cashAllocations) {
        if (allocation.covered && allocation.orderId) codReceived.add(String(allocation.orderId));
      }
      continue;
    }
    if (settlement.status === "paid" || settlement.status === "reconciled" || settlement.cashPendingCop === 0) {
      for (const orderId of settlement.orderIds ?? []) codReceived.add(String(orderId));
    }
  }
  return codReceived;
}

function buildPaymentInfo(
  order: OrderDoc,
  sellerEntries: WalletEntryDoc[],
  settlementsById: Map<string, SettlementDoc>,
  codReceived: Set<string>
) {
  const entries = sellerEntries.filter((entry) => entry.orderId === order.id && entry.type !== "platform_margin");
  const netCop = Math.round(entries.reduce((sum, entry) => sum + Number(entry.amountCop || 0), 0));
  const settlementIds = Array.from(new Set(entries.map((entry) => entry.settlementId).filter(Boolean))) as string[];
  const unsettledCount = entries.filter((entry) => !entry.settlementId).length;
  const settlementStatuses = settlementIds.map((id) => String(settlementsById.get(id)?.status ?? "desconocido"));
  const allSettled = entries.length > 0 && unsettledCount === 0;
  const allPaid = allSettled && settlementStatuses.every((status) => status === "paid" || status === "reconciled");
  const eligible = order.paymentMethod === "prepaid" || codReceived.has(String(order.id));
  const estado = entries.length === 0
    ? "sin_movimientos"
    : allPaid
      ? "pagado"
      : allSettled
        ? "en_liquidacion"
        : eligible
          ? "pendiente_habilitado"
          : "pendiente_bloqueado_cod";
  return {
    estado,
    pagado: allPaid,
    habilitadoParaPago: eligible,
    netoCop: netCop,
    movimientos: entries.length,
    movimientosSinLiquidar: unsettledCount,
    settlementIds,
    settlements: settlementIds.map((id) => ({
      id,
      status: String(settlementsById.get(id)?.status ?? "desconocido"),
      paidAt: settlementsById.get(id)?.paidAt ?? null
    }))
  };
}

function orderPayload(order: OrderDoc) {
  return {
    id: order.id,
    trackingCode: order.trackingCode ?? null,
    shopifyOrderId: order.shopifyOrderId ?? null,
    status: order.status,
    failedCategory: order.failedCategory ?? null,
    failedReason: order.failedReason ?? null,
    paymentMethod: order.paymentMethod ?? null,
    totalCop: Math.round(Number(order.totalCop || 0)),
    customerName: order.customerName ?? null,
    createdAt: order.createdAt ?? null,
    updatedAt: order.updatedAt ?? null,
    fecha: orderDateValue(order)
  };
}

export const storeApi = onRequest(async (request, response) => {
  if (request.method !== "GET") {
    response.set("Allow", "GET");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  // Ruta: /kpis | /orders | /settlements (con o sin el prefijo del nombre de la función).
  const path = (request.path || "/").replace(/^\/storeApi/, "") || "/";
  const resource = path.replace(/^\/+|\/+$/g, "") || "docs";

  const sellerId = String(request.query.sellerId ?? "").trim();
  const suppliedKey = String(request.query.key ?? request.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!sellerId || !suppliedKey) {
    response.status(401).json({ ok: false, error: "missing_credentials", hint: "sellerId y key (query) o Authorization: Bearer <key>" });
    return;
  }

  const db = getFirestore();
  const configSnap = await db.collection("storeApiConfigs").doc(sellerId).get();
  const config = configSnap.data() ?? {};
  const expectedKey = String(config.apiKey ?? "");
  if (!configSnap.exists || config.status !== "active" || !expectedKey || !safeEqual(suppliedKey, expectedKey)) {
    response.status(401).json({ ok: false, error: "invalid_key" });
    return;
  }

  const from = String(request.query.from ?? "").trim();
  const to = String(request.query.to ?? "").trim();
  const statusFilter = String(request.query.status ?? "").trim();
  const limit = Math.min(Math.max(Number(request.query.limit ?? 500) || 500, 1), 1000);

  if (resource === "docs") {
    response.status(200).json({
      ok: true,
      tienda: config.sellerName ?? sellerId,
      endpoints: {
        "GET /kpis?from=YYYY-MM-DD&to=YYYY-MM-DD": "KPIs operativos del rango, calculados igual que el dashboard (tomados por domiciliario, despachables, % despacho, entregados, fallidos por categoria).",
        "GET /orders?from=&to=&status=&limit=": "Pedidos de la tienda con clasificacion operativa y estado de pago por pedido (pagado / en_liquidacion / pendiente_habilitado / pendiente_bloqueado_cod).",
        "GET /settlements": "Liquidaciones de la tienda con sus pedidos, montos y estado (pending/paid/reconciled)."
      },
      autenticacion: "sellerId y key por query string, o header Authorization: Bearer <key>."
    });
    return;
  }

  // Pedidos de la tienda (scoping duro por sellerId).
  const ordersSnap = await db.collection("orders").where("sellerId", "==", sellerId).get();
  const allOrders = ordersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as OrderDoc);
  const rangeOrders = allOrders.filter((order) => inRange(order, from, to));

  if (resource === "kpis") {
    response.status(200).json({
      ok: true,
      tienda: config.sellerName ?? sellerId,
      rango: { desde: from || null, hasta: to || null },
      kpis: computeKpis(rangeOrders)
    });
    return;
  }

  if (resource === "orders" || resource === "settlements") {
    const [entriesSnap, settlementsSnap] = await Promise.all([
      db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", sellerId).get(),
      db.collection("settlements").get()
    ]);
    const sellerEntries = entriesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc);
    const allSettlements = settlementsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SettlementDoc);
    const settlementsById = new Map(allSettlements.map((settlement) => [String(settlement.id), settlement]));
    const codReceived = buildCodReceivedSet(allSettlements);

    if (resource === "orders") {
      const filtered = rangeOrders
        .filter((order) => !statusFilter || order.status === statusFilter)
        .sort((left, right) => String(right.createdAt || right.updatedAt).localeCompare(String(left.createdAt || left.updatedAt)))
        .slice(0, limit);
      response.status(200).json({
        ok: true,
        tienda: config.sellerName ?? sellerId,
        rango: { desde: from || null, hasta: to || null },
        total: filtered.length,
        pedidos: filtered.map((order) => ({
          ...orderPayload(order),
          operacion: classifyOrder(order),
          pago: buildPaymentInfo(order, sellerEntries, settlementsById, codReceived)
        }))
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
      tienda: config.sellerName ?? sellerId,
      total: sellerSettlements.length,
      liquidaciones: sellerSettlements.map((settlement) => ({
        id: settlement.id,
        status: settlement.status,
        desde: settlement.startDate,
        hasta: settlement.endDate,
        netoCop: Math.round(Number(settlement.netCop || 0)),
        codCop: Math.round(Number(settlement.codCop || 0)),
        cobrosCop: Math.round(Number(settlement.feesCop || 0)),
        costoProductoCop: Math.round(Number(settlement.productCostCop || 0)),
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

  response.status(404).json({ ok: false, error: "unknown_resource", recursos: ["/kpis", "/orders", "/settlements"] });
});
