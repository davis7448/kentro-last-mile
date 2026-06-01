import type { ShopifyStore } from "@/lib/types";

const shopifyOAuthStartEndpoint = "https://us-central1-kentro-last-mile.cloudfunctions.net/shopifyPilotOAuthStart";

export type ShopifyConnectionStatus = "pending_configuration" | "ready_to_connect" | "connected" | "error";

export type ShopifyConnection = {
  sellerId: string;
  shopDomain?: string;
  status: ShopifyConnectionStatus;
  requiredScopes: string[];
  oauthStartPath: string;
};

export function normalizeShopifyDomain(shop: string) {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "")
    .concat(".myshopify.com");
}

export function getSellerShopifyConnection(sellerId: string, shopDomain?: string, store?: ShopifyStore): ShopifyConnection {
  return {
    sellerId,
    shopDomain: store?.shopDomain ?? shopDomain,
    status: store?.status ?? "ready_to_connect",
    requiredScopes: ["read_orders", "read_fulfillments", "read_products"],
    oauthStartPath: `${shopifyOAuthStartEndpoint}?sellerId=${encodeURIComponent(sellerId)}`
  };
}

export function shopifyOAuthStartUrl(sellerId: string, shopDomain: string) {
  const normalized = normalizeShopifyDomain(shopDomain);
  return `${shopifyOAuthStartEndpoint}?sellerId=${encodeURIComponent(sellerId)}&shop=${encodeURIComponent(normalized)}`;
}
