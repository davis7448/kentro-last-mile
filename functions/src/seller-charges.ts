/**
 * Cuanto cobra Kentro a una tienda por un pedido. La UNICA copia de esa regla.
 *
 * Antes vivia repartida: `wallet-entries.ts` (lo que escribe el cierre del servidor),
 * `src/lib/finance.ts` (lo que calcula la app en modo local) y `community-order-pricing.ts` (la
 * base de una comunidad). Cada copia tenia su propio conjunto de tiendas con tarifa especial y su
 * propio fijo del fallido, y la copia rancia es justo el riesgo de la regla de oro #3 de
 * CLAUDE.md: una base de comunidad calculada con la tarifa CRUDA del ajuste (9.000) mientras al
 * cerrar se cobraba el fijo (12.000). Aqui se decide una vez y los demas importan.
 *
 * NO importa NADA, a proposito: la importan tambien la app (Next, navegador) y las pruebas de la
 * raiz, que no pueden cargar `firebase-admin` ni nada de Node. Una sola sentencia `import` aqui
 * arrastraria el servidor al bundle del cliente. Hay una guarda de fuente que lo comprueba.
 */

export const defaultSettings = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 9000
};

export const tariffFields = [
  "sellerDeliveredFeeCop",
  "sellerFailedFeeCop",
  "fulfillmentFeeCop",
  "driverDeliveredPayCop",
  "driverFailedPayCop"
] as const;

export type TariffField = (typeof tariffFields)[number];
export type Tariffs = Record<TariffField, number>;

/** Lo minimo del pedido que decide el cobro. */
export type SellerChargeOrder = {
  sellerId?: string;
  driverId?: string | null;
  pickedUpAt?: string;
};

/** Los tres conceptos que paga la tienda (== CommunityPricingField). */
export type SellerFeeValues = Pick<Tariffs, "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop">;

/**
 * DELIBERADO: el cobro por fallido es 12.000 para toda tienda que no sea DANDA, pase lo que pase.
 * Gana sobre `settings/global` Y sobre la tarifa de zona que resolvio `resolveTariffs`. Es decir:
 * cambiar sellerFailedFeeCop en la pantalla de ajustes NO tiene efecto. Ya paso una vez (ago-2026,
 * se puso en 9.000 y se siguio cobrando 12.000 sin que nada avisara). Si algun dia debe mandar el
 * ajuste, hay que quitar este fijo de `resolveSellerCharges` Y limpiar sellerFailedFeeCop de las
 * zonas.
 */
export const SELLER_FAILED_FEE_FIXED_COP = 12000;

export const dandaSellerIds = new Set(["seller-1779315416119"]);
const dandaPreferredDriverId = "driver-1778271901513";
const dandaDriverPayCutoff = Date.parse("2026-06-09T05:00:00.000Z");
const dandaSellerFeeCutoff = Date.parse("2026-07-17T05:00:00.000Z");

/**
 * Una tienda con tarifa especial en codigo NO puede pertenecer a una comunidad: su flete depende de
 * la fecha de ENTREGA, que al crear el pedido todavia no se conoce, asi que no hay base honesta que
 * congelar y el descuento del lider se calcularia sobre un precio que no es el que se va a cobrar.
 *
 * El rechazo vive AQUI, pegado al conjunto que decide el cobro, y no en el sello del pedido: son dos
 * vistas de una misma pregunta —"¿esta tienda tiene tarifa especial?"— y tenerlas separadas es justo
 * lo que permite que diverjan (anadir una tienda al conjunto y olvidar la copia del sello). Con las
 * dos leyendo el mismo conjunto, divergir deja de ser posible.
 *
 * LANZA, no devuelve: ignorarlo en silencio haria nacer el pedido con precio de comunidad, y ese
 * fallo no avisa —solo se ve al cuadrar un corte—. Si algun dia una tienda de estas debe entrar en
 * una comunidad, primero hay que decidir que tarifa manda.
 */
export function assertSellerCanJoinCommunity(sellerId: string): void {
  if (dandaSellerIds.has(sellerId)) {
    throw new Error(`La tienda ${sellerId} tiene tarifa especial en codigo y no puede pertenecer a una comunidad.`);
  }
}

// La tarifa de flete de DANDA subio a $13.500 para pedidos ENTREGADOS desde el
// 17-jul-2026 (sin importar la fecha de creacion). En closeOrder, deliveredAtIso
// es el momento del cierre (= fecha de entrega).
export function dandaDeliveredFeeCop(deliveredAtIso: string): number {
  const deliveredAt = typeof deliveredAtIso === "string" ? Date.parse(deliveredAtIso) : Number.NaN;
  return Number.isFinite(deliveredAt) && deliveredAt >= dandaSellerFeeCutoff ? 13500 : 12000;
}

/** Zona > 0 gana; si no, ajuste > 0; si no, el valor por defecto. Un numero guardado como texto cuenta. */
export function resolveTariffs(settings: Record<string, unknown>, zone?: Record<string, unknown>): Tariffs {
  const values = {} as Tariffs;
  for (const field of tariffFields) {
    const zoneValue = Number(zone?.[field]);
    const settingValue = Number(settings[field]);
    const fallbackValue = Number(defaultSettings[field]);
    values[field] = Number.isFinite(zoneValue) && zoneValue > 0 ? zoneValue : Number.isFinite(settingValue) && settingValue > 0 ? settingValue : fallbackValue;
  }
  return values;
}

/**
 * Lo que se cobra (y se paga al transportista) por este pedido, partiendo de tarifas YA
 * resueltas. DANDA tiene tarifa especial en codigo: flete por fecha de ENTREGA, fallido gratis,
 * pago al transportista fijo (11.000 con el preferido si recogio desde el corte, 10.000 si no) y
 * nada por fallido; su manejo de bodega si sale de la tarifa. Cualquier otra tienda paga la tarifa
 * con el fallido fijo. No muta `tariffs`.
 */
export function resolveSellerCharges(order: SellerChargeOrder, tariffs: Tariffs, deliveredAtIso: string): Tariffs {
  if (dandaSellerIds.has(String(order.sellerId ?? ""))) {
    const pickedUpAt = typeof order.pickedUpAt === "string" ? Date.parse(order.pickedUpAt) : Number.NaN;
    const usesNewDandaDriverPay =
      String(order.driverId ?? "") === dandaPreferredDriverId &&
      Number.isFinite(pickedUpAt) &&
      pickedUpAt >= dandaDriverPayCutoff;
    return {
      ...tariffs,
      sellerDeliveredFeeCop: dandaDeliveredFeeCop(deliveredAtIso),
      sellerFailedFeeCop: 0,
      driverDeliveredPayCop: usesNewDandaDriverPay ? 11000 : 10000,
      driverFailedPayCop: 0
    };
  }
  return { ...tariffs, sellerFailedFeeCop: SELLER_FAILED_FEE_FIXED_COP };
}

/**
 * La base de una comunidad: lo que pagaria por estas tarifas una tienda normal, sin lider. Sale
 * de `resolveSellerCharges` y no de las tarifas crudas, para que el piso del lider sea lo que de
 * verdad se cobra (con el fallido fijo) y no el ajuste que la pantalla muestra.
 */
export function communityBase(tariffs: Tariffs): SellerFeeValues {
  const charges = resolveSellerCharges({ sellerId: "" }, tariffs, "");
  return {
    sellerDeliveredFeeCop: charges.sellerDeliveredFeeCop,
    sellerFailedFeeCop: charges.sellerFailedFeeCop,
    fulfillmentFeeCop: charges.fulfillmentFeeCop
  };
}
