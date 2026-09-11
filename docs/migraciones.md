# Migraciones de datos

Guiones de un solo uso que cambian datos ya escritos. **No se despliegan**: se corren a mano, en
seco primero, y se anotan aqui con su resultado.

---

## `leaderUid` en las comunidades (spec 003, 11-09-2026)

**Guion:** `scripts/backfill-leader-uid.js`

### Que hace y por que

La spec 003 hace que una comunidad **sin lider** cobre tarifa base y no cause cashback (RF_20). El
servidor lo decide mirando `leaderUid` en el documento de la comunidad.

Ese campo **no existia**. Hasta la spec 003, el vinculo comunidad↔lider vivia **solo en los reclamos
de la cuenta**: `createCommunityLeader` escribia nueve campos en el documento y ninguno era el lider.

### El riesgo, dicho claro

**Si la regla de precio llega a produccion antes que esta migracion, todas las comunidades vivas
pasan a ser comunidades sin lider.** Tarifa base y cashback cero en cada pedido nuevo, **sin error y
sin aviso**: los pedidos se crean, la operacion sigue, y simplemente deja de pagarse un cashback que
si se habia causado. Es la regla de oro #5 del `CLAUDE.md` — no falla, no avisa, solo muestra menos
dinero del que se debe.

**Orden obligatorio: migracion → functions.** No al reves.

### Como se corre

```bash
node scripts/backfill-leader-uid.js            # en seco: dice que haria
node scripts/backfill-leader-uid.js --apply    # escribe
```

Es idempotente: una comunidad que ya tiene `leaderUid` no se toca. Se para sin escribir si encuentra
**comunidades ambiguas** —dos cuentas que dicen liderar la misma—, porque eso lo resuelve una
persona, no un guion.

Las cuentas con `communityStanding: "creditor"` **no cuentan como lideres**: conservan el vinculo
para poder cobrar lo que se les debe, pero ya no gobiernan. Anotarlas deshariaa el efecto de
haberlas retirado.

### Resultado de la pasada en seco — 11-09-2026

```
comunidades: 0
  ya tenian leaderUid : 0
  se escribirian      : 0
  sin lider           : 0
  ambiguas            : 0
```

**Produccion no tiene ninguna comunidad todavia**, asi que hoy la migracion es un no-op. El guion
queda escrito igualmente: la primera comunidad que se cree por la pantalla nueva ya nacera con su
`leaderUid`, y este guion es la red para cualquier comunidad que se hubiera creado antes de que ese
campo existiera.

**Volver a correrlo en seco antes de desplegar la regla de precio**, por si entre medias se creo
alguna.
