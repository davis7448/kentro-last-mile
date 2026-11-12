import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvidenceTimingDoc, errorTag, EVIDENCE_TIMING_FIELDS } from "./evidence-timing";

const env = { uid: "u1", role: "messenger", userAgent: "Mozilla/5.0", online: true, connection: { effectiveType: "3g", downlink: 1.234, rtt: 350, saveData: false } };

describe("buildEvidenceTimingDoc", () => {
  it("arma el registro completo, redondeado", () => {
    const doc = buildEvidenceTimingDoc(
      { source: "form", outcome: "failed", orderId: "o1", originalBytes: 3_500_000, preparedBytes: 210_000.4, decoder: "bitmap", width: 4000, height: 3000, prepareMs: 812.7, uploadMs: 5400.2, attempts: 1, stateAtSubmit: "uploading", submitWaitMs: 3100, closeMs: 900, result: "closed" },
      env,
      "2026-11-12T10:00:00.000Z"
    );
    expect(doc).toMatchObject({ uid: "u1", role: "messenger", outcome: "failed", prepareMs: 813, uploadMs: 5400, preparedBytes: 210000, netType: "3g", netDownlink: 1.23, netRtt: 350, netSaveData: false, result: "closed" });
  });

  it("omite lo vacio o invalido en vez de escribir undefined o un 0 falso", () => {
    const doc = buildEvidenceTimingDoc({ prepareMs: Number.NaN, uploadMs: -5 }, { uid: "u1", role: "driver", connection: null }, "x");
    expect(Object.values(doc)).not.toContain(undefined);
    expect(doc).not.toHaveProperty("prepareMs");
    expect(doc).not.toHaveProperty("uploadMs");
    expect(doc).not.toHaveProperty("netType");
    expect(doc.result).toBe("abandoned");
    expect(doc.source).toBe("form");
  });

  it("recorta el user agent al tope de la regla", () => {
    const doc = buildEvidenceTimingDoc({}, { ...env, userAgent: "a".repeat(1000) }, "x");
    expect(String(doc.userAgent).length).toBe(300);
  });

  it("solo produce campos que la regla acepta", () => {
    const doc = buildEvidenceTimingDoc(
      { source: "queue", outcome: "delivered", orderId: "o", originalBytes: 1, originalType: "image/jpeg", preparedBytes: 1, decoder: "img", width: 1, height: 1, prepareMs: 1, uploadMs: 1, reprepareMs: 1, attempts: 2, tokenRetry: true, uploadError: "e", selectToSubmitMs: 1, stateAtSubmit: "ready", submitWaitMs: 1, closeMs: 1, closeError: "c", result: "close_error" },
      env,
      "x"
    );
    for (const key of Object.keys(doc)) expect(EVIDENCE_TIMING_FIELDS).toContain(key);
  });
});

describe("firestore.rules evidenceTimings", () => {
  it("acepta exactamente los campos de EVIDENCE_TIMING_FIELDS", () => {
    const rules = readFileSync(join(__dirname, "../../firestore.rules"), "utf8");
    const block = rules.slice(rules.indexOf("match /evidenceTimings/"));
    const list = block.slice(block.indexOf("hasOnly(["), block.indexOf("])"));
    const ruleFields = [...list.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]).sort();
    expect(ruleFields).toEqual([...EVIDENCE_TIMING_FIELDS].sort());
  });
});

describe("errorTag", () => {
  it("prefiere el code de Firebase y si no el mensaje", () => {
    expect(errorTag({ code: "storage/canceled", message: "x" })).toBe("storage/canceled");
    expect(errorTag(new Error("boom"))).toBe("boom");
    expect(errorTag(null)).toBe("unknown");
  });
});
