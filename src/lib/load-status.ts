/**
 * Que tiene derecho a DECIR una pantalla segun como haya ido la carga (spec 005, RF_07, RF_08).
 *
 * Hoy `SellerView` (`operations-app.tsx:11177`) busca la tienda con
 * `state.sellers.find((item) => item.id === session.profileId)` y, si no la encuentra, pinta
 * "Perfil de vendedor pendiente. Tu cuenta existe, pero falta vincularla a una tienda. Un
 * administrador debe asignar tu usuario al sellerId correcto" (`:11255`). Ese mensaje se emite SIN
 * saber si la carga funciono, y ahi esta el fallo: cuando la descarga de `sellers` se cae —por una
 * regla que deniega, por la red, por lo que sea— la lista llega vacia y la pantalla le atribuye el
 * problema a la CONFIGURACION de la cuenta. Le dice a la persona que vaya a pedirle al administrador
 * un arreglo que no hace falta, mientras la tienda esta perfectamente vinculada. Una lista vacia no
 * significa "no tienes tienda": significa "no se pudo saber".
 *
 * Por eso el `outcome` de la carga manda PRIMERO y RF_07 gana siempre a RF_08 (plan §3.3). Sin datos
 * no se puede afirmar nada sobre la cuenta, ni siquiera cuando lo que hay a mano "parece" confirmar
 * que la cuenta esta mal configurada. Con `loading` o `failed` no se mira ni `sellerId` ni `sellers`.
 *
 * Este modulo DECIDE; la pantalla (T8) solo pinta el estado que aqui se devuelve. La decision vive
 * fuera del componente para poder probarla sin montar React, que es lo que la union monolitica de
 * `operations-app.tsx` hacia imposible.
 *
 * Sin imports a proposito: lo van a usar la pantalla y quiza el estado, asi que no puede arrastrar
 * React, Firestore ni Node. Puro: no muta la entrada ni la lista, y dos llamadas iguales dan lo mismo.
 */

/** Como fue UNA carga. `loading` y `failed` son estados de la carga, no de la cuenta. */
export type LoadOutcome = "loading" | "ok" | "failed";

export type StoreProfileState =
  | { kind: "loading" }
  | { kind: "ok"; sellerId: string }
  | { kind: "load_failed" } // RF_07: aviso + reintentar, nunca "perfil pendiente"
  | { kind: "no_store_assigned" } // RF_08, caso 1: la cuenta no tiene tienda
  | { kind: "store_missing" }; // RF_08, caso 2: la tienda asignada ya no aparece

export function storeProfileState(input: {
  /** La carga BASE. Manda sobre todo lo demas. */
  outcome: LoadOutcome;
  /** El id del reclamo; "" (o en blanco) si la cuenta no tiene tienda. */
  sellerId: string;
  /** Puede traer OTRAS tiendas: un lider baja las de su comunidad ademas de la suya. */
  sellers: ReadonlyArray<{ id: string }>;
}): StoreProfileState {
  // 1 y 2. El estado de la carga se resuelve ANTES de mirar la cuenta (RF_07 > RF_08).
  if (input.outcome === "loading") return { kind: "loading" };
  if (input.outcome === "failed") return { kind: "load_failed" };

  // A partir de aqui la carga fue buena y lo que se vea de la cuenta si es cierto (RF_08).
  //
  // El recorte cuenta como "sin asignar" y no como "tienda que ya no existe" porque un reclamo en
  // blanco ("" o "   ") no nombra ninguna tienda: no hay nada que haya podido desaparecer. Son dos
  // averias distintas con arreglos distintos —a una cuenta hay que asignarle su tienda; a la otra
  // hay que averiguar por que se borro o se renombro la que tenia— y por eso la pantalla les debe
  // mensajes distintos. Buscar un id en blanco dentro de `sellers` daria "no esta" y acabaria
  // culpando a una tienda inexistente de un problema que es de asignacion.
  const claimedSellerId = input.sellerId.trim();
  if (claimedSellerId === "") return { kind: "no_store_assigned" };

  // `some` recorre sin mutar; basta con saber si el id RECLAMADO esta. Que la lista traiga ademas
  // las tiendas de la comunidad no cambia ninguna decision.
  const isPresent = input.sellers.some((seller) => seller.id === claimedSellerId);
  if (!isPresent) return { kind: "store_missing" };

  // Se devuelve el id reclamado (ya normalizado), no el del elemento encontrado: es el mismo valor,
  // y es el que la pantalla vuelve a usar para localizar la tienda en `state.sellers`.
  return { kind: "ok", sellerId: claimedSellerId };
}

export type CommunityStoresState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "load_failed" } // RF_10: eso si es un fallo, y si admite reintentar
  | { kind: "no_stores" } // RF_11: no es un error, y no lleva reintentar
  | { kind: "not_governing" }; // RF_12: la negativa es la respuesta correcta

/**
 * Por que la pantalla de comunidad no tiene tiendas que ensenar (spec 005, RF_10, RF_11, RF_12).
 *
 * Hoy `CommunityLeaderView` (`operations-app.tsx:5052-5092`) resuelve esto con una rama de carga y
 * UNA tarjeta de error generica, "No se pudieron cargar tus cifras" (`:5060-5067`), que absorbe tres
 * situaciones distintas. Y una de las tres NO es un fallo: al **acreedor** —quien dejo de liderar
 * pero sigue cobrando lo que se le debe— el servidor le niega `getCommunityStats` **por diseno**
 * (`community-access.ts:130-132`: `canReadCommunityStats` solo reconoce admin o lider de ESA
 * comunidad). Es la respuesta correcta, no una averia. Pintarsela como error es mentirle, y encima
 * ofrecerle un boton de reintentar es mandarlo a reintentar para siempre algo que ningun reintento
 * le va a conceder. Que vea "Todavia no tienes tiendas" (`:5069`) seria peor todavia: las tiendas
 * existen, lo que pasa es que ya no son suyas.
 *
 * La condicion de esa tercera tarjeta, `!stats || stats.emptiness === "no_stores"` (`:5069`), mete el
 * mismo error una vez mas por el otro lado: una respuesta que no llego (`!stats`) se pinta como
 * comunidad vacia. "No se pudo saber" y "no hay nada" son cosas distintas. Aqui se separan.
 *
 * EL ORDEN DE DECISION IMPORTA, y es este:
 *
 *   1. Acreedor -> `not_governing`, ANTES de mirar `statsOutcome`. Si se mirara antes la carga, su
 *      denegacion por diseno saldria clasificada como `load_failed`, que es justo el fallo a matar.
 *   2. `loading` -> `loading`.
 *   3. `failed`  -> `load_failed` (RF_10).
 *   4. `emptiness === "no_stores"` -> `no_stores` (RF_11).
 *   5. resto -> `ok`.
 *
 * Dos cosas que NO pueden pasar, y por que:
 *
 * - **`standing: undefined` NO es acreedor.** No es un caso teorico: es el estado de HOY, porque
 *   `subscribeFirebaseUser` (`firebase/auth.ts`) todavia no propaga la posicion en la comunidad (lo
 *   arregla T6). Si la ausencia de posicion se tratara como acreedor, a TODO lider de verdad se le
 *   diria "ya no gobiernas esta comunidad" y se le esconderia su comunidad entera mientras T6 no
 *   entre. Ante la duda se gobierna: con `undefined` el comportamiento es identico al de `"leader"`.
 *
 * - **`emptiness` no decide nada si la carga no fue buena.** Por el orden ni se mira, y es
 *   deliberado: ese campo describe una respuesta que SI llego, asi que con la callable cargando o
 *   caida no hay nada que describir. Dejar que un `"no_stores"` residual de la llamada anterior
 *   decidiera seria repetir el fallo de `:5069`, pintar una carga rota como comunidad vacia.
 *
 * Y un aviso sobre la entrada: `statsOutcome` es la carga de la CALLABLE `getCommunityStats`, no la
 * carga base de Firestore. Son DOS cargas distintas y mezclarlas fue la contradiccion que encontro el
 * analisis. El `LoadReport` de `sellers` no entra aqui: su unica consecuencia es el aviso de que el
 * enlace de invitacion no se pudo resolver, y eso es T9 (plan §3.5).
 *
 * Este modulo DECIDE; la pantalla solo pinta. Puro: no muta la entrada y dos llamadas iguales dan lo
 * mismo.
 */
export function communityStoresState(input: {
  /** Como fue la llamada a la CALLABLE `getCommunityStats`, no la carga base. */
  statsOutcome: LoadOutcome;
  /** Posicion en la comunidad. `undefined` = aun no se sabe, y se decide como lider (T6). */
  standing: "leader" | "creditor" | undefined;
  /** Tal cual lo emite el servidor (`community-stats-math.ts:151,186`), mas el campo ausente. */
  emptiness: "no_stores" | "no_orders_in_period" | null | undefined;
}): CommunityStoresState {
  // 1. RF_12 gana a todo, y va antes que la carga a proposito: al acreedor el servidor le deniega
  //    por diseno, asi que como haya ido la llamada es irrelevante. Se compara contra "creditor" en
  //    positivo —y no "todo lo que no sea leader"— para que `undefined` caiga del lado del lider.
  if (input.standing === "creditor") return { kind: "not_governing" };

  // 2 y 3. El estado de la carga se resuelve antes de interpretar lo que la respuesta traiga.
  if (input.statsOutcome === "loading") return { kind: "loading" };
  if (input.statsOutcome === "failed") return { kind: "load_failed" };

  // 4. La carga fue buena, asi que `emptiness` ya describe algo real. Solo `"no_stores"` significa
  //    comunidad sin tiendas: `"no_orders_in_period"` es una comunidad CON tiendas a la que le
  //    faltan pedidos en el periodo, y ahi la pantalla normal es la correcta.
  if (input.emptiness === "no_stores") return { kind: "no_stores" };

  // 5. Hay tiendas y hay cifras que ensenar.
  return { kind: "ok" };
}

/** Que parte de la carga base falto. Una caida no implica las demas (plan §2). */
export type LoadIssue = "community_sellers";
export type LoadReport = { issues: readonly LoadIssue[] };

/**
 * La union de las dos mitades de `sellers` y el parte de lo que falto (spec 005, RF_01, RF_06, RF_02).
 *
 * Hoy `loadFirestoreState` (`state-store.ts:182-193`) pide las tiendas con un `Promise.all` de dos
 * mitades —la tienda propia por id, y `sellers where communityId ==` la suya— y las une con
 * `mergeById`. Medido en T1 contra produccion (plan §0): la segunda mitad se rechaza con
 * `403 PERMISSION_DENIED`, y como es un `Promise.all`, ese rechazo **tumba la carga entera**: la
 * pantalla se queda sin tienda, sin ciudades y sin ajustes. De ahi salia el "Perfil de vendedor
 * pendiente" que vio la primera cuenta real con los dos papeles.
 *
 * La mitad de comunidad es degradable; la tienda propia NO. Por eso la de comunidad puede llegar aqui
 * como `{ failed: true }` y la propia siempre como lista: quien decide esa asimetria es el llamador
 * (envuelve una y exige la otra), y este modulo solo tiene que saber interpretarla.
 *
 * **"No hay" y "no se pudo saber" son cosas distintas, y por eso esto devuelve un PARTE ademas de la
 * lista.** Una comunidad recien creada y una consulta rechazada producen exactamente la misma lista
 * vacia; sin el parte la pantalla no podria distinguirlas y le ensenaria "todavia no tienes tiendas"
 * a quien en realidad las tiene pero no se pudieron leer. Y la degradacion no es gratis: sin la mitad
 * de comunidad el lider pierde tambien el enlace de invitacion (`communitySignupSlug`, hallazgo 2 del
 * plan §0), asi que lo que falto tiene que poder viajar hasta la pantalla. Por eso una mitad de
 * comunidad **vacia** no es una incidencia —esa consulta respondio, y respondio cero— y una
 * **rechazada** si lo es.
 *
 * Orden: la propia primero y luego las de la comunidad que no estuvieran ya. Es estable a proposito:
 * la tienda propia es la que la pantalla de la tienda busca primero, y un orden que cambiara entre
 * cargas moveria las filas del desglose de comunidad sin motivo. Sin duplicados, como ya garantizaba
 * `mergeById`: la tienda de un lider que ademas pertenece a su propia comunidad llega por las dos
 * mitades y tiene que salir UNA vez, o la pantalla la contaria dos veces (§5 viñeta 1).
 *
 * Generica en `T` para que `state-store.ts` le pase `Seller` entero sin castear ni perder campos por
 * el camino. Pura: no muta ninguna de las dos mitades ni sus elementos.
 */
export function mergeCommunitySellers<T extends { id: string }>(input: {
  own: readonly T[];
  community: readonly T[] | { failed: true };
}): { sellers: T[]; report: LoadReport } {
  // Se discrimina con `in` y no con `Array.isArray`: sobre una union con `readonly T[]` el narrowing
  // de `isArray` no conserva el lado de la lista (su firma promete `any[]`, que no la admite).
  const communityFailed = "failed" in input.community;
  const community: readonly T[] = communityFailed ? [] : (input.community as readonly T[]);

  // Acumulador nuevo y `Set` de ids ya vistos: se recorre propia-y-luego-comunidad una sola vez, y
  // la primera aparicion de cada id es la que sobrevive. Las dos copias de una tienda que llega por
  // las dos mitades son el MISMO documento leido por dos consultas, asi que cual gane es indiferente.
  const sellers: T[] = [];
  const seenIds = new Set<string>();
  for (const seller of [...input.own, ...community]) {
    if (seenIds.has(seller.id)) continue;
    seenIds.add(seller.id);
    sellers.push(seller);
  }

  return { sellers, report: { issues: communityFailed ? ["community_sellers"] : [] } };
}
