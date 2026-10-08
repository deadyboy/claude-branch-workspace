# CBW 可视化实验夹具（scripts/experiments）

本目录是 `docs/13_VISUAL_WORKSPACE_EXPERIMENT_PLAN.md` 第 4 节（实验环境与数据）
的**固定夹具与数据生成器**。对应任务 4.1、4.2。

**边界：本目录只新增实验脚本与产物，不修改任何产品代码**（`apps/**`、`packages/**`
的既有源文件均未改动）。生成器不调用真实模型，不消耗额度。

---

## 1 目录与产物

一次实验的所有产物在**同一个 run 目录**下（4.1 要求）：

```
F:\CodexTemp\cbw-ui-x\<run-id>\
  manifest.json        # make-fixtures 输出的判定真值（E1/E4a）
  P1-clean-git\        # 干净 Git 项目
  P2-plain-folder\     # 普通文件夹（无 Git）
  P3-boundary\         # 边界项目
  conv-d1-<ts>\        # make-conversations D1 产物
    d1.db              #   域 SQLite（真实 DomainService 写入）
    truth.json         #   关系真值（E2）
  conv-d2-<ts>\ ...
  conv-d3-<ts>\ ...
  e2e.db / live.db     # 由 E2E / 真实 UI 实验进程创建（见 §5）
  screenshots\ traces\ # 仅实验执行时产生
```

`run-id` = 时间戳 + 随机后缀（生成器自动产生；也可 `--out` 指定）。

---

## 2 生成夹具（P1 / P2 / P3）

```bash
node scripts/experiments/make-fixtures.mjs [--out <dir>]
```

默认 `--out` = `F:\CodexTemp\cbw-ui-x\<run-id>`。若目标目录已存在且非空则拒绝覆盖。

### 样本用途

| 样本 | 内容 | 用途（方案条目） |
|---|---|---|
| **P1** `P1-clean-git/` | `src/greeting.ts`（含 `formatGreeting`，可加"空输入处理"）、`README.md`、`test/greeting.test.mjs`；**固定初始提交** | E1 项目入口、E3 执行/恢复、E4a Diff 审阅 |
| **P2** `P2-plain-folder/` | `notes/topic-a.md`、`notes/topic-b.md`、`notes/summary.md`；**无 Git** | E1 非代码项目/共享模式、E8 项目图 |
| **P3** `P3-boundary/` | 见下 | E1 路径与能力提示 |

### P3 边界内容

| 目录/路径 | 场景 | 期望 |
|---|---|---|
| `folder with spaces/` | 含 ASCII 空格路径 | 可打开 |
| `中文目录/` | 含中文路径 | 可打开/正常渲染 |
| `dirty-repo/` | Git 仓库**有未提交改动**（`tracked.txt` 被改 + `untracked.txt` 未跟踪） | 共享模式可用；创建 worktree 被拒并说明原因 |
| `no-first-commit/` | `git init` 后**无首个提交** | worktree 不可用并说明原因 |
| `does-not-exist-<rand>` | **不可访问路径** | 服务端返回明确执行端路径错误 |

第 5 项不在磁盘创建——它是一段**保证不存在**的路径，`manifest.json` 的
`P3.paths.inaccessible` 给出原样字符串，实验时直接引用。

### P1 提交可复现

`manifest.json` 的 `P1.initialCommit` 是可复现的。生成器对每次 git 调用固定了
`user.name/user.email/GIT_AUTHOR_DATE/GIT_COMMITTER_DATE`，并强制
`core.autocrlf=false`、`commit.gpgsign=false`、`GIT_CONFIG_NOSYSTEM=1`，使
commit hash 与宿主机全局 git 配置无关。同一批文件内容 → 同一 hash
（实测两次运行均为 `864d5c06876e79b0cee2bee9374ba2c4f3218414`）。

### `manifest.json` 格式（E1/E4a 判定真值）

```jsonc
{
  "schema": "cbw.experiments.fixtures/v1",
  "runId": "...", "createdAt": "...", "out": "F:/CodexTemp/cbw-ui-x/<run-id>",
  "samples": {
    "P1": { "root": "...", "git": true, "branch": "main",
            "initialCommit": "<hash>", "clean": true,
            "files": ["README.md","src/greeting.ts","test/greeting.test.mjs"] },
    "P2": { "root": "...", "git": false, "hasGitDir": false,
            "files": ["notes/summary.md", ...] },
    "P3": { "root": "...",
            "paths": { "spacedDir":"...", "cjkDir":"...",
                       "dirtyRepo":"...", "noFirstCommitRepo":"...",
                       "inaccessible":"..." },
            "expectations": { ... }, "files": [...] }
  }
}
```

E4a 用 `P1.initialCommit` 作为 diff 基准；E1 断言 UI 打开的项目路径与
`P1.root`/`P2.root` 一致，并按 `P3.expectations` 核对能力提示。

---

## 3 生成对话（D1 / D2 / D3）

```bash
node scripts/experiments/make-conversations.mjs \
  --dataset d1|d2|d3 [--seed N] [--db <path>] [--out <dir>]
```

- **必须**先构建 domain：`pnpm --filter @cbw/domain build`（生成器读取
  `packages/domain/dist/index.js`；缺失时提示并退出）。
- 数据通过 `@cbw/domain` 的 `DomainService` 写入（`createProject` /
  `createRootConversation` / `createBranchFromNode` / `appendCompletedTurn`），
  **不手写 SQL**。
- 默认 `--seed 20261006`、`--dataset d1`。

### 数据集

| 数据集 | 结构 | 规模 |
|---|---|---|
| **D1** | Main 6 轮；Main 第 2 轮**同时**派生 A、B（**同名** `research`）；A 第 1 轮派生 A1 | 4 分支 / 11 轮 |
| **D2** | 随机分叉树，含强制重名 | **20 分支 / 100 轮** |
| **D3** | 随机分叉树，含强制重名 | **100 分支 / 1000 轮** |

（"第 N 轮"指人类计数；`localTurnIndex` 从 0 起，故第 2 轮 = index 1。）

### 复现性保证

**结构**由 `(dataset, seed)` 完全决定（`mulberry32` 固定 PRNG）：哪些分支从哪个
父分支的哪个节点分叉、父子关系、每分支轮数，同一 `(dataset, seed)` 每次一致
（实测同 seed 结构指纹相同）。

**ID** 由 domain 层的随机 UUID 产生，故每次运行不同。`truth.json` 记录的是
**实际写入库中的 ID**——生成器在写完后**回读数据库**构建真值，因此真值不可能
与库内容不一致。

### `truth.json` 格式（E2 逐项比对依据）

```jsonc
{
  "schema": "cbw.experiments.conversations/v1",
  "dataset": "d1", "seed": 20261006, "db": ".../d1.db",
  "projectId": "...", "rootBranchId": "...",
  "stats": { "branchCount": 4, "uniqueTurnCount": 11,
             "duplicateNamesForced": 2, "distinctDisplayNames": 3,
             "elapsedMs": 60 },
  "branches": [   // 每个分支一行
    { "id":"...", "displayName":"Main", "parentBranchId":null,
      "forkFromNodeId":null, "workspaceMode":"shared",
      "originStrategy":"imported", "status":"active", "nodeCount":6 }
  ],
  "nodes": [      // 每个轮次一行（node = turn）
    { "id":"...", "branchId":"...", "parentNodeId":null,
      "localTurnIndex":0, "status":"completed" }
  ],
  "forkEdges": [  // 分叉边：branch -> 其 forkFromNodeId（属 parentBranchId）
    { "branchId":"...", "parentBranchId":"...", "forkFromNodeId":"..." }
  ],
  "d1": { ... }   // 仅 D1：人类可读的显式期望与不变量
}
```

E2 比对方法：
- **fork 边**：对每条 `forkEdges`，断言 `nodes[forkFromNodeId].branchId ===
  parentBranchId`（即分叉点确属父分支）。
- **turnSeq 边**：对每个 node，`parentNodeId === null` 当且仅当
  `localTurnIndex === 0`；否则父节点同分支且 `localTurnIndex - 1`。
- **同名分支**：`branches` 中 `displayName` 相同的行 **`id` 必须不同**——
  证明身份由 ID 而非名字决定（宪法 §2.4/§2.5）。

### D1 的显式期望（`truth.d1`）

```jsonc
{
  "forkAtMainTurn2": "<Main turn2 的 nodeId>",
  "branches": {
    "A":  { "displayName":"research", "parentBranchId":"<Main>",
            "forkFromNodeId":"<Main turn2>", "turnCount":2 },
    "B":  { "displayName":"research", "parentBranchId":"<Main>",
            "forkFromNodeId":"<Main turn2>", "turnCount":2 },
    "A1": { "displayName":"deep-dive", "parentBranchId":"<A>",
            "forkFromNodeId":"<A turn1>", "turnCount":1 }
  },
  "duplicateName": ["A","B"],
  "invariants": [
    "A 与 B 的 forkFromNodeId 均等于 Main 第 2 轮节点",
    "A1 的 forkFromNodeId 等于 A 第 1 轮节点",
    "A 的有效对话恰好继承 Main 第 1-2 轮，不含第 3-6 轮"
  ]
}
```

第 3 条不变量可用 `DomainService.getEffectiveConversation(A.branchId)` 独立复核
（实测：A 继承 4 条 = Main turn1/2 各 user+assistant，无 turn3-6 泄漏）。

---

## 4 端口与路径约定（方案 4.1）

| 项 | 约定 |
|---|---|
| **现有实例** | `127.0.0.1:15723` 是**正在运行的实例入口**。实验**不得占用或停止它**。 |
| **候选端口** | `15823`。运行前检查占用；被占则另选空闲端口并同步更新测试地址。 |
| **样本/输出根** | `F:\CodexTemp\cbw-ui-x\<run-id>` |
| **隔离** | 每次实验使用独立工作树、独立端口、独立数据库 |
| **凭据** | 真实凭据沿用现有认证；**不进入截图、数据库导出或公开报告** |

E2E 环境变量（方案 §8，从实际 `package.json` 所在目录执行）：

```powershell
$env:CBW_E2E_PORT = '15823'
$env:CBW_E2E_DB   = 'F:\CodexTemp\cbw-ui-x\<run-id>\e2e.db'
pnpm test:e2e
```

真实 UI 验收另用独立进程与 `live.db`，显式清除 `CBW_FAKE_RUNTIME`/`CBW_FAKE_SCRIPT`，
显式设置 `CBW_PORT`/`CBW_DB` 后再 `pnpm start`。

---

## 5 快速上手

```bash
# 0) 一次性：构建 domain
pnpm --filter @cbw/domain build

# 1) 夹具
node scripts/experiments/make-fixtures.mjs
#    -> 记录 manifest.json 的 out / P1.initialCommit

# 2) 对话（套用同一 run 目录）
node scripts/experiments/make-conversations.mjs --dataset d1 \
  --out "F:/CodexTemp/cbw-ui-x/<run-id>/conv-d1"
node scripts/experiments/make-conversations.mjs --dataset d2 --out ".../conv-d2"
node scripts/experiments/make-conversations.mjs --dataset d3 --out ".../conv-d3"

# 3) E2E（独立端口 + DB）
$env:CBW_E2E_PORT='15823'; $env:CBW_E2E_DB='F:\CodexTemp\cbw-ui-x\<run-id>\e2e.db'
pnpm test:e2e
```

---

## 6 实测结果（本目录生成器自检）

| 命令 | 结果 |
|---|---|
| `make-fixtures.mjs --out ...` | P1/P2/P3 创建成功；P1 commit 两次运行均 `864d5c06876e79b0cee2bee9374ba2c4f3218414`（可复现）；P1 测试 `node --test` 2/2 通过 |
| `make-conversations.mjs --dataset d1` | 4 分支 / 11 轮，60 ms；A/B 同分叉于 Main turn2，A1 分叉于 A turn1（独立核对通过） |
| `make-conversations.mjs --dataset d2` | 20 分支 / 100 轮，~0.4 s；19 条 fork 边，0 异常 |
| `make-conversations.mjs --dataset d3` | 100 分支 / 1000 轮，~2.7 s；99 条 fork 边，0 异常 |
| 同 seed 结构复现 | 相同（结构指纹一致） |
