import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueEvidence,
  markQueuedEvidenceError,
  pruneOrphanPhotos,
  queuedEvidenceToFile,
  readEvidenceQueue,
  readQueuedPhoto,
  removeQueuedEvidence,
  writeEvidenceQueue,
  type QueuedEvidence
} from "@/lib/evidence-queue";

/** `localStorage` de mentira con cuota configurable, que es justo lo que hay que poder provocar. */
class FakeStorage {
  private map = new Map<string, string>();
  quotaBytes = Number.POSITIVE_INFINITY;

  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    const used = [...this.map.entries()].reduce((total, [k, v]) => (k === key ? total : total + k.length + v.length), 0);
    if (used + key.length + value.length > this.quotaBytes) {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    }
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

let store: FakeStorage;

/** Node no trae FileReader; solo hace falta el camino de `readAsDataURL`. */
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then((buffer) => {
      this.result = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onload?.();
    });
  }
}

function photoFile(name: string, kilobytes: number) {
  return new File([new Uint8Array(kilobytes * 1024).fill(65)], name, { type: "image/jpeg" });
}

function baseInput(orderId: string, file: File) {
  return { orderId, outcome: "delivered" as const, note: "Entregado en porteria", file };
}

beforeEach(() => {
  store = new FakeStorage();
  (globalThis as Record<string, unknown>).window = { localStorage: store, atob: (value: string) => Buffer.from(value, "base64").toString("binary") };
  (globalThis as Record<string, unknown>).FileReader = FakeFileReader;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).FileReader;
});

describe("evidence queue", () => {
  it("guarda la foto aparte del indice, para que el indice siga siendo diminuto", async () => {
    await enqueueEvidence(baseInput("KNT-000001", photoFile("evidencia.jpg", 300)));

    const rawIndex = store.getItem("kentro-evidence-queue") ?? "";
    expect(rawIndex.length).toBeLessThan(600);
    expect(rawIndex).not.toContain("base64");

    const [item] = readEvidenceQueue();
    expect(item.orderId).toBe("KNT-000001");
    expect(readQueuedPhoto(item.id)?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("el indice no crece con el tamano de la foto", async () => {
    await enqueueEvidence(baseInput("KNT-000001", photoFile("chica.jpg", 20)));
    const small = (store.getItem("kentro-evidence-queue") ?? "").length;
    store.clear();
    await enqueueEvidence(baseInput("KNT-000001", photoFile("chica.jpg", 900)));
    const large = (store.getItem("kentro-evidence-queue") ?? "").length;
    expect(large).toBe(small);
  });

  it("reconstruye el File desde el dataURL guardado", async () => {
    const item = await enqueueEvidence(baseInput("KNT-000002", photoFile("evidencia.jpg", 8)));
    const file = await queuedEvidenceToFile(item, readQueuedPhoto(item.id) ?? "");
    expect(file.name).toBe("evidencia.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(8 * 1024);
  });

  it("sacrifica la evidencia mas vieja antes que perder la nueva cuando se llena la cuota", async () => {
    const old = await enqueueEvidence(baseInput("KNT-000010", photoFile("vieja.jpg", 2)));
    store.quotaBytes = store.getItem(`kentro-evidence-photo-${old.id}`)!.length + 2000;

    const fresh = await enqueueEvidence(baseInput("KNT-000011", photoFile("nueva.jpg", 2)));

    const queue = readEvidenceQueue();
    expect(queue.map((item) => item.id)).toEqual([fresh.id]);
    expect(readQueuedPhoto(fresh.id)).not.toBeNull();
    expect(readQueuedPhoto(old.id)).toBeNull();
  });

  it("avisa en vez de perder la foto en silencio cuando no cabe ni sola", async () => {
    store.quotaBytes = 100;
    await expect(enqueueEvidence(baseInput("KNT-000012", photoFile("nueva.jpg", 2)))).rejects.toThrow(/espacio/i);
  });

  it("borra la foto al sacar el item de la cola", async () => {
    const item = await enqueueEvidence(baseInput("KNT-000003", photoFile("evidencia.jpg", 4)));
    expect(removeQueuedEvidence(item.id)).toEqual([]);
    expect(readQueuedPhoto(item.id)).toBeNull();
  });

  it("limpia fotos huerfanas que quedaron sin item", async () => {
    const item = await enqueueEvidence(baseInput("KNT-000004", photoFile("evidencia.jpg", 4)));
    store.setItem("kentro-evidence-photo-qe-fantasma-1", "data:image/jpeg;base64,AAAA");
    pruneOrphanPhotos();
    expect(store.getItem("kentro-evidence-photo-qe-fantasma-1")).toBeNull();
    expect(readQueuedPhoto(item.id)).not.toBeNull();
  });

  it("marca el error del item sin tocar los demas", async () => {
    const first = await enqueueEvidence(baseInput("KNT-000005", photoFile("a.jpg", 2)));
    const second = await enqueueEvidence(baseInput("KNT-000006", photoFile("b.jpg", 2)));
    const next = markQueuedEvidenceError(second.id, "Sin senal");
    expect(next.find((item) => item.id === second.id)?.error).toBe("Sin senal");
    expect(next.find((item) => item.id === first.id)?.error).toBeUndefined();
  });

  it("migra los items del formato viejo sin perder la foto", async () => {
    // Lo que dejaria en el telefono la version anterior: base64 dentro del propio indice.
    const legacy = {
      id: "qe-KNT-000009-1",
      orderId: "KNT-000009",
      outcome: "failed",
      note: "Cliente no responde",
      reason: "Cliente no responde",
      failedCategory: "failed_visit",
      fileName: "vieja.jpg",
      fileType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,QUFBQQ==",
      createdAt: "2026-09-01T10:00:00.000Z"
    };
    store.setItem("kentro-evidence-queue", JSON.stringify([legacy]));

    const [item] = readEvidenceQueue();
    expect(item.id).toBe(legacy.id);
    expect("dataUrl" in item).toBe(false);
    expect(readQueuedPhoto(legacy.id)).toBe(legacy.dataUrl);
    expect(store.getItem("kentro-evidence-queue")).not.toContain("QUFBQQ");

    const file = await queuedEvidenceToFile(item, readQueuedPhoto(legacy.id) ?? "");
    expect(file.name).toBe("vieja.jpg");
    expect(file.size).toBe(4);
  });

  it("sobrevive a un indice corrupto", () => {
    store.setItem("kentro-evidence-queue", "{no-json");
    expect(readEvidenceQueue()).toEqual([]);
  });

  it("mantiene el orden: el mas nuevo al principio", async () => {
    const first = await enqueueEvidence(baseInput("KNT-000007", photoFile("a.jpg", 2)));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await enqueueEvidence(baseInput("KNT-000008", photoFile("b.jpg", 2)));
    expect(readEvidenceQueue().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it("no explota fuera del navegador", () => {
    delete (globalThis as Record<string, unknown>).window;
    expect(readEvidenceQueue()).toEqual([]);
    expect(() => writeEvidenceQueue([] as QueuedEvidence[])).not.toThrow();
  });
});
