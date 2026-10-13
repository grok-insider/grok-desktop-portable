import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compareBlocks, compareResources, digest, evaluate, percentile, verifyEvidence} from './remote-evaluation.mjs';

const bytes = await readFile(new URL('../docs/experiments/remote-evaluation.json', import.meta.url));
const catalog = JSON.parse(bytes), hash = digest(bytes);
const source = 'a'.repeat(64), proof = 'b'.repeat(64);
const evidence = [{path:'source.json',sha256:source},{path:'proof.json',sha256:proof}];
const resources = () => ['cpu-idle-percent','resident-bytes','wakeups-per-second'].map(id => ({id,baseline:Array(8).fill(10),candidate:Array(8).fill(10)}));
const receipt = id => ({schema:1, catalogSha256:hash, sourceManifestSha256:source, evidence, experiment:id, round:1, checks:catalog.experiments.find(entry => entry.id === id).requiredChecks.map(id => ({id,status:'passed',sourceManifestSha256:source,evidenceSha256:[proof]}))});
const blocks = (before=100, after=60) => Array.from({length:8}, (_, id) => ({id,order:id%2 ? 'BA':'AB',warmups:50,valid:true,baseline:Array(200).fill(before),candidate:Array(200).fill(after)}));

test('nearest-rank p95 retains the tail rather than reporting the median', () => {
  assert.equal(percentile([...Array(94).fill(1), ...Array(6).fill(20)], .95), 20);
});
test('paired blocks expose an aggregate improvement caused by temporal scale', () => {
  const input=blocks();
  input.forEach((block,i) => {block.baseline.fill(i<6 ? 10:1000);block.candidate.fill(i<6 ? 12:500);});
  const result=compareBlocks(input,catalog.evaluationPolicy.performance);
  assert.equal(result.medianReductionPercent,-20);
  assert.equal(result.positiveBlocks,2);
});
test('a missing acceptance is inconclusive and a failed required fix remains open', () => {
  const input=receipt('attachment-limits');input.checks.pop();
  assert.equal(evaluate(catalog,input,hash).decision,'inconclusive');
  input.checks[0].status='failed';
  assert.equal(evaluate(catalog,input,hash).decision,'revise');
});
test('human validation cannot be borrowed from another version or a window without input', () => {
  const input={...receipt('drafts'),benefit:{status:'met'},human:{participated:false,utility:5,sourceManifestSha256:source,evidenceSha256:proof}};
  assert.equal(evaluate(catalog,input,hash).decision,'inconclusive');
  input.human.participated=true;input.human.utility=3;
  assert.equal(evaluate(catalog,input,hash).decision,'discard');
  input.human.utility=4;
  assert.equal(evaluate(catalog,input,hash).decision,'keep');
  input.human.sourceManifestSha256='c'.repeat(64);
  assert.equal(evaluate(catalog,input,hash).decision,'inconclusive');
});
test('unknown checks and changed criteria cannot fabricate a passed experiment', () => {
  const input=receipt('authentication');input.checks.push({id:'invented',status:'passed'});
  assert.throws(()=>evaluate(catalog,input,hash),/unknown_check/);
  assert.throws(()=>evaluate(catalog,receipt('authentication'),'b'.repeat(64)),/catalog_identity/);
});
test('performance requires both actual conditions and the absolute benefit', () => {
  const input={...receipt('event-delivery'),resources:resources(),conditions:{single:blocks(),'ten-with-slow-consumer':blocks()}};
  assert.equal(evaluate(catalog,input,hash).decision,'keep');
  input.conditions.single=blocks(10,6);
  assert.equal(evaluate(catalog,input,hash).decision,'discard');
  delete input.conditions.single;
  assert.throws(()=>evaluate(catalog,input,hash),/conditions_required/);
});
test('contaminated or cherry-picked blocks cannot be evaluated', () => {
  const input=blocks();input[0].valid=false;
  assert.throws(()=>compareBlocks(input,catalog.evaluationPolicy.performance),/invalid_block/);
  input[0].valid=true;input[0].id=input[1].id;
  assert.throws(()=>compareBlocks(input,catalog.evaluationPolicy.performance),/duplicate_block/);
  input[0].id=0;input[0].order='BA';
  assert.throws(()=>compareBlocks(input,catalog.evaluationPolicy.performance),/unbalanced_order/);
});
test('evidence validates bytes and confines symlinks to its own directory', async () => {
  const directory=await mkdtemp(join(tmpdir(),'remote-evaluator-'));
  const outside=await mkdtemp(join(tmpdir(),'remote-evaluator-outside-'));
  try {
    await writeFile(join(directory,'result'),'original');
    const evidence=[{path:'result',sha256:digest('original')}];
    await verifyEvidence(evidence,directory);
    await writeFile(join(directory,'result'),'changed');
    await assert.rejects(verifyEvidence(evidence,directory),/hash_mismatch/);
    await writeFile(join(outside,'result'),'original');
    await symlink(join(outside,'result'),join(directory,'escape'));
    await assert.rejects(verifyEvidence([{path:'escape',sha256:digest('original')}],directory),/outside_root/);
  } finally {await rm(directory,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('a claimed pass must reference evidence from the exact candidate', () => {
  const input=receipt('authentication');
  input.checks[0].sourceManifestSha256='c'.repeat(64);
  assert.throws(()=>evaluate(catalog,input,hash),/check_evidence/);
  input.checks[0].sourceManifestSha256=source;
  input.checks[0].evidenceSha256=['c'.repeat(64)];
  assert.throws(()=>evaluate(catalog,input,hash),/check_evidence/);
});
test('resource regressions cannot hide behind a latency improvement', () => {
  const data=resources();
  data[0].baseline.fill(0);data[0].candidate.fill(1);
  assert.equal(compareResources(data,catalog.evaluationPolicy.performance)[0].passed,true);
  data[1].candidate.fill(11.01);
  const input={...receipt('event-delivery'),resources:data,conditions:{single:blocks(),'ten-with-slow-consumer':blocks()}};
  assert.equal(evaluate(catalog,input,hash).decision,'revise');
  delete input.resources;
  assert.equal(evaluate(catalog,input,hash).decision,'inconclusive');
});
test('large transcript improvement cannot excuse a slower small conversation', () => {
  const input={...receipt('long-conversation'),resources:resources(),conditions:{100:blocks(10,11),1000:blocks(),10000:blocks()}};
  assert.equal(evaluate(catalog,input,hash).decision,'keep');
  input.conditions[100]=blocks(10,13);
  assert.equal(evaluate(catalog,input,hash).decision,'revise');
});
test('publication accepts measured CPU savings but enforces propagation delay', () => {
  const input={...receipt('publication-cost'),resources:resources(),conditions:{cpu:blocks(100,60),'read-bytes':blocks(100,100)},publicationDelay:{baselineMs:3000,candidateMs:3250}};
  assert.equal(evaluate(catalog,input,hash).decision,'keep');
  input.publicationDelay.candidateMs=3251;
  assert.equal(evaluate(catalog,input,hash).decision,'revise');
  input.publicationDelay.candidateMs=3000;input.conditions.cpu=blocks(100,75);
  assert.equal(evaluate(catalog,input,hash).decision,'discard');
});
