import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve, join} from "node:path";

const root = process.argv[2] && resolve(process.argv[2]);
if (!root) throw new Error("need evidence directory");
const protocol = JSON.parse(readFileSync(join(root, "protocol.json"), "utf8"));
const completion = JSON.parse(readFileSync(join(root, "completion.json"), "utf8"));
const source = readFileSync(join(root, "blocks.jsonl"), "utf8");
const records = source.trim().split("\n").map((line) => JSON.parse(line));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
const median = (values) => {const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;};
const interval = (values) => {
  let seed = 18391;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;};
  const bootstrap = Array.from({length: 10_000}, () => median(Array.from({length: values.length}, () => values[Math.floor(random() * values.length)])));
  bootstrap.sort((a, b) => a - b);
  return [bootstrap[Math.floor(bootstrap.length * 0.025)], bootstrap[Math.ceil(bootstrap.length * 0.975) - 1]];
};
const metric = (record, when, name) => record[`metrics${when}`].find((entry) => entry.name === name)?.value;
const failures = [];
if (completion.failure || completion.completed !== 96 || records.length !== 96 || protocol.blocks !== 8 || protocol.samples !== 200 || protocol.warmups !== 50) failures.push("coverage");
if (protocol.order?.filter((entry) => entry === "AB").length !== 4 || protocol.order?.filter((entry) => entry === "BA").length !== 4) failures.push("counterbalance");
const groups = [];
for (const size of [100, 1000, 10_000]) for (const action of ["input", "stream"]) {
  const pairs = [];
  for (let block = 0; block < 8; block++) {
    const find = (variant) => records.filter((record) => record.size === size && record.action === action && record.block === block && record.variant === variant);
    const references = find("reference"); const candidates = find("candidate");
    if (references.length !== 1 || candidates.length !== 1) {failures.push(`pair:${size}:${action}:${block}`); continue;}
    const [reference] = references; const [candidate] = candidates;
    const actualOrder = records.filter((record) => record.size === size && record.action === action && record.block === block).map((record) => record.variant === "reference" ? "A" : "B").join("");
    if (reference.order !== protocol.order?.[block] || candidate.order !== protocol.order?.[block] || actualOrder !== protocol.order?.[block]) failures.push(`order:${size}:${action}:${block}`);
    if (reference.samples.length !== 200 || candidate.samples.length !== 200 || reference.errors.length || candidate.errors.length || [...reference.samples, ...candidate.samples].some((sample) => !Number.isFinite(sample.layoutMs) || sample.layoutMs < 0 || !Number.isFinite(sample.nextFrameMs) || sample.nextFrameMs < sample.layoutMs)) failures.push(`samples:${size}:${action}:${block}`);
    const summarize = (record) => ({layoutP50: percentile(record.samples.map((value) => value.layoutMs), 0.5), layoutP95: percentile(record.samples.map((value) => value.layoutMs), 0.95), layoutP99: percentile(record.samples.map((value) => value.layoutMs), 0.99), frameP95: percentile(record.samples.map((value) => value.nextFrameMs), 0.95), heapBefore: record.heapBefore.usedSize, heapAfter: record.heapAfter.usedSize, measuredSeconds: metric(record, "After", "Timestamp") - metric(record, "Before", "Timestamp"), taskSeconds: metric(record, "After", "TaskDuration") - metric(record, "Before", "TaskDuration")});
    const baseline = summarize(reference); const next = summarize(candidate);
    if (!(baseline.layoutP95 > 0)) failures.push(`zero_baseline:${size}:${action}:${block}`);
    pairs.push({block, reference: baseline, candidate: next, improvement: (baseline.layoutP95 - next.layoutP95) / baseline.layoutP95});
  }
  if (pairs.length !== 8) continue;
  const referenceP95 = median(pairs.map((pair) => pair.reference.layoutP95));
  const candidateP95 = median(pairs.map((pair) => pair.candidate.layoutP95));
  const improvement = median(pairs.map((pair) => pair.improvement));
  const confidence = interval(pairs.map((pair) => pair.improvement));
  const frameReference = median(pairs.map((pair) => pair.reference.frameP95));
  const frameCandidate = median(pairs.map((pair) => pair.candidate.frameP95));
  const heapReference = median(pairs.map((pair) => pair.reference.heapAfter));
  const heapCandidate = median(pairs.map((pair) => pair.candidate.heapAfter));
  const taskReference = median(pairs.map((pair) => pair.reference.taskSeconds));
  const taskCandidate = median(pairs.map((pair) => pair.candidate.taskSeconds));
  const gates = {
    layoutNoRegression: candidateP95 - referenceP95 <= Math.max(referenceP95 * 0.1, 2),
    nextFrameNoRegression: frameCandidate - frameReference <= Math.max(frameReference * 0.1, 2),
    heapNoRegression: heapCandidate <= heapReference * 1.1,
    heapStableDuringMeasuredSamples: pairs.every((pair) => pair.candidate.heapAfter <= pair.candidate.heapBefore * 1.1),
    taskCpuNoRegression: taskCandidate - taskReference <= Math.max(taskReference * 0.1, median(pairs.map((pair) => pair.reference.measuredSeconds)) * 0.01),
    ...(size >= 1000 ? {improvementTarget: improvement >= 0.2, confidenceFavorable: confidence[0] > 0} : {}),
  };
  for (const [name, passed] of Object.entries(gates)) if (!passed) failures.push(`${size}:${action}:${name}`);
  groups.push({size, action, referenceP95, candidateP95, pairedMedianImprovement: improvement, pairedBootstrap95: confidence, frameReference, frameCandidate, heapReference, heapCandidate, taskReference, taskCandidate, gates, pairs});
}
const report = {status: failures.length ? "review" : "measured_metrics_passed", failureCount: failures.length, failures, groups, resourceQualification: "incomplete", independentAuditRequired: true, participantAcceptanceRequired: true, limitations: ["No mobile hardware measurement", "No idle CPU, process resident bytes or scheduler wakeup qualification; task CPU and JavaScript heap measure different resources", "No long memory soak; heap stability covers the measured workload only", "Event-to-layout and following-frame timings are laboratory measurements, not field INP", "Fixture keeps all rows of a live session; recovered history is separately bounded by the host"], sourceSha256: createHash("sha256").update(source).digest("hex"), generatedAt: new Date().toISOString()};
writeFileSync(join(root, "summary.json"), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify({status: report.status, failures, groups: groups.map(({size, action, referenceP95, candidateP95, pairedMedianImprovement}) => ({size, action, referenceP95, candidateP95, pairedMedianImprovement}))}) + "\n");
