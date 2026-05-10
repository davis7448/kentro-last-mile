# Kentro

MVP funcional para una plataforma de ultima milla con vendedores Shopify, administradores y transportistas.

## Incluye

- Next.js + Firebase Hosting/Functions/Firestore/Storage.
- Roles simulados: admin, vendedor y transportista.
- Sincronizacion Shopify simulada desde la UI y contrato de webhook en `functions/src/index.ts`.
- Flujo operativo: direccion en riesgo, asignacion, pedidos libres, llamada, recogida, ruta, entregado, fallido y reintento.
- Evidencia demo para entregas/fallidos.
- Wallet de vendedor y transportista.
- Liquidacion con saldo disponible, reserva de 9.000 COP por pendiente y solicitud automatica.
- Inventario por SKU para bodega inicial.
- Auditoria visible de acciones.

## Comandos

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

## Firebase

- Project ID: `kentro-last-mile`
- Hosting: https://kentro-last-mile.web.app
- Firestore: creado en `nam5` con reglas desplegadas.
- Storage: pendiente de inicializar bucket desde Firebase Console.
- Functions: pendiente de activar Blaze porque requiere Cloud Build.

## Siguientes integraciones reales

- Reemplazar estado local por Firestore y reglas por rol con custom claims.
- Completar OAuth Shopify y verificacion HMAC de webhooks.
- Agregar Mapbox Permanent Geocoding y fallback Google Address Validation.
- Subir evidencias reales a Firebase Storage.
- Crear jobs de conciliacion, bloqueo por deuda y alerta semanal de fallidos.
