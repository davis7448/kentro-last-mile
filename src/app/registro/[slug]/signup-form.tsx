"use client";

import { useEffect, useState } from "react";
import { brandFor } from "@/lib/community-view";
import { fetchCommunityBySlug, registerSellerBySlug } from "@/lib/firebase/auth";

type Brand = { name: string; logoPath: string | null } | null;
type Status = "loading" | "invalid" | "ready" | "submitting" | "done";

/**
 * Los CUATRO estados de una pantalla asincrona, sin atajos: cargando, enlace invalido (el
 * "vacio" de esta pantalla), listo y enviado. Un enlace muerto no puede quedarse en blanco:
 * quien lo abre no tiene forma de saber que le pasa si no se lo decimos.
 */
export default function SignupForm({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [brand, setBrand] = useState<Brand>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", password: "", responsibleName: "", phone: "", storeName: "" });
  /**
   * RF_43 pide CINCO datos y ni uno mas, asi que aqui no hay "confirmar contrasena": seria el
   * sexto, y la spec lo prohibe con su motivo escrito — cada campo extra en un formulario abierto
   * en un movil es una tienda que no se registra. El ojo resuelve el mismo problema, escribirla mal
   * sin darse cuenta, sin anadir nada que rellenar.
   */
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCommunityBySlug(slug)
      .then((data) => {
        if (cancelled) return;
        if (!data.acceptsSignups) {
          setStatus("invalid");
          return;
        }
        setBrand({ name: data.name ?? "", logoPath: data.logoPath ?? null });
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (status === "loading") {
    return <p className="text-center text-sm text-ink-60">Comprobando el enlace...</p>;
  }

  if (status === "invalid") {
    return (
      <div className="rounded-3xl border border-white/[0.06] bg-panel p-6 text-center">
        <h1 className="text-lg font-semibold">Este enlace ya no admite registros</h1>
        <p className="mt-2 text-sm text-ink-60">
          Pide un enlace vigente a quien te invito. Si ya tienes cuenta, inicia sesion.
        </p>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="rounded-3xl border border-white/[0.06] bg-panel p-6 text-center">
        <h1 className="text-lg font-semibold">Tu tienda quedo creada</h1>
        <p className="mt-2 text-sm text-ink-60">
          Ya puedes entrar. Antes de crear tu primer pedido tendras que completar ciudad, punto de
          recogida y cuenta bancaria.
        </p>
        <a href="/" className="mt-4 inline-block rounded-full bg-acid px-5 py-2 text-sm font-semibold text-black">
          Entrar
        </a>
      </div>
    );
  }

  const marca = brandFor(brand ?? undefined);
  const disabled = status === "submitting";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setStatus("submitting");
    try {
      await registerSellerBySlug({ slug, ...form });
      setStatus("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar el registro.");
      setStatus("ready");
    }
  };

  return (
    <div className="rounded-3xl border border-white/[0.06] bg-panel p-6">
      <header className="mb-5 text-center">
        {marca.kind === "community" ? (
          // <img> y no next/image a proposito: la URL la aporta el lider y no esta en el
          // dominio permitido de next/image, que la rechazaria en produccion.
          <img src={marca.logoPath} alt={marca.name} className="mx-auto mb-3 h-14 w-auto object-contain" />
        ) : (
          <p className="mb-3 text-2xl font-bold tracking-tight text-acid">Kentro</p>
        )}
        <h1 className="text-lg font-semibold">Registra tu tienda</h1>
        {marca.kind === "community" && <p className="mt-1 text-sm text-ink-60">Te invita {marca.name}</p>}
      </header>

      <form onSubmit={submit} className="space-y-3">
        <Field label="Nombre de la tienda" value={form.storeName} onChange={(v) => setForm({ ...form, storeName: v })} disabled={disabled} />
        <Field label="Tu nombre" value={form.responsibleName} onChange={(v) => setForm({ ...form, responsibleName: v })} disabled={disabled} />
        <Field label="Telefono" type="tel" inputMode="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} disabled={disabled} />
        <Field label="Correo" type="email" inputMode="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} disabled={disabled} />
        <Field
          label="Contrasena"
          type={showPassword ? "text" : "password"}
          value={form.password}
          onChange={(v) => setForm({ ...form, password: v })}
          disabled={disabled}
          hint="Minimo 6 caracteres."
          action={{ label: showPassword ? "Ocultar" : "Ver", onClick: () => setShowPassword((current) => !current) }}
        />

        {error && <p className="rounded-2xl bg-field p-3 text-sm text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-full bg-acid px-5 py-3 text-sm font-semibold text-black disabled:opacity-60"
        >
          {disabled ? "Creando tu tienda..." : "Crear mi tienda"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  disabled,
  hint,
  action
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "tel" | "email";
  disabled?: boolean;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <label className="block text-xs text-ink-60">
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {action && (
          <button type="button" onClick={action.onClick} className="focus-ring rounded-full px-2 py-1 text-xs font-semibold text-acid">
            {action.label}
          </button>
        )}
      </span>
      <input
        aria-label={label}
        type={type}
        inputMode={inputMode}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        required
        className="mt-1 w-full rounded-xl bg-field px-3 py-3 text-base text-fg outline-none focus:ring-2 focus:ring-acid/40"
      />
      {hint ? <span className="mt-1 block px-1 text-xs text-ink-60">{hint}</span> : null}
    </label>
  );
}
