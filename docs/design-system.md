# Sistema de diseño de Kentro — "Acid Glass"

Referencia para construir pantallas nuevas. Todos los valores están tomados del código en
producción (`src/app/globals.css`, `tailwind.config.ts`), no de una maqueta.

---

## 1. Cómo se llegó aquí (léelo antes de proponer un estilo)

Se descartaron **cinco direcciones** antes de acertar. Vale la pena saber por qué, para no
repetirlas:

| Intento | Por qué se cayó |
|---|---|
| Papelería logística (guía de carga, sellos, mono) | "no se ve profesional ni moderno" |
| 4 direcciones oscuras (terminal, telemetría, alto contraste, grafito) | mismo veredicto |
| Registro SaaS neutro (azul, verde, oscuro suave) | seguía sin convencer |

El error de método fue **elegir la estética en lugar del usuario**. La dirección solo se
acertó cuando pidió referencias visuales concretas y se extrajeron sus reglas medibles.

**Regla:** no propongas una estética. Pide 3–5 capturas de productos que le gusten, extrae los
ejes medibles (radio, elevación, saturación del acento, densidad) y constrúyelo desde ahí.

Los cinco intentos compartían los mismos tics, que son los que leían como "no profesional":

- esquinas de 0–2px
- bordes duros en vez de elevación
- monoespaciada en rótulos
- microrótulos en MAYÚSCULAS con `letter-spacing` ancho
- paleta apagada, repartida en vez de dominante + acento

---

## 2. Identidad

### Color

Tema **oscuro único**. Los valores viven en `:root` y en `tailwind.config.ts`.

| Token | Valor | Uso | Contraste |
|---|---|---|---|
| `--ink` / `bg-ink` | `#0e1116` | fondo de página | — |
| `--panel` / `bg-panel` | `#191e25` | tarjeta opaca | — |
| `--field` / `bg-field` | `#212832` | superficie secundaria | — |
| `--fg` / `text-fg` | `#f4f6f8` | texto principal | 14.6:1 sobre panel |
| `--fg-2` / `text-ink-70` | `#cbd3dc` | texto terciario | — |
| `--muted` / `text-ink-60` | `#9aa5b3` | texto secundario | 6.1:1 sobre panel |
| `--acid` / `bg-acid` | `#c6f24e` | acción y éxito | 12.2:1 sobre panel |
| `--deep` / `text-deep` | `#10140c` | tinta **sobre** ácido | 13.9:1 |
| `--danger` / `text-rust` | `#ff8b7c` | dinero debido, error | — |
| `text-info` | `#7cc4ff` | informativo | — |

**Reglas de color que no se negocian:**

1. Sobre `bg-acid` el texto va **siempre** en `text-deep`. El ácido es un verde claro: con tinta
   da 13.9:1, con blanco 1.7:1 — ilegible. Se encontraron 4 sitios con blanco sobre ácido,
   incluido el botón de subir evidencia.
2. El ácido es **exclusivo de lo accionable** y de **una** cifra destacada por pantalla. Si hay
   dos cifras en ácido, ninguna destaca.
3. Ningún gris por debajo de `#9aa5b3` para texto. El sistema anterior usaba
   `rgba(0,0,0,.5)` (3.95:1) para rotular los indicadores: fallaba WCAG AA y era invisible al sol.

### Tipografía

**Plus Jakarta Sans** para todo, autoalojada con `next/font` (sin petición a Google en el
arranque, sin salto de texto).

- Titulares: 30–42px, peso 700–800, `letter-spacing: -0.035em`
- Cuerpo: 14px, peso 400–500
- Rótulos: 11–13px en `text-ink-60`
- **Cifras: la misma sans** con la clase `.tabular` (`font-variant-numeric: tabular-nums`)

Nunca monoespaciada para rótulos, nunca mayúsculas con tracking ancho. El dinero necesita
numerales tabulares para alinearse en columna, no una fuente distinta.

### Forma

| Elemento | Radio |
|---|---|
| Botones, chips, pestañas, badges, avatares | `rounded-full` (999px) |
| Tarjetas y paneles | `rounded-2xl` (16px) / `rounded-3xl` (24px) |

Inventario actual: **253 píldoras, 183 contenedores redondeados, cero cuadrados.**

> **Trampa comprobada:** `rounded-full` en un elemento de **bloque** (con `grid`, `flex-col`,
> `content-between` o altura mínima grande) produce un **círculo**, no una píldora. Pasó con los
> filtros de categoría de fallidos: tres líneas apiladas dentro de un `grid min-h-20` salieron
> como círculos con el texto desbordado. **Píldora solo para contenido de una línea.**

### Elevación

Las tarjetas se separan por **tono y sombra**, nunca por filete marcado:

```css
border: 1px solid rgba(255,255,255,0.06);
box-shadow: 0 8px 32px rgba(0,0,0,0.30);
```

Un borde visible devuelve el aspecto de caja. Los filetes de 1px solo se usan **dentro** de una
tarjeta, para separar filas.

---

## 3. Glassmorfismo

Es cristal **esmerilado y discreto**. No es *liquid glass*: nada de bordes con degradado
cromático, nada de barridos especulares.

```css
.glass {
  background: rgba(255,255,255,0.06);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  border: 1px solid rgba(255,255,255,0.14);
}
.glass-acid {
  background: rgba(198,242,78,0.86);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255,255,255,0.32);
  color: var(--deep);
}
```

**Sin luz de color detrás, el cristal no existe.** `backdrop-filter` sobre un color plano no
produce nada. Por eso `.bloom-field` pinta tres brillos radiales difuminados (ácido, azul,
coral) en posición fija detrás de todo. Con dos brillos el cristal se lee como un gris
translúcido; con tres cambia según dónde caiga.

**Lleva cristal:** botón primario, grupo de pestañas, avatar, badge, iconos de barra superior y
**una** tarjeta héroe por pantalla.

**No lleva cristal:** tablas de datos ni bloques de cifras. Van sobre `bg-panel` opaco. Un fondo
que cambia bajo cada fila destruye la comparación en columna, que es justo para lo que existe
esa tabla.

**Se apaga solo** por debajo de 640px y con `prefers-reduced-transparency`: `backdrop-filter`
repinta en cada scroll y las pantallas de calle corren en gama baja.

---

## 4. Dos densidades de un mismo sistema

Kentro son dos productos bajo una misma piel. Antes ambos recibían lo mismo y el de calle era
el de escritorio encogido.

| | Consola (admin, tienda) | Calle (líder, mensajero) |
|---|---|---|
| Contexto | oficina, ratón y teclado | una mano, sol directo, prisa |
| Cuerpo | 13–14px | **17px mínimo** |
| Alto de control | `--control-consola` 44px | `--control-calle` 56px |
| Acción primaria | 44px | 64px |
| Tema | oscuro | **claro** (el oscuro no se lee al sol) |
| Cristal | sí | no |

### Cómo conviven las dos densidades en la misma app

El tema no se cambia con una clase por color: se cambia **redefiniendo los tokens en un subárbol**.
Por eso todos los colores en `tailwind.config.ts` se declaran por canales RGB:

```css
--c-acid: 198 242 78;              /* canales sueltos, sin rgb() */
--acid: rgb(var(--c-acid));
```

```ts
acid: "rgb(var(--c-acid) / <alpha-value>)"   // en tailwind.config.ts
```

Los canales sueltos son lo que permite las dos cosas a la vez:

1. **Modificadores de opacidad de Tailwind** — `bg-acid/10` funciona porque Tailwind sustituye
   `<alpha-value>`. Con `--acid: #c6f24e` guardado entero, `bg-acid/10` no puede componer el alfa.
2. **Tematizar un subárbol** — `.theme-light` redefine solo `--c-ink`, `--c-panel`… y **todo lo que
   cuelga cambia de tema sin tocar una sola clase**. Así `MessengerView` va en claro dentro de una
   app oscura: se envuelve en `.theme-light` y ya. La misma regla sube los controles a 56px y el
   cuerpo a 17px.

**No escribas un color literal en una clase.** Un `bg-[#f7f8f4]` sobrevive a la migración de tokens,
no responde al cambio de tema y aparece como una barra blanca en modo oscuro. Ya pasó dos veces.

---

## 5. Patrones de composición

### Navegación

**Un solo componente** (`ViewTabs`) para los cinco roles: lo que cambia es qué entradas
aparecen, definido en la tabla `NAV_ITEMS` con sus `roles`. La consistencia es por construcción,
no por disciplina.

- **Escritorio:** riel fijo de 84px a la izquierda. Libera altura y deja de desplazarse con el
  contenido.
- **Teléfono:** barra inferior en la zona del pulgar, con `env(safe-area-inset-bottom)`.
- **Máximo 5 entradas.** Seis a 390px dejan 65px cada una.

### Segmentar, no apilar

Si una vista acumula secciones sin relación entre sí, **son destinos distintos**, no una página
larga.

Señal de alarma: **una barra de anclas internas**. Si hiciste atajos para recorrer la página, la
página es demasiado larga. El líder logístico tenía 6 secciones apiladas con anclas y 2 entradas
de navegación; ahora son 5 destinos agrupados **por momento de la jornada**:

`Operación` (todo el día) · `Despacho` (mañana) · `Finanzas` (cierre) · `Wallet` (consulta) ·
`Histórico` (ocasional)

El título de la página cambia por destino (`DRIVER_VIEW_TITLES`). Un "Dashboard" genérico para
seis secciones no dice dónde estás.

### Cuando un destino responde a varias preguntas: pestañas

Segmentar por navegación tiene un límite: no todo merece un icono en el riel. Liquidaciones era un
único destino con **siete tablas seguidas** que en realidad respondían a tres preguntas distintas —
qué hay que pagar hoy, qué se cerró ya, y cuánto se movió en un rango de fechas. Ahí van pestañas
**dentro** de la pantalla, no entradas nuevas en el riel:

- Una pestaña = una pregunta. Si dos pestañas se consultan siempre juntas, son una sola.
- La primera es la accionable, no la informativa. Se entra a Liquidaciones para pagar, no para leer.
- `role="tablist"` en el contenedor y `aria-selected` en cada botón.

Regla para elegir entre riel y pestañas: **el riel separa trabajos, las pestañas separan preguntas
dentro de un trabajo.** Integraciones y Ajustes son trabajos distintos de Operación; "cortes
cerrados" no es un trabajo distinto de "liquidar".

### Franja de KPI + una héroe

Los indicadores no son N tarjetas sueltas: una **sola superficie con separadores**
(`divide-x`), y al lado **una** tarjeta ácida con la cifra que resume el negocio.

### Tablas

En móvil una tabla de 5 columnas no cabe, y la solución no es encogerla: es **convertirla en
tarjetas por fila**. El panel financiero del líder pasó de 4 tablas (hasta 620px de ancho) a 0.

**Toda lista larga pagina.** Ese panel renderizaba 24 cortes + 71 abonos + 61 pedidos = **156
filas de golpe** en un teléfono. Ahora son 6 por página, 18 en total.

Al convertir, **el dato más útil manda**: en Abonos, la nota (`"abono recaudo nequi Martha…"`)
era la columna que se cortaba, y es lo que de verdad se lee. Ahora va a línea completa.

### Reducir densidad sin quitar funciones

El encargo recurrente es "se ve demasiada información y desordenada", **nunca** "quita cosas". Las
cuatro palancas, en el orden en que conviene aplicarlas:

1. **Plegar por bloque — `CollapsiblePanel`.** `title`, `summary`, `count`, `defaultOpen`,
   `hideWhenEmpty`, `tone`, `action`. La regla que hace que funcione: **se abre solo lo que tiene
   trabajo pendiente**. Un día tranquilo y uno con solicitudes abiertas no deben verse igual. Con
   `hideWhenEmpty` el panel vacío no existe, en vez de ocupar espacio diciendo "no hay nada".
2. **Colapsar la fila — `OrderRow`.** Iniciales del cliente, nombre, tracking, píldora de estado con
   punto y valor. Al tocar despliega el `OrderCard` completo. Una tarjeta de pedido tenía 24 campos;
   la fila muestra 5 y **no se pierde ninguno**.
3. **Prosa detrás de un icono.** La explicación de una métrica va tras un `?`, no permanente. El que
   ya sabe leerla no la vuelve a leer nunca.
4. **Una sola acción primaria por bloque.** Las demás, secundarias o dentro del detalle.

Y una que no es de composición sino de honestidad: **si una cifra sale de datos incompletos, dilo o
no la muestres**. Cuando los indicadores vienen agregados del servidor, la pantalla lo dice y oculta
el recaudo en vez de enseñar uno corto.

### Divulgación progresiva

La tarjeta de pedido pintaba **24 campos con el mismo peso** para alguien que recorre 108
pedidos. Ahora:

- **Visible:** guía, estado, tienda · cliente, dirección, quién lo lleva, valor
- **Plegado tras "Ver detalle":** Ref, creado, método, punto de recogida, producto, SKU, ventana

El criterio: *¿esto sirve para **decidir** sobre el pedido, o solo cuando ya lo elegiste?*

---

## 6. Reglas de UX comprobadas

1. **Cero duplicación.** Se encontraron: la misma cifra en la tarjeta héroe y en el StatTile de
   debajo; el balance dos veces en Wallet; dos estados vacíos para lo mismo; el número de pedido
   en el título y en la línea secundaria. Antes de añadir un dato, busca si ya está en pantalla.
2. **Objetivo táctil de 44px mínimo**, aplicado vía `button.focus-ring` en `globals.css`. Eran
   125 de 129 botones por debajo.
3. **Esqueleto en la primera carga.** `hydrated` existía pero solo se usaba en el autoguardado:
   la app pintaba el panel vacío y se llenaba de golpe, lo que se leía como "no hay pedidos".
4. **Escape cierra los modales.** No había ni un manejador de teclado en toda la app.
5. **Los iconos solos necesitan `aria-label`.** Había 30 `title=` y un solo `aria-label`.
6. **`html, body { overflow-x: hidden }`.** Sin esa guarda, una tabla ancha arrastraba el ancho
   del documento y la cabecera fija dejaba de cubrir la pantalla: se veía contenido asomando por
   encima y el encabezado sin llegar al borde derecho.
7. **Teléfonos como enlaces `tel:`.** Antes había que copiarlos a mano estando en la calle.
8. **Cuidado con las rejillas estrechas.** A 390px, tres columnas dejan ~114px por tarjeta y una
   cifra en pesos ocupa ~144px. Reparto correcto: conteos pueden ir a un tercio, **el dinero
   necesita media pantalla**. El contenedor interno necesita `min-w-0 flex-1` o el texto empuja
   la tarjeta hacia fuera en lugar de ajustarse.

---

## 7. Cómo migrar una vista nueva

1. **Redefine tokens antes de reemplazar clases.** De 1.285 usos de color, ~800 migraron solo
   cambiando el *valor* de `field`, `ink-60`, `rust`, `mint`. Solo hay que reemplazar las clases
   con **doble significado**:

   | Clase | Por qué | Reemplazo |
   |---|---|---|
   | `bg-white` | era tarjeta clara | `bg-panel` |
   | `text-ink` | era texto oscuro | `text-fg` |
   | `border-black/10` | en oscuro el filete es luz | `border-white/10` |
   | `bg-ink text-white` | botón oscuro sobre fondo oscuro = invisible | `bg-acid text-deep` |

2. **Cuidado con los regex sobre clases.** `\btext-ink\b` también captura `text-ink-60`, porque
   el guion es frontera de palabra. Usa lookahead: `text-ink(?![-\w/])`. Un regex mal acotado
   produjo `border-white/20/15`, una clase que Tailwind ignora — y las tarjetas se quedaron sin
   borde con `rounded-sm`.

3. **Busca colores literales.** `bg-[#f7f8f4]/95` sobrevivió a toda la migración de tokens y
   dejó una barra blanca en medio de la app.

4. **Verifica que cada reemplazo se aplicó.** Dos bugs llegaron a producción por reemplazos
   condicionales que no coincidieron y fallaron en silencio. Cuenta las ocurrencias después de
   cada cambio; que falle ruidosamente.

---

## 8. Checklist antes de dar por hecha una pantalla

- [ ] Ningún dato aparece dos veces
- [ ] Toda lista larga pagina
- [ ] Ninguna tabla en móvil: tarjetas por fila
- [ ] Metadatos secundarios plegados
- [ ] Controles a 44px (56px si es de calle)
- [ ] Texto sobre ácido en `text-deep`
- [ ] `rounded-full` solo en contenido de una línea
- [ ] Una sola cifra en ácido por pantalla
- [ ] Sin desbordamiento horizontal a 390px
- [ ] `min-w-0` en contenedores flex con texto variable
- [ ] Iconos solos con `aria-label`
- [ ] Ningún `useMemo`/`useState`/`useEffect` después de un `return` anticipado (`npm run lint`)
- [ ] Los `useMemo` dependen de las **porciones** del estado que usan, no de `state` entero
- [ ] Ninguna tabla pinta más de ~25 filas sin paginar
- [ ] Ninguna tabla pasa de ~8 columnas: lo diagnóstico va al detalle desplegable, no a una columna
- [ ] Ningún dato aparece a la vez en la tabla y en su propio detalle
- [ ] `tsc --noEmit` limpio, tests en verde, build correcto, `npm run lint` sin errores
- [ ] Ninguna función ni callable perdido respecto al estado anterior
