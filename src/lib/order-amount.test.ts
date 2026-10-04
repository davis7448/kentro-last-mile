/**
 * Spec 022 — T1: un importe imposible no se puede guardar.
 *
 * El 2026-09-19 una tienda tecleo $11.770.047.900 por dos sets de tornillos y el pedido quedo
 * contra entrega y listo para asignar. Si llega a entregarse, la cabecera de su corte le pide esa
 * cifra en efectivo al domiciliario — y la cabecera es, desde la spec 019, "la que se liquida".
 *
 * El tope no es un numero redondo elegido a ojo: los 5.103 pedidos de produccion tienen un maximo
 * legitimo de $239.800, percentil 99,9 de $224.775 y un prepago mayor de $1.233.000.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRM_ORDER_TOTAL_COP,
  MAX_ORDER_TOTAL_COP,
  checkOrderTotalCop,
  needsAmountConfirmation
} from "../../functions/src/order-amount";

describe("spec 022 · T1 · checkOrderTotalCop (RF_01, RF_02, RF_04)", () => {
  it("RF_02 · el tope deja pasar todo lo real de produccion", () => {
    // Maximo legitimo observado, percentil 99,9 y el mayor prepago real.
    for (const legitimo of [40000, 89900, 224775, 239800, 1233000]) {
      expect(checkOrderTotalCop(legitimo).ok).toBe(true);
    }
    expect(MAX_ORDER_TOTAL_COP).toBe(2000000);
  });

  it("RF_01 · los dos importes imposibles de produccion se rechazan", () => {
    expect(checkOrderTotalCop(11770047900).ok).toBe(false);
    expect(checkOrderTotalCop(76506523000).ok).toBe(false);
  });

  it("RF_01 · cero, negativo, no finito y no entero se rechazan", () => {
    for (const malo of [0, -1, -89900, Number.NaN, Number.POSITIVE_INFINITY, 89900.5]) {
      expect(checkOrderTotalCop(malo).ok).toBe(false);
    }
  });

  it("RF_01 · lo que ni siquiera es un numero se rechaza sin convertirlo por su cuenta", () => {
    // "1.199.900" convertido a la ligera da 1.199900 o NaN segun quien lo convierta. Aqui no se
    // adivina: quien teclea vuelve a teclear.
    for (const malo of ["89900", "1.199.900", null, undefined, {}, []]) {
      expect(checkOrderTotalCop(malo as never).ok).toBe(false);
    }
  });

  it("RF_04 · el mensaje dice el importe recibido Y el tope, en pesos legibles", () => {
    const resultado = checkOrderTotalCop(11770047900);

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.message).toContain("$11.770.047.900");
    expect(resultado.message).toContain("$2.000.000");
  });

  it("devuelve el importe ya validado, para que quien llama no vuelva a leer el crudo", () => {
    const resultado = checkOrderTotalCop(89900);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.totalCop).toBe(89900);
  });

  it("RF_05 · el umbral de confirmacion es mas bajo que el tope y no bloquea", () => {
    expect(CONFIRM_ORDER_TOTAL_COP).toBeLessThan(MAX_ORDER_TOTAL_COP);
    expect(needsAmountConfirmation(499000)).toBe(false);
    expect(needsAmountConfirmation(500001)).toBe(true);
    // Lo que pide confirmacion sigue siendo guardable: confirmar no es saltarse el tope.
    expect(checkOrderTotalCop(1233000).ok).toBe(true);
  });
});
