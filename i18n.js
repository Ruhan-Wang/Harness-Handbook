/* ==========================================================================
   Harness Handbook — bilingual EN/ZH i18n
   --------------------------------------------------------------------------
   EN strings live in the DOM (cached on first run) and in tr() fallbacks in
   script.js. This file provides the ZH dictionary + the runtime that swaps
   languages. Keys match data-i18n / data-i18n-text attributes in index.html
   and tr() calls in script.js.
   ========================================================================== */
(function () {
  "use strict";

  const LS_KEY = "hh-lang";
  const VALID = new Set(["en", "zh"]);

  const META = {
    en: {
      title: "Harness Handbook — Making Evolving Agent Harnesses Readable, Navigable & Editable",
      description:
        "A behavior-first map of an agent-harness codebase. Harness Handbook lets developers and coding agents locate a behavior, read the code evidence, and edit with confidence.",
    },
    zh: {
      title: "Harness Handbook — 让 Agent Harness 可理解、可审核、可修改",
      description:
        "一份行为级说明书，帮助开发者理解、审核并改造复杂 Agent Harness。",
    },
  };

  const ZH = {
    /* ---- chrome ---- */
    "brand.text": "Harness Handbook",
    "nav.method": "方法",
    "nav.results": "结果",
    "nav.handbook": "查看 Handbook",
    "nav.paper": "Studio 演示",
    "theme.toggle": "切换深色模式",
    "lang.en": "EN",
    "lang.zh": "中文",

    /* ---- TOC ---- */
    "toc.title": "目录",
    "toc.1": "为什么 Agent Harness 需要一本说明书？",
    "toc.2": "一个行为，多个实现位置",
    "toc.3": "Harness Handbook：一张可导航的行为地图",
    "toc.4": "Harness Handbook 的生成：从代码事实到行为地图",
    "toc.5": "Harness Handbook 如何指向代码证据？",
    "toc.6": "Coding agent 如何使用 Harness Handbook？",
    "toc.7": "Handbook Studio：面向人类用户的 Harness 控制台",
    "toc.8": "要点总结",

    /* ---- hero ---- */
    "hero.kicker": "Agent Harness &nbsp;·&nbsp; Tencent HY LLM Frontier &nbsp;·&nbsp; 2026 年 6 月",
    "hero.title": "Harness Handbook",
    "hero.dek": "让 Agent Harness 可理解、可审核、可修改。",
    "hero.subtitle":
      "想读懂一个 Agent Harness，审核一个公开 Harness，或者基于它构建自己的 Agent 系统？真正困难的往往不是代码是否可见，而是行为是否可理解：系统在不同阶段会做什么、状态如何传递、又由哪些实现位置支撑。Harness Handbook 将复杂 Harness 整理成一份<b>行为级说明书</b>，按“系统做什么”组织执行流程与关键行为，并把每条路径连接回可验证的代码证据。<br><br>在此基础上，它也可以成为用户与繁琐 hard code 之间的<b>交互中间层</b>：用户从行为出发提出理解、审核或修改需求，Handbook 将这些需求映射到行为单元、代码证据和操作路径。这样，复杂 Harness 在持续演化时仍然保留一层人类可理解、可审阅、可介入的行为级说明层，使 human-in-the-loop 不只发生在最终确认时，也贯穿理解、审核与修改的全过程。",
    "hero.authors":
      "Ruhan Wang<sup>1,2,*</sup> · Yucheng Shi<sup>1,†</sup> · Zongxia Li<sup>1,3</sup> · Zhongzhi Li<sup>1,4</sup> · Yue Yu<sup>2</sup> · Junyao Yang<sup>1,5</sup> · Kishan Panaganti<sup>1</sup> · Haitao Mi<sup>1</sup> · Dongruo Zhou<sup>2</sup> · Leoweiliang<sup>1</sup>",
    "hero.affils":
      "<sup>1</sup> Tencent HY LLM Frontier &nbsp;·&nbsp; <sup>2</sup> Indiana University &nbsp;·&nbsp; <sup>3</sup> University of Maryland &nbsp;·&nbsp; <sup>4</sup> University of Georgia &nbsp;·&nbsp; <sup>5</sup> National University of Singapore",
    "hero.corresponding":
      "<sup>*</sup> Corresponding author: Ruhan Wang (ruhwang@iu.edu)",
    "hero.mentor":
      "<sup>†</sup> Lead project collaborator",
    "hero.figcap":
      "<b>核心思想。</b>一条行为请求通常不会只对应一处代码。Harness Handbook 把<span class=\"u-b\">“系统应该做什么”</span>整理成可导航的行为路径，并把路径上的每一步连接回<span class=\"u-i\">真实代码证据</span>，让理解、审核和修改都能从同一张地图出发。",

    /* ---- TL;DR ---- */
    "tldr.kicker": "一分钟速览",
    "tldr.1":
      "<b>Harness Handbook 解决的问题。</b>Harness 是决定 Agent 行为如何展开的关键层，连接模型、提示、工具、状态、权限和执行环境；但这些机制通常抽象、隐含，并分散在复杂代码中。Harness Handbook 将这些运行机制组织成可导航的行为地图，让读者从系统行为出发理解 Harness，而不是先陷入零散源码。",
    "tldr.2":
      "<b>读懂一个 Harness。</b>如果目标是理解一个开源 Harness，仅看文件树通常不够。Handbook 通过 L1 系统概览建立整体执行流程，通过 L2 行为单元概览说明阶段职责、状态流转和行为依赖，再通过 L3 连接触发条件、执行路径与源码证据，让读者先理解“系统行为如何发生”，再进入具体实现。",
    "tldr.3":
      "<b>让 coding agent 更可靠、低成本地修改 Harness。</b>coding agent 修改 Harness 时，关键是编辑前能否找准行为落点。Handbook 通过 <b>Behavior-Guided Progressive Disclosure</b>（BGPD）将自然语言修改请求映射到相关行为单元和实现证据，帮助 planner 生成更聚焦的编辑计划，减少无关搜索、遗漏风险和 planner 阶段的 token 开销。",
    "tldr.4":
      "<b>基于现有 Harness 构建自己的 Agent。</b>如果用户希望基于 Codex 等系统构建个性化 Agent，Handbook 可以作为进入现有 Harness 的行为入口，帮助理解工具、权限、状态、记忆、执行策略和沙箱边界如何塑造 Agent 行为，并连接回可验证代码证据。用户不必深入阅读复杂源码，就能通过与 Handbook 交互提出修改意图、核对依据并确认代码更新，使 human-in-the-loop 贯穿理解、审核与修改全过程。",

    /* ---- §01 ---- */
    "s01.num": "第 01 节",
    "s01.title": "为什么 Agent Harness 需要一本说明书？",
    "s01.p1":
      "谈到 AI Agent，人们通常首先想到模型。但在真实系统中，Agent 并不只是模型本身。提示如何构建、工具如何暴露、状态如何在多轮交互中延续、权限如何检查，以及模型输出如何被转化为下一步动作，都由 <span class=\"u-h\">Harness</span> 负责组织。换句话说，Harness 是模型周围的运行时系统，也是 Agent 行为真正展开的地方。",
    "s01.p2":
      "然而，Harness 的行为往往只隐含在代码结构中。即使一个 Harness 完全开源，读者首先看到的仍然只是文件、函数、配置和控制流。文件树能告诉你代码放在哪里，却不会直接说明系统行为如何发生：哪些条件会触发工具调用，哪些路径需要用户确认，哪些状态会影响后续动作，以及异常或失败时系统会如何继续执行。",
    "s01.note.label": "什么是 Harness？",
    "s01.note.p":
      "Harness 可以理解为模型周围的运行时层：它负责组装上下文、暴露工具、维护状态、执行权限与沙箱策略，并将模型输出转化为真实动作。AutoGen、OpenHands 等框架，以及 Claude Code、Codex 等生产系统，都表明 Harness 设计已经成为影响 Agent 可靠性、可控性和可扩展性的关键因素。",
    "s01.bridge":
      "这也是为什么读懂一个 Agent Harness，往往不只是“打开仓库看看代码”。不同读者会带着不同目的进入同一个代码库：",
    "s01.need1.label": "理解",
    "s01.need1.value": "这个 Harness 如何组织 Agent 行为？",
    "s01.need1.note": "模型接收哪些上下文？工具在什么条件下可用？状态如何在步骤之间传递？异常或失败时系统如何继续执行？先建立系统级运行图景，而不是直接进入单个文件。",
    "s01.need2.label": "审核",
    "s01.need2.value": "这个公开 Harness 是否符合预期？",
    "s01.need2.note": "是否存在隐藏权限、自动批准路径、沙箱绕过、异常数据流，或与文档不一致的真实行为？审核的重点，是将潜在风险连接回可验证的实现证据。",
    "s01.need3.label": "改造",
    "s01.need3.value": "如何基于它构建自己的 Agent 系统？",
    "s01.need3.note": "如果要调整工具、记忆、确认逻辑、执行策略或沙箱边界，需要先定位这些行为分别由哪些代码位置支撑。",
    "s01.p3":
      "这三类问题看起来不同，但它们共享同一个前提：读者必须先把<span class=\"u-b\">“系统做什么”</span>连接到<span class=\"u-i\">“代码在哪里实现”</span>。Harness Handbook 的目标，就是将复杂 Harness 转化为一份可导航、可复核的行为级说明书。",
    "s01.q": "目标行为到底在哪里实现？",

    /* ---- §02 ---- */
    "s02.num": "第 02 节",
    "s02.title": "一个行为，多个实现位置",
    "s02.p1":
      "理解、审核和改造看似对应不同任务，但一旦进入代码库，它们都会收敛到同一个核心问题：目标行为究竟由哪些实现共同决定？",
    "s02.figcap":
      "<b>一个行为，多个落点。</b>“删除文件前是否先询问用户”并不是由某个单独函数决定的，而是由提示、工具包装、权限配置、状态管理，以及沙箱执行 / 回退路径共同塑造。无论是理解、审核还是改造 Harness，都必须先找齐这些实现位置。",
    "s02.p2":
      "以“删除文件前是否需要用户确认”为例。这一行为并不对应单一函数，而是可能同时涉及提示规则、工具包装、权限配置、状态记录和执行路径。因此，理解者关注系统为什么会触发确认，审核者关注是否存在绕过确认的路径，改造者则需要定位应当调整的具体实现位置。",
    "s02.case1.label": "理解",
    "s02.case1.value": "解释确认行为如何发生",
    "s02.case1.note": "当 Agent 请求删除文件时，Harness 为什么没有直接执行，而是先要求用户确认？这通常涉及提示规则、权限配置、执行状态，以及工具调用如何被拦截或放行。",
    "s02.case2.label": "审核",
    "s02.case2.value": "检查是否存在绕过路径",
    "s02.case2.note": "某些运行模式、回退路径或工具包装器可能跳过确认，使高风险操作被直接执行。审核的重点，是找出这些隐藏路径并回到代码证据验证。",
    "s02.case3.label": "改造",
    "s02.case3.value": "定位需要调整的实现",
    "s02.case3.note": "如果希望删除文件、联网请求、写入系统目录等高风险操作都必须先确认，就需要定位相关规则、状态记录和执行路径分别落在哪些模块中。",
    "s02.p3":
      "表面上看，这只是一个简单规则：删除文件前先询问用户。但在真实 Harness 中，这个行为通常不会集中在一个 <code>confirmBeforeDelete()</code> 函数里。Prompt 可能规定模型在删除前应先询问用户，tool wrapper 可能拦截删除工具调用，permission config 定义哪些操作属于高风险，state manager 记录用户是否已经批准，sandbox runner 和 fallback path 则决定删除请求最终被执行、被拒绝，还是进入另一条处理路径。",
    "s02.p4":
      "因此，真正困难的不是打开某个文件，而是判断哪些文件、函数、配置和执行路径共同决定了这个行为。我们把这一步称为<b>行为定位</b>：把一个行为问题映射到所有相关的实现证据。它不是修改前的附属步骤，而是理解、审核和改造 Harness 的基础。Harness Handbook 要补上的，正是这张从行为问题通向代码证据的地图。",

    /* ---- §03 ---- */
    "s03.num": "第 03 节",
    "s03.title": "Harness Handbook：一张可导航的行为地图",
    "s03.p1":
      "Harness Handbook 不是文件树的另一种视图，而是一种以行为为中心的 <span class=\"u-b\">Harness 表示</span>。它先帮助读者建立系统级理解，再逐层进入行为单元、执行路径和代码位置；每一步都保留可验证的<span class=\"u-i\">代码证据</span>，让行为解释可以被复核，也让后续修改有据可依。",
    "s03.figcap":
      "<b>从系统理解到行为证据。</b>L1 建立 Harness 的整体系统理解；L2 将系统组织为行为单元，并说明单元之间的职责、输入输出和前后关系；L3 深入单个行为单元内部，连接触发条件、状态变化、异常路径和代码证据。Handbook 的作用不是一次展示所有信息，而是用三层结构把复杂 Harness 组织成可导航的行为地图。",
    "s03.l1":
      "<b>L1 · 系统概览</b> 提供 Harness 的全局视角。它不从文件和函数入手，而是先梳理系统级执行流程：请求如何进入，经过哪些阶段，状态如何在步骤之间流转，模型输出又如何被转化为实际动作。它回答的是：<i>这个 Harness 作为一个整体如何运转？</i>",
    "s03.l2":
      "<b>L2 · 行为单元概览</b> 将系统流程进一步组织为一组行为单元。每个行为单元对应 Harness 中一类相对完整的行为，并说明它的职责、输入输出、前后依赖和关键状态。它帮助读者理解：复杂 Harness 的行为如何被拆分、连接，并在系统流程中协同完成。",
    "s03.l3":
      "<b>L3 · 行为单元详解</b> 深入单个行为单元内部，解释一个具体行为如何发生：何时触发、如何执行、状态如何变化、异常或失败时走哪条路径，以及哪些文件和函数提供实现证据。到这一层，理解、审核和修改都能回到可验证的代码依据。",
    "s03.entry.head": "一个 L3 行为单元示例",
    "s03.entry.p":
      "以“删除文件前确认”为例，L3 展示的是单个行为单元内部的完整实现逻辑。它不只是回答“是否需要确认”，而是展开说明确认决策如何被触发、受哪些权限规则约束、用户选择如何被记录、执行路径如何继续或中止，以及哪些代码证据支撑这些判断。通过这一层，读者可以理解行为机制，审核潜在绕过路径，并在需要调整策略时定位相关实现位置。",

    /* ---- unit card ---- */
    "unit.badge": "行为单元 · 工具执行阶段",
    "unit.title": "删除文件前确认",
    "unit.summary": "当 Agent 发起删除文件请求时，Harness 不会立即执行该操作，而是先检查权限策略与用户确认状态，再根据确认结果决定继续执行、拒绝请求或返回错误。",
    "unit.f1.k": "触发条件",
    "unit.f1.v": "Planner 生成删除文件调用，例如 <code>delete_file(path)</code>。",
    "unit.f2.k": "权限规则",
    "unit.f2.v": "权限配置将文件删除标记为高风险操作，要求在执行前获得用户确认。",
    "unit.f3.k": "状态变化",
    "unit.f3.v": "Harness 记录确认请求与用户响应，并据此判断当前执行是否可以继续。",
    "unit.f4.k": "执行路径",
    "unit.f4.v": "用户批准后，请求进入 <code>sandbox runner</code> 执行；用户拒绝或未授权时，调用被中止并返回错误。",
    "unit.f5.k": "边界情况",
    "unit.f5.v": "<code>headless</code> 模式、自动批准策略或回退路径可能改变确认流程，需要单独检查。",
    "unit.ev.label": "证据",
    "unit.figcap":
      "<b>一个 L3 行为单元。</b>它不只是声明“删除文件前需要确认”，而是将确认决策拆解为一组可复核的实现细节：请求如何触发、权限规则如何约束、确认状态如何记录、执行路径如何继续或中止，以及哪些代码证据支撑这些判断。因此，L3 不仅用于理解行为机制，也可以支持绕过风险审核，并在需要调整策略时定位相关实现位置。",

    /* ---- §04 ---- */
    "s04.num": "第 04 节",
    "s04.title": "Harness Handbook 的生成：从代码事实到行为地图",
    "s04.p1":
      "Harness Handbook 从现有 Harness 代码库生成，但它并不是对文件内容的直接摘要。生成流程首先提取可验证的程序事实，再将这些事实按照系统行为重新组织，最终合成为三层结构的 Handbook。整个过程遵循事实优先原则：自然语言负责解释系统行为，所有实现证据都必须锚定在代码事实中，而不是来自模型猜测。",
    "s04.figcap":
      "<b>从代码库到行为说明书。</b>静态分析提取程序事实；行为中心组织把事实映射到系统行为；最后合成三层结构的 Handbook，证据链接全程保留。",
    "s04.step1.title": "提取事实",
    "s04.step1.out": "→ 程序图",
    "s04.step1.p":
      "第一步从代码库中提取静态程序事实，包括文件、函数、类、调用关系、状态读写、配置边界和外部 API 调用。这些事实共同构成<b>程序图</b>，用来刻画 Harness 内部实现元素之间的真实连接关系。",
    "s04.step2.title": "按行为组织",
    "s04.step2.out": "→ 行为地图",
    "s04.step2.p":
      "第二步将程序图中的代码事实重新组织为行为地图。流程先构建 Harness 生命周期的粗略<b>执行骨架</b>，再将函数、模块和代码区域映射到对应的行为阶段与行为单元。这个映射会通过<b>提议者–评审者循环</b>持续校正，直到行为阶段划分、行为单元边界和代码证据之间形成一致对应。",
    "s04.step3.title": "合成手册",
    "s04.step3.out": "→ Handbook",
    "s04.step3.p":
      "最后，收敛后的行为地图被渲染为三层结构：系统概览、行为单元概览和行为单元详解。说明文字可以由自然语言生成，但源码链接、函数引用和代码片段必须锚定在已提取的程序事实中。换句话说，<b>文字负责解释，事实负责锚定</b>。",

    /* ---- §05 ---- */
    "s05.num": "第 05 节",
    "s05.title": "Harness Handbook 如何指向代码证据？",
    "s05.p1":
      "Harness Handbook 的使用方式，是把一个行为问题逐步展开成可追踪的证据路径。读者不需要先做全仓库搜索，而是从 L1 的系统上下文进入，在 L2 找到相关行为单元，再进入 L3 查看触发条件、状态变化、执行路径和源码链接。我们将这种围绕具体问题逐层展开信息的方式称为<b>行为引导的渐进式披露</b>（Behavior-Guided Progressive Disclosure，BGPD）。它的目标很直接：让理解、审核和修改都从相关代码证据出发，而不是从零散文件搜索出发。",
    "s05.figcap":
      "<b>从问题到证据。</b>BGPD 将行为问题组织成一条可追踪的证据路径：先通过 L1 建立系统级上下文，再通过 L2 定位相关行为单元，最后进入 L3 查看触发条件、状态变化、执行路径与源码链接。理解与审核以证据核对为核心；修改任务则在这些证据基础上形成编辑计划。仓库始终是事实来源，Handbook 的作用是减少无目标搜索，并更快指向需要验证或调整的实现位置。",
    "s05.flow.1": "行为问题",
    "s05.flow.2": "L1 系统概览",
    "s05.flow.3": "L2 行为单元概览",
    "s05.flow.4": "L3 行为单元详解",
    "s05.flow.5": "证据 / 编辑计划",
    "s05.use.head": "三种使用方式",
    "s05.use.dev.label": "理解：建立系统模型",
    "s05.use.dev.1": "从 L1/L2 开始，读者先梳理 Harness 的整体执行流程、状态流转，以及行为单元之间的依赖关系。",
    "s05.use.dev.2": "目标不是直接跳入单个文件，而是建立系统级理解，判断一个行为应放在哪个上下文中解释。",
    "s05.use.dev.3": "只有先形成这张行为地图，后续问题才能被放回正确的系统结构中理解。",
    "s05.use.audit.label": "审核：验证行为可信性",
    "s05.use.audit.1": "进入 L3 后，读者检查具体行为单元的触发条件、权限规则、状态变化、回退路径和代码证据。",
    "s05.use.audit.2": "目标是验证公开 Harness 的实际行为是否符合预期，并识别潜在绕过路径或隐藏风险。",
    "s05.use.audit.3": "审核不依赖文档承诺，而是沿行为路径回到可复核的实现依据。",
    "s05.use.agent.label": "改造：定位修改边界",
    "s05.use.agent.1": "当需要调整行为时，读者先沿 Handbook 定位相关行为单元、实现链接和依赖路径。",
    "s05.use.agent.2": "这条证据路径可以进一步转化为编辑计划，减少全仓库搜索，并降低遗漏关键实现点的风险。",
    "s05.use.agent.3": "编辑计划引用 Handbook 证据，执行阶段再回到真实代码中验证和修改。",

    /* ---- §06 ---- */
    "s06.num": "第 06 节",
    "s06.title": "Coding agent 如何使用 Harness Handbook？",
    "s06.p1":
      "这一节展示 Harness Handbook 如何支持 coding agent 在修改前完成行为定位与规划。给定一个自然语言修改请求，agent 不直接进行全仓库搜索，而是先通过 BGPD 查阅 Handbook：从 L1 系统概览建立上下文，经由 L2 行为单元概览定位相关行为单元，再进入 L3 行为单元详解核对代码证据，并据此生成编辑计划。实验中，我们使用基于 NexAU 框架的 coding agent 作为 planner，并以 DeepSeek-V4-Pro 作为 planner LLM，模拟 Harness 修改前的定位与规划阶段。为隔离 Handbook 的影响，对比实验仅改变一个条件：planner 在定位前是否使用 Harness Handbook。",
    "s06.spec1.label": "被测 Harness",
    "s06.spec1.value": "Terminus-2 与 Codex",
    "s06.spec1.note": "两个真实生产级 Harness，覆盖多阶段控制流、工具编排、状态管理和跨模块行为。",
    "s06.spec2.label": "对照设置",
    "s06.spec2.value": "Agent 使用 Handbook vs. 不使用 Handbook",
    "s06.spec2.note": "两组使用相同的 coding agent、planner LLM 和编码流程；唯一区别是 agent 在行为定位前是否沿 BGPD 查阅 Harness Handbook。",
    "s06.spec3.label": "评审设置",
    "s06.spec3.value": "三个独立评审模型",
    "s06.spec3.note": "评估关注 planner 是否找对行为落点并形成合理修改计划，而非最终代码是否一次通过。每组 pairwise comparison 由 GPT-5.5、Opus 4.8 和 DeepSeek-V4-Pro 分别评审。",
    "s06.reqtypes":
      "修改请求分为三类：<b>Q（Query）</b> 表示对已有行为的局部调整，例如改变触发条件、执行时机或控制流；<b>CF（Cross-file）</b> 表示跨文件的端到端能力扩展，需要同时贯通 schema、流水线逻辑、运行时行为和外部接口；<b>SH（Search-hostile）</b> 表示对搜索不友好的改动，通常分散在镜像实现、回退路径或冷门执行路径中，容易被关键词搜索遗漏。",

    "s06.r1.tag": "结果 1",
    "s06.r1.head": "更准确的行为定位，更低的搜索成本",
    "s06.r1.p":
      "成对评审结果显示，在两个 Harness 上，使用 Handbook 的 planner 都更常定位到目标行为对应的正确实现位置，同时每个案例消耗的 planner token 更少。这说明 Handbook 的作用并不是简单增加上下文，而是将搜索过程引向更相关的代码区域，从而减少无关探索并提高规划效率。",
    "chart.win.title": "总体偏好率",
    "chart.win.sub": "成对比较中获胜的百分比 · 越高越好",
    "chart.tok.title": "Planner token 成本",
    "chart.tok.sub": "每案例百万 token · 越低越好",
    "legend.baseline": "基线",
    "legend.handbook": "使用 Handbook",
    "s06.r1.figcap":
      "<b>偏好率提升，搜索成本下降。</b>在两个 Harness 上，评审模型都更偏好使用 Handbook 的 planner；同时，每个案例的 planner token 成本也有所下降。",
    "chart.judges.title": "三位评审模型，两个 Harness",
    "chart.judges.sub": "各评审给出的偏好率：不用 → 使用 Handbook",
    "chart.judges.axis": "偏好率 %",
    "s06.judges.figcap":
      "<b>增益并非来自单一评审偏差。</b>三位评审模型在两个 Harness 上都更偏好使用 Handbook 的 planner，说明结果并不依赖某一个评审模型。",

    "s06.r2.tag": "结果 2",
    "s06.r2.head": "增益主要来自更准确的行为定位",
    "s06.r2.p":
      "为分析改进来源，我们将 planner 预测的修改位置与参考计划对齐，并在文件级和符号级两个粒度上评估定位质量。参考计划由独立模型生成，包括 Opus 4.8 和 GPT-5.5，用作对照基准。结果显示，使用 Handbook 后，Recall、Precision 和 F1 在几乎所有设置下同步提升；同时，完全落入错误子系统的 <i>Wrong</i> 案例明显减少。这说明 Handbook 的主要作用是提升行为定位准确性，帮助 planner 更可靠地找到目标行为对应的实现位置。",
    "seg.opus": "Opus 4.8 参考",
    "seg.gpt": "GPT-5.5 参考",
    "seg.opus.short": "Opus 4.8",
    "seg.gpt.short": "GPT-5.5",
    "loc.th.harness": "Harness",
    "loc.th.level": "粒度",
    "loc.th.metric": "指标",
    "loc.th.baseline": "基线",
    "loc.th.handbook": "Handbook",
    "loc.th.gap": "Δ",
    "loc.l.file": "文件",
    "loc.l.symbol": "符号",
    "loc.m.recall": "Recall",
    "loc.m.precision": "Precision",
    "loc.m.f1": "F1",
    "loc.m.wrong": "Wrong",
    "loc.cap":
      "<b>以参考答案为基准的定位得分</b>（{label} 参考）。<b>Wrong</b> 越低越好。",
    "s06.r3.tag": "结果 3",
    "s06.r3.head": "跨请求类型与定位难度保持稳定",
    "s06.r3.p":
      "Handbook 的优势在三类请求类型以及 Easy、Medium、Hard 三个定位难度上都保持稳定。Easy 案例通常只涉及一个主要行为单元或少量直接实现位置；Medium 案例需要协调多个行为单元、状态变化或跨文件依赖；Hard 案例则要求发现隐藏在非显式执行路径中的依赖关系。结果表明，Handbook 不仅有助于处理局部、直接的修改请求，也能支持定位分散在 Harness 多处的复杂行为。",
    "seg.codex": "Codex",
    "seg.terminus": "Terminus",
    "seg.pattern": "按请求类型",
    "seg.difficulty": "按难度",
    "sc.q": "Q · 微调",
    "sc.cf": "CF · 跨文件",
    "sc.sh": "SH · 搜索不友好",
    "sc.easy": "Easy",
    "sc.medium": "Medium",
    "sc.hard": "Hard",
    "s06.r3.figcap":
      "<b>稳定泛化。</b>在两个 Harness 上，使用 Handbook 的 planner 在不同请求类型和不同定位难度下都获得更高偏好率，说明增益并不局限于某一类修改模式或某一档难度。",

    /* ---- §07 ---- */
    "s07.num": "第 07 节",
    "s07.title": "结果解读：Handbook 如何改善行为定位？",
    "s07.i1.title": "行为地图比文件树更适合理解 Harness",
    "s07.i1.p":
      "文件树回答的是“代码放在哪里”，但理解、审核和改造 Harness 时，真正关键的问题是“系统会做什么”以及“这些行为由哪些实现位置共同支撑”。Harness Handbook 按行为组织系统，因此更接近人类理解、检查和修改复杂 Harness 的方式。",
    "s07.i2.title": "Handbook 不是扩大搜索，而是提高相关性",
    "s07.i2.p":
      "实验中 Recall 和 Precision 同时提升，说明 Handbook 并不是让 planner 检查更多位置，而是将搜索引向更相关的实现区域。换言之，它在减少无关探索的同时，提高了目标行为定位的覆盖度和准确性。",
    "s07.i3.title": "理解、审核和修改共享同一条证据路径",
    "s07.i3.p":
      "理解需要系统级行为视图，审核需要可验证的实现证据，修改需要定位相关代码位置。Harness Handbook 将这三类需求连接到同一条从行为问题到代码证据的路径上，因此既服务人类读者，也能支持 planner 生成更可靠的编辑计划。",

    /* ---- §07 · Studio ---- */
    "sui.num": "第 07 节",
    "sui.title": "Handbook Studio：面向人类用户的 Harness 控制台",
    "sui.cta": "打开 Handbook Studio 交互演示",
    "sui.cta.note": "在浏览器中直接运行——完整的 Codex 与 Terminus Handbook、Handbook 与代码的对应，以及一个已保存的 Co-Edit 示例。",
    "sui.p1":
      "Harness Handbook 最有价值的形态，不是一份静态文档，而是一个可以被使用的交互入口。Handbook Studio 将它变成面向人类用户的工作台：接入一个 Harness 仓库后，系统生成三层 Handbook；此后，用户可以通过这份 Handbook 阅读系统行为，从任意行为描述跳转到对应的代码证据，并在同一张行为地图上发起可审查的修改。Handbook 负责组织理解与操作路径，仓库始终是事实来源。",
    "sui.tab1.label": "阅读",
    "sui.tab1.value": "Handbook",
    "sui.tab1.note":
      "三层 Handbook 被组织为可导航的工作台：系统概览、执行阶段、行为单元与关键概念逐层展开。用户也可以直接提问，快速理解某个行为如何触发、执行并影响系统状态。",
    "sui.tab2.label": "对照",
    "sui.tab2.value": "Handbook ⇄ Code",
    "sui.tab2.note":
      "每条行为描述都能回到代码证据。点击行为单元、状态变量或执行路径时，分屏视图会在右侧打开对应源码；左侧用于理解行为解释，右侧用于核对实现依据。",
    "sui.tab3.label": "修改",
    "sui.tab3.value": "Co-Edit",
    "sui.tab3.note":
      "修改从行为地图发起。用户选中行为单元并描述目标变化后，系统生成可审查的修改计划和代码 diff；用户确认后再写入仓库，并同步更新 Handbook。",
    "sui.loop.head": "一个使用案例：从行为问题到可审查修改",
    "sui.loop.p":
      "以一个真实场景为例：一位量化研究员希望基于 Codex 搭建自己的研究型 agent，用来自动运行数据实验。比如，他想用过去几年的行情数据测试某个交易策略是否有效，也就是业内常说的“回测”。这类实验通常需要反复调整参数并多次运行：研究员希望 agent 在执行某一条命令时，能够为这条命令单独指定一组环境变量，例如访问行情数据所需的密钥、当前实验的起止日期等。这些变量只在本次命令执行期间生效，命令结束后就被清除，不会影响后续命令。换句话说，这是一个看似简单的行为需求：<b>“让这条命令带上自己的环境变量。”</b><br><br>放回文件树中，这个看似简单的需求会分散到多个实现位置：首先，命令参数的数据结构需要新增 <code>env</code> 字段；其次，工具说明需要告诉模型可以使用这个字段；然后，执行链路需要把这组环境变量传到真正启动命令的位置，并确保它只对当前命令生效；最后，相关测试也需要同步更新，验证新的字段和执行行为是否正确。具体来说，这会牵涉 <code>ShellCommandToolCallParams</code>、<code>ExecCommandArgs</code>、<code>to_exec_params</code>、<code>ExecCommandRequest</code>、<code>process_manager</code> 以及三个测试文件，总共 <b>10 个文件中的 14 处实现</b>。手工找齐这些位置既繁琐，也很容易遗漏。<br><br>而在交互式 Handbook 中，用户不需要先去查找这些文件。用户只需要用自然语言说明希望改变的行为：某条命令可以携带一组临时环境变量，并且这些变量只在这条命令执行期间生效。Handbook Studio 会将这个需求定位到“命令执行与环境变量”这一行为单元，并映射回相关证据链，列出需要修改的实现位置，生成可审查的修改计划和代码 diff。对用户来说，这只是行为地图上的一个字段级改动；真正写入仓库时，系统会把它展开为 10 个文件中的 14 处实现更新。用户审阅并确认后，代码和 Handbook 会同步更新。",
    "sui.flow.1": "① 提出行为问题",
    "sui.flow.2": "② 定位行为单元",
    "sui.flow.3": "③ 对照代码证据",
    "sui.flow.4": "④ 发起修改意图",
    "sui.flow.5": "⑤ 审阅并同步",
    "sui.figcap":
      "<b>一个行为级需求，多个实现落点。</b>用户只提出“让这条命令带上自己的环境变量，且不影响后续命令”的需求；在行为地图上，这只是一个字段级 diff。确认后，该改动会展开到参数 schema、两份工具描述、shell 与 unified-exec 两条执行链路、spawn 环境合并点，以及断言工具规格的测试镜像——最终同步为 <b>10 个文件里的 14 处代码更新</b>。",
    "sui.g1":
      "<b>从行为问题开始。</b>用户不需要先理解仓库结构，而是直接提出想理解、审核或修改的行为。系统会将这个问题放回执行流程中，定位相关阶段与行为单元。",
    "sui.g2":
      "<b>用代码证据验证。</b>Handbook 负责解释行为如何发生，源码证据负责验证这些解释是否成立。用户可以在同一界面中完成行为阅读、源码核对和证据追踪。",
    "sui.g3":
      "<b>在行为地图上修改。</b>当行为不符合预期时，用户可以在对应行为单元上提出修改意图。系统会生成可审查的修改计划和代码 diff，并在用户确认后写入仓库、同步更新 Handbook。",

    /* ---- §08 ---- */
    "s08.num": "第 08 节",
    "s08.title": "要点总结",
    "s08.1": "代码公开不等于行为清楚。复杂 Agent Harness 需要一份按系统行为组织、并能回到代码证据的行为级说明书。",
    "s08.2": "通过系统概览与行为单元地图，建立 Harness 的执行流程、状态流转和行为结构。",
    "s08.3": "将权限规则、确认逻辑、回退路径、数据流和冷门分支连接到可验证的实现证据。",
    "s08.4": "将目标行为映射到相关文件、函数和执行路径，使修改前的定位更准确，并减少全仓库搜索。",
    "s08.5": "Harness Handbook 不再只是静态文档，而是人类用户进入 Harness 的交互入口：从行为问题出发，完成阅读、验证，并在同一张行为地图上发起可审查的修改。",
    "s08.closing":
      "同一张行为地图同时服务人和 coding agent：读者可以从行为问题进入系统，planner 可以在修改前完成定位，每个判断都能回到代码证据。Harness Handbook 的核心价值不是替代代码，而是让理解、审核和修改都以可验证的代码证据为依据。",

    /* ---- footer ---- */
    "footer.cite.title": "引用本工作",
    "bib.copy": "复制",
    "bib.copied": "已复制 ✓",
    "bib.failed": "复制失败",

    /* ================= figures (script.js) ================= */
    /* hero */
    "fig.hero.aria": "一条行为请求，经由 Handbook 映射到代码中的实现位置",
    "fig.hero.olA": "你想要的行为",
    "fig.hero.q1": "「删除文件之前",
    "fig.hero.q2": "先询问用户。」",
    "fig.hero.subA1": "由用户用自然语言",
    "fig.hero.subA2": "表述。",
    "fig.hero.olB": "HANDBOOK",
    "fig.hero.l1": "系统概览",
    "fig.hero.l1s": "整体执行流程",
    "fig.hero.l2": "行为单元概览",
    "fig.hero.l2s": "相关行为单元",
    "fig.hero.l3": "行为单元详解",
    "fig.hero.l3s": "实现证据与路径",
    "fig.hero.olC": "它在代码中的落点",
    "fig.hero.subC": "五个分散的落点——在动手编辑之前就已找齐",

    /* tree */
    "fig.tree.aria": "删除文件前是否先询问用户这一行为对应 Harness 代码库中多个分散文件",
    "fig.tree.olA": "行为问题",
    "fig.tree.q1": "「删除文件之前",
    "fig.tree.q2": "先询问用户。」",
    "fig.tree.subA": "",
    "fig.tree.olC": "每个落点做什么",
    "fig.tree.a1": "记录用户是否批准",
    "fig.tree.a2": "拦截删除工具调用",
    "fig.tree.a3": "告诉模型删除前要询问",
    "fig.tree.a4": "定义删除为高风险操作",
    "fig.tree.a5": "记录确认结果",
    "fig.tree.a6": "处理沙箱执行与回退路径",
    "fig.tree.stat1": "一个行为，多个实现位置。",
    "fig.tree.stat2": "关键词搜索容易漏掉间接路径。",

    /* levels */
    "fig.levels.aria": "Harness Handbook 通过三层结构从系统理解逐步连接到行为证据",
    "fig.levels.funnel.title": "从系统理解到行为证据",
    "fig.levels.funnel.sub": "Harness Handbook 通过三层结构逐步组织行为信息。",
    "fig.levels.input.label": "Harness 仓库",
    "fig.levels.input.text": "代码事实被组织为三层 Handbook",
    "fig.levels.l1.level": "L1",
    "fig.levels.l1tab": "L1 · 系统概览",
    "fig.levels.l1task": "建立整体系统理解",
    "fig.levels.l1q1": "问题：这个 Harness 整体如何运行？",
    "fig.levels.l1q2": "关注架构、执行流程、主要阶段和状态流。",
    "fig.levels.l1out1": "输出",
    "fig.levels.l1out2": "系统级行为框架",
    "fig.levels.st1": "输入",
    "fig.levels.st2": "规划",
    "fig.levels.st3": "执行",
    "fig.levels.st4": "观察",
    "fig.levels.st5": "收尾",
    "fig.levels.l2.level": "L2",
    "fig.levels.l2tab": "L2 · 行为单元概览",
    "fig.levels.l2task": "理解系统由哪些行为单元组成",
    "fig.levels.l2q1": "问题：有哪些行为单元，彼此如何衔接？",
    "fig.levels.l2q2": "关注职责、输入输出、前后关系和关键状态。",
    "fig.levels.l2out1": "输出",
    "fig.levels.l2out2": "行为单元地图",
    "fig.levels.c1": "工具调用",
    "fig.levels.c1s": "校验、分发并包装每次工具调用",
    "fig.levels.c2": "沙箱执行",
    "fig.levels.c2s": "隔离副作用",
    "fig.levels.c3": "结果路由",
    "fig.levels.c3s": "把输出转发给状态与遥测",
    "fig.levels.l3.level": "L3",
    "fig.levels.l3tab": "L3 · 行为单元详解",
    "fig.levels.l3title": "删除文件前确认",
    "fig.levels.l3task": "深入单个行为单元内部",
    "fig.levels.l3q1": "问题：这个行为单元如何具体执行？",
    "fig.levels.l3q2": "关注触发条件、状态变化、异常路径和代码证据。",
    "fig.levels.l3out1": "输出",
    "fig.levels.l3out2": "可验证实现证据",

    /* pipeline */
    "fig.pipe.aria": "Handbook 构建流程：提取事实、按行为组织、合成手册",
    "fig.pipe.repo": "harness 仓库",
    "fig.pipe.t1": "提取事实",
    "fig.pipe.d1a": "对文件、函数、调用、",
    "fig.pipe.d1b": "状态与配置做静态分析",
    "fig.pipe.o1": "程序图",
    "fig.pipe.t2": "按行为组织",
    "fig.pipe.d2a": "把代码映射到执行骨架上，",
    "fig.pipe.d2b": "反复精化直至收敛",
    "fig.pipe.o2": "行为地图",
    "fig.pipe.t3": "合成手册",
    "fig.pipe.d3a": "渲染三层结构，",
    "fig.pipe.d3b": "保留全部证据链接",
    "fig.pipe.o3": "Handbook · L1–L3",
    "fig.pipe.loop": "提议者 ⇄ 评审者，直至收敛",
    "fig.pipe.foot": "文字解释，事实锚定——每个条目都链接到可验证的代码证据。",

    /* bgpd */
    "fig.bgpd.aria": "BGPD 将行为问题沿 L1 L2 L3 逐步收窄到代码证据，修改时再形成编辑计划",
    "fig.bgpd.h1": "1 · 行为问题",
    "fig.bgpd.h2": "2 · L1 系统概览",
    "fig.bgpd.h3": "3 · L2 行为单元概览",
    "fig.bgpd.h4": "4 · L3 行为单元详解",
    "fig.bgpd.h5": "5 · 证据 / 编辑计划",
    "fig.bgpd.q1": "删除文件前",
    "fig.bgpd.q2": "是否需要确认？",
    "fig.bgpd.st1": "输入阶段",
    "fig.bgpd.st2": "规划阶段",
    "fig.bgpd.st3": "工具执行阶段",
    "fig.bgpd.st4": "观察阶段",
    "fig.bgpd.st5": "收尾阶段",
    "fig.bgpd.u1": "删除前确认",
    "fig.bgpd.u2": "权限规则",
    "fig.bgpd.u3": "状态记录",
    "fig.bgpd.u4": "回退路径",
    "fig.bgpd.l3form": "行为单元 · 触发/状态/证据",
    "fig.bgpd.l3title": "删除文件前确认",
    "fig.bgpd.l3r1": "触发：delete_file(path)",
    "fig.bgpd.l3r2": "权限：高风险操作",
    "fig.bgpd.l3r3": "状态：记录用户确认",
    "fig.bgpd.l3r4": "路径：批准 / 拒绝",
    "fig.bgpd.l3r5": "证据：5 处实现",
    "fig.bgpd.d1": "确认检查",
    "fig.bgpd.d2": "权限规则",
    "fig.bgpd.d3": "绕过直删",
    "fig.bgpd.d4": "证据支持计划",
    "fig.bgpd.coarse": "粗 — 系统上下文",
    "fig.bgpd.fine": "细 — 代码证据",
    "fig.bgpd.note": "按需展开信息；证据可用于理解、审核，也可继续支持修改计划。",
  };

  /* ===================== runtime ===================== */
  let currentLang = "en";
  const EN = {};
  let cached = false;

  function cacheDefaults() {
    if (cached) return;
    cached = true;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) EN[key] = el.innerHTML;
    });
    document.querySelectorAll("[data-i18n-text]").forEach((el) => {
      const key = el.getAttribute("data-i18n-text");
      if (key) EN[key] = el.textContent;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) EN[key] = el.getAttribute("title") || "";
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria");
      if (key) EN[key] = el.getAttribute("aria-label") || "";
    });

    EN["meta.title"] = document.title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) EN["meta.description"] = metaDesc.getAttribute("content") || "";
  }

  function getLang() {
    return currentLang;
  }

  function tr(key, enFallback) {
    cacheDefaults();
    if (currentLang === "zh" && Object.prototype.hasOwnProperty.call(ZH, key)) {
      return ZH[key];
    }
    if (Object.prototype.hasOwnProperty.call(EN, key)) return EN[key];
    if (enFallback !== undefined) return enFallback;
    return key;
  }

  function applyMeta(lang) {
    const pack = META[lang] || META.en;
    document.title = pack.title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute("content", pack.description);
  }

  function applyLang(lang) {
    if (!VALID.has(lang)) lang = "en";
    cacheDefaults();
    currentLang = lang;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

    applyMeta(lang);

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.innerHTML = tr(key);
    });
    document.querySelectorAll("[data-i18n-text]").forEach((el) => {
      const key = el.getAttribute("data-i18n-text");
      if (key) el.textContent = tr(key);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.setAttribute("title", tr(key));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria");
      if (key) el.setAttribute("aria-label", tr(key));
    });

    const langSwitch = document.getElementById("lang-switch");
    if (langSwitch) {
      langSwitch.querySelectorAll(".seg__btn[data-lang]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.lang === lang);
      });
    }

    document.dispatchEvent(new CustomEvent("hh-langchange", { detail: { lang } }));
  }

  function setLang(lang) {
    if (!VALID.has(lang)) return;
    try {
      localStorage.setItem(LS_KEY, lang);
    } catch (_) { /* private mode */ }
    applyLang(lang);
  }

  function init() {
    let saved = "en";
    try {
      saved = localStorage.getItem(LS_KEY) || "en";
    } catch (_) {
      saved = "en";
    }
    const forced = new URLSearchParams(location.search).get("lang"); // ?lang=en|zh
    if (VALID.has(forced)) saved = forced;
    applyLang(saved === "zh" ? "zh" : "en");

    const langSwitch = document.getElementById("lang-switch");
    if (langSwitch) {
      langSwitch.querySelectorAll(".seg__btn[data-lang]").forEach((btn) => {
        btn.addEventListener("click", () => setLang(btn.dataset.lang));
      });
    }
  }

  window.HH_I18N = { getLang, setLang, tr, applyLang, cacheDefaults, ZH, META, init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
