/**
 * P0 eval corpus: seeded facts + queries with expected answers.
 *
 * Fully deterministic and frozen: no LLM is involved in producing gold answers,
 * so the recall/state/injection numbers are reproducible and auditable
 * (Veracium's "ground truth first" principle: facts are planted before any
 * question exists, so gold answers are valid by construction).
 */
import type { MemoryInput } from '../../src/domain/types.js'

export interface EvalFact {
  input: MemoryInput
  /** Queries that should surface this memory (one per case, ordered). */
  queries: string[]
}

export function factCorpus(): EvalFact[] {
  const facts: Array<{ topic: string; summary: string; keywords: string[]; queries: string[] }> = [
    { topic: '构建工具是 pnpm', summary: '项目用 pnpm 管理依赖，不用 npm 或 yarn。', keywords: ['pnpm', '依赖'], queries: ['用 pnpm 装依赖', '怎么安装包 pnpm'] },
    { topic: '测试框架是 vitest', summary: '单元测试用 vitest 跑。', keywords: ['vitest', '测试'], queries: ['跑单元测试 vitest', '测试命令'] },
    { topic: 'CI 用 GitHub Actions', summary: 'CI 流水线用 GitHub Actions，改动合并前必须通过。', keywords: ['github actions', 'ci'], queries: ['CI 怎么配的', 'GitHub Actions 什么时候跑'] },
    { topic: '部署目标是 us-east-1', summary: '部署到 AWS us-east-1，不部署到其他区。', keywords: ['us-east-1', '部署'], queries: ['部署到哪个区', 'aws 区域'] },
    { topic: '用 uv 管理 Python 环境', summary: '用户偏好用 uv 管理 Python 环境和依赖，而不是 pip/conda。', keywords: ['uv', 'python'], queries: ['uv 建环境', 'python 环境怎么管'] },
    { topic: '提交信息用中文', summary: '这个项目所有 commit message 都用中文写。', keywords: ['commit', '中文'], queries: ['commit message 用什么语言', '提交信息规范'] },
    { topic: '端口固定 8080', summary: '本地开发服务器固定监听 8080 端口。', keywords: ['8080', '端口'], queries: ['开发服务器端口', '监听哪个端口'] },
    { topic: '禁止使用 rm -rf', summary: '沙箱里禁止执行 rm -rf。', keywords: ['rm -rf', '沙箱'], queries: ['能不能 rm -rf', '清理目录命令'] },
  ]
  return facts.map((f) => ({
    input: {
      type: 'project_fact' as const,
      scope: 'workspace' as const,
      workspace: '/eval',
      topic: f.topic,
      summary: f.summary,
      keywords: f.keywords,
      evidence: [],
      confidence: 1,
      source: 'manual' as const,
      writer: 'human',
    },
    queries: f.queries,
  }))
}

/** Queries that must NOT surface any memory (used for precision). */
export function noiseQueries(): string[] {
  return ['讲讲量子物理', '推荐一部电影', '天气怎么样', '红烧肉怎么做']
}
