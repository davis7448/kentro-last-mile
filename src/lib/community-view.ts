import type { Role } from "./types";

/**
 * Etiquetas visibles de cada rol.
 *
 * Existe por una colision de nombres real: `driver` se llama "Lider logistico" en toda la
 * interfaz desde antes de que existiera el lider de comunidad. Escribir "Lider" a secas en
 * cualquiera de los dos hace que el equipo confunda a quien reparte con quien agrupa tiendas.
 */
export function roleLabel(role: Role): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "seller":
      return "Vendedor";
    case "seller_logistics":
      return "Logistico tienda";
    case "driver":
      return "Lider logistico";
    case "messenger":
      return "Mensajero";
    case "community_leader":
      return "Lider de comunidad";
  }
}

/**
 * RF_14, RF_15: que marca se pinta. Con logo del lider, el suyo; sin el, el de la plataforma.
 * Nunca un hueco ni una imagen rota, que es lo que pasa si se confia en que el campo exista.
 */
export type Brand = { kind: "community"; name: string; logoPath: string } | { kind: "platform"; name: string };

export function brandFor(community?: { name?: string; logoPath?: string | null }): Brand {
  const logoPath = typeof community?.logoPath === "string" ? community.logoPath.trim() : "";
  const name = typeof community?.name === "string" ? community.name.trim() : "";
  if (logoPath && name) return { kind: "community", name, logoPath };
  return { kind: "platform", name: "Kentro" };
}
