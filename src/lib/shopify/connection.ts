export type ShopifyConnectionStatus = "pending_configuration" | "ready_to_connect" | "connected" | "error";

export type ShopifyConnection = {
  sellerId: string;
  shopDomain?: string;
  status: ShopifyConnectionStatus;
  requiredScopes: string[];
  oauthStartPath: string;
};

export function getSellerShopifyConnection(sellerId: string, shopDomain?: string): ShopifyConnection {
  return {
    sellerId,
    shopDomain,
    status: "pending_configuration",
    requiredScopes: ["read_orders", "write_orders", "read_fulfillments", "write_fulfillments"],
    oauthStartPath: `/api/shopify/oauth/start?sellerId=${encodeURIComponent(sellerId)}`
  };
}
