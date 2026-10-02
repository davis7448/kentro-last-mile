/**
 * Spec 026 · T11 — canal de aviso por webhook (RF_05; plan 2.5).
 *
 * `functions/src/ops-notify.ts` es el unico sitio que habla con el canal externo. Contrato:
 *
 *   isOpsChannelConfigured(url: string | undefined | null): boolean
 *     - `undefined`, `null`, `""`, solo espacios y `"none"` (sin importar mayusculas ni espacios
 *       alrededor) = NO hay canal. Cualquier otra cadena = hay canal.
 *
 *   sendOpsNotice(text, { url, fetchImpl?, timeoutMs? }): Promise<OpsNoticeResult>
 *     - NUNCA lanza: todo fallo vuelve como resultado.
 *     - Sin canal  -> { ok: false, reason: "no_channel" } y `fetch` NO se llama.
 *     - 2xx        -> { ok: true, httpStatus }.
 *     - no-2xx     -> { ok: false, reason: "http_error", httpStatus }.
 *     - excepcion  -> { ok: false, reason: "network_error", error: string }.
 *     - timeout    -> { ok: false, reason: "timeout", error: string } (AbortController con `timeoutMs`).
 *     - La peticion es POST, `Content-Type: application/json`. El cuerpo depende del host (T20,
 *       hallazgo R1-RF_05-1: Google Chat responde 400 ante el campo desconocido `content`):
 *         discord.com / discordapp.com (y sus subdominios, sin importar mayusculas) -> `{ content: text }`
 *         cualquier otro host (hooks.slack.com, chat.googleapis.com, generico)     -> `{ text }`
 *         url no parseable                                                         -> `{ text }`, sin lanzar
 *       Nunca un campo de mas.
 *     - El mensaje de error nunca incluye la URL: el webhook lleva el token en la ruta y el resultado
 *       termina en `cashOverdueRuns`.
 *
 * `ops-notify.ts` no importa `firebase-functions`: la programada lee el secreto y se lo pasa.
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle
 * con su propio mensaje.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

type OpsNotifyModule = typeof import("../../functions/src/ops-notify");
const loadNotify = (): Promise<OpsNotifyModule> => import("../../functions/src/ops-notify");

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/SECRET-TOKEN-abc";

function absolute(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

function responseWith(status: number): Response {
  return new Response(status === 204 ? null : "body", { status });
}

describe("T11 · isOpsChannelConfigured", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["cadena vacia", ""],
    ["solo espacios", "   "],
    ["none", "none"],
    ["NONE con espacios", "  NONE \n"]
  ])("sin canal cuando la url es %s", async (_label, url) => {
    const { isOpsChannelConfigured } = await loadNotify();
    expect(isOpsChannelConfigured(url as string | undefined)).toBe(false);
  });

  it("con canal cuando hay una url", async () => {
    const { isOpsChannelConfigured } = await loadNotify();
    expect(isOpsChannelConfigured(WEBHOOK_URL)).toBe(true);
  });

  it("con canal cuando la url trae espacios alrededor", async () => {
    const { isOpsChannelConfigured } = await loadNotify();
    expect(isOpsChannelConfigured(`  ${WEBHOOK_URL}  `)).toBe(true);
  });
});

describe("T11 · sendOpsNotice sin canal", () => {
  it.each([
    ["undefined", undefined],
    ["cadena vacia", ""],
    ["solo espacios", "  "],
    ["none", "none"]
  ])("con url %s devuelve no_channel y no llama a fetch", async (_label, url) => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn();
    const result = await sendOpsNotice("hola", { url: url as string, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "no_channel" });
  });
});

describe("T11 · sendOpsNotice con canal", () => {
  it("2xx: devuelve ok con el status", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => responseWith(204));
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, httpStatus: 204 });
  });

  it("200 tambien es ok", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => responseWith(200));
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, httpStatus: 200 });
  });

  // T20: antes fijaba `{ content, text }`; WEBHOOK_URL es de Discord, asi que ahora fija `{ content }` solo.
  it("hace un solo POST JSON a la url (recortada); a Discord solo con { content }", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseWith(200));
    await sendOpsNotice("Efectivo vencido: 3 pedidos", {
      url: `  ${WEBHOOK_URL} `,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0];
    expect(String(input)).toBe(WEBHOOK_URL);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toMatch(/^application\/json/);
    expect(JSON.parse(String(init?.body))).toEqual({
      content: "Efectivo vencido: 3 pedidos"
    });
  });

  it("pasa una senal de aborto a fetch", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseWith(200));
    await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("500: fallo http_error con el httpStatus", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => responseWith(500));
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "http_error", httpStatus: 500 }));
  });

  it("3xx no cuenta como enviado", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => responseWith(302));
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "http_error", httpStatus: 302 }));
  });

  it("excepcion de red: fallo network_error con el mensaje, sin lanzar", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "network_error", error: expect.stringContaining("ECONNREFUSED") });
  });

  it("fetch que lanza algo que no es Error tampoco escapa", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(() => {
      throw "boom";
    });
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "network_error", error: expect.any(String) });
  });

  it("timeout: aborta tras timeoutMs y devuelve timeout", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );
    const started = Date.now();
    const result = await sendOpsNotice("hola", {
      url: WEBHOOK_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 30
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual({ ok: false, reason: "timeout", error: expect.any(String) });
  });

  it("el error nunca expone la url del webhook (lleva el token)", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async () => {
      throw new Error(`request to ${WEBHOOK_URL} failed`);
    });
    const result = await sendOpsNotice("hola", { url: WEBHOOK_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN-abc");
  });
});

describe("T20 · cuerpo segun el canal", () => {
  const TEXT = "Efectivo vencido: 3 pedidos ($120.000)";

  async function bodyFor(url: string): Promise<unknown> {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseWith(200));
    const result = await sendOpsNotice(TEXT, { url, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, httpStatus: 200 });
    return JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
  }

  it.each([
    ["discord.com", "https://discord.com/api/webhooks/123/TOKEN"],
    ["discordapp.com", "https://discordapp.com/api/webhooks/123/TOKEN"],
    ["subdominio ptb.discord.com", "https://ptb.discord.com/api/webhooks/123/TOKEN"],
    ["subdominio canary.discordapp.com", "https://canary.discordapp.com/api/webhooks/123/TOKEN"],
    ["host en mayusculas", "https://DISCORD.COM/api/webhooks/123/TOKEN"],
    ["host mixto con espacios", "  https://Discord.Com/api/webhooks/123/TOKEN  "]
  ])("Discord (%s): cuerpo exactamente { content }", async (_label, url) => {
    expect(await bodyFor(url)).toEqual({ content: TEXT });
  });

  it.each([
    ["Slack", "https://hooks.slack.com/services/T000/B000/XXXX"],
    ["Google Chat", "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=K&token=T"],
    ["Google Chat en mayusculas", "https://CHAT.GOOGLEAPIS.COM/v1/spaces/AAAA/messages?key=K&token=T"],
    ["otro host", "https://example.com/hooks/abc"],
    ["host que solo contiene discord.com", "https://notdiscord.com/api/webhooks/1/T"],
    ["discord.com como subdominio ajeno", "https://discord.com.evil.example/api/webhooks/1/T"],
    ["discord.com en la ruta", "https://example.com/discord.com/api/webhooks/1/T"]
  ])("%s: cuerpo exactamente { text }", async (_label, url) => {
    expect(await bodyFor(url)).toEqual({ text: TEXT });
  });

  it("url no parseable: cuerpo { text } y no lanza", async () => {
    const { sendOpsNotice } = await loadNotify();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseWith(200));
    const result = await sendOpsNotice(TEXT, {
      url: "esto no es una url",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: true, httpStatus: 200 });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ text: TEXT });
  });
});

describe("T11 · guarda de fuente", () => {
  it("ops-notify.ts no importa firebase-functions ni firebase-admin", () => {
    const source = readFileSync(absolute("functions/src/ops-notify.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']firebase-functions/);
    expect(source).not.toMatch(/from\s+["']firebase-admin/);
    expect(source).not.toMatch(/require\(\s*["']firebase-(functions|admin)/);
  });
});
