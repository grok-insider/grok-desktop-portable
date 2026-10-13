import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {compareBlocks} from "./remote-evaluation.mjs";

const policy = {blocks: 8, warmups: 50, samplesPerVariant: 200, orderCounts: {AB: 4, BA: 4}, bootstrapResamples: 10000, seed: 18391};
function run(change) {
  const directory = mkdtempSync(join(tmpdir(), "transcript-evaluator-"));
  try {
    const order = ["AB", "BA", "AB", "BA", "BA", "AB", "AB", "BA"];
    const records = [];
    for (const size of [100, 1000, 10000]) for (const action of ["input", "stream"]) for (let block = 0; block < 8; block++) for (const variant of [...order[block]].map((label) => label === "A" ? "reference" : "candidate")) {
      const layout = variant === "reference" ? 20 : 10 + block * 0.5;
      records.push({size, action, block, order: order[block], variant, samples: Array.from({length: 200}, () => ({layoutMs: layout, nextFrameMs: 30})), errors: [], heapBefore: {usedSize: 1000}, heapAfter: {usedSize: 1000}, metricsBefore: [{name: "Timestamp", value: 0}, {name: "TaskDuration", value: 0}], metricsAfter: [{name: "Timestamp", value: 1}, {name: "TaskDuration", value: 0.1}]});
    }
    change?.(records);
    writeFileSync(join(directory, "protocol.json"), JSON.stringify({blocks: 8, samples: 200, warmups: 50, order}));
    writeFileSync(join(directory, "completion.json"), JSON.stringify({completed: 96, failure: null}));
    writeFileSync(join(directory, "blocks.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"));
    const process = spawnSync("node", [new URL("./evaluate-transcript.mjs", import.meta.url).pathname, directory], {encoding: "utf8"});
    assert.equal(process.status, 0, process.stderr);
    return {report: JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")), records};
  } finally {rmSync(directory, {recursive: true, force: true});}
}

test("bootstrap is identical to the central evaluator for each condition", () => {
  const {report, records} = run();
  assert.equal(report.status, "measured_metrics_passed");
  assert.equal(report.resourceQualification, "incomplete");
  for (const group of report.groups) {
    const blocks = Array.from({length: 8}, (_, id) => {
      const reference = records.find((record) => record.size === group.size && record.action === group.action && record.block === id && record.variant === "reference");
      const candidate = records.find((record) => record.size === group.size && record.action === group.action && record.block === id && record.variant === "candidate");
      return {id, order: reference.order, warmups: 50, valid: true, baseline: reference.samples.map((value) => value.layoutMs), candidate: candidate.samples.map((value) => value.layoutMs)};
    });
    const expected = compareBlocks(blocks, policy);
    assert.equal(group.pairedMedianImprovement * 100, expected.medianReductionPercent);
    group.pairedBootstrap95.forEach((value, index) => assert(Math.abs(value * 100 - expected.confidence95[index]) < 1e-10));
  }
});

test("a benefit below twenty percent at one thousand items fails even if ten thousand passes", () => {
  const {report} = run((records) => {for (const record of records) if (record.size === 1000 && record.variant === "candidate") record.samples.forEach((sample) => sample.layoutMs = 18);});
  assert(report.failures.includes("1000:input:improvementTarget"));
  assert(report.failures.includes("1000:stream:improvementTarget"));
});

test("recorded order must match the registered block schedule", () => {
  const {report} = run((records) => {records[0].order = "BA";});
  assert(report.failures.includes("order:100:input:0"));
});

test("physical record order is checked independently of its declared label", () => {
  const {report} = run((records) => {[records[0], records[1]] = [records[1], records[0]];});
  assert(report.failures.includes("order:100:input:0"));
});
