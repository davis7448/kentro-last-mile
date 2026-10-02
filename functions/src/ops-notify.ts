/**
 * Spec 026 · RF_05 (plan 2.5) — canal de aviso a operaciones por webhook.
 *
 * Es el unico sitio que habla con el canal externo. No importa el SDK de functions ni el de admin:
 * la programada lee el secreto y pasa la url. `sendOpsNotice` nunca lanza; todo fallo vuelve como
 * resultado, y ningun mensaje de error contiene la url (el webhook lleva el token en la ruta y el
 * resultado se guarda en `cashOverdueRuns`).
 *
 * El cuerpo depende del host del webhook (T20, hallazgo R1-RF_05-1): Discord (discord.com,
 * discordapp.com y sus subdominios) recibe exactamente `{ content }`; cualquier otro host, o una url
 * que no se pueda parsear, recibe exactamente `{ text }` (Slack, Google Chat). Nunca un campo de mas:
 * Google Chat responde 400 ante el campo desconocido `content`.
 */

export type OpsNoticeResult =
  | { ok: true; httpStatus: number }
  | { ok: false; reason: "no_channel" }
  | { ok: false; reason: "http_error"; httpStatus: number }
  | { ok: false; reason: "network_error"; error: string }
  | { ok: false; reason: "timeout"; error: string };

export interface SendOpsNoticeOptions {
  url: string | undefined | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_OPS_NOTICE_TIMEOUT_MS = 10_000;

const NO_CHANNEL_SENTINEL = "none";
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export function isOpsChannelConfigured(url: string | undefined | null): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  return trimmed !== "" && trimmed.toLowerCase() !== NO_CHANNEL_SENTINEL;
}

const DISCORD_HOSTS = ["discord.com", "discordapp.com"];

function isDiscordHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    // Url no parseable: se trata como canal generico; el envio decide si falla.
    return false;
  }
  return DISCORD_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** Cuerpo exacto para el canal: `{ content }` en Discord, `{ text }` en los demas. */
function buildNoticeBody(text: string, url: string): { content: string } | { text: string } {
  return isDiscordHost(url) ? { content: text } : { text };
}

/** Quita la url del webhook (y cualquier otra url) de un mensaje de error. */
function redact(message: string, url: string): string {
  const withoutUrl = url ? message.split(url).join("[webhook]") : message;
  return withoutUrl.replace(URL_PATTERN, "[url]");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

export async function sendOpsNotice(text: string, options: SendOpsNoticeOptions): Promise<OpsNoticeResult> {
  if (!isOpsChannelConfigured(options.url)) {
    return { ok: false, reason: "no_channel" };
  }
  const url = (options.url as string).trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPS_NOTICE_TIMEOUT_MS;

  const controller = new AbortController();
  let hasTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Ademas de abortar, la carrera garantiza que volvemos aunque `fetchImpl` ignore la senal.
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      hasTimedOut = true;
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const request = Promise.resolve().then(() =>
      fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildNoticeBody(text, url)),
        signal: controller.signal
      })
    );
    // Evita un rechazo no manejado si la peticion falla despues de ganar el timeout.
    request.catch(() => undefined);

    const outcome = await Promise.race([request, timeoutPromise]);
    if (outcome === "timeout") {
      return { ok: false, reason: "timeout", error: `no response after ${timeoutMs} ms` };
    }
    const httpStatus = outcome.status;
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ok: true, httpStatus };
    }
    return { ok: false, reason: "http_error", httpStatus };
  } catch (error) {
    const message = redact(describeError(error), url);
    if (hasTimedOut) {
      return { ok: false, reason: "timeout", error: message };
    }
    return { ok: false, reason: "network_error", error: message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
