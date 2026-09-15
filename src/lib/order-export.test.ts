import { describe, expect, it } from "vitest";
import { buildOrderExportRows, orderExportColumns } from "./order-export";
import { seedState } from "./seed";
import type { AppState, Order } from "./types";

function baseState(): AppState {
  return {
    ...seedState(),
    messengers: [{
      id: "messenger-1",
      leaderDriverId: "driver-1",
      name: "Carlos Mensajero",
      phone: "+57 300 000 0000",
      active: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    }]
  };
}

function baseOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord-export",
    trackingCode: "KNT-001",
    shopifyOrderId: "#1001",
    sellerId: "seller-1",
    cityId: "city-cali",
    zoneId: "zone-north",
    driverId: "driver-1",
    messengerId: "messenger-1",
    customerName: "Cliente Uno",
    customerPhone: "+57 300 123 4567",
    addressRaw: "Calle 1 #2-3",
    normalizedAddress: "Calle 1 #2-3, Cali",
    lat: 3.4516,
    lng: -76.532,
    addressRisk: "accepted",
    status: "delivered",
    paymentMethod: "cod",
    fulfillmentMode: "warehouse",
    totalCop: 120000,
    productName: "Producto A",
    sku: "SKU-A",
    quantity: 2,
    pickupPointName: "Bodega principal",
    pickupAddress: "Carrera 9 #10-11",
    scheduledDate: "2026-06-29",
    scheduledWindow: "09:00-12:00",
    evidence: [{
      id: "ev-delivery",
      type: "delivery",
      photoLabel: "entrega.jpg",
      photoUrl: "https://example.com/entrega.jpg",
      note: "Entregado a cliente",
      createdAt: "2026-06-29T15:00:00.000Z",
      actorId: "driver-1"
    }],
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T16:00:00.000Z",
    ...overrides
  };
}

describe("order export rows", () => {
  it("builds rows for delivered, failed, active and cancelled orders", () => {
    const state = baseState();
    const rows = buildOrderExportRows([
      baseOrder({ id: "delivered", status: "delivered" }),
      baseOrder({
        id: "failed",
        status: "failed",
        failedCategory: "failed_visit",
        failedReason: "Cliente no sale",
        retryDecision: "pending",
        evidence: [{
          id: "ev-failed",
          type: "failed",
          photoLabel: "fallido.jpg",
          note: "No contestan",
          reason: "Cliente no sale",
          createdAt: "2026-06-29T14:00:00.000Z",
          actorId: "driver-1"
        }]
      }),
      baseOrder({ id: "active", status: "in_route" }),
      baseOrder({ id: "cancelled", status: "cancelled", paymentMethod: "prepaid" })
    ], state);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.estado)).toEqual(["Entregado", "Fallido", "En ruta", "Cancelado"]);
    expect(rows[1].categoria_fallido).toBe("Fallido real con visita");
    expect(rows[1].fallido_cobrable).toBe("si");
    expect(rows[3].valor_cod_cop).toBe("");
  });

  it("includes enriched seller, city, zone, driver and messenger data", () => {
    const [row] = buildOrderExportRows([baseOrder()], baseState());

    expect(row.vendedor).toBe("Tienda Aurora");
    expect(row.dominio_tienda).toBe("aurora-demo.myshopify.com");
    expect(row.ciudad).toBe("Cali");
    expect(row.zona).toBe("Norte Cali");
    expect(row.lider_logistico).toBe("Luis Rojas");
    expect(row.mensajero).toBe("Carlos Mensajero");
  });

  it("preserves every column when optional order fields are missing", () => {
    const [row] = buildOrderExportRows([
      baseOrder({
        trackingCode: undefined,
        zoneId: undefined,
        driverId: undefined,
        messengerId: undefined,
        productName: undefined,
        sku: undefined,
        quantity: undefined,
        evidence: []
      })
    ], baseState());

    expect(Object.keys(row)).toEqual([...orderExportColumns]);
    expect(row.numero_guia).toBe("");
    expect(row.zona).toBe("");
    expect(row.cantidad_evidencias).toBe(0);
    expect(row.evidencia_tipo).toBe("");
  });

  it("exports only the orders passed to the helper", () => {
    const state = baseState();
    state.orders = [baseOrder({ id: "included" }), baseOrder({ id: "excluded" })];

    const rows = buildOrderExportRows([state.orders[0]], state);

    expect(rows).toHaveLength(1);
    expect(rows[0].id_pedido).toBe("included");
  });
});

/*
 * Spec 013 (`specs/013_pedido_manual_entero_y_direccion_en_la_guia.md`), T3. El Excel es una de las
 * cuatro superficies de RF_08: `direccion_original` es el texto de la linea `Direccion`,
 * `direccion_normalizada` el de `Correccion o nota` (o "" si el modulo no la emite) e `indicaciones`
 * el de `Indicaciones`, todas sacadas de `orderAddressLines` (plan §2.3). Las cabeceras hacen de
 * rotulo. Que el archivo consuma el modulo y no lea la direccion por su cuenta lo vigila la guarda
 * de `spec-013-guards.test.ts` (T3); aqui se prueba el resultado.
 */
describe("Spec 013 — la direccion sale del modulo y el Excel gana `indicaciones` (RF_08, RF_12)", () => {
  /** Las columnas de HOY, literales: si alguien renombra, quita o reordena una, esto lo dice. */
  const columnasAnteriores = [
    "numero_guia",
    "referencia_shopify",
    "id_pedido",
    "vendedor",
    "dominio_tienda",
    "ciudad",
    "zona",
    "estado",
    "cliente",
    "telefono",
    "direccion_original",
    "direccion_normalizada",
    "lat",
    "lng",
    "metodo_pago",
    "modo_fulfillment",
    "valor_cod_cop",
    "valor_total_cop",
    "producto",
    "sku",
    "cantidad",
    "recaudo_cod_cop",
    "cobro_flete_cop",
    "cobro_fallido_cop",
    "cobro_fulfillment_cop",
    "costo_producto_cop",
    "neto_pedido_cop",
    "lider_logistico",
    "mensajero",
    "punto_recogida",
    "direccion_recogida",
    "fecha_programada",
    "ventana_programada",
    "resultado_llamada",
    "nota_llamada",
    "fecha_reprogramada",
    "ventana_reprogramada",
    "categoria_fallido",
    "fallido_cobrable",
    "motivo_fallido",
    "decision_reintento",
    "rotulo_impreso_en",
    "rotulo_impreso_por",
    "veces_impreso",
    "cantidad_evidencias",
    "evidencia_tipo",
    "evidencia_motivo",
    "evidencia_nota",
    "evidencia_archivo",
    "evidencia_link_foto",
    "evidencia_creada_en",
    "todos_links_evidencia",
    "todas_notas_evidencia",
    "recogido_en",
    "creado_en",
    "actualizado_en",
    "pedido_json",
    "evidencias_json"
  ];

  // La tupla `as const` no admite `includes("indicaciones")` mientras la columna no exista: se lee
  // como lista de cadenas a proposito, que es lo que ve quien procesa el archivo.
  const columnas: readonly string[] = orderExportColumns;

  /** El pedido viejo real del caso limite de la spec: la tienda escribio la observacion en "normalizada". */
  const pedidoViejo = () =>
    baseOrder({
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "timbre azul, preguntar por Marta",
      deliveryNotes: undefined
    });

  it("RF_12 · `indicaciones` existe y es la ULTIMA columna", () => {
    expect(columnas, "no hay columna `indicaciones`").toContain("indicaciones");
    expect(columnas.at(-1), "`indicaciones` no va al final: quien procesa el archivo por posicion se descuadra").toBe("indicaciones");
  });

  it("RF_12 · las columnas anteriores a `indicaciones` son EXACTAMENTE las de hoy, en el mismo orden", () => {
    expect(columnas.slice(0, -1)).toEqual(columnasAnteriores);
  });

  it("RF_11 via Excel · pedido viejo: original en `direccion_original`, la nota tal cual en `direccion_normalizada`, `indicaciones` vacia", () => {
    const [row] = buildOrderExportRows([pedidoViejo()], baseState());

    expect(row.direccion_original).toBe("Calle 5 # 38-25 apto 301");
    expect(row.direccion_normalizada).toBe("timbre azul, preguntar por Marta");
    expect(row.indicaciones, "la fila no trae `indicaciones` (\"\" cuando el pedido no tiene)").toBe("");
  });

  it("RF_06, RF_07 via Excel · con las tres: `indicaciones` = deliveryNotes y `direccion_normalizada` = la corregida distinta", () => {
    const [row] = buildOrderExportRows([
      baseOrder({
        addressRaw: "Calle 5 # 38-25 apto 301",
        normalizedAddress: "Carrera 38 # 5-25 apto 301",
        deliveryNotes: "Preguntar por Marta"
      })
    ], baseState());

    expect(row.indicaciones).toBe("Preguntar por Marta");
    expect(row.direccion_normalizada).toBe("Carrera 38 # 5-25 apto 301");
    expect(row.direccion_original).toBe("Calle 5 # 38-25 apto 301");
  });

  it("RF_07 via Excel · corregida igual salvo mayusculas, tildes o espacios: `direccion_normalizada` = \"\" (antes se duplicaba)", () => {
    const [row] = buildOrderExportRows([
      baseOrder({
        addressRaw: "Calle 5 # 38-25 apto 301, Cañasgordas",
        normalizedAddress: "CALLE 5 # 38-25  APTO 301, canasgordas ",
        deliveryNotes: undefined
      })
    ], baseState());

    expect(row.direccion_original).toBe("Calle 5 # 38-25 apto 301, Cañasgordas");
    expect(row.direccion_normalizada, "la corregida 'igual' se sigue exportando duplicada").toBe("");
  });

  it("RF_05 via Excel · original vacia: `direccion_original` = \"SIN DIRECCION\"", () => {
    const [vacia, espacios] = buildOrderExportRows([
      baseOrder({ id: "vacia", addressRaw: "", normalizedAddress: undefined, deliveryNotes: undefined }),
      baseOrder({ id: "espacios", addressRaw: "   ", normalizedAddress: undefined, deliveryNotes: undefined })
    ], baseState());

    expect(vacia.direccion_original).toBe("SIN DIRECCION");
    expect(espacios.direccion_original).toBe("SIN DIRECCION");
  });

  it("RF_12 · cada fila tiene exactamente las claves de `orderExportColumns`, en el mismo orden y con `indicaciones` la ultima", () => {
    const rows = buildOrderExportRows([pedidoViejo(), baseOrder({ id: "otro", deliveryNotes: "Timbre azul" })], baseState());

    for (const row of rows) {
      const claves = Object.keys(row);
      expect(claves).toHaveLength(orderExportColumns.length);
      expect(claves).toEqual([...orderExportColumns]);
      expect(claves.at(-1)).toBe("indicaciones");
    }
  });
});
