#!/usr/bin/env node
/**
 * SOLO LECTURA. Resume `evidenceTimings` (src/lib/evidence-timing.ts): en que tramo se va el tiempo
 * de una evidencia en el telefono del domiciliario.
 *
 *   node scripts/read-evidence-timings.js            # ultimas 48 h
 *   node scripts/read-evidence-timings.js --hours 24 --csv > /tmp/x.csv
 *
 * Una sola consulta por `createdAt` (indice de campo unico automatico). La coleccion caduca a 14 dias.
 */
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const args = process.argv.slice(2);
const hoursArg = args.indexOf("--hours");
const hours = hoursArg >= 0 ? Number(args[hoursArg + 1]) : 48;
const asCsv = args.includes("--csv");

const metrics = ["originalBytes", "preparedBytes", "prepareMs", "uploadMs", "reprepareMs", "selectToSubmitMs", "submitWaitMs", "closeMs"];

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function summarize(rows, label) {
  const out = { group: label, n: rows.length };
  for (const metric of metrics) {
    const values = rows.map((row) => row[metric]).filter((value) => typeof value === "number").sort((a, b) => a - b);
    out[`${metric}.p50`] = quantile(values, 0.5);
    out[`${metric}.p90`] = quantile(values, 0.9);
  }
  return out;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] === undefined ? "(vacio)" : String(row[key]);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function platform(userAgent = "") {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "otro";
}

async function main() {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - hours * 3600 * 1000);
  const snap = await db.collection("evidenceTimings").where("createdAt", ">=", since).get();
  const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data(), createdAt: doc.get("createdAt")?.toDate?.().toISOString(), expiresAt: undefined }));

  if (asCsv) {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((column) => column !== "expiresAt");
    console.log(columns.join(","));
    for (const row of rows) console.log(columns.map((column) => JSON.stringify(row[column] ?? "")).join(","));
    return;
  }

  console.log(`evidenceTimings en las ultimas ${hours} h: ${rows.length}\n`);
  if (rows.length === 0) return;
  for (const key of ["result", "source", "stateAtSubmit", "decoder", "netType", "tokenRetry", "uploadError", "closeError"]) {
    console.log(key.padEnd(14), JSON.stringify(countBy(rows, key)));
  }
  console.log("plataforma    ", JSON.stringify(countBy(rows.map((row) => ({ p: platform(row.userAgent) })), "p")));

  const groups = [
    ["todo", rows],
    ["form", rows.filter((row) => row.source === "form")],
    ["queue", rows.filter((row) => row.source === "queue")],
    ["ios", rows.filter((row) => platform(row.userAgent) === "ios")],
    ["android", rows.filter((row) => platform(row.userAgent) === "android")],
    ["clic:ready", rows.filter((row) => row.stateAtSubmit === "ready")],
    ["clic:no-ready", rows.filter((row) => row.source === "form" && row.stateAtSubmit !== "ready")]
  ];
  for (const [label, group] of groups) {
    if (group.length === 0) continue;
    console.log("\n" + JSON.stringify(summarize(group, label)));
  }
  for (const netType of new Set(rows.map((row) => row.netType).filter(Boolean))) {
    console.log("\n" + JSON.stringify(summarize(rows.filter((row) => row.netType === netType), `net:${netType}`)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
