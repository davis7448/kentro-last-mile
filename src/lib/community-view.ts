import type {
  BulkSignupDisableFailureReason,
  BulkSignupDisableReport,
  BulkSignupDisableSkipReason
} from "../../functions/src/community-containment";
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

// --- Contencion de un enlace filtrado (RF_41, RF_42) ---------------------------------------

/**
 * RF_42: los rotulos hablan SOLO de accesos y de cuentas. Ni pedidos, ni asientos, ni cortes,
 * ni una sola palabra de borrado: la contencion no borra nada, y decir lo contrario engana
 * igual que un contador mal sumado. El orden de las claves es el del enumerado del nucleo, y
 * es el orden en que se pintan los grupos.
 */
export const BULK_DISABLE_FAILURE_LABELS: Record<BulkSignupDisableFailureReason, string> = {
  no_contact_email: "Sin correo de contacto: no hay acceso que buscar",
  auth_lookup_failed: "No se pudo consultar el acceso",
  no_auth_user: "No existe una cuenta con ese correo",
  auth_update_failed: "El acceso sigue abierto: fallo el cierre",
  not_attempted: "No se llego a intentar"
};

/** Los motivos por los que el filtro dejo una tienda intacta. No son fallos. */
export const BULK_DISABLE_SKIP_LABELS: Record<BulkSignupDisableSkipReason, string> = {
  other_community: "De otra comunidad",
  out_of_range: "Fuera del rango elegido",
  no_join_date: "Sin fecha de ingreso",
  invalid_join_date: "Fecha de ingreso ilegible"
};

/**
 * `none` mientras no conste ni un acceso cerrado —veinte fallos son cero contencion, y un rango
 * que no alcanzo a ninguna tienda tampoco contiene nada—; `partial` en cuanto haya un solo
 * fallo junto a los cierres. Que queden tiendas intactas no lo impide: son las que el filtro
 * dejo fuera a proposito.
 */
export type BulkSignupDisableOutcome = "contained" | "partial" | "none";

export type BulkSignupDisableTally<R extends string> = {
  reason: R;
  label: string;
  count: number;
  sellerIds: string[];
};

export type BulkSignupDisableView = {
  communityId: string;
  fromIso: string;
  toIso: string;
  outcome: BulkSignupDisableOutcome;
  /** Los cuatro repartos, cada uno por su lado. Sin un total: fundirlos ES el fallo. */
  counts: { disabled: number; failed: number; untouched: number; blocked: number };
  disabled: { sellerId: string; authUids: string[] }[];
  failures: BulkSignupDisableTally<BulkSignupDisableFailureReason>[];
  skipped: BulkSignupDisableTally<BulkSignupDisableSkipReason>[];
  blocked: string[];
};

/**
 * Agrupa por motivo recorriendo el ENUMERADO, no el informe: si el orden dependiera de como
 * fueran llegando las respuestas de Auth, la misma operacion se leeria distinta cada vez que se
 * corre. Los motivos que no ocurrieron no salen —un grupo en cero es ruido en una pantalla de
 * emergencia— y dentro de cada grupo las tiendas conservan el orden del informe.
 */
function tallyByReason<R extends string>(
  entries: readonly { sellerId: string; reason: R }[],
  labels: Record<R, string>
): BulkSignupDisableTally<R>[] {
  const reasons = Object.keys(labels) as R[];
  return reasons
    .map((reason) => {
      const sellerIds = entries.filter((entry) => entry.reason === reason).map((entry) => entry.sellerId);
      return { reason, label: labels[reason], count: sellerIds.length, sellerIds };
    })
    .filter((group) => group.count > 0);
}

/**
 * Lo que el administrador LEE despues de una desactivacion en bloque.
 *
 * `summarizeBulkSignupDisable` (T32) ya reparte cada tienda planeada entre desactivadas,
 * fallidas, intactas y selladas, cada una con su motivo de un enumerado cerrado. Eso cierra el
 * fallo mudo en el servidor; esto cierra la otra mitad, que es la unica que alguien mira.
 *
 * El modo de fallo peligroso no es contener de mas, sino de menos: quien lee "18 tiendas
 * desactivadas" da la fuga por contenida y se va. Si las fallidas se sumaran con las cerradas,
 * o las intactas se agruparan en un numero sin motivo, volveria el mismo fallo que T32 acaba de
 * cerrar, ahora en la interfaz y sin que nada se ponga rojo. Por eso el mapeo es una funcion
 * pura y no vive inline en la pantalla: aqui se puede probar.
 */
export function buildBulkSignupDisableView(report: BulkSignupDisableReport): BulkSignupDisableView {
  const outcome: BulkSignupDisableOutcome =
    report.disabled.length === 0 ? "none" : report.failed.length > 0 ? "partial" : "contained";

  return {
    communityId: report.communityId,
    fromIso: report.fromIso,
    toIso: report.toIso,
    outcome,
    counts: {
      disabled: report.disabled.length,
      failed: report.failed.length,
      untouched: report.untouched.length,
      blocked: report.blocked.length
    },
    // Una tienda puede tener mas de una cuenta con su correo. El informe las devuelve en crudo
    // (T32) y esta vista no es quien para reducirlas a un numero.
    disabled: report.disabled.map((entry) => ({ sellerId: entry.sellerId, authUids: [...entry.authUids] })),
    failures: tallyByReason(report.failed, BULK_DISABLE_FAILURE_LABELS),
    skipped: tallyByReason(report.untouched, BULK_DISABLE_SKIP_LABELS),
    blocked: [...report.blocked]
  };
}
