import type { Metadata } from "next";
import SignupForm from "./signup-form";

/**
 * Pantalla publica de registro por enlace de comunidad.
 *
 * Es la unica ruta de la plataforma que se abre sin sesion, y casi siempre en un movil desde
 * un enlace compartido por WhatsApp. De ahi dos decisiones: la marca se resuelve en el cliente
 * (la callable publica es la unica que sabe si el enlace sigue vivo) y el formulario pide
 * cinco campos, ni uno mas.
 */
export const metadata: Metadata = {
  title: "Registra tu tienda | Kentro",
  robots: { index: false, follow: false }
};

export default async function CommunitySignupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-5 py-10">
      <SignupForm slug={slug} />
    </main>
  );
}
