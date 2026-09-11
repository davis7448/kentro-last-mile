/**
 * El documento con el que nace una tienda captada por el enlace de un lider. SIN acceso a
 * Firestore ni a Auth, y sin reloj propio.
 *
 * Hasta ahora este objeto se armaba inline dentro de `registerSellerBySlug`, entre la llamada
 * a Auth y la escritura en Firestore. Ahi dentro no se puede afirmar nada: para ver que se
 * guarda hay que crear una cuenta de verdad. Y es justo lo que se guarda lo que sostiene los
 * dos requisitos mas delicados del alta por enlace:
 *
 *   - RF_07: la tienda nace OPERATIVA. El alta es automatica por decision de negocio y nadie
 *     aprueba nada. Un solo campo que insinue lo contrario —un `status: "pending"`, un
 *     `approved: false`— y la tienda que se registro desde el movil en la reunion del lider
 *     no puede operar, sin que nadie se entere. Por eso el documento son quince claves
 *     cerradas y la contrasena no es una de ellas: vive en Auth y solo en Auth.
 *   - RF_08: queda constancia PERMANENTE de por que enlace entro y cuando. Esa procedencia
 *     —`communityId`, `communityJoinedAt`, `communitySignupSlug`— es lo unico que hace
 *     posible la contencion de RF_41 (`community-containment.ts`): desactivar en bloque lo
 *     que entro por un enlace filtrado en un rango de fechas. Si el slug se escribe en crudo,
 *     deja de casar con `communitySlugs` y el remedio se deja tiendas fuera, en silencio.
 *
 * De ahi que el instante llegue por parametro y no de `Date.now()`: siendo puro, lo que se
 * previsualiza y lo que se escribe no pueden divergir, y una reejecucion no reescribe la
 * procedencia con otra fecha.
 */
import { normalizeSlug } from "./community-slug";
import type { SignupInput } from "./community-signup-validate";

export type SignupSellerDocContext = {
  /** Lo genera la callable: aqui dentro no hay reloj. */
  sellerId: string;
  communityId: string;
  /** En crudo, tal como venia en el enlace: se normaliza aqui. */
  slug: string;
  /** El defecto `city-cali` vive en la callable, que es quien lee `settings/app`. */
  activeCityId: string;
  nowIso: string;
};

export type SignupSellerDoc = {
  id: string;
  name: string;
  shopDomain: string;
  cityId: string;
  bankAccount: string;
  email: string;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  communityId: string;
  communityJoinedAt: string;
  communitySignupSlug: string;
  onboardingComplete: boolean;
  createdAt: string;
  updatedAt: string;
};

export function buildSignupSellerDoc(input: SignupInput, context: SignupSellerDocContext): SignupSellerDoc {
  return {
    id: context.sellerId,
    name: input.storeName,
    shopDomain: "",
    cityId: context.activeCityId,
    bankAccount: "",
    email: input.email,
    contactEmail: input.email,
    contactName: input.responsibleName,
    contactPhone: input.phone,
    communityId: context.communityId,
    communityJoinedAt: context.nowIso,
    communitySignupSlug: normalizeSlug(context.slug),
    // RF_44: entra y se mueve por la app, pero no crea pedidos hasta completar ciudad,
    // punto de recogida y cuenta bancaria.
    onboardingComplete: false,
    createdAt: context.nowIso,
    updatedAt: context.nowIso
  };
}
