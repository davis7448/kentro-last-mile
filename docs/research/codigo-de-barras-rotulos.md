# Codigo de barras en los rotulos (Code128-B)

**Fecha:** 2026-09-01 · **Estado:** implementado

## Problema

El rotulo (100x150mm) llevaba solo un QR con la URL de deep-link `origin/?order=KNT-003259`. Sirve
para la camara del telefono (mensajeros), pero en **despacho se usa una pistola lectora laser/CCD**,
que es un lector 1D y no puede leer un QR. Hacia falta agregar una simbologia lineal sin perder el QR.

## Simbologia

**Code128 subset B.** Alternativas descartadas:

| Simbologia | Veredicto |
|---|---|
| **Code128-B** | **Elegida.** Cubre ASCII 32-126, o sea letras + digitos + el guion de `KNT-003259`. Densa y con checksum obligatorio. |
| Code39 | Descartada: ~40% mas ancha para el mismo dato y sin checksum por defecto. |
| Code128-C | Descartada: solo digitos; obligaria a codificar `003259` y re-prefijar `KNT-` al leer. |
| EAN/UPC | Descartada: largo fijo y numerico, no modela un codigo interno. |

Se codifica el **codigo KNT completo**, no la URL: una URL de ~40 caracteres daria barras finisimas en
100mm de ancho. Como `extractOrderCode` (`operations-app.tsx`) devuelve tal cual cualquier valor que no
sea una URL, y `findEligibleOrder` compara exacto contra `trackingCode`, la pistola entra por el mismo
camino que ya usa el QR: **cero cambios en backend, reglas o modelo de datos**.

## Libreria: ninguna, encoder propio en `src/lib/barcode.ts`

| Criterio | jsbarcode | bwip-js | Encoder propio |
|---|---|---|---|
| Salida como string HTML/SVG | Necesita un nodo del DOM o canvas al que pintar | Idem (canvas) o buffer PNG en Node | Devuelve el string directo |
| Peso | ~35 kB | ~200 kB+ | ~3 kB |
| Control del ancho de modulo en mm | Indirecto | Si | Si |
| Simbologias | Muchas (no hacen falta) | Muchisimas (no hacen falta) | Solo Code128-B |
| Dependencia nueva | Si | Si | No |

Decisivo: el rotulo se arma como **string de HTML** que se inyecta con `popup.document.write`, asi que
una libreria orientada al DOM obligaria a crear nodos sueltos y serializarlos. Code128-B son ~90 lineas
puras y encaja con la convencion del repo (`settlement-math.ts`, `date-ranges.ts`: logica pura + vitest).
No se evaluaron CVEs porque no se instalo nada.

## Dimensionado (por que estos numeros)

- `KNT-003259` = 10 caracteres -> `11 * (10 + 2) + 13` = **145 modulos**.
- Modulo (X-dimension) **0.5mm** -> 72.5mm + 5mm de zona muda a cada lado = **82.5mm**.
- Ancho util del rotulo ~87mm (100mm menos el margen `@page` de 4mm y el borde/padding de `.label`).
- 0.5mm son **4 puntos en una termica de 203dpi**: margen de sobra para una pistola de mano.
- Alto de barras 13mm.

Para hacerle sitio a la franja se quito la linea con la URL en letra de 7.5px (era ilegible y ahora es
redundante con el codigo legible bajo las barras) y el QR bajo de 27mm a 22mm. El QR sigue llevando la
URL completa, o sea el deep-link con la camara del telefono no se pierde.

## Verificacion hecha

- `src/lib/barcode.test.ts`: round-trip con decodificador independiente, checksum recalculado aparte,
  invariantes de la tabla (107 patrones unicos, 11 modulos, stop de 13), zonas mudas y errores.
- Render real del rotulo a PDF/PNG con chromium headless y **decodificacion desde los pixeles** con un
  lector escrito aparte: las 49 filas de barrido de cada rotulo devuelven el codigo correcto, incluso a
  1.89px por modulo (muy por debajo de lo que da una impresora termica).

## Riesgo conocido

Algunas pistolas mandan mal el guion segun la distribucion de teclado con la que esten configuradas.
Si al pistolear llega `KNT003259` o `KNT/003259`, hay que configurar la pistola en teclado US. El plan B
seria codificar solo los digitos, pero eso obliga a re-prefijar `KNT-` al leer.
