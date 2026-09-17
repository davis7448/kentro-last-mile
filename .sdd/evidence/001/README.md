# Evidencia funcional — Spec 001: Lider de comunidad

Fecha: 2026-09-11 · Rama `feat/pedido-manual-multilinea` · Commit `89ad5bb`
Ejecutado contra el **build de produccion** (`next build` + `next start -p 3100`), no contra `next dev`.

---

## Lo que se verifico, y con que resultado

| Recorrido | Viewport | Consola | 4xx/5xx | Desborde | Veredicto |
|---|---|---|---|---|---|
| `RNF_03_registro-movil-enlace-invalido` | 390x844, UA iOS 14.8 | 4 (ver nota) | 0 | no | **pasa** |
| `RNF_05_portada-movil` | 390x844, UA iOS 14.8 | 1 (ver nota) | 0 | no | **pasa** |
| `RNF_05_portada-escritorio` | 1280x900 | 0 | 0 | no | **pasa** |

Cada carpeta trae `pantalla.png`, `trace.zip` (DOM, red y consola paso a paso), `consola.log` y
`red-fallida.log`.

### RNF_03 — la pantalla publica en un iPhone con iOS 14

Renderiza completa, sin desborde horizontal, y **el mensaje es el que exige RF_09**:

> Este enlace ya no admite registros. Pide un enlace vigente a quien te invito.
> Si ya tienes cuenta, inicia sesion.

No revela si la comunidad existe, que es justo lo que la spec pide de un enlace invalido.

### Guardia de navegadores (CLAUDE.md)

```
find .next/static -name "*.js" | wc -l   ->  17
grep -rlo 'static{' .next/static          ->   0
```

Cero `class static block` en los 17 chunks. En iOS 14 eso no es un error de ejecucion sino de
**sintaxis**: el navegador descarta el bundle entero y la app no pinta nada. El `browserslist` del
`package.json` sigue haciendo su trabajo.

### Nota sobre los errores de consola

Los cuatro de la pantalla de registro son **artefactos de correr en localhost**, no fallos del
producto:

- `404` y CORS sobre `getCommunityBySlug` — **esa callable todavia no esta desplegada** (ver abajo),
  y aunque lo estuviera, `localhost:3100` no es un origen autorizado.
- Aviso de dominio no autorizado para OAuth: `localhost` no esta en la lista de dominios de
  Firebase Auth. Esperado y sin efecto aqui.

**Un hallazgo que si merece anotarse:** cuando la callable falla, la pantalla muestra exactamente el
mismo mensaje que ante un enlace revocado. Para RF_09 es correcto; para una caida del backend es
engañoso — una tienda que no puede registrarse creeria que su enlace ya no vale. No lo cubre ningun
requisito de la spec 001 y no se ha tocado; queda como candidato a spec propia.

---

## Lo que NO se pudo verificar, y por que

**Produccion tiene cero comunidades.** Comprobado en solo lectura el 11-09-2026:

```
comunidades: 0 · slugs registrados: 0 · tiendas con comunidad: 0 · asientos de cashback: 0
```

No hay enlace real que abrir, ni lider con quien entrar, ni cashback que contener. Los tres
recorridos que pedia la auditoria exigirian **sembrar datos sinteticos en la plataforma viva**:

| Recorrido | Que exigiria | Por que no se hizo |
|---|---|---|
| Registro completo por enlace (RF_07, RF_43) | Crear comunidad, lider y **una tienda real** con su usuario de Auth | Contamina `sellers`, `communities` y Auth de la plataforma que mueve el dinero real |
| Contencion de punta a punta (RF_41, RF_42) | **Desactivar cuentas reales** en un rango | Accion en bloque, dificil de revertir, sobre cuentas de produccion |
| Panel del lider con cifras (RF_29-RF_33) | Pedidos y cashback sinteticos | Desvia `getPlatformPosition`, `getOrderStats`, los cortes y el panel del admin |

Es la misma razon por la que `docs/rendimiento.md` dice que RNF_01 no se midio contra produccion.
**No hay emuladores configurados** en `firebase.json`: montarlos es el camino limpio para cerrar
estos tres, y es trabajo propio, no un paso de esta verificacion.

`RNF_05` queda cubierto **solo en la parte publica**. El panel del lider y el del admin siguen sin
captura, porque no hay con quien entrar.

---

## Estado para desplegar

Comprobado contra produccion el 11-09-2026:

**Funciones** — 66 locales, 51 en produccion.
- **15 nuevas** se anadirian: `getCommunityBySlug`, `registerSellerBySlug`, `createCommunityLeader`,
  `setCommunityLeaderStatus`, `setCommunityLinkStatus`, `setCommunitySlug`, `setCommunityLogo`,
  `scheduleCommunityPrice`, `cancelScheduledCommunityPrice`, `dismissMassSignupAlert`,
  `disableCommunitySignupsInRange`, `reassignSellerCommunity`, `getCommunityStats`,
  `getMyStoreTariff`, `onSettingsFloorRaise`.
- **0 se borrarian.** El guard de `scripts/guard-functions-deploy.js` queda satisfecho.

**Indices** — 39 locales, 30 en produccion (normalizando el `__name__` implicito).
- **9 nuevos** se crearian: los siete de `orders` por `communityId`, el de
  `sellers(communityId, communityJoinedAt)` —el que usa la contencion de RF_41— y
  `walletEntries(ownerType, ownerId, createdAt)`.
- **0 se borrarian.**

**Calidad** — 532 pruebas verdes, `tsc` limpio en raiz y en `functions/`, `npm run lint` con 0
errores y los 3 avisos conocidos, `next build` correcto y `functions/npm run build` correcto.

### Orden obligatorio (regla de oro #12)

1. `firebase deploy --only firestore:indexes --project kentro-last-mile` y **esperar a `READY`**
   (varios minutos en `orders`). Una consulta sin indice falla EN DURO: el rol afectado se queda
   sin pedidos.
2. `cd functions && npm run build` y
   `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions --project kentro-last-mile`.
3. `firebase deploy --only firestore:rules,storage --project kentro-last-mile`.
   **`storage.rules` cambio en T45** y sin esa regla la subida de logos se deniega.
4. `firebase deploy --only hosting --project kentro-last-mile`.

**Functions antes que hosting, sin excepcion:** `disableCommunitySignupsInRange` cambio su forma de
retorno (de `{ disabled: string[] }` al informe completo). Hosting primero dejaria al panel nuevo
recibiendo la forma vieja.


---

## Despliegue a produccion — 11-09-2026

Lanzado en los cuatro pasos del orden obligatorio, esperando a que cada uno terminara.

| Paso | Resultado |
|---|---|
| 1. `firestore:indexes` | Desplegado. **39/39 READY** comprobado por sondeo (los 9 nuevos tardaron ~5 min) |
| 2. `functions` | 66/66 desplegadas. **0 borradas** |
| 3. `firestore:rules` + `storage` | Las dos compiladas y publicadas |
| 4. `hosting` | Publicado en https://kentro-last-mile.web.app |

### Dos cosas que pasaron y conviene dejar escritas

**`onSettingsFloorRaise` fallo en el primer intento.** Es el primer trigger de Eventarc del
proyecto y la identidad de servicio no existia todavia; el reintento la genero
(`generating the service identity for eventarc.googleapis.com`) y la funcion se creo sin tocar
nada mas. Si se despliega un trigger nuevo en un proyecto sin ninguno, contar con ese reintento.

**El guard bloqueo `--only hosting`.** El hosting de Next.js lleva su propia funcion SSR
(`ssrkentrolastmile`), asi que `--only hosting` arrastra `functions` y dispara el predeploy. Se
levanto con `ALLOW_FUNCTIONS_DEPLOY=1` **despues** de comprobar 66 locales / 66 desplegadas y cero
borrados, que es exactamente la condicion que el guard existe para proteger.

### Comprobacion en vivo

```
portada                         HTTP 200 en 0,22 s
cache-control de la portada     no-cache, must-revalidate   <- la trampa del CLAUDE.md, correcta
/registro/<slug inexistente>    HTTP 200
getCommunityBySlug              HTTP 200 -> {"result":{"acceptsSignups":false}}
```

Esa ultima linea es la que antes daba 404: la callable ya vive, y ante un slug inexistente responde
**sin revelar si la comunidad existe**, que es lo que pide RF_09.

### E2E contra produccion (evidencia en `PROD_*`)

| Recorrido | Carga | Consola | 4xx/5xx | Desborde |
|---|---|---|---|---|
| `PROD_RNF_03_registro-movil` | 2.233 ms | 1 (favicon) | 0 | no |
| `PROD_RNF_05_portada-movil` | 1.925 ms | 0 | 0 | no |

iPhone 390x844 con UA de iOS 14.8. El unico error de consola es `/favicon.ico` 404: cosmetico,
preexistente y ajeno a esta spec (tampoco existen `manifest.json` ni `apple-touch-icon.png`).

**Lo que sigue sin poder verificarse no cambia con el despliegue:** produccion sigue teniendo cero
comunidades. El recorrido completo de registro, la contencion de punta a punta y el panel del lider
necesitan una comunidad real creada por un administrador, o emuladores.
