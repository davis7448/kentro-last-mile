#!/usr/bin/env node
/**
 * Spec 023, DoD 4 / RNF_01 — lecturas de Firestore por dia, antes y despues.
 *
 *   node scripts/measure-023-reads.js [dias=21]
 *
 * Lee `firestore.googleapis.com/document/read_count` de Cloud Monitoring (necesita `gcloud auth`), por hora
 * de Colombia (UTC-5), y lo resume por dia con la mediana de 0 a 6 h (el "suelo"). Marca los despliegues:
 *  - fase A (storeApi):              2026-11-10 14:40 UTC
 *  - fase B (getPlatformPosition + hosting): 2026-11-10 ~16:35 UTC
 * Linea base (`.sdd/evidence/023/baseline.md`): ~2,5 M por dia habil, suelo ~72.000-78.000 por hora.
 * RNF_01 pide bajar al menos un 70 %: <= ~750.000 por dia habil.
 */
const { execSync } = require("child_process");

const days = Number(process.argv[2] || 21);
const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const end = new Date();
end.setUTCMinutes(0, 0, 0);
const start = new Date(end.getTime() - days * 86400000);
const params = new URLSearchParams({
  filter: 'metric.type="firestore.googleapis.com/document/read_count"',
  "interval.startTime": start.toISOString(),
  "interval.endTime": end.toISOString(),
  "aggregation.alignmentPeriod": "3600s",
  "aggregation.perSeriesAligner": "ALIGN_SUM",
  "aggregation.crossSeriesReducer": "REDUCE_SUM"
});

(async () => {
  const response = await fetch(`https://monitoring.googleapis.com/v3/projects/kentro-last-mile/timeSeries?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  const points = (data.timeSeries?.[0]?.points ?? []).map((point) => ({
    // El punto se etiqueta con el fin de la hora; se resta una hora y cinco de huso.
    at: new Date(new Date(point.interval.endTime).getTime() - 3600000 - 5 * 3600000),
    reads: Number(point.value.int64Value)
  }));
  const byDay = new Map();
  for (const point of points) {
    const day = point.at.toISOString().slice(0, 10);
    const hour = point.at.getUTCHours();
    const row = byDay.get(day) ?? { total: 0, night: [] };
    row.total += point.reads;
    if (hour < 6) row.night.push(point.reads);
    byDay.set(day, row);
  }
  const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const rows = [...byDay.entries()].sort().map(([day, row]) => ({
    dia: day,
    lecturas: row.total.toLocaleString("es-CO"),
    sueloNocturnoPorHora: median(row.night).toLocaleString("es-CO"),
    fase: day < "2026-11-10" ? "antes" : day === "2026-11-10" ? "despliegue" : "despues"
  }));
  console.table(rows);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
