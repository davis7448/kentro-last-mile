import type { AppState } from "./types";

const now = new Date().toISOString();

export function emptyState(): AppState {
  return {
    activeRole: "seller",
    cities: [{ id: "city-cali", name: "Cali", active: true }],
    zones: [],
    sellers: [],
    shopifyStores: [],
    storeWebhookConfigs: [],
    shopifyInstallRequests: [],
    shopifySyncIssues: [],
    drivers: [],
    messengers: [],
    pickupBatches: [],
    inventory: [],
    orders: [],
    wallet: [],
    settlements: [],
    payouts: [],
    audit: [],
    settings: {
      activeCityId: "city-cali",
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 12000,
      fulfillmentFeeCop: 2000,
      driverDeliveredPayCop: 9000,
      driverFailedPayCop: 9000,
      pendingReserveCop: 9000,
      debtBlockDays: 7,
      failedRateAlertPercent: 80,
      payoutDays: ["Martes", "Viernes"]
    }
  };
}

export function seedState(): AppState {
  return {
    activeRole: "admin",
    cities: [
      { id: "city-cali", name: "Cali", active: true },
      { id: "city-med", name: "Medellin", active: false }
    ],
    zones: [
      { id: "zone-north", cityId: "city-cali", name: "Norte Cali", polygonLabel: "Sameco, La Flora, Chipichape", active: true, sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 9000, driverFailedPayCop: 9000 },
      { id: "zone-center", cityId: "city-cali", name: "Centro Cali", polygonLabel: "Centro, San Nicolas, Alameda", active: true, sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 9000, driverFailedPayCop: 9000 },
      { id: "zone-south", cityId: "city-cali", name: "Sur Cali", polygonLabel: "Ciudad Jardin, Valle del Lili, Caney", active: true, sellerDeliveredFeeCop: 13000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 9000, driverFailedPayCop: 9000 }
    ],
    sellers: [
      {
        id: "seller-1",
        name: "Tienda Aurora",
        shopDomain: "aurora-demo.myshopify.com",
        cityId: "city-cali",
        bankAccount: "Bancolombia *** 4401",
        pickupPointName: "Tienda Aurora",
        pickupAddress: "Cali",
        pickupContactName: "Operaciones Aurora",
        pickupContactPhone: ""
      },
      {
        id: "seller-2",
        name: "Casa Verde",
        shopDomain: "casa-verde-demo.myshopify.com",
        cityId: "city-cali",
        bankAccount: "Davivienda *** 8102",
        pickupPointName: "Casa Verde",
        pickupAddress: "Cali",
        pickupContactName: "Operaciones Casa Verde",
        pickupContactPhone: "",
        debtBlockedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      }
    ],
    shopifyStores: [],
    storeWebhookConfigs: [],
    shopifyInstallRequests: [],
    shopifySyncIssues: [],
    drivers: [
      { id: "driver-1", name: "Luis Rojas", phone: "+57 300 111 2233", active: true },
      { id: "driver-2", name: "Diana Perez", phone: "+57 301 555 7788", active: true },
      { id: "driver-3", name: "Mario Silva", phone: "+57 310 909 1122", active: true }
    ],
    messengers: [],
    pickupBatches: [],
    inventory: [
      { id: "inv-1", sellerId: "seller-1", sku: "AUR-CAFE-250", name: "Cafe premium 250g", available: 42, reserved: 3 },
      { id: "inv-2", sellerId: "seller-1", sku: "AUR-TERMO", name: "Termo acero", available: 18, reserved: 1 },
      { id: "inv-3", sellerId: "seller-2", sku: "CV-MACETA-M", name: "Maceta mediana", available: 27, reserved: 2 }
    ],
    orders: [
      {
        id: "ord-1",
        shopifyOrderId: "#1098",
        sellerId: "seller-1",
        cityId: "city-cali",
        zoneId: "zone-north",
        customerName: "Paula Gomez",
        customerPhone: "+57 300 123 4488",
        addressRaw: "Av 6N # 24N-10 apto 402, Cali",
        normalizedAddress: "Avenida 6N #24N-10 Apto 402, Cali, Colombia",
        geoProvider: "mapbox",
        lat: 4.6921,
        lng: -74.0432,
        addressRisk: "accepted",
        status: "ready_to_assign",
        paymentMethod: "cod",
        fulfillmentMode: "warehouse",
        totalCop: 118000,
        sku: "AUR-CAFE-250",
        evidence: [],
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ord-2",
        shopifyOrderId: "#1099",
        sellerId: "seller-1",
        cityId: "city-cali",
        zoneId: "zone-center",
        driverId: "driver-1",
        customerName: "Andres Diaz",
        customerPhone: "+57 311 222 0099",
        addressRaw: "calle 63 con 7, confirmar edificio",
        normalizedAddress: "Calle 5 #38, San Fernando, Cali, Colombia",
        geoProvider: "google_address_validation",
        addressRisk: "review",
        status: "address_risk",
        paymentMethod: "prepaid",
        fulfillmentMode: "seller_pickup",
        totalCop: 94000,
        scheduledWindow: "Hoy 2:00 PM - 5:00 PM",
        evidence: [],
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ord-3",
        shopifyOrderId: "#2101",
        sellerId: "seller-2",
        cityId: "city-cali",
        zoneId: "zone-south",
        driverId: "driver-2",
        customerName: "Martha Leon",
        customerPhone: "+57 320 889 2211",
        addressRaw: "Av Boyaca # 42 sur - 30",
        normalizedAddress: "Carrera 100 #16, Ciudad Jardin, Cali, Colombia",
        geoProvider: "mapbox",
        addressRisk: "accepted",
        status: "scheduled",
        paymentMethod: "cod",
        fulfillmentMode: "seller_pickup",
        totalCop: 156000,
        scheduledWindow: "Manana 8:00 AM - 11:00 AM",
        evidence: [],
        createdAt: now,
        updatedAt: now
      },
      {
        id: "ord-4",
        shopifyOrderId: "#2102",
        sellerId: "seller-2",
        cityId: "city-cali",
        zoneId: "zone-south",
        driverId: "driver-2",
        customerName: "Jorge Ruiz",
        customerPhone: "+57 315 700 8855",
        addressRaw: "Bosa centro diagonal a la iglesia",
        normalizedAddress: "Valle del Lili, Cali, Colombia",
        geoProvider: "mapbox",
        addressRisk: "review",
        status: "failed",
        paymentMethod: "cod",
        fulfillmentMode: "warehouse",
        totalCop: 83000,
        sku: "CV-MACETA-M",
        failedReason: "Cliente no sale",
        retryDecision: "pending",
        evidence: [
          {
            id: "ev-1",
            type: "failed",
            photoLabel: "fachada-bosa.jpg",
            note: "Se llamo tres veces y no respondio en porteria.",
            reason: "Cliente no sale",
            actorId: "driver-2",
            createdAt: now
          }
        ],
        createdAt: now,
        updatedAt: now
      }
    ],
    wallet: [
      {
        id: "we-open-1",
        ownerType: "seller",
        ownerId: "seller-1",
        type: "cod_revenue",
        amountCop: 100000,
        description: "Saldo libre anterior conciliado",
        createdAt: now
      },
      {
        id: "we-failed-ord-4",
        ownerType: "seller",
        ownerId: "seller-2",
        orderId: "ord-4",
        type: "failed_fee",
        amountCop: -9000,
        description: "Cobro fallido #2102",
        createdAt: now
      },
      {
        id: "we-driver-ord-4",
        ownerType: "driver",
        ownerId: "driver-2",
        orderId: "ord-4",
        type: "driver_earning",
        amountCop: 8000,
        description: "Pago fallido #2102",
        createdAt: now
      }
    ],
    settlements: [],
    payouts: [],
    audit: [
      {
        id: "audit-1",
        actorId: "system",
        actorRole: "admin",
        action: "seed",
        entity: "app",
        entityId: "demo",
        summary: "Datos demo inicializados",
        createdAt: now
      }
    ],
    settings: {
      activeCityId: "city-cali",
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 12000,
      fulfillmentFeeCop: 2000,
      driverDeliveredPayCop: 9000,
      driverFailedPayCop: 9000,
      pendingReserveCop: 9000,
      debtBlockDays: 7,
      failedRateAlertPercent: 80,
      payoutDays: ["Martes", "Viernes"]
    }
  };
}
