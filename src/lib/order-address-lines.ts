/**
 * Lineas de direccion de un pedido (spec 013, RNF_02).
 *
 * UNICA fuente de las lineas que pintan la guia impresa, la tarjeta, la vista del mensajero y el
 * Excel: todas recorren lo que devuelve `orderAddressLines`, en este orden y con estos rotulos.
 * Existe porque la guia mostraba la "direccion normalizada" EN LUGAR de la original, y las tiendas
 * usaban esa casilla para observaciones: el mensajero salia con "timbre azul" y sin direccion.
 * Puro: sin React, sin DOM, sin Firestore.
 */

import type { Order } from "./types";

export type AddressLineLabel = "Direccion" | "Correccion o nota" | "Indicaciones";
export type AddressLine = { label: AddressLineLabel; text: string };

/** Texto que ocupa la linea `Direccion` cuando la original esta vacia (RF_05). */
export const SIN_DIRECCION = "SIN DIRECCION";

/** Sin tildes (NFD + quitar marcas combinantes), sin mayusculas, espacios colapsados, recortado. La puntuacion no se toca. */
const normalizeAddressText = (text: string | undefined): string =>
  (text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Igualdad de RF_07: "igual" significa igual tras `normalizeAddressText` en ambos lados. */
export function sameAddressText(left: string | undefined, right: string | undefined): boolean {
  return normalizeAddressText(left) === normalizeAddressText(right);
}

/**
 * Las lineas que TODA superficie pinta, en orden:
 * 1. `Direccion`: la original recortada, o `SIN_DIRECCION` si queda vacia (RF_05).
 * 2. `Correccion o nota`: la "normalizada" recortada, solo si no esta vacia y no es igual a la
 *    original (RF_07, RF_11). No se adivina si es correccion o nota: se muestra tal cual.
 * 3. `Indicaciones`: `deliveryNotes` recortado, solo si no esta vacio (RF_06, RF_09).
 * Devuelve un array nuevo en cada llamada y no muta la entrada.
 */
export function orderAddressLines(
  order: Pick<Order, "addressRaw" | "normalizedAddress" | "deliveryNotes">
): AddressLine[] {
  const original = (order.addressRaw ?? "").trim();
  const correction = (order.normalizedAddress ?? "").trim();
  const notes = (order.deliveryNotes ?? "").trim();

  const lines: AddressLine[] = [{ label: "Direccion", text: original || SIN_DIRECCION }];

  if (correction && !sameAddressText(correction, original)) {
    lines.push({ label: "Correccion o nota", text: correction });
  }

  if (notes) {
    lines.push({ label: "Indicaciones", text: notes });
  }

  return lines;
}
