import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shopify App Store Review | Kentro",
  description: "Testing instructions and review notes for the Kentro Shopify app."
};

const reviewSteps = [
  "Open Kentro at https://kentro.com.co.",
  "Log in with the seller review account provided in the Shopify review submission.",
  "Go to Conexion Shopify in the seller dashboard.",
  "Enter a Shopify test store domain, for example your-test-store.myshopify.com.",
  "Click Conectar tienda and approve the Shopify OAuth permission screen.",
  "After authorization, confirm the connected store appears in the seller dashboard.",
  "Create a test order in the connected Shopify store.",
  "Confirm the order appears in Kentro under Pedidos.",
  "Log in as admin and assign the order to an active transportista.",
  "Log in as the transportista and advance the order through call confirmation, pickup, route, and delivery or exception.",
  "Upload a small JPG or PNG as delivery evidence and add an observation.",
  "Return to admin and verify order status, evidence, wallet movements, and inventory reservations."
];

const notes = [
  "Kentro supports multiple Shopify stores per seller.",
  "OAuth uses read_orders, read_fulfillments and read_products. read_all_orders may be requested for reconciliation of missed or historical orders.",
  "Orders outside the active operating city may be ignored by the current operational configuration.",
  "Shopify access tokens are stored server-side in restricted storage and are not visible to client users.",
  "The app uses role-based dashboards for admin, seller, and transportista users."
];

export default function ShopifyAppStoreReviewPage() {
  return (
    <main className="min-h-screen bg-field px-4 py-8 text-ink">
      <article className="mx-auto max-w-3xl rounded-lg border border-black/10 bg-white p-6 shadow-panel">
        <p className="text-sm font-semibold uppercase tracking-normal text-black/50">Kentro</p>
        <h1 className="mt-2 text-3xl font-bold">Shopify App Store Review</h1>
        <p className="mt-3 text-sm leading-6 text-black/70">
          Kentro connects Shopify stores with a last-mile delivery operation. The app imports orders, supports driver assignment, delivery evidence, inventory reservations, wallets, and settlements.
        </p>

        <section className="mt-6">
          <h2 className="text-lg font-bold">Testing Instructions</h2>
          <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm leading-6 text-black/70">
            {reviewSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold">App-Specific Notes</h2>
          <ul className="mt-3 grid list-disc gap-2 pl-5 text-sm leading-6 text-black/70">
            {notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>

        <section className="mt-6 rounded-md bg-field p-4">
          <h2 className="text-lg font-bold">Required URLs</h2>
          <div className="mt-3 grid gap-2 text-sm text-black/70">
            <p><b>App URL:</b> https://kentro.com.co</p>
            <p><b>Privacy Policy:</b> https://kentro.com.co/privacy</p>
            <p><b>OAuth Callback:</b> https://us-central1-kentro-last-mile.cloudfunctions.net/shopifyOAuthCallback</p>
            <p><b>Webhook Endpoint:</b> https://us-central1-kentro-last-mile.cloudfunctions.net/shopifyWebhook</p>
          </div>
        </section>
      </article>
    </main>
  );
}
