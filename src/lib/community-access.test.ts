import { describe, expect, it } from "vitest";
import {
  canBulkDisableCommunitySignups,
  canCreateCommunityLeader,
  canEditCommunityBrand,
  canEditCommunityPricing,
  canReadCommunityStats,
  canReadSellerFinancials,
  canReadSellerOperational,
  canReassignSellerCommunity,
  canSetCommunityLeaderStatus,
  canSetCommunityLinkStatus,
  communityAcceptsSignups,
  communityIdForAdminCreatedSeller,
  leaderCanSignIn,
  type Actor
} from "../../functions/src/community-access";

const admin: Actor = { uid: "u-admin", role: "admin" };
const lider: Actor = { uid: "u-lider", role: "community_leader", communityId: "com-1" };
const otroLider: Actor = { uid: "u-otro", role: "community_leader", communityId: "com-2" };
const tienda: Actor = { uid: "u-tienda", role: "seller", sellerId: "seller-1" };

const sellerPropio = { id: "seller-1", communityId: "com-1" };
const sellerAjeno = { id: "seller-9", communityId: "com-2" };
const sellerSinComunidad = { id: "seller-0" };

describe("T10 · permisos del lider de comunidad", () => {
  it("RF_50: solo un administrador crea lideres de comunidad", () => {
    expect(canCreateCommunityLeader(admin)).toBe(true);
    expect(canCreateCommunityLeader(lider)).toBe(false);
    expect(canCreateCommunityLeader(tienda)).toBe(false);
  });

  it("RF_50, RF_51: solo un administrador activa o desactiva a un lider", () => {
    expect(canSetCommunityLeaderStatus(admin)).toBe(true);
    expect(canSetCommunityLeaderStatus(lider)).toBe(false);
  });

  it("RF_05: solo un administrador revoca o reactiva un enlace", () => {
    expect(canSetCommunityLinkStatus(admin)).toBe(true);
    expect(canSetCommunityLinkStatus(lider)).toBe(false);
  });

  it("RF_51: un lider desactivado no entra, pero eso no toca su comunidad", () => {
    expect(leaderCanSignIn({ status: "active" })).toBe(true);
    expect(leaderCanSignIn({ status: "disabled" })).toBe(false);
  });

  it("RF_06: un enlace revocado o de un lider desactivado no admite altas", () => {
    expect(communityAcceptsSignups({ status: "active", linkStatus: "active" })).toBe(true);
    expect(communityAcceptsSignups({ status: "active", linkStatus: "revoked" })).toBe(false);
    expect(communityAcceptsSignups({ status: "disabled", linkStatus: "active" })).toBe(false);
  });

  it("RF_27: un lider fija precios de SU comunidad y de ninguna otra", () => {
    expect(canEditCommunityPricing(lider, "com-1")).toBe(true);
    expect(canEditCommunityPricing(lider, "com-2")).toBe(false);
    expect(canEditCommunityPricing(otroLider, "com-1")).toBe(false);
    expect(canEditCommunityPricing(tienda, "com-1")).toBe(false);
  });

  it("RF_14: la marca la cambia su lider, o un administrador", () => {
    expect(canEditCommunityBrand(lider, "com-1")).toBe(true);
    expect(canEditCommunityBrand(admin, "com-1")).toBe(true);
    expect(canEditCommunityBrand(otroLider, "com-1")).toBe(false);
  });

  it("RF_52: un lider solo ve cifras de su comunidad", () => {
    expect(canReadCommunityStats(lider, "com-1")).toBe(true);
    expect(canReadCommunityStats(lider, "com-2")).toBe(false);
    expect(canReadCommunityStats(admin, "com-2")).toBe(true);
  });

  it("RF_52: un lider ve la operacion de sus tiendas y de ninguna ajena", () => {
    expect(canReadSellerOperational(lider, sellerPropio)).toBe(true);
    expect(canReadSellerOperational(lider, sellerAjeno)).toBe(false);
    expect(canReadSellerOperational(lider, sellerSinComunidad)).toBe(false);
  });

  it("RF_31: un lider NUNCA ve el saldo de una tienda, ni de la suya", () => {
    expect(canReadSellerFinancials(lider, sellerPropio)).toBe(false);
    expect(canReadSellerFinancials(admin, sellerPropio)).toBe(true);
    expect(canReadSellerFinancials(tienda, { id: "seller-1" })).toBe(true);
  });

  it("RF_11: solo un administrador reasigna una tienda de comunidad", () => {
    expect(canReassignSellerCommunity(admin)).toBe(true);
    expect(canReassignSellerCommunity(lider)).toBe(false);
    expect(canReassignSellerCommunity(tienda)).toBe(false);
  });

  it("RF_12: una tienda creada a mano por un administrador nace sin comunidad", () => {
    expect(communityIdForAdminCreatedSeller()).toBeUndefined();
  });
});

/**
 * T44 · Quien puede lanzar la desactivacion en bloque (RF_41, RF_42).
 *
 * `disableCommunitySignupsInRange` lleva desplegada desde T32 sin un solo llamador: no hay
 * envoltorio en `src/lib/firebase/auth.ts` ni control en el panel, asi que un administrador
 * real no puede ejecutar lo que la spec declara **el unico remedio ante un enlace filtrado**
 * (RF_41). T44 construye esa superficie, y este es el unico trozo de ella que se puede afirmar
 * con una prueba pura: el predicado de quien ve el control. El recorrido de punta a punta va
 * con captura en la evidencia de `/sdd-verify`, tal como declara `specs/001_tasks.md`.
 *
 * El predicado vive aqui, y no dentro del componente, por la misma razon que sus hermanos: es
 * una frontera de permiso, y la callable ya decide lo mismo por su cuenta
 * (`communities.ts:414`, hoy con un `actor.role !== "admin"` suelto). Si la interfaz y el
 * servidor deciden por caminos distintos, tarde o temprano dicen cosas distintas.
 */

const logistico: Actor = { uid: "u-log", role: "seller_logistics", sellerId: "seller-1" };
const transportista: Actor = { uid: "u-driver", role: "driver", driverId: "driver-1" };
const mensajero: Actor = { uid: "u-mens", role: "messenger", driverId: "driver-2" };

describe("T44 · desactivacion en bloque desde el panel del admin", () => {
  it("RF_41: solo un administrador lanza la desactivacion en bloque", () => {
    expect(canBulkDisableCommunitySignups(admin, "com-1")).toBe(true);
    // Los cinco roles de la plataforma, uno a uno: la accion cierra accesos de decenas de
    // tiendas de golpe y no hay nadie mas que pueda dispararla.
    expect(canBulkDisableCommunitySignups(tienda, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(logistico, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(transportista, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(mensajero, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(otroLider, "com-1")).toBe(false);
  });

  it("RF_41: ni el lider de la comunidad del enlace filtrado puede ejecutar la limpieza", () => {
    // El caso interesante: es SU enlace el que se filtro y son SUS tiendas las que entraron,
    // asi que es quien mas incentivo tiene para tapar el rastro. La contencion sigue siendo
    // del administrador — como revocar el enlace (RF_05), que tampoco es suyo.
    expect(canBulkDisableCommunitySignups(lider, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(lider, "com-2")).toBe(false);
  });

  it("RF_42: el permiso no depende de pedidos ni del historial de dinero de esas cuentas", () => {
    // El predicado recibe DOS cosas —quien pide y sobre que comunidad— y ninguna mas: ni
    // saldos, ni cortes, ni pedidos. Fijar la aridad es lo que impide que manana alguien
    // condicione la contencion a que las tiendas "no deban nada", que es justo lo contrario
    // de lo que dice RF_42: no se borra ni se toca su historial, solo se cierra el acceso.
    expect(canBulkDisableCommunitySignups.length).toBe(2);
    // La comunidad solo sirve para contrastarla con la del actor. Ni se consulta ni se mira su
    // volumen: un administrador la desactiva igual sea cual sea, tambien una que no conoce.
    expect(canBulkDisableCommunitySignups(admin, "com-2")).toBe(true);
    expect(canBulkDisableCommunitySignups(admin, "com-que-no-existe")).toBe(true);
  });
});
