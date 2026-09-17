import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Una sola familia para toda la app. Se autoaloja desde next/font: sin peticion a
// fonts.googleapis.com en el arranque y sin salto de texto al cargar.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Kentro",
  description: "Centro operativo para ultima milla, Shopify, transportistas y wallets"
};

/**
 * Capturador de errores de arranque.
 *
 * Va INLINE y en ES5 a proposito: si el bundle no se puede parsear o falla al arrancar, cualquier
 * cosa que dependa de el es inutil justo cuando mas falta hace. Sin esto, un fallo de arranque deja
 * una pantalla muerta sin una sola pista, y diagnosticarlo desde un telefono ajeno es imposible.
 *
 * Pinta una barra inferior descartable con el error real y un enlace a /diag.html. Nunca tapa la
 * app: si no hay error, no existe.
 */
const BOOT_ERROR_REPORTER = `(function(){
  var shown=false;
  function show(msg){
    if(shown||!msg)return; shown=true;
    try{
      var b=document.createElement("div");
      b.setAttribute("style","position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#2a0f0f;color:#ffd7d7;font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;padding:12px 14px;border-top:2px solid #ff6b6b;max-height:45%;overflow:auto");
      var t=document.createElement("div");
      t.setAttribute("style","font-weight:700;color:#ff6b6b;margin-bottom:4px");
      t.appendChild(document.createTextNode("Kentro no pudo arrancar"));
      var m=document.createElement("div");
      m.setAttribute("style","word-break:break-word;white-space:pre-wrap");
      m.appendChild(document.createTextNode(String(msg).slice(0,600)));
      var a=document.createElement("a");
      a.href="/diag.html"; a.setAttribute("style","display:inline-block;margin-top:8px;color:#c6f24e;font-weight:700");
      a.appendChild(document.createTextNode("Abrir diagnostico"));
      var x=document.createElement("button");
      x.setAttribute("style","position:absolute;top:8px;right:10px;background:none;border:0;color:#ffd7d7;font-size:20px");
      x.appendChild(document.createTextNode("\u00d7"));
      x.onclick=function(){ b.parentNode && b.parentNode.removeChild(b); };
      b.appendChild(t); b.appendChild(m); b.appendChild(a); b.appendChild(x);
      (document.body||document.documentElement).appendChild(b);
    }catch(e){}
  }
  window.addEventListener("error",function(e){
    show(e && e.message ? e.message + (e.filename ? " @ " + e.filename : "") : "Error al cargar un recurso");
  },true);
  window.addEventListener("unhandledrejection",function(e){
    var r=e && e.reason; show(r && r.message ? r.message : String(r));
  });
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={jakarta.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_ERROR_REPORTER }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
