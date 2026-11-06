"use client";

import { useState } from "react";
import {
  acceptsAllProducts,
  describeFilter,
  effectiveFilter,
  recentFilterDiscards,
  resolveFilterOnSave,
  syncInstruction,
  type FilterMode
} from "../../functions/src/store-webhook-filter";
import type { StoreWebhookConfig } from "@/lib/types";

/**
 * Spec 037 (HU_01, HU_02): bloque de la tienda que dice, en una frase, que pedidos entran por su
 * webhook y cuales se descartan, y deja cambiar el filtro a proposito. La frase sale del mismo
 * modulo que aplica el servidor: no puede mostrar un filtro distinto del que se usa.
 * Pantallas: specs/design/037_el_webhook_de_tienda_acepta_todo_por_defecto/HU_01.*, HU_02.*
 */
export interface StoreWebhookFilterCardProps {
  config: StoreWebhookConfig;
  webhookUrl: string;
  busy: boolean;
  onRegenerate: () => void;
  onSaveFilter: (filter: { filterMode: FilterMode; skuContains?: string }) => Promise<void>;
}

export function StoreWebhookFilterCard({ config, webhookUrl, busy, onRegenerate, onSaveFilter }: StoreWebhookFilterCardProps) {
  const current = effectiveFilter(config);
  const acceptsAll = acceptsAllProducts(current);
  const discarded = recentFilterDiscards(config.filterDiscards, new Date());
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<FilterMode>(acceptsAll ? "all" : "sku");
  const [skuText, setSkuText] = useState(acceptsAll ? "" : current.skuContains);
  const [saveError, setSaveError] = useState("");

  // La vista previa usa la misma regla que guardara el servidor (RF_05, RF_09: vacio = todos).
  const draft = resolveFilterOnSave({ existing: null, input: mode === "all" ? { filterMode: "all" } : { filterMode: "sku", skuContains: skuText } });
  const preview = describeFilter(effectiveFilter(draft), config.cityAllowlist);

  function startEditing() {
    setMode(acceptsAll ? "all" : "sku");
    setSkuText(acceptsAll ? "" : current.skuContains);
    setSaveError("");
    setEditing(true);
  }

  async function save() {
    setSaveError("");
    try {
      await onSaveFilter(mode === "all" ? { filterMode: "all" } : { filterMode: "sku", skuContains: skuText });
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "No se pudo guardar el filtro.");
    }
  }

  if (editing) {
    return (
      <div className="grid gap-3">
        <div role="radiogroup" aria-label="Filtro de productos" className="grid gap-2">
          <p className="text-xs font-semibold text-ink-60">Filtro de productos</p>
          {([["all", "Todos mis productos"], ["sku", "Solo productos cuyo SKU contenga..."]] as const).map(([value, label]) => (
            <label key={value} className={`focus-ring flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-sm ${mode === value ? "border-acid/40 bg-acid/10" : "border-white/10 bg-panel"}`}>
              <input type="radio" name={`filter-mode-${config.sellerId}`} value={value} checked={mode === value} onChange={() => setMode(value)} className="accent-[rgb(var(--c-acid))]" />
              {label}
            </label>
          ))}
        </div>
        {mode === "sku" && (
          <label className="grid gap-1 text-xs text-ink-60">
            SKU contiene
            <input
              className="rounded-2xl border border-white/10 bg-panel px-3 py-2 text-sm uppercase text-fg"
              value={skuText}
              onChange={(event) => setSkuText(event.target.value.toUpperCase())}
              autoComplete="off"
            />
            <span>Tambien entran pedidos con esa etiqueta.</span>
          </label>
        )}
        <div className="grid gap-1 rounded-2xl border border-white/10 bg-panel px-3 py-2">
          <p className="text-xs font-semibold text-ink-60">Asi quedara</p>
          <p role="status" aria-live="polite" className="text-sm text-fg">{preview}</p>
        </div>
        {saveError && <p role="alert" className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{saveError}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="focus-ring min-h-11 rounded-full bg-acid px-4 py-2 text-xs font-semibold text-deep disabled:cursor-not-allowed disabled:bg-field disabled:text-ink-60" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Guardando..." : "Guardar filtro"}
          </button>
          <button className="focus-ring min-h-11 rounded-full border border-white/10 bg-panel px-4 py-2 text-xs font-semibold" type="button" disabled={busy} onClick={() => setEditing(false)}>
            Cancelar
          </button>
        </div>
        <p className="text-xs text-ink-60">La URL del webhook no cambia al guardar.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <p role="status" className={`rounded-2xl border px-3 py-2 text-sm text-fg ${acceptsAll ? "border-acid/40 bg-acid/10" : "border-info/40 bg-info/10"}`}>
        {describeFilter(current, config.cityAllowlist)}
      </p>
      {discarded > 0 && (
        <p role="status" className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">
          {discarded} {discarded === 1 ? "pedido descartado" : "pedidos descartados"} por el filtro esta semana
        </p>
      )}
      {acceptsAll && (
        <p className="rounded-2xl bg-panel px-3 py-2 text-xs text-ink-60">Si editas en Shopify un pedido viejo de esta ciudad, entra a Kentro como pedido nuevo sin confirmar. Puedes borrarlo sin costo.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="focus-ring min-h-11 rounded-full border border-white/10 bg-panel px-4 py-2 text-xs font-semibold" type="button" onClick={startEditing}>
          Cambiar filtro
        </button>
      </div>
      <input aria-label="URL del webhook" className="rounded-2xl border border-white/10 bg-panel px-3 py-2 text-xs text-fg" readOnly value={webhookUrl} />
      <div className="flex flex-wrap gap-2">
        <button className="focus-ring min-h-11 rounded-full bg-acid px-4 py-2 text-xs font-semibold text-deep" type="button" onClick={() => void navigator.clipboard?.writeText(webhookUrl)}>
          Copiar URL
        </button>
        <button className="focus-ring min-h-11 rounded-full border border-white/10 bg-panel px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:text-ink-60" type="button" disabled={busy} onClick={onRegenerate}>
          {busy ? "Actualizando..." : "Actualizar webhook"}
        </button>
      </div>
      <div className="rounded-2xl bg-panel px-3 py-2 text-xs text-ink-60">
        <h4 className="font-semibold text-fg">Instrucciones Shopify</h4>
        <p>1. Crear webhook Order creation con esta URL.</p>
        <p>2. Crear webhook Order update con esta misma URL.</p>
        <p>3. {syncInstruction(current)}</p>
      </div>
    </div>
  );
}
