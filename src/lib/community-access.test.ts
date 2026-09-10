import { describe, expect, it } from "vitest";
import {
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
