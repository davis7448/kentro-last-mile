# Constitucion del proyecto: Kentro (plataforma de ultima milla)

Reglas fundamentales de este repositorio. Cualquier propuesta que las viole se rechaza, venga de
quien venga. Los principios 8 a 13 no son teoria: cada uno esta escrito a partir de un fallo que ya
llego a produccion y costo dinero o dejo la app en blanco.

**Stack real:** Next.js 16 + React 19 + TypeScript estricto + Firebase (Hosting / Functions Node 20 /
Firestore / Storage) + Tailwind 3. Gestor: npm con `package-lock.json`. Integracion con Shopify.

**Comandos de verdad:**

| Que | Comando | Donde |
|---|---|---|
| Pruebas | `npm test` (`vitest run`) | raiz — cubre `src/**/*.test.ts` |
| Tipos (app) | `npx tsc --noEmit` | raiz |
| Tipos (backend) | `npx tsc --noEmit` | `functions/` |
| Lint | `npm run lint` (`eslint src`) | raiz |

---

## 1. La especificacion manda

Ninguna linea de codigo de produccion se escribe, cambia o borra sin una especificacion previa
aprobada en `specs/`. La spec se mantiene sincronizada con el comportamiento real del sistema: una
spec que miente es peor que no tener spec.

## 2. Simplicidad del stack

Se prioriza lo que el proyecto ya usa. Cada dependencia nueva se justifica en el plan y requiere
aprobacion humana explicita. **`browserslist` no se sube sin motivo escrito**: con el objetivo por
defecto de Next 16, el propio runtime emite un `class static block` que en iOS 14 no es un error de
ejecucion sino de sintaxis — el navegador descarta el bundle entero y la app no pinta nada.

## 3. Nucleo desacoplado de la interfaz

La logica de negocio vive en modulos puros y probables sin red ni navegador: `src/lib/finance.ts`,
`src/lib/actions.ts`, `src/lib/date-ranges.ts`, `functions/src/wallet-entries.ts`,
`functions/src/settlement-math.ts`, `functions/src/order-corrections-plan.ts`. Cuando una regla de
dinero tenga que existir en cliente y servidor, se extrae a un modulo puro y se ata con una prueba
que compare ambos lados (como hace `src/lib/platform-position.test.ts`), nunca se copia.

## 4. Sin codigo sin pruebas

Cada requisito funcional tiene al menos una prueba automatizada. Convencion del repo: las pruebas
viven junto al modulo, como `src/lib/<modulo>.test.ts`. Vitest solo recoge `src/**/*.test.ts`, asi
que **el codigo de `functions/` se prueba desde `src/` importando `../../functions/src/<modulo>`** —
ese es el patron existente y se respeta. Nada se da por terminado con la suite en rojo.

## 5. El ciclo de vida de un pedido solo se cambia en el servidor

`status`, `driverId` y la evidencia se modifican **unicamente** por callables
(`applyOrderTransition` y compania), nunca con escrituras directas del cliente. Toda transicion
valida concurrencia optimista (`expectedStatus` == estado real) y queda auditada; las reglas de
Firestore prohiben al cliente escribir esos campos. Esto existe para impedir el "clobber": un
navegador con estado viejo pisando una entrega ya hecha.

## 6. Idioma

Codigo, variables, funciones y archivos en **ingles**. Interfaz de usuario, mensajes de error
visibles, comentarios explicativos y documentacion en **espanol**.

## 7. La entrega la firma un humano

Ningun agente mergea a `main` ni despliega a produccion. El despliegue de Functions esta bloqueado
por `scripts/guard-functions-deploy.js` y exige `ALLOW_FUNCTIONS_DEPLOY=1` de forma deliberada: no
se sortea, se pide.

---

## 8. Antes de recortar una descarga, comprobar que dinero depende de lo recortado

Ningun rol baja su historial completo, y esta bien. Pero el saldo "Pendiente por entregar" del lider
sale de pedidos entregados en efectivo aun sin cortar, que pueden ser muy anteriores a la ventana:
acotar sin rescatarlos por id le bajaba el saldo **$1.135.720 en silencio**. Un recorte de datos no
falla ni avisa — solo muestra menos dinero del que se debe. Toda ventana nueva se acompana de la
comprobacion de que cifra se mueve.

Corolario operativo: el admin puede leer pedidos por lotes; **el lider y el mensajero no**. Un solo
id ajeno o inexistente en un `where(documentId(), "in", [...])` devuelve 403 y tumba el lote entero,
y el error se traga en silencio justo en el saldo. Por eso existe `getDocumentsOneByOne` y no vuelve
al lote.

## 9. El dinero se calcula en un solo sitio

`functions/src/wallet-entries.ts` es la unica fuente de verdad sobre cuanta plata genera un pedido.
**Costo de producto = costo del item por unidad-de-Shopify x cantidad real de Shopify**, cobrado por
linea/SKU, excluyendo "envio prioritario". Nada de expandir cantidades en la plataforma ni de
reintroducir factores fragiles como el viejo `unitsPerSoldUnit`.

`failedCategory` tiene **cinco** valores (`failed_visit`, `no_coverage`, `bad_order_or_no_contact`,
`bad_phone`, `pending_review`). Los cobrables se cuentan **en positivo** (`failed_visit` o campo
ausente), nunca restando los no cobrables: hacerlo al reves desviaba 44 pedidos por `pending_review`.

## 10. Un corte ya pagado o conciliado no se reescribe

Las correcciones de estados terminales se compensan con asientos `-correction-reverse-*` en el
periodo abierto. Un corte pendiente si se recalcula. El planificador
(`order-corrections-plan.ts`) es puro, de modo que `dryRun: true` devuelve exactamente lo que se va
a escribir: la previsualizacion y la aplicacion no pueden divergir, y esa propiedad no se negocia.

## 11. Ante datos que crecen, agregar en servidor antes que ampliar la descarga

La lentitud de esta app nunca ha estado en el pintado, sino en cuantos documentos baja el navegador
antes de mostrar algo. `getOrderStats` y `getPlatformPosition` existen por eso. Antes de tocar nada
por rendimiento se lee `docs/rendimiento.md`, que trae el presupuesto medido por rol y como medirlo.

## 12. Orden de despliegue y cache

**Indices -> functions -> hosting.** Una consulta sin indice falla en duro: el rol afectado se queda
sin pedidos. Los indices se **anaden**, nunca se reemplazan — desplegar borra los que falten en el
archivo, asi que se compara contra produccion antes (`firebase firestore:indexes`).

La cache de `firebase.json` (`no-cache` para el HTML, `immutable` un ano para `/_next/static/**`) no
se toca sin pensar: el `max-age=3600` por defecto de Firebase dejaba la app en blanco en moviles tras
cada despliegue.

## 13. Una importacion nunca cambia de dueno a un pedido

Lo que entra de una tienda actualiza lo que la tienda sabe; **no toca nada de lo que la plataforma
aprendio despues**: ni el lider, ni el mensajero, ni la direccion corregida al confirmar, ni el
precio de comunidad congelado, ni los productos de un pedido cerrado o editado a mano. La regla vive
en un solo sitio (`functions/src/order-import-merge.ts`) y la usan todas las vias de entrada; las
cuatro excepciones estan declaradas ahi mismo, con su razon.

El 2026-09-15, entre las 16:36 y las 16:39, una reimportacion historica dejo **34 pedidos sin
lider**. Lo que se vio: el mensajero del KNT-004747 se quedo sin poder subir evidencia ni marcar
entregado. Lo que no se vio, y es lo caro: 26 entregas en efectivo salieron del saldo pendiente del
lider **sin un solo error en pantalla**.

Dos corolarios que costaron otra tarde de analisis cada uno:

- **`driverId: null` dentro de un `merge` no es "no tocar", es "borrar".** Conservar un campo es
  **omitir la clave**, nunca reescribir el valor leido. Pero en la CREACION ese `null` tiene que
  estar: un documento sin el campo no empareja `where("driverId", "==", null)` y el pedido nuevo no
  aparece en el pozo del lider ni en las cifras.
- **El estado de un pedido no dice si alguien lo toco.** Dos callables editan a mano sin cambiar el
  estado, y una de ellas ajusta el **recaudo** de pedidos que ya van en la calle. Por eso una
  edicion manual deja marca, y un pedido marcado no vuelve a recibir nada de la tienda.

## 14. Lint y diseno antes de subir interfaz

`npm run lint` no es opcional antes de desplegar UI: `react-hooks/rules-of-hooks` va como **error**
porque un `useMemo` tras un `return` anticipado tumbo la app en moviles con React #310, solo para
tiendas y solo sin cache. Antes de tocar interfaz se lee `docs/design-system.md` (sistema "Acid
Glass": tema oscuro, verde acido `#c6f24e` como unico acento, Plus Jakarta Sans).
