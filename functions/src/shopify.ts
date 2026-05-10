import { onRequest } from "firebase-functions/v2/https";

export const shopifyOAuthStart = onRequest(async (request, response) => {
  const sellerId = String(request.query.sellerId ?? "");
  const shop = String(request.query.shop ?? "");

  response.status(501).json({
    ok: false,
    status: "pending_configuration",
    sellerId,
    shop,
    next: "Configure SHOPIFY_APP_API_KEY, SHOPIFY_APP_API_SECRET and implement HMAC-protected OAuth callback."
  });
});

export const shopifyOAuthCallback = onRequest(async (_request, response) => {
  response.status(501).json({
    ok: false,
    status: "pending_configuration",
    next: "Exchange Shopify code for access token, encrypt it, store shopifyStores/{sellerId}, then subscribe webhooks."
  });
});
