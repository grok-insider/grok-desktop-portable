import {createHash} from 'node:crypto';
import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
const insist = (condition, message) => {if (!condition) throw new Error(message);};
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function percentile(values, fraction) {
  insist(finite(fraction) && fraction > 0 && fraction <= 1, 'invalid_percentile');
  insist(values.length > 0 && values.every(value => finite(value) && value >= 0), 'invalid_samples');
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  insist(sorted.length > 0 && sorted.every(finite), 'invalid_median');
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function randomSource(seed) {
  let value = seed >>> 0;
  return () => {value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296;};
}
export function compareBlocks(blocks, policy) {
  insist(Array.isArray(blocks) && blocks.length === policy.blocks, 'wrong_block_count');
  insist(new Set(blocks.map(block => block.id)).size === blocks.length, 'duplicate_block');
  for (const [order, count] of Object.entries(policy.orderCounts)) insist(blocks.filter(block => block.order === order).length === count, 'unbalanced_order');
  const reductions = [], savedMs = [];
  for (const block of blocks) {
    insist(block.warmups === policy.warmups, 'wrong_warmup_count');
    insist(block.baseline?.length === policy.samplesPerVariant && block.candidate?.length === policy.samplesPerVariant, 'wrong_sample_count');
    insist(block.valid === true, 'invalid_block_conditions');
    const before = percentile(block.baseline, 0.95), after = percentile(block.candidate, 0.95);
    insist(before > 0, 'zero_baseline');
    reductions.push(100 * (before - after) / before);
    savedMs.push(before - after);
  }
  const random = randomSource(policy.seed);
  const bootstrap = Array.from({length: policy.bootstrapResamples}, () => median(Array.from({length: blocks.length}, () => reductions[Math.floor(random() * blocks.length)])));
  bootstrap.sort((a, b) => a - b);
  return {medianReductionPercent: median(reductions), medianSavedMs: median(savedMs), positiveBlocks: reductions.filter(value => value > 0).length, confidence95: [bootstrap[Math.floor(bootstrap.length * 0.025)], bootstrap[Math.ceil(bootstrap.length * 0.975) - 1]], pairedReductions: reductions};
}
export function compareResources(resources, policy) {
  insist(Array.isArray(resources), 'resources_required');
  insist(new Set(resources.map(resource => resource.id)).size === resources.length, 'duplicate_resource');
  const expected = ['cpu-idle-percent', 'resident-bytes', 'wakeups-per-second'];
  insist(resources.length === expected.length && resources.every(resource => expected.includes(resource.id)), 'resource_conditions_required');
  return resources.map(resource => {
    insist(resource.baseline?.length === policy.blocks && resource.candidate?.length === policy.blocks, 'resource_blocks_required');
    insist([...resource.baseline, ...resource.candidate].every(value => finite(value) && value >= 0), 'invalid_resource_samples');
    const before = median(resource.baseline), after = median(resource.candidate);
    const absolute = resource.id === 'cpu-idle-percent' ? 1 : 0;
    const allowance = Math.max(absolute, before * policy.nonTargetRegressionPercent / 100);
    return {id: resource.id, before, after, allowance, passed: after - before <= allowance};
  });
}
export async function verifyEvidence(records, root) {
  insist(Array.isArray(records) && records.length > 0, 'evidence_required');
  const base = await realpath(root);
  const paths = new Set();
  for (const entry of records) {
    insist(typeof entry.path === 'string' && !isAbsolute(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256), 'invalid_evidence');
    const path = await realpath(resolve(base, entry.path));
    const local = relative(base, path);
    insist(local !== '..' && !local.startsWith('../') && !isAbsolute(local), 'evidence_outside_root');
    insist(!paths.has(path), 'duplicate_evidence');
    paths.add(path);
    insist((await stat(path)).isFile(), 'evidence_not_file');
    insist(digest(await readFile(path)) === entry.sha256, 'evidence_hash_mismatch');
  }
}
export function evaluate(catalog, input, catalogHash) {
  insist(input.schema === 1 && input.catalogSha256 === catalogHash, 'catalog_identity_mismatch');
  const experiment = catalog.experiments.find(item => item.id === input.experiment);
  insist(experiment, 'unknown_experiment');
  insist(Number.isInteger(input.round) && input.round >= 1 && input.round <= catalog.evaluationPolicy.maxRounds, 'round_requires_new_hypothesis');
  insist(/^[a-f0-9]{64}$/.test(input.sourceManifestSha256), 'source_identity_required');
  insist(Array.isArray(input.evidence) && input.evidence.some(entry => entry.sha256 === input.sourceManifestSha256), 'source_manifest_evidence_required');
  const evidenceHashes = new Set(input.evidence.map(entry => entry.sha256));
  insist(Array.isArray(input.checks) && new Set(input.checks.map(check => check.id)).size === input.checks.length, 'invalid_checks');
  for (const check of input.checks) {
    insist(experiment.requiredChecks.includes(check.id) && ['passed', 'failed', 'not_run'].includes(check.status), 'unknown_check');
    if (check.status !== 'not_run') insist(check.sourceManifestSha256 === input.sourceManifestSha256 && Array.isArray(check.evidenceSha256) && check.evidenceSha256.length > 0 && check.evidenceSha256.every(hash => evidenceHashes.has(hash)), 'check_evidence_required');
  }
  const failed = input.checks.filter(check => check.status === 'failed').map(check => check.id);
  const missing = experiment.requiredChecks.filter(id => !input.checks.some(check => check.id === id && check.status !== 'not_run'));
  const result = {schema: 1, experiment: experiment.id, round: input.round, catalogSha256: catalogHash, sourceManifestSha256: input.sourceManifestSha256, decision: 'inconclusive', reasons: [], failed, missing};
  if (failed.length) {result.decision = 'revise'; result.reasons.push('acceptance_failed'); return result;}
  if (missing.length) {result.reasons.push('acceptance_incomplete'); return result;}
  if (['event-delivery', 'long-conversation', 'publication-cost'].includes(experiment.id)) {
    if (!input.resources) {result.reasons.push('resource_validation_pending'); return result;}
    result.resources = compareResources(input.resources, catalog.evaluationPolicy.performance);
    if (result.resources.some(resource => !resource.passed)) {result.decision = 'revise'; result.reasons.push('resource_regression'); return result;}
  }
  if (input.experiment === 'event-delivery') {
    insist(input.conditions && Object.keys(input.conditions).sort().join(',') === 'single,ten-with-slow-consumer', 'conditions_required');
    result.performance = {};
    for (const [name, blocks] of Object.entries(input.conditions)) {
      const metrics = compareBlocks(blocks, catalog.evaluationPolicy.performance);
      result.performance[name] = metrics;
      if (metrics.confidence95[0] <= 0) {result.reasons.push(`uncertain_performance:${name}`); continue;}
      if (metrics.medianReductionPercent < catalog.evaluationPolicy.performance.eventReductionPercent || metrics.medianSavedMs < catalog.evaluationPolicy.performance.eventReductionMs) result.reasons.push(`benefit_not_met:${name}`);
    }
    if (result.reasons.some(reason => reason.startsWith('uncertain'))) return result;
    if (result.reasons.length) {result.decision = 'discard'; return result;}
  } else if (input.experiment === 'long-conversation') {
    insist(input.conditions && Object.keys(input.conditions).sort().join(',') === '100,1000,10000', 'conditions_required');
    result.performance = {};
    for (const [name, blocks] of Object.entries(input.conditions)) {
      const metrics = compareBlocks(blocks, catalog.evaluationPolicy.performance);
      result.performance[name] = metrics;
      if (name === '100') {
        if (metrics.medianReductionPercent < -10 && metrics.medianSavedMs < -2) {result.decision = 'revise'; result.reasons.push('small_conversation_regression'); return result;}
      } else if (metrics.confidence95[0] <= 0) result.reasons.push(`uncertain_performance:${name}`);
      else if (metrics.medianReductionPercent < catalog.evaluationPolicy.performance.interactionReductionPercent) result.reasons.push(`benefit_not_met:${name}`);
    }
    if (result.reasons.some(reason => reason.startsWith('uncertain'))) return result;
    if (result.reasons.length) {result.decision = 'discard'; return result;}
  } else if (input.experiment === 'publication-cost') {
    insist(input.conditions && Object.keys(input.conditions).sort().join(',') === 'cpu,read-bytes', 'conditions_required');
    result.performance = Object.fromEntries(Object.entries(input.conditions).map(([name, blocks]) => [name, compareBlocks(blocks, catalog.evaluationPolicy.performance)]));
    insist(finite(input.publicationDelay?.baselineMs) && finite(input.publicationDelay?.candidateMs) && input.publicationDelay.baselineMs >= 0 && input.publicationDelay.candidateMs >= 0, 'publication_delay_required');
    if (input.publicationDelay.candidateMs > input.publicationDelay.baselineMs + 250) {result.decision = 'revise'; result.reasons.push('publication_delay_regression'); return result;}
    if (!Object.values(result.performance).some(metrics => metrics.confidence95[0] > 0 && metrics.medianReductionPercent >= catalog.evaluationPolicy.performance.publicationSavingPercent)) {
      result.reasons.push('publication_benefit_not_demonstrated');
      if (Object.values(result.performance).every(metrics => metrics.confidence95[1] < catalog.evaluationPolicy.performance.publicationSavingPercent)) result.decision = 'discard';
      return result;
    }
  } else if (!experiment.mandatory) {
    insist(['met', 'not_met', 'unmeasured'].includes(input.benefit?.status), 'benefit_required');
    if (input.benefit.status === 'unmeasured') {result.reasons.push('benefit_unmeasured'); return result;}
    if (input.benefit.status === 'not_met') {result.decision = 'discard'; result.reasons.push('benefit_not_met'); return result;}
  }
  if (experiment.humanRequired) {
    if (input.human?.participated !== true) {result.reasons.push('human_validation_pending'); return result;}
    if (input.human.sourceManifestSha256 !== input.sourceManifestSha256 || !evidenceHashes.has(input.human.evidenceSha256)) {result.reasons.push('human_candidate_mismatch'); return result;}
    insist(Number.isInteger(input.human.utility) && input.human.utility >= 1 && input.human.utility <= 5, 'invalid_utility');
    if (input.human.utility < catalog.evaluationPolicy.humanUtilityMinimum) {result.decision = 'discard'; result.reasons.push('utility_not_met'); return result;}
  }
  result.decision = 'keep';
  result.reasons.push(experiment.mandatory ? 'required_acceptance_passed' : 'acceptance_and_benefit_passed');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [catalogPath, inputPath, evidenceRoot, outputPath] = process.argv.slice(2);
    insist(catalogPath && inputPath && evidenceRoot && outputPath, 'usage: node scripts/remote-evaluation.mjs CATALOG INPUT EVIDENCE_ROOT NEW_OUTPUT');
    const bytes = await readFile(catalogPath), input = JSON.parse(await readFile(inputPath, 'utf8'));
    await verifyEvidence(input.evidence, evidenceRoot);
    insist(input.evidence.some(entry => entry.sha256 === input.sourceManifestSha256), 'source_manifest_evidence_required');
    const result = evaluate(JSON.parse(bytes), input, digest(bytes));
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    process.stdout.write(JSON.stringify({experiment: result.experiment, decision: result.decision, reasons: result.reasons}) + '\n');
    process.exitCode = result.decision === 'keep' ? 0 : 1;
  } catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 2;}
}
