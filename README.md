# Kentro

MVP funcional para una plataforma de ultima milla con administradores, vendedores, transportistas, inventario, wallets y liquidaciones.

## Incluye

- Next.js + Firebase Hosting/Functions/Firestore/Storage.
- Roles reales por Firebase Auth custom claims: admin, vendedor y transportista.
- Dashboards separados por rol.
- Pedido manual con guia legible `KNT-000000`.
- Flujo operativo: direccion en riesgo, asignacion, llamada, reprogramacion, recogida, ruta, entregado, fallido y reintento.
- Evidencia real en Firebase Storage para entregas y fallidos.
- Wallet de vendedor, transportista y margen de plataforma.
- Liquidaciones persistentes por vendedor y transportista.
- Inventario por SKU con reserva automatica y recalculo de reservas.
- Zonas/tarifas configurables para operacion inicial en Cali.
- Auditoria de acciones criticas.

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
- Firestore: activo con reglas por rol.
- Storage: activo con reglas para evidencias.
- Functions: activas en `us-central1`.
- Plan: Blaze.

## QA

La matriz de pruebas esta en [`docs/qa-matrix.md`](docs/qa-matrix.md).

Antes de avanzar a integraciones externas, todos los casos `P0` y `P1` deben quedar en `OK`.

## Siguientes integraciones reales

- Completar OAuth Shopify y verificacion HMAC de webhooks.
- Agregar Mapbox Permanent Geocoding y fallback Google Address Validation.
- Agregar notificaciones operativas.
- Crear reportes gerenciales.
- Crear jobs de conciliacion, bloqueo por deuda y alerta semanal de fallidos.
- Actualizar runtime/dependencias de Functions antes de la decommission de Node.js 20.
