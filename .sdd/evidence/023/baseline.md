# Spec 023 — línea base de lecturas (2026-11-10)

Fuente: Cloud Monitoring, `firestore.googleapis.com/document/read_count`, proyecto `kentro-last-mile`,
suma por hora (`ALIGN_SUM`, 3600 s). Datos crudos en `baseline-hourly-raw.json`, por hora en
`baseline-hourly.csv` (hora de Colombia, UTC-5).

## Lecturas por día (hora de Colombia)

| Día | Lecturas | Nota |
|---|---:|---|
| 2026-10-27 | 3.243.547 | |
| 2026-10-28 | 2.604.414 | |
| 2026-10-29 | 2.419.311 | |
| 2026-10-30 | 2.162.373 | |
| 2026-10-31 | 2.017.618 | sábado |
| 2026-11-01 | 1.682.128 | domingo |
| 2026-11-02 | 1.870.133 | festivo |
| 2026-11-03 | 2.567.776 | |
| 2026-11-04 | 2.800.700 | |
| 2026-11-05 | 2.477.408 | |
| 2026-11-06 | 2.744.626 | |
| 2026-11-07 | 2.190.406 | |
| 2026-11-08 | 997.353 | facturación caída hasta las ~16 h |
| 2026-11-09 | 2.881.617 | |

**Línea base para RNF_01: mediana de días hábiles completos 27-oct a 9-nov ≈ 2,5 M/día.**

## El suelo ya no es de 13.000/h: es de ~72.000–78.000/h

Mediana por hora del día (14 días): de 0 a 6 h, **~72.000 lecturas/h constantes**. En septiembre eran
~13.000. Ese suelo, sostenido 24 h, son ~1,75 M/día: **la mayor parte del total**, y no sigue el uso de
la app.

## Quién lo produce: `GET /orders` de la API de tiendas

Por tipo, el 99,5 % de las lecturas son `QUERY`. Correlando por hora con las peticiones a Cloud Run
(noche del 9-nov): las únicas peticiones constantes de madrugada son `storeapi`, ~8/h. La noche del
10-nov, cuando `storeapi` recibió 1 petición, las lecturas cayeron a ~0.

`functions/src/store-api.ts`, ruta `GET /orders?from=&to=`, en **cada** llamada lee, aunque pida un
solo día:

1. **todos** los pedidos de la tienda (`orders where sellerId ==`), y filtra el rango en memoria;
2. **todos** los asientos de wallet de la tienda;
3. **todos** los cortes de la plataforma.

Documentos leídos por llamada, contados el 2026-11-10:

| Tienda | Pedidos | Asientos | Cortes | **Lecturas por llamada** |
|---|---:|---:|---:|---:|
| DANDA (`seller-1779315416119`) | 7.083 | 11.955 | 110 | **19.148** |
| Kovia (`seller-1778271867877`) | 182 | 284 | 110 | 576 |
| Infinito (`seller-1791232545779`) | 3 | 4 | 110 | 117 |

Los llamantes son integraciones `Python-urllib/3.12` desde dos VPS de Hostinger que NO son este
(`2a02:4780:2d:25::1`, `2a02:4780:2d:b2f9::1`). Cada hora, a en punto, piden el día de hoy más
uno a tres días sueltos anteriores. En 8 días de logs (`storeapi-get-8d.csv`): 651 llamadas de lista de
DANDA, 389 de Kovia, 222 de Infinito.

Lecturas estimadas de `storeApi` por día (llamadas × lecturas por llamada) frente al total:

| Día (UTC) | storeApi estimado | Total del día | Parte |
|---|---:|---:|---:|
| 2026-11-03 | 2.045.262 | 2.567.776 | 80 % |
| 2026-11-04 | 2.008.811 | 2.800.700 | 72 % |
| 2026-11-05 | 1.775.462 | 2.477.408 | 72 % |
| 2026-11-06 | 2.159.115 | 2.744.626 | 79 % |
| 2026-11-09 | 1.896.155 | 2.881.617 | 66 % |

**La API de tiendas pesa entre el 66 % y el 80 % de todas las lecturas.** Lo que la spec atribuía a
abrir la app (admin descargando `walletEntries`, hoy 19.421 asientos) es el resto: ~0,6–0,9 M/día.

## Equivalencia del filtro de fecha

`inRange` compara `String(createdAt || updatedAt).slice(0, 10)`. Los 8.308 pedidos tienen `createdAt`
como texto ISO (8.149 con offset `-05:00`, 159 con `Z`); ninguno falta. Para textos que empiezan por
`YYYY-MM-DD`, `createdAt >= from && createdAt < día_siguiente(to)` en Firestore selecciona exactamente
los mismos pedidos que `inRange`. El índice `sellerId ASC + createdAt ASC` ya existe.

## Fase A: medida antes/después contra producción (2026-11-10, solo lectura)

`node scripts/verify-023.js compare` (salida en `phase-a-compare.txt`): mismo handler compilado,
con los cargadores de antes y con los dirigidos, contra Firestore de producción.

| Caso | Lecturas antes | Lecturas después | Tiempo antes → después | Respuesta |
|---|---:|---:|---|---|
| DANDA, `/orders` de hoy (2 pedidos) | 19.151 | 113 | 4,4 s → 0,6 s | idéntica |
| DANDA, `/orders` de un día pasado (26 pedidos) | 19.151 | 204 | 4,0 s → 0,7 s | idéntica |
| DANDA, `/orders` de una semana (549 pedidos) | 19.151 | 1.215 | 4,1 s → 0,9 s | idéntica |
| DANDA, `/kpis` del mes | 7.083 | 676 | 2,3 s → 0,4 s | idéntica |
| Kovia, `/orders` de hoy | 576 | 111 | | idéntica |
| Kovia, `/orders` de 45 días | 576 | 291 | | idéntica |
| Kovia, `/orders` sin rango | 576 | 576 | | idéntica (sin rango no cambia) |
| Infinito, `/orders` de 4 días | 117 | 112 | | idéntica |

De las ~110 lecturas que quedan en una llamada pequeña, 110 son la colección `settlements` entera, que
`buildCodReceivedSet` necesita y crece despacio.

### Proyección (a confirmar con 3 días reales tras desplegar, DoD 4)

Con el reparto de llamadas de la semana del 3 al 9 de noviembre (~100/día de DANDA, ~55 de Kovia, ~27
de Infinito, casi todas de un día):

| | Antes | Después (estimado) |
|---|---:|---:|
| `storeApi` por día | ~2,0 M | ~30.000 |
| Total del proyecto por día hábil | ~2,5 M | **~0,55 M (−78 %)** |
| Suelo nocturno por hora | ~72.000–78.000 | ~1.500 + lo que deje la app abierta |

`/resumen` (25 llamadas/semana de DANDA, 19.148 lecturas cada una, ~70.000/día) no cambia en la fase A:
el saldo necesita el histórico (spec 018).
