# dsh-mnemos 公开数据集基准（LongMemEval-S / LoCoMo-10）

本基准把业界公开的长期记忆评测数据集灌进 dsh-mnemos 的真实检索管线，产出与
deja-vu 官方公布数字同口径的结果。方法与 deja-vu 的
`scripts/longmemeval` / `scripts/locomo` 对齐：每题/每样本把 haystack 会话写入
临时存储（每会话一条记忆，summary 载全文，FTS5 索引覆盖会话全部内容），用问题
**原文**检索（不改写、无 LLM、无向量），量答案会话的排名。

## 数据来源（公开）

| 数据集 | 来源 | 规模 |
|---|---|---|
| LongMemEval-S (cleaned) | `xiaowu0162/longmemeval-cleaned` @ HuggingFace | 500 题，去 abstention 后 470 题 |
| LoCoMo-10 | `KimmoZZZ/locomo` @ HuggingFace | 10 个长对话样本，1982 道 QA |

## 检索路径（产品现状）

产品检索已实现**多级词法阶梯**（`MemoryStore.searchMemories`）：

1. **FTS5 全词 AND**：查询所有词都必须命中同一条记忆（最精确）；
2. **FTS5 任词 OR**：仅当 AND 零命中时，改任一查询词命中即可（bm25 排序）；
3. **包含扫描**：仅当前两者都零命中时，退回子串包含。

在此之上，记忆服务再与"二元组相似度"排名做倒数排名融合（RRF），得到
`memory_search` 工具 / 命令 / ABI 实际使用的排序。

基准脚本同时保留两个模式供对照：`current` = 上面的产品路径；
`ladder` = 纯 FTS5 阶梯（不含二元组融合）。

## 结果（产品路径）

### LongMemEval-S（470 题，session-level）

| 指标 | hit@1 | hit@5 | hit@10 | hit@20 | MRR | evidence-recall@1 |
|---|---|---|---|---|---|---|
| **dsh-mnemos 产品路径（阶梯）** | **87.2%** | 96.6% | 98.5% | 99.4% | **0.914** | **56.3%** |
| deja-vu 官方公布 | 85.3% | 95.5% | 96.4% | 97.0% | 0.896 | 55.0% |

### LoCoMo-10（1982 QA）

| 路径 | R@1 | MRR |
|---|---|---|
| **dsh-mnemos 产品路径（阶梯）** | **60.9%** | 0.725 |
| deja-vu 官方公布（本地已复现） | 69.8% | 0.768 |

### 改进前基线（单级 AND，供对照）

阶梯上线前，产品路径只做全词 AND + 二元组融合：
LongMemEval-S hit@1 约 10%（store 层纯 AND 约 9%）、LoCoMo R@1 约 7%。
全部差距来自查询构造（AND 强制全词命中），不是底层引擎。

## 诚实结论

1. **LongMemEval-S 上 dsh-mnemos 产品路径全面超过 deja-vu 官方数字**：
   hit@1 87.2% vs 85.3%、MRR 0.914 vs 0.896、evidence-recall@1 56.3% vs 55.0%。
2. **LoCoMo-10 上仍低于 deja**（60.9% vs 69.8%）：LoCoMo 对话更长、问题更依赖
   跨会话与推理，deja 的词形还原（stem）层和更强的排序变体在这里占优。这是
   下一步可追的方向（加词形还原 / 更细的排序加权），但已属优化而非缺陷。
3. deja-vu 官方数字已在本机**真实复现**（go1.25.5，跑 deja-vu 官方 `scripts/longmemeval` /
   `scripts/locomo`，同一份 cleaned 数据、同指标、同问题原文）：LongMemEval-S
   hit@1=85.3%、MRR=0.896，与官方公布一致；LoCoMo R@1=69.8%（官方公布 69.6%，
   差异为数据集处理细节）。我们的对比全部建立在可复现的真实跑分上。

## 复现

```bash
# LongMemEval-S（需先下载 longmemeval_s_cleaned.json 到任意路径）
BENCH_DATA=/path/to/longmemeval_s_cleaned.json BENCH_SKIP_ABS=1 \
  BENCH_LIMIT=470 BENCH_OUT=scripts/bench/longmemeval-scorecard.json \
  pnpm run bench:longmemeval

# LoCoMo-10
BENCH_DATA=/path/to/locomo10.json BENCH_OUT=scripts/bench/locomo-scorecard.json \
  pnpm run bench:locomo
```

## 复现 deja-vu 官方数字（本地，go1.25+）

```bash
git clone https://github.com/vshulcz/deja-vu
cd deja-vu
# 安装 go1.25（官方 tarball：dl.google.com/go/go1.25.x.linux-amd64.tar.gz）
go run ./scripts/longmemeval -data /path/to/longmemeval_s_cleaned.json -skip-abs
go run ./scripts/locomo -data /path/to/locomo10.json
```

预期输出（本机实测，与官方公布一致）：

```
LongMemEval-S TOTAL 470  85.3%  95.5%  96.4%  97.0%  MRR 0.896
LoCoMo      TOTAL 1982  R@1 69.8%  R@5 85.8%  MRR 0.768
```

评分卡 JSON：`scripts/bench/longmemeval-scorecard.json`、
`scripts/bench/locomo-scorecard.json`。
