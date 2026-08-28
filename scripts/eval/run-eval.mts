/**
 * P0 effect eval: run the deterministic benchmark and write a scorecard.
 *
 *   node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/eval/run-eval.mts
 *
 * Groups (all deterministic, no LLM, reproducible):
 *   T1 fact recall   — seeded facts vs queries: recall@k, precision@k, MRR, hit@1
 *   T3 state tracking— a fact is superseded by a replacement; does recall return the current value
 *   T4 injection      — the real injection path (recallByKeywords): injected tokens + does the right memory get in
 *
 * The LLM-backed 开/关 A/B (task success) needs the harness model and a real agent
 * loop; it is documented as a follow-up. These three groups are the reproducible core.
 */
import { writeFileSync } from 'node:fs'
import { openMemoryStore } from '../../src/domain/store.js'
import { createSensitiveDetector } from '../../src/domain/sensitive.js'
import { createMemoryService, DEFAULT_GATE } from '../../src/domain/service.js'
import { recallIndex } from '../../src/domain/recall.js'
import { factCorpus, noiseQueries } from './corpus.js'

function makeEnv(): { store: ReturnType<typeof openMemoryStore>; service: ReturnType<typeof createMemoryService> } {
  const store = openMemoryStore(':memory:')
  const service = createMemoryService(store, createSensitiveDetector(), { ...DEFAULT_GATE })
  return { store, service }
}

function rankOf(ids: string[], target: string): number {
  const i = ids.indexOf(target)
  return i === -1 ? Number.POSITIVE_INFINITY : i + 1
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {}
  const corpus = factCorpus()

  // ---- T1 fact recall ----
  {
    const { store, service } = makeEnv()
    for (const fact of corpus) service.add(fact.input, 'human')
    const ids = corpus.map((f) => service.search(f.input.topic, 50)[0]?.id).filter(Boolean) as string[]
    const queries = corpus.map((f) => f.queries).flat()
    const expected = corpus.flatMap((f) => f.queries.map(() => f.input.topic))
    let hits1 = 0
    let mrrSum = 0
    const retrievedPerQuery: number[] = []
    for (const q of queries) {
      const rows = service.search(q, 5)
      const topics = rows.map((r) => r.topic)
      const want = expected[queries.indexOf(q)]!
      const rank = topics.indexOf(want)
      if (rank === 0) hits1 += 1
      if (rank !== -1) mrrSum += 1 / (rank + 1)
      retrievedPerQuery.push(rank === -1 ? 0 : 1)
    }
    const n = queries.length
    const hit1 = hits1 / n
    const mrr = mrrSum / n
    const recallAt5 = retrievedPerQuery.reduce((a, b) => a + b, 0) / n
    // precision: for noise queries, no memory should be retrieved.
    let noiseRetrieved = 0
    for (const q of noiseQueries()) {
      if (service.search(q, 5).length > 0) noiseRetrieved += 1
    }
    const precisionNoise = 1 - noiseRetrieved / noiseQueries().length
    results.T1_fact_recall = { queries: n, hit_at_1: +hit1.toFixed(3), recall_at_5: +recallAt5.toFixed(3), mrr: +mrr.toFixed(3), precision_on_noise: +precisionNoise.toFixed(3), ids_seeded: ids.length }
    store.close()
  }

  // ---- T3 state tracking ----
  {
    const { store, service } = makeEnv()
    const old = corpus[3]! // deploy target us-east-1
    const committed = service.add(old.input, 'human')
    const oldId = committed.memory!.id
    // supersede: propose a replacement, approve it
    const replacement: typeof old.input = {
      ...old.input,
      summary: '部署目标改为 ap-southeast-1。',
      keywords: ['ap-southeast-1', '部署'],
    }
    const proposed = service.proposeReplacement(replacement, oldId, 'model')
    const approved = service.approve(proposed.approvalId!, 'approve')
    const q = '部署到哪个区'
    const rows = service.search(q, 5)
    const currentValueVisible = rows.some((r) => r.summary.includes('ap-southeast-1'))
    const staleValueTop = rows[0]?.summary.includes('us-east-1') === true
    results.T3_state_tracking = {
      replacement_approved: approved.ok,
      current_value_visible: currentValueVisible,
      stale_value_still_ranked: staleValueTop,
      current_value_rank: rows.map((r) => r.summary).indexOf(rows.find((r) => r.summary.includes('ap-southeast-1'))?.summary ?? '') + 1,
    }
    store.close()
  }

  // ---- T4 injection efficiency (frozen per-session index) ----
  {
    const { store, service } = makeEnv()
    for (const fact of corpus) service.add(fact.input, 'human')
    const index = recallIndex(service, { maxBytes: 4096, workspace: '/eval' })
    const tokens = Math.ceil(Buffer.byteLength(index.text, 'utf8') / 3)
    const covered = corpus.filter((f) => index.text.includes(f.input.topic)).length
    results.T4_injection = {
      index_lines: index.injectedCount,
      avg_injected_tokens: tokens,
      right_memory_injected_rate: +(covered / corpus.length).toFixed(3),
      index_bytes: Buffer.byteLength(index.text, 'utf8'),
    }
    store.close()
  }

  // ---- Scorecard ----
  const generatedAt = new Date().toISOString()
  const scorecard = { generated_at: generatedAt, plugin: 'dsh-mnemos', groups: results }
  writeFileSync(new URL('./scorecard.json', import.meta.url).pathname, JSON.stringify(scorecard, null, 2))

  const md = [
    '# dsh-mnemos 效果成绩单',
    '',
    `生成时间：${generatedAt}（确定性评测，无 LLM，可复跑 ` + '`node --import tsx/esm scripts/eval/run-eval.mts`' + `）`,
    '',
    '## T1 事实召回',
    `- 问题数：${results.T1_fact_recall.queries}`,
    `- hit@1：**${results.T1_fact_recall.hit_at_1}**`,
    `- recall@5：**${results.T1_fact_recall.recall_at_5}**`,
    `- MRR：**${results.T1_fact_recall.mrr}**`,
    `- 噪音查询精度：**${results.T1_fact_recall.precision_on_noise}**`,
    '',
    '## T3 状态追踪（事实被修订后答当前值）',
    `- 替换批准：${results.T3_state_tracking.replacement_approved}`,
    `- 当前值可见：${results.T3_state_tracking.current_value_visible}`,
    `- 旧值仍在首位：${results.T3_state_tracking.stale_value_still_ranked}`,
    '',
    '## T4 注入效率（每会话冻结索引）',
    `- 索引行数：${results.T4_injection.index_lines}`,
    `- 平均注入 token：**${results.T4_injection.avg_injected_tokens}**`,
    `- 索引覆盖正确记忆：**${results.T4_injection.right_memory_injected_rate}**`,
    '',
    '## 说明',
    '- 这些数字只测"召回/注入/状态"，不测"任务成功率"；开/关记忆的任务 A/B 需要真实模型与代理循环，是后续步骤。',
    '- 复现方式：在上面命令在当前 DSH 仓库目录运行。',
    '',
  ].join('\n')
  writeFileSync(new URL('./scorecard.md', import.meta.url).pathname, md)

  console.log(md)
  console.log('wrote scripts/eval/scorecard.{json,md}')
}

void main()
