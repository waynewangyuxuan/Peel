下面这版按“可以直接进入产品与设计评审”的标准写。重点不是罗列 Feature，而是把每一个核心选择背后的理由、边界和未来演进路径写清楚。

# Spatial Thread Workspace（工作名）— V0 产品需求文档

**文档状态：** Draft for alignment
**版本：** V0.1
**日期：** 2026-08-24
**产品名称：** 待定
**Design Anchor：** 已确认的 Focus ↔ Overview 交互原型

---

## 1. Executive Summary

Spatial Thread Workspace 是一个建立在 Codex Thread 与原生 Fork 能力之上的空间化思考工具。

它解决的不是“怎样再做一个更好看的 Codex Client”，而是一个线性 Chat UI 很难处理的问题：

> 当一个问题开始出现多个值得并行展开的方向时，如何在不破坏正常 Chat 体验的前提下，让这些方向之间的来源、关系、状态和结果保持可见？

用户通常先在 Codex 中开始一段普通对话。大多数对话并不需要进入本产品。只有当用户意识到：

* 这个问题有两条或更多值得分别探索的路径；
* 当前讨论继续下去会污染原来的主线；
* 同一个项目中已经存在多个相关 Chat 或 Worktree；
* 用户需要在不同方向之间来回切换，并理解它们如何形成；

用户才把这段 Chat 注册进一个 Space，并从某个准确的 Turn 创建 Fork。

产品的核心交互是：

```text
Search existing Codex chat
→ Bring it into a Space
→ Branch from here
→ Continue in a real Codex child thread
→ Zoom out to understand the fork structure
→ Re-enter any branch and continue working
```

V0 不试图取代用户在 Codex 中的全部日常交互，也不试图成为 Agent orchestration、Git management 或项目管理工具。

它只把一件事做到足够好：

> **当 Codex Chat 变得非线性时，让它以空间结构继续存在。**

---

## 2. Why：为什么需要这个产品

### 2.1 线性 Chat 无法表达真实的思考结构

传统 Chat UI 默认假设：

```text
Question
→ Answer
→ Follow-up
→ Answer
→ Follow-up
```

但复杂的产品和工程问题往往是：

```text
Original question
├── Product direction
├── Frontend interaction
├── Backend architecture
└── Alternative implementation
```

在线性 Chat 里，用户只能选择：

1. 在同一条对话中不断切换主题，造成 Context 混杂；
2. 新开 Chat，但失去它和原始问题之间的关系；
3. 手动复制上下文，在多个 Chat 之间来回寻找；
4. 依赖自己的记忆，记住每条 Chat 为什么存在。

Codex 已经允许用户从某个位置创建 Branch，但 Branch 创建以后仍主要表现为另一个 Chat。原本清晰的父子关系，会再次退化成一个扁平的历史列表。

问题因此不是“用户不能 Fork”，而是：

> **Fork 发生以后，产品没有持续表达 Fork。**

---

### 2.2 Codex Fork 不只是思路分叉，也可能成为真实实验

普通 LLM Chat 的 Fork 通常只是两条不同的讨论路径。

Codex Thread 自带代码阅读、文件修改、命令执行和 Git 能力，因此一个 Fork 还可能表示：

```text
Hypothesis A
→ 在当前代码中尝试方案 A
→ 产生 Diff

Hypothesis B
→ 在独立 Worktree 中尝试方案 B
→ 产生另一组 Diff
```

Codex 官方已经将 Project 用于组织共享上下文和多条 Chat，并支持让同一项目中的 Chat 在 Local 或隔离 Worktree 中执行；Worktree 的目的正是让多个 Chat 在同一项目中并行工作而不互相干扰。([OpenAI Developers][1])

这让 Fork Tree 的价值高于普通对话图：

> 用户看到的不只是“我聊过哪些方向”，而是“一个项目中的不同探索和实验是如何从同一个问题生长出来的”。

但 V0 不会因此建立一套新的 Experiment Management System。Worktree 和 Diff 只是 Thread 的附加信息，而不是新的一级对象。

---

### 2.3 为什么不是普通 Graph Tool

很多 Branching Chat 原型把每条 Message 做成 Canvas Node，让用户自由连线和拖动。

这种方式在 Demo 中直观，但在真实使用中会遇到两个问题：

第一，长对话、代码块、流式输出、Composer、文字选择和滚动行为很难在一个经过缩放和变换的 Canvas Node 中保持高质量。

第二，用户开始管理 Node、Edge、Port 和 Layout，而不再专注于思考和对话。

本产品的核心判断是：

> **Graph 应该存在于 Chat 下面，而不是让 Chat 被塞进 Graph 里面。**

因此：

* Focus 状态提供接近 Codex / ChatGPT 的完整 Chat 体验；
* Overview 状态才展示完整空间结构；
* Thread 是空间中的一级对象；
* Message 只作为可 Fork 的准确 Anchor，不成为主图上的独立 Node；
* 用户不能任意创建没有语义的 Edge。

---

### 2.4 为什么现在可以做

Codex App Server 是 Codex 用于支持 Rich Client 的接口，提供认证、历史读取、Thread lifecycle、审批和流式 Agent Event。它原生支持：

* `thread/read`：不 Resume Thread，直接读取历史；
* `thread/list`：列出与搜索 Thread；
* `thread/fork`：复制历史并创建新的 Thread ID；
* `lastTurnId`：从准确的 Turn Fork；
* `thread/name/set`：更新用户可见的 Thread 名称；
* `thread/status/changed`：获取运行状态；
* `turn/start`：在指定 Thread 和工作目录中继续执行。([OpenAI Developers][2])

团队已经实测：即使 Parent Thread 正在原生 Codex Client 中使用，我们仍然可以从它创建新的 Fork。

这使产品不需要复制一套 Conversation Backend。我们只需要为真实 Codex Thread 增加：

```text
Space membership
Fork topology
Spatial position
View state
```

---

## 3. Product Thesis

产品的核心表达是：

> **Focus 让用户继续工作；Overview 让用户看清这些工作是怎样分叉出来的。**

完整产品关系为：

```text
Codex Project
└── Space
    ├── Thread
    ├── Thread
    ├── Thread
    └── Fork relationships
```

其中：

```text
Project
= 长期共享的代码、文件、Instructions 和上下文边界

Space
= 围绕一个问题形成的、由用户主动策展的探索空间

Thread
= 一条真实存在并可继续执行的 Codex Chat

Fork Edge
= 一条 Thread 从另一条 Thread 的哪个 Turn 分叉出来

Worktree
= 某条 Thread 当前执行代码的环境，是 metadata，不是图的结构

Subagent
= 某条 Thread 内部发生的后台活动，默认不进入主 Fork Tree
```

---

## 4. Goals

V0 必须实现以下价值：

### 4.1 保留 Fork 的来源与结构

用户能清楚地知道：

* 当前 Chat 从哪里 Fork；
* 它的 Parent、Sibling 和 Child 是谁；
* 整个问题目前发展成了哪些方向；
* 点击 `Branched from` 可以回到 Parent 的准确 Fork Turn。

### 4.2 保持高质量 Chat 体验

用户进入任何 Thread 后，都能正常：

* 阅读完整 Transcript；
* 使用 Markdown 和代码块；
* 发送 Prompt；
* 接收流式输出；
* 处理 Approval；
* 查看 Codex Activity；
* 使用语音输入；
* 继续真实的 Codex 执行。

Spatial UI 不能让 Chat 退化成“Canvas 中的聊天框”。

### 4.3 让 Overview 提供比 Focus Tree 更高的信息密度

Focus Tree 负责回答：

> 我现在在哪里？附近有哪些路径？

Overview 负责回答：

> 整个探索是什么形状？每条路径正在做什么、最近得到了什么结果？

### 4.4 让 Space 保持稳定的空间记忆

用户在 Overview 中形成的空间认知必须能够保留。

新增一个 Fork 不能导致已有节点整体重新排列。用户放置过的节点不能在重新打开 Space 后改变位置。

### 4.5 保持与 Codex 原生能力的一致性

Thread 名称、Transcript、状态和执行环境仍然由 Codex 管理。

我们不创建另一套 Shadow Conversation，也不创建一套只在本产品中存在的 Thread Name。

---

## 5. Non-goals

V0 明确不做：

* 取代用户的全部 Codex 或 ChatGPT 日常使用；
* 自动把一个 Project 的所有 Chat 都变成图；
* 通用 Graph Editor；
* 任意创建、连接或修改 Edge；
* Agent orchestration control room；
* 把 Subagent 全部画进主 Fork Tree；
* Git branch graph；
* Worktree management dashboard；
* Test status dashboard；
* Task 或 Ticket 管理；
* 自动 Semantic Merge；
* Compare → Select → Integrate；
* Convergence Checkpoint；
* GitHub Issue / PR workflow；
* 多人实时协作；
* ChatGPT 私人历史的全量搜索；
* 自动判断 Decision、Open Question 或 Conclusion；
* 为语音输入增加技术词提示、关键词 Prompt 或额外 Vocabulary 配置。

这些能力未来可以从真实使用中逐步生长，但不能稀释 V0 的核心体验。

---

## 6. Target User

### Primary User

已经使用 Codex 处理真实项目，并经常出现以下行为的个人开发者、产品工程师或 AI-native builder：

* 同一问题会打开多条 Chat；
* 会从历史 Turn 创建 Branch；
* 会在一个 Repo 中同时推进多个方向；
* 可能为不同方向使用不同 Worktree；
* 需要频繁回到旧 Chat 恢复思路；
* 扁平 Chat 列表已经不足以表达工作的关系。

### Jobs to Be Done

> 当一个 Codex 对话开始产生多个值得独立探索的方向时，我希望把这些方向放在一个可见的结构中继续推进，从而不用依赖记忆管理它们之间的关系。

> 当我在一个项目中同时运行多个相关 Chat 或 Worktree 时，我希望看见它们从哪个问题分叉、各自在做什么，并能快速进入任何一条路径。

---

## 7. Core Domain Model

### 7.1 Project

Project 沿用 Codex / ChatGPT 的既有概念。

它是长期存在的共享上下文边界，可以包括：

* 本地文件夹或代码仓库；
* Project Instructions；
* Sources；
* 多条相关 Chat；
* Local 和 Worktree 执行环境。

一个 Project 可以拥有多个 Space。

```text
Project · spatial-codex
├── Space · Fork interaction
├── Space · App Server integration
└── Space · Product positioning
```

---

### 7.2 Space

Space 是本产品拥有的一级对象。

它表示：

> 围绕一个问题形成的一组被用户主动注册和组织起来的 Thread。

Space 不是 Codex Project 中全部 Chat 的自动镜像。

规则：

* 一个 Codex Project 可以有多个 Space；
* V0 中，一个 Space 最多绑定一个主要 Project；
* 无 Project 的独立 Chat 可以创建 Projectless Space；
* V0 不支持 Cross-project Space；
* 用户打开一个 Chat 阅读时，不会自动加入 Space；
* 用户执行 `Start a space`、`Add to space` 或第一次 `Branch from here` 时，才注册该 Chat；
* 一个 Thread 可以作为引用出现在多个 Space 中；
* 在某个 Space 内创建的新 Fork，自动成为当前 Space 的成员；
* Space 默认名称来自 Root Thread Title；
* 用户可以独立修改 Space Name，Space Name 不同步到 Codex Thread。

---

### 7.3 Thread

Thread 对应真实的 Codex Thread。

我们不复制完整 Transcript 作为自己的 Source of Truth。

Thread 可以：

* 作为 Space 的 Root；
* 从另一个 Thread Fork；
* 继续接收真实 Codex Turn；
* 运行在 Local 或 Worktree 中；
* 产生文件修改与 Diff；
* Spawn Subagent。

---

### 7.4 Fork Edge

Fork Edge 表达真实 Conversation lineage：

```text
Parent Thread
└── Child Thread
```

至少包含：

```text
parentThreadId
childThreadId
forkedAtTurnId
createdAt
```

其中：

* `parentThreadId` 决定来源 Thread；
* `forkedAtTurnId` 决定准确历史边界与返回位置；
* Edge 永远只表达 Chat Fork；
* Edge 不表达 Git Branch、Worktree 或一般依赖关系。

---

### 7.5 Worktree

Worktree 是 Thread 的可选运行位置。

它只在 UI 中以轻量 metadata 出现：

```text
worktree · overview-cards
3 files changed
```

点击可以查看 Diff 或打开 Worktree。

Worktree 不形成第二张图，也不改变 Fork Edge 的语义。

---

### 7.6 Subagent

Subagent 是 Parent Thread 中一次 Turn 的后台活动。

主 Fork Tree 不展示 Subagent 为普通 Thread Node，否则产品会滑向 Multi-Agent Control Room。

V0 行为：

* Subagent 默认折叠在 Parent Thread 的 Activity 中；
* Overview Card 可以显示 `2 subagents`；
* Hover 展示 Agent Name、Role、状态和真实任务 Snippet；
* 点击可以查看 Subagent Activity 或打开对应 Thread；
* Subagent 不影响 Space 的主布局。

Codex 当前会在支持的客户端中展示 Subagent Activity，并允许用户检查它的工作及返回给 Parent 的结果。([OpenAI Developers][3])

---

## 8. Product Design Principles

### 8.1 Chat First, Space Second

普通状态必须首先像一个高质量的 Codex / ChatGPT Chat。

Spatial structure 只有在 Fork 发生或用户进入 Overview 后才成为主视觉。

**Why：** 用户的主要工作仍然是阅读、输入和执行，而不是管理图。

---

### 8.2 Graph Underneath, Chat on Top

Focus Chat 使用完整的屏幕空间布局，而不是被缩放在 Canvas Node 中。

**Why：** 保护文字选择、滚动、Composer、代码块、流式输出和键盘行为。

---

### 8.3 Focus 与 Overview 使用不同的信息契约

Focus Tree 低信息密度，只负责导航。

Overview Card 高信息密度，负责帮助用户识别不同方向的状态与内容。

**Why：** 用户近距离工作时需要减少干扰；拉远后 Transcript 已经不可见，需要更多信息帮助识别。

---

### 8.4 Deterministic Before Interpretive

V0 Overview 只优先显示可验证的信息，不让模型擅自宣布用户“已经决定了什么”。

**Why：** Overview 是用户理解整个项目的界面。如果卡片内容不可信，整张图即使漂亮也没有价值。

---

### 8.5 Stable Spatial Memory

已有节点的位置不因为新增节点而整体洗牌。

**Why：** Spatial UI 的价值来自用户逐渐形成位置记忆。如果每次进入布局都变化，Canvas 会退化成一次性的可视化。

---

### 8.6 Execution Is Context, Not Product Structure

Worktree、Diff 和文件变化附着在 Thread 上，但不成为新的一级导航系统。

**Why：** 产品核心仍然是 Chat Fork。如果提前建立 execution ontology，产品会变成 AgentMap、Git Client 或项目管理器。

---

### 8.7 Familiar First, High-bandwidth Second

`Branch from here` 是所有用户都能理解的标准入口。

Peel 拖拽是更直接的高带宽交互，但不能成为唯一入口。

**Why：** 保留 Codex / ChatGPT 用户已有的肌肉记忆，同时提供 Spatial 产品独有的直接操纵体验。

---

## 9. Core User Journey

## 9.1 Project Entry

用户进入一个 Codex Project 后，首先看到：

```text
Project · spatial-codex

Spaces
• Fork interaction
• App Server integration
• Product positioning

Recent Codex chats
• Search chats…
```

这里不自动展示整个 Project 的 Chat Graph。

用户可以：

* 打开已有 Space；
* 搜索一个现有 Codex Chat；
* 从 Chat 创建新的 Space；
* 把 Chat 加入已有 Space。

---

## 9.2 Search and Register an Existing Chat

用户搜索：

```text
fork interaction
```

结果显示：

* Thread Title；
* Preview；
* 所属 Project；
* 更新时间；
* 可选 Worktree / Branch Name。

用户打开结果后，先进入普通的只读 Focus Chat。

此时 Chat 尚未自动进入 Space。

用户第一次执行以下任一动作时，系统注册它：

```text
Start a space
Add to space
Branch from here
```

如果用户直接 `Branch from here`：

1. 系统自动创建一个 Space；
2. Root 为当前 Chat；
3. Space 临时名称使用 Root Thread Title；
4. 当前 Fork 成为 Space 中第一个 Child。

---

## 9.3 Focus Mode

Focus 是日常工作状态：

```text
┌──────────────────┬────────────────────────────────────┐
│ Persistent Tree  │ Full-fidelity Chat                 │
│                  │                                    │
│ Root             │ Transcript                         │
│ ├ Frontend       │ Commands / File changes            │
│ └ Backend  ←     │ Approvals                          │
│                  │                                    │
│                  │ Composer                           │
└──────────────────┴────────────────────────────────────┘
```

### Focus Tree 展示

* Thread Title；
* Parent / Child 层级；
* 当前节点；
* Running / Needs approval / New result / Failed；
* 可选 Worktree 标记；
* 可选 changed-files 数量。

Focus Tree 不展示：

* 长 Summary；
* Latest User / Assistant Snippet；
* Decision；
* Open Question；
* 完整 Diff。

当 Space 较大时：

* 当前路径、Sibling 和直接 Child 优先展开；
* 不相关 Subtree 可以折叠；
* Overview 仍可查看完整结构。

---

## 9.4 Branch from Here

### Entry

用户 Hover 一个已经完成的 Turn，在消息操作中看到：

```text
Copy
Branch from here
More
```

也可以拖动 Peel Handle，直接从该 Turn 向空间中拉出一个新方向。

两种入口产生完全相同的结果。

---

### Fork Draft

点击后，不立刻创建 Durable Codex Thread。

系统先创建本地 Fork Draft：

```text
Parent Thread
→ Fork Draft
```

界面行为：

* 新 Child Chat Surface 出现；
* Composer 自动获得焦点；
* Parent 与 Child 的 Fork 关系立即可见；
* Fork Draft 不进入 Durable Overview；
* 用户可以按 Escape 取消；
* 取消不会创建空 Thread 或空 Worktree。

---

### Execution Location

如果 Parent 位于 Git-backed Project，Composer 附近显示轻量选择：

```text
Current workspace ▾
```

选项：

```text
Continue in current workspace
Create a new worktree
```

如果 Parent 已在 Worktree：

```text
Continue in this worktree
Create a new worktree
```

要求：

* 不使用 Modal；
* 用户可以在 First Send 前修改；
* Worktree 只是 Fork 的运行位置，不改变 Fork Tree；
* 默认策略在技术设计与 Dogfood 后确认；
* Worktree 创建的具体 App Server / Git 实现不在本 PRD 中决定。

---

### First-send Commit

用户输入第一条 Prompt 并点击 Send 后，系统才：

1. 如需要，创建或准备目标 Worktree；
2. 调用真实的 Codex `thread/fork`；
3. 通过 `lastTurnId` Fork 到准确 Turn；
4. 保存 Parent、Child 与 Fork Turn；
5. 在 Child Thread 中开始第一轮；
6. 将 Fork Draft 转为 Durable Node。

Codex App Server 原生支持从 stored Thread 创建新 Thread，并通过 `lastTurnId` 复制到指定 Turn。([OpenAI Developers][2])

失败规则：

* Worktree 创建失败：保留 Prompt，允许切换到 Current Workspace 或 Retry；
* Fork 创建失败：保留完整 Fork Draft；
* Fork 成功但 First Turn 失败：Child Thread 保留，允许 Retry；
* 任何失败都不能丢失 Composer 内容。

---

### Branched From

Child Transcript 在共同历史结束的位置显示：

```text
──────── Branched from [Parent Thread Title] ────────
```

点击后：

1. 切换到 Parent Thread；
2. 滚动到准确 Fork Turn；
3. 短暂高亮该 Turn；
4. 返回 Child 后恢复之前的 Scroll 和 Draft。

---

## 9.5 Thread Naming

### Fork Draft

尚未 Send 时显示：

```text
New branch
```

### First Send

使用第一条 User Prompt 作为临时标题，进行确定性截断：

```text
Overview 可以展示每个 Chat 更多的信息
```

### First Turn Completed

系统可以生成一个更短的标题：

```text
Overview information density
```

生成后同步写回 Codex Thread。

### Inline Rename

用户可以在以下位置直接 Rename：

* Focus Tree；
* Overview Card；
* Thread Header。

Rename 通过 Codex `thread/name/set` 写回真实 Thread，而不是只保存在 Space 中。Codex 会在读取和列出 Thread 时返回其用户可见 Name。([OpenAI Developers][2])

核心规则：

> 用户手动 Rename 后，系统永远不再自动覆盖这个名称。

---

## 9.6 Overview Mode

用户点击 Overview 或执行 Zoom Out 后：

* 当前完整 Chat 收缩为 Thread Preview；
* Composer 消失；
* 没有任何 Thread 处于 Focus；
* 完整 Fork Graph 成为主界面；
* 每个 Thread Card 展示更多确定性信息。

点击任意 Card 后，重新进入该 Thread 的 Focus Mode。

### V0 Overview Card 信息

必须包含：

```text
Thread Title

Branched from [Parent Title]
Fork Turn Snippet

Latest User Prompt Snippet
Latest Completed Assistant Result Snippet

Last Active Time
Turn Count

Running / Needs Approval / New Result / Failed

Worktree Name
Changed File Count

Subagent Count / Status
```

示例：

```text
Rich overview cards

Branched from Focus vs Overview
“比起 Focus 的 Fork Tree，Overview 可以展示更多……”

Latest user
“先做一个 Demo 让我感受一下吧”

Latest result
“Focus Tree 是导航；Overview 是理解整个探索状态。”

18 turns · 12m ago
worktree · spatial-ui · 3 files

2 subagents
```

V0 不展示模型推断的：

```text
Decision
Conclusion
Open Question
Rejected Direction
```

这些属于未来的 Interpretation Layer。

---

## 9.7 Spatial Layout

### Initial Placement

* Root 放在稳定的起始位置；
* Child 默认放在 Parent 的右侧或下游；
* Sibling 保持可辨识间距；
* 新 Child 的加入不能整体重排现有节点。

### Manual Position

用户可以拖动 Overview Card。

位置持久化到 Space Metadata。

### Tidy Layout

可以提供显式的：

```text
Tidy layout
```

但系统不能在后台自动重新排列所有内容。

### Edge

* Edge 只表达 Fork；
* 默认低对比度；
* Active Path 或 Hover 时增强；
* 不使用彩色 Branch 类型；
* 不允许用户任意画 Edge。

---

## 9.8 Worktree and Diff

Worktree 只以轻量形式出现：

```text
worktree · overview-cards
3 files changed
```

点击后打开临时 Diff Surface：

* 文件列表；
* Additions / Deletions；
* 文件或 Hunk Diff；
* Open Worktree；
* Open in Editor；
* Open in Codex。

退出 Diff 后返回原来的 Focus 或 Overview 状态。

V0 不实现：

* Worktree Dashboard；
* Git Graph；
* Branch Management；
* Commit / Push / PR 主流程；
* 自动比较多个 Worktree。

Codex 自身已经提供本地 Project 和 Worktree 的 Git Diff、Stage、Revert、Commit 与 PR 能力；本产品只在 Fork 语境中提供轻量入口。([OpenAI Developers][4])

---

## 9.9 Voice Dictation

Composer 包含麦克风入口：

```text
Record
→ Transcribe
→ Insert editable text into Composer
→ User reviews or edits
→ Send
```

要求：

* Dictation 和键盘输入属于同一个 Draft；
* 用户可在录音前后继续打字；
* Transcript 在发送前必须可编辑；
* Draft 按 Thread 保存；
* 切换 Thread 不丢失；
* Overview 中没有 Composer，因此不录音；
* 不添加自定义技术词提示；
* 不添加额外 Prompt 或关键词配置。

这一交互与 ChatGPT Dictation 的既有模式一致：录制 Prompt、检查和修改转写，再作为普通文字发送。([OpenAI Help Center][5])

---

## 9.10 Thread Status and Attention

非 Focus Thread 只使用四种需要用户注意的状态：

```text
Running
Needs approval
New result
Failed
```

Idle 不展示状态。

状态可以出现在：

* Focus Tree；
* Overview Card；
* Project Space List。

`New result` 基于：

```text
latestCompletedTurnId
vs.
lastViewedTurnId
```

而不是模型判断。

---

## 9.11 Subagent Activity

Parent Thread Card 可以展示：

```text
2 subagents
```

Hover：

```text
Explorer
Inspecting App Server fork behavior
Running

Tester
Validating Overview layout
Completed
```

信息来源优先使用：

* Agent Name / Nickname；
* Agent Role；
* 第一条 Delegated Task；
* Runtime Status；
* Latest Completed Result Snippet。

不自动生成额外 Summary。

---

## 9.12 Open in Codex

所有 Thread 始终提供：

```text
Open in Codex
Open worktree
View original
```

原因：

* 某些 Codex Item 可能尚未被本产品完整渲染；
* 某些 Git 或 Worktree 操作更适合在原生 Codex 完成；
* 用户可能正在原生 Codex 中继续 Parent；
* 本产品不应该把用户锁在不完整的 Client 中。

---

## 10. Space Lifecycle

### Create Space

来源：

* 从已有 Chat 点击 `Start a space`；
* 从已有 Chat第一次 `Branch from here`；
* 在 Project 页面显式创建，并选择 Root Chat。

### Rename Space

Space Name 只属于本产品，不同步到 Codex。

默认名称使用 Root Thread Title。

### Add to Space

用户可以把一个现有 Codex Thread 注册到 Space。

V0 中只有真实 Fork Edge 才形成 Parent / Child 关系；被添加但无 Fork Relation 的 Thread 不自动连线。

### Remove from Space

只移除：

* Space Membership；
* Node Position；
* Space-specific Metadata。

不删除：

* Codex Thread；
* Transcript；
* Worktree；
* Git Changes。

### Archive Space

只隐藏 Space，不修改任何 Codex Thread。

### Archive / Delete Codex Thread

这是对原始 Codex 数据的操作，必须明确区分于 `Remove from Space`，并提供二次确认。

---

## 11. Source of Truth

### Codex Owns

```text
Project
Thread ID
Thread Transcript
Turn and Item
Thread Name
Thread Status
Approval
Worktree / cwd
Git State
Subagent Thread
```

### Our App Owns

```text
Space
Space Membership
Fork Edge Metadata
Fork Turn Anchor
Spatial Position
Camera State
Collapsed Subtrees
Last Viewed State
Local Fork Draft
Per-thread Scroll Position
Per-thread Composer Draft
```

### Shared but Synchronized

```text
Thread Title
```

用户在本产品 Rename 时，写回 Codex。

本产品不长期维护一个与 Codex 不一致的 Shadow Title。

---

## 12. V0 Functional Scope

### P0：Launch Requirements

* 读取 Codex Project 与 Thread；
* 搜索现有 Codex Chat；
* 创建 Space；
* 注册 Root Thread；
* Focus Mode；
* 持久化 Fork Tree；
* 从 Completed Turn 执行 `Branch from here`；
* Peel Drag Gesture；
* Local Fork Draft；
* First-send Commit；
* Current Workspace / New Worktree 选择；
* Child Thread 中继续真实 Codex Turn；
* `Branched from` 精确返回；
* Overview Mode；
* 确定性 Overview Card；
* 稳定 Node Position；
* Inline Rename 并同步 Codex；
* Voice Dictation；
* Worktree Name 与 changed-files 提示；
* 轻量 Diff Surface；
* Running / Approval / New Result / Failed；
* Subagent Indicator；
* Remove from Space；
* Archive Space；
* Open in Codex；
* Draft 和 Scroll Restoration。

### P1：可在 V0 后追加

* 自动发现原生 Codex 中新创建的相关 Fork；
* 恢复外部 Fork 的准确 Turn Anchor；
* Keyboard-first Overview Navigation；
* Collapse / Park Subtree；
* Show Recent Only；
* Tidy Layout；
* Space Search；
* Pin Thread；
* 更完整的未知 Codex Item Renderer。

---

## 13. UX Acceptance Criteria

### Focus Fidelity

* 完整 Chat 不经过 Canvas Scale Transform；
* 正常文字选择与复制；
* Composer 不因 Camera 移动而改变位置；
* Code Block 可正常横向滚动；
* Streaming 不导致 Scroll Jump；
* 用户主动向上滚动后停止 Auto-follow；
* 切换 Thread 后恢复 Scroll 和 Draft；
* Approval 显示在产生它的 Thread 内。

### Fork

* 点击 `Branch from here` 后，Fork Draft 在 150ms 内可见；
* Composer 立即获得焦点；
* 取消 Draft 不创建 Durable Thread；
* First Send 失败不丢失文字；
* Fork 成功后 Tree 和 Overview 立即出现 Child；
* Child 可返回准确 Parent Fork Turn。

### Overview

* Overview 中没有完整 Transcript 和 Composer；
* 每个 Card 的主要内容均可回到真实 Turn；
* 不使用未经标识的模型推断；
* 新增 Child 不移动已有 Node；
* 重新打开 Space 后位置保持一致；
* 点击任意 Card 可回到 Focus；
* 30–50 个 Node 时仍能理解主要结构。

### Naming

* 第一条 Prompt 自动形成临时标题；
* 第一轮后可以生成短标题；
* Inline Rename 同步 Codex；
* 用户 Rename 后不再被自动覆盖。

---

## 14. Success Metrics

### Activation

* 用户打开一个既有 Codex Chat 后，能够在 30 秒内创建第一个 Fork；
* 新用户无需理解 Node、Edge、Graph 或 Git 术语即可完成 Fork。

### Core Utility

* 创建过至少两个 Fork 的 Space 中，用户会通过 Tree 或 Overview 返回非当前 Branch；
* 用户能在不打开 Transcript 的情况下，从 Overview 判断每条 Branch 的大致方向与状态；
* 用户能够准确回答当前 Thread 的 Parent 和 Sibling。

### Reliability

* Fork Draft 丢失率：0；
* Rename 同步成功率：>99%；
* Fork Edge 与真实 Codex Thread Relation 一致；
* Node Position 意外变化率：0；
* Worktree 创建失败不会导致 Thread 或 Prompt 丢失。

### Dogfood Signals

重点观察：

* 用户通常在哪种 Turn 创建 Fork；
* 一个 Space 平均有多少 Fork；
* 用户是否会从 Fork 再 Fork；
* Focus Tree 和 Overview 的使用频率；
* 用户选择 Current Workspace 与 New Worktree 的比例；
* 用户何时点击 Diff；
* 用户是否主动 Rename；
* Branch 在多少天后被重新进入；
* 哪些信息最能帮助用户在 Overview 中识别 Thread。

---

## 15. Risks and Mitigations

### Risk 1：产品退化成 Graph Viewer

**表现：** 图很好看，但用户仍然需要逐个打开 Chat 才知道内容。

**Mitigation：**

* Overview 提供高信息密度的确定性 Card；
* Fork Point、Latest User、Latest Result 均可直接识别；
* Focus Tree 与 Overview 使用不同信息契约。

---

### Risk 2：产品退化成普通 Codex Clone

**表现：** 大量时间花在复刻所有 Codex Feature，Spatial Fork 反而不突出。

**Mitigation：**

* 保留 `Open in Codex`；
* 不支持的能力优雅降级；
* V0 只完整支持 Fork 所需的 Chat 主路径；
* 不以替代全部日常 Codex 使用为目标。

---

### Risk 3：产品退化成 Agent / Execution Dashboard

**表现：** Worktree、Subagent、Diff、Test 状态开始成为主要界面。

**Mitigation：**

* 主图只展示用户 Chat Fork；
* Worktree 是 Node Metadata；
* Subagent 折叠在 Parent；
* 不建立 Execution Graph；
* 不建立 Test Dashboard。

---

### Risk 4：Overview 信息看似丰富但不可信

**表现：** 模型错误地把讨论解释为 Decision 或 Conclusion。

**Mitigation：**

* V0 仅使用确定性信息；
* 所有 Snippet 指向真实 Turn；
* Interpretation Layer 延后；
* 未来 AI Summary 必须标注更新时间和来源。

---

### Risk 5：空间位置无法形成记忆

**表现：** 自动布局导致 Node 不断跳动。

**Mitigation：**

* Existing Node 默认不移动；
* Manual Position 持久化；
* 自动布局只能显式触发；
* 新 Child 在 Parent 附近增量放置。

---

### Risk 6：Worktree 选择增加 Fork 摩擦

**表现：** 用户每次 Fork 都要理解 Git 环境。

**Mitigation：**

* 选择器保持轻量；
* 不使用 Modal；
* 默认继承 Parent 当前环境；
* 只有 Git-backed Thread 展示；
* 用户可以在 First Send 前修改。

---

## 16. Future Direction

V0 建立稳定的：

```text
Chat
→ Fork
→ Space
→ Focus
→ Overview
```

在真实使用积累足够多的 Branch 以后，产品可以继续向：

```text
Compare
→ Select
→ Integrate
→ Produce convergence checkpoint
```

发展。

未来 Convergence 不等同于自动合并两条 Chat，也不等同于自动 Git Merge。

它应允许用户分别选择：

* 要保留的判断；
* 要带回的原始 Turn；
* 要采用的代码结果；
* 要继续保留的 Open Question；
* 新的共同起点。

但在用户真实形成大量 Fork 以前，不提前实现这套系统。

---

## 17. Deferred Decisions

以下问题留给 Tech Design、真实 Codex Schema 检查与 Dogfood：

1. New Worktree 的具体 App Server 接口或 Git fallback；
2. Current Workspace 与 New Worktree 的默认策略；
3. 自动短标题使用什么模型、何时触发；
4. 原生 Codex 外部 Fork 的准确 Turn Anchor 如何恢复；
5. Focus Tree 在多大规模后自动折叠；
6. Overview 的增量布局算法；
7. ChatGPT Conversation 的授权导入与 Fork Adapter；
8. Space 是否最终允许 Cross-project Reference；
9. Subagent Activity 的展开层级；
10. Compare / Convergence 的最早进入条件。

这些问题不改变 V0 的产品结构，因此不应阻塞设计和基础实现。

---

## 18. Final Product Definition

> **Spatial Thread Workspace 是 Codex Project 中围绕一个问题形成的空间化 Fork Workspace。它保留完整、熟悉的 Chat 体验，同时让不同 Thread 从哪里分叉、正在做什么、产生了什么结果保持可见。**

更简洁地说：

> **Codex owns the conversation.
> We make its branches visible.**

[1]: https://developers.openai.com/codex/projects?utm_source=chatgpt.com "Projects and chats"
[2]: https://developers.openai.com/codex/app-server?utm_source=chatgpt.com "Codex App Server"
[3]: https://developers.openai.com/codex/agent-configuration/subagents?utm_source=chatgpt.com "Subagents"
[4]: https://developers.openai.com/codex/environments/local-environment?utm_source=chatgpt.com "Local environments"
[5]: https://help.openai.com/articles/8400625-voice-mode-faq?utm_source=chatgpt.com "ChatGPT Voice"
