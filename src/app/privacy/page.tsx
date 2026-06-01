import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Politica de Privacidad | Kentro",
  description: "Politica de privacidad de Kentro para vendedores Shopify y operaciones de ultima milla."
};

const sections = [
  {
    title: "1. Informacion que recopilamos",
    body: [
      "Cuando un vendedor conecta su tienda Shopify con Kentro, podemos recopilar informacion de la tienda, pedidos, productos, SKU, valor del pedido, metodo de pago, estado financiero y fecha de creacion.",
      "Tambien procesamos informacion operativa del cliente final, como nombre, telefono, direccion de entrega y ciudad, junto con zona, transportista asignado, estado de entrega, fecha o franja programada y novedades.",
      "Kentro puede almacenar evidencias de entrega, imagenes, observaciones, motivos de fallido o reprogramacion, movimientos de wallet, tarifas, pagos a transportistas, liquidaciones y margen operativo.",
      "No recopilamos informacion de tarjetas de credito ni credenciales privadas de clientes finales."
    ]
  },
  {
    title: "2. Uso de la informacion",
    body: [
      "Usamos la informacion para importar pedidos desde Shopify, gestionar entregas, asignar transportistas, validar direcciones, controlar zonas operativas, registrar evidencias, calcular wallets, pagos, tarifas y liquidaciones.",
      "Tambien usamos los datos para prevenir duplicidad de pedidos, mantener trazabilidad operativa, generar reportes y auditar acciones dentro de la plataforma."
    ]
  },
  {
    title: "3. Conexion con Shopify",
    body: [
      "Kentro usa OAuth para conectar tiendas Shopify. El vendedor autoriza desde Shopify los permisos requeridos por la aplicacion.",
      "Los tokens de acceso se almacenan de forma restringida y no son visibles para usuarios finales desde la aplicacion.",
      "Kentro puede recibir webhooks de Shopify, como creacion de pedidos, para sincronizar informacion operativa con la plataforma."
    ]
  },
  {
    title: "4. Comparticion de informacion",
    body: [
      "Kentro no vende informacion personal.",
      "La informacion solo es visible para usuarios autorizados segun su rol: administradores, vendedores y transportistas.",
      "Podemos compartir informacion con proveedores tecnologicos necesarios para operar la plataforma, como Shopify, Firebase, Google Cloud y servicios de almacenamiento o procesamiento."
    ]
  },
  {
    title: "5. Almacenamiento y seguridad",
    body: [
      "La informacion se almacena en servicios cloud seguros, incluyendo Firebase, Firestore, Cloud Functions y Firebase Storage.",
      "Aplicamos autenticacion, controles por rol, reglas de acceso y separacion de datos sensibles. Las evidencias de entrega se almacenan en un bucket protegido y solo usuarios autenticados con acceso autorizado pueden consultarlas."
    ]
  },
  {
    title: "6. Retencion de datos",
    body: [
      "Conservamos la informacion mientras sea necesaria para operar la plataforma, cumplir obligaciones comerciales, resolver disputas, auditar entregas y mantener historial financiero.",
      "Un vendedor puede solicitar la eliminacion o desconexion de su tienda Shopify escribiendo al contacto de soporte de Kentro."
    ]
  },
  {
    title: "7. Derechos del usuario",
    body: [
      "Los usuarios pueden solicitar acceso, correccion, eliminacion cuando aplique, desconexion de una tienda Shopify o revocacion de acceso OAuth desde Shopify."
    ]
  },
  {
    title: "8. Eliminacion y desconexion de Shopify",
    body: [
      "El vendedor puede revocar el acceso de Kentro desde su panel de Shopify o solicitarnos la desconexion.",
      "Al desconectar una tienda, Kentro dejara de recibir nuevos pedidos desde Shopify. Algunos datos historicos pueden conservarse para fines operativos, contables, liquidaciones, auditoria y cumplimiento."
    ]
  },
  {
    title: "9. Cookies y tecnologias similares",
    body: [
      "Kentro puede usar almacenamiento local, sesiones de autenticacion y tecnologias similares para mantener la sesion del usuario y mejorar la experiencia de uso."
    ]
  },
  {
    title: "10. Cambios a esta politica",
    body: [
      "Podemos actualizar esta politica de privacidad. Cuando haya cambios relevantes, publicaremos la nueva version con fecha de actualizacion."
    ]
  },
  {
    title: "11. Contacto",
    body: [
      "Para solicitudes relacionadas con privacidad, soporte o eliminacion de datos, contacta a Kentro en el correo de soporte configurado por la operacion.",
      "Sitio web: https://kentro-last-mile.web.app"
    ]
  }
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-field px-4 py-8 text-ink">
      <article className="mx-auto max-w-3xl rounded-lg border border-black/10 bg-white p-6 shadow-panel">
        <p className="text-sm font-semibold uppercase tracking-normal text-black/50">Kentro</p>
        <h1 className="mt-2 text-3xl font-bold">Politica de Privacidad</h1>
        <p className="mt-2 text-sm text-black/60">Ultima actualizacion: 16 de mayo de 2026</p>
        <p className="mt-5 text-sm leading-6 text-black/70">
          Kentro es una plataforma de gestion operativa de ultima milla para vendedores que conectan sus tiendas Shopify con procesos de despacho, inventario, transportistas, evidencias de entrega, wallets y liquidaciones.
        </p>

        <div className="mt-6 grid gap-5">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-lg font-bold">{section.title}</h2>
              <div className="mt-2 grid gap-2">
                {section.body.map((paragraph) => (
                  <p key={paragraph} className="text-sm leading-6 text-black/70">{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}
