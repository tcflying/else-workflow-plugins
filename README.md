# else-workflow-plugins

<!-- project-evidence-rules:20261006 -->
> 开发与验收接续：先读 [本目录 AGENTS](./AGENTS.md) 的“每轮推进与独立验收铁律”。每项目每轮记录真实推进/局部阻塞、原始证据、实际验证和未测边界；已授权下一步同步执行，旧证据不冒充新增，自报 PASS 不作为独立验收。失败/阻塞可诚实收束，不要求轮轮成功。统一 task 规范与证据 CLI 的本机路径、加载范围和无 Stop Hook 限制见该入口。
<!-- /project-evidence-rules:20261006 -->

MiniMax Code（MMX）与 DSH 双宿主的**实时工作流插件**：在宿主聊天界面里直接看到工作流运行卡片（阶段、子代理、tokens、耗时、结果、历史），零第三方依赖，不修改宿主源码。两端共享同一套文件后端引擎 [`wf.mjs`](./plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs)（0.8.1）。

> 语言：中文（README）。代码注释与测试名以英文为主。

## 当前状态（2026-10-10，全部为已测事实）

| 项 | 状态 |
| --- | --- |
| W1—W7 波次（F01—F24） | ✅ 已改、已隔离测试、已独立复查（台账见 [`1004.md`](./1004.md) §10） |
| MMX 生产 GUI 验收 | ✅ r3 端到端 8/8（真实点击走 Chromium 输入管线：LIVE 卡片→阶段推进→完成态→结果/看板/历史/脚本四 modal→✕ 全关），63/63 隔离测试绿 |
| DSH core 0.2.0-rc.2（Desktop 2.0.17）适配 | ✅ 0.2.7，99/99 测试绿；无头 core 实机验证 API 200 + 客户端物化；生产已激活（健康启动实证） |
| MMX sidecar 自愈看护 | ✅ 实战验证：杀 sidecar→自动拉活→重注入；宿主被外部重启后全链自动恢复 |
| 原生会话 Hook（MMX） | ⚠️ 已加载、已触发，但宿主 hook 执行通道对本机**所有**本地插件都 `HOOK_TIMEOUT`（含第三方样例插件，宿主侧问题）；会话归属请用卡片上「🔗 绑定当前会话」显式绑定，功能不受阻 |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| [`mmx-workflow-pipeline/`](./mmx-workflow-pipeline/README.md) | MMX 端：`sidecar.mjs`（编排 Host + CDP 注入）、`client-inject.js`（渲染器客户端）、`scripts/sidecar-watchdog.mjs`（自愈看护）、`install-skills.mjs` |
| [`dsh-workflow-pipeline/`](./dsh-workflow-pipeline/README.md) | DSH 端：`index.mjs`（Host）、`client.js`（客户端）、`run-lifecycle.mjs`、`test/iso/launch-dsh-isolated.ps1` |
| [`plugins/dynamic-workflow/`](./plugins/dynamic-workflow) | 共享引擎 `runtime/wf.mjs` + 引擎测试 |
| [`plugins/mmx-native-session-hook/`](./plugins/mmx-native-session-hook) | MMX 原生会话归属 Hook（manifest + relay） |
| `workflow-pipeline-guide/` | 2026-10-03 归档基线（submodule，[tcflying/workflow-pipeline-guide](https://github.com/tcflying/workflow-pipeline-guide) @ `dd6853c`） |
| [`1004.md`](./1004.md) · [`workflow-ui-v2-SPEC.md`](./workflow-ui-v2-SPEC.md) | 修复台账（权威记录）· UI v2 规范 |

---

# 使用说明

## 一、MMX（MiniMax Code 桌面版）

### 1.1 一次性安装

前置：MiniMax Code 桌面版已登录；Node ≥ 20；仓库在本机（`G:/mmx-project/zcode动态工作流-原else`）。

```bash
# ① 启动编排 Host + 注入器（监听 127.0.0.1:4231，经 CDP 127.0.0.1:9331 注入）
node mmx-workflow-pipeline/sidecar.mjs
#    看到 "workflow renderer attached" 即注入成功。
#    端口被占会明确报错退出（固定端口纪律，绝不静默换端口）。

# ② （推荐）装自愈看护 + 开机自启：sidecar 死了自动拉活（宿主在时才拉）
node mmx-workflow-pipeline/scripts/install-watchdog-startup.mjs --write   # 写入 Startup 文件夹 VBS
node mmx-workflow-pipeline/scripts/install-watchdog-startup.mjs --launch  # 立即启动看护循环

# ③ 部署 /mmx-workflow 技能（引擎路径随仓库移动后需重跑一次）
node mmx-workflow-pipeline/install-skills.mjs --force

# ④ 原生会话 Hook（可选，自动归属用）：拷贝到宿主插件目录
#    C:/Users/datoo/.minimax/plugins/mmx-native-session-hook/  ← 本仓 plugins/ 同名目录
#    注意：当前宿主 hook 通道有 HOOK_TIMEOUT 问题（见排障表），归属推荐用卡片按钮
```

宿主窗口需带调试端口启动才会被注入：`MiniMax Code.exe --remote-debugging-port=9331 --remote-debugging-address=127.0.0.1`。注入器每 10 秒轮询、断连 5 秒重试，宿主重启后只要 sidecar 活着会自动重注入。

### 1.2 日常使用

**方式 A（推荐）：自然语言。** 在 MMX 聊天里描述"同一件事多目标/多角度/多对象扇出"类需求，`/mmx-workflow` 技能会自动加载并由宿主代理调引擎。

**方式 B：命令行直跑**（在仓库根）：

```bash
# echo 后端：子代理原样回显，秒回，用于验证 UI/链路
node plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs run examples/demo.js \
  --backend echo --yes --run-id demo-1 --name "演示" --concurrency 2

# file 后端：真实等待真人作答（parked 协议，见 1.3）
node plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs run my-flow.js \
  --backend file --yes --run-id my-run --concurrency 1
```

运行开始后，**MMX 聊天界面顶部出现实时卡片**：

- 标题行：状态图标（⚙运行中 / ✓完成 / !失败）· 运行名 · 归属 · `N 个阶段 · M 个子代理` · 耗时
- 控制钮：`⏹` 停止 · `↻` 恢复 · `⤢` 展开 · `×` 关闭卡片（不删运行）
- 阶段行：每阶段 `阶段名 · 进度 n/m`，子代理逐个翻状态
- 正文预览：每个 agent 调用的 prompt 与结果摘要
- 底部入口：`📋 发现看板（按严重度）` · `📄 结果` · `🗂 历史` · `🔗 绑定当前会话`
  - **绑定当前会话**：把运行归属到当前聊天会话（侧栏进度在 DSH 有；MMX 侧栏操作代码已按产品决策移除，MMX 只有卡片）
  - **🗂 历史**：全局历史（含未绑定运行），可从任何会话打开已完成运行
- 顶部常驻入口：非会话页面显示 `🗂 工作流历史` 全局入口

### 1.3 file 后端的真人作答（parked 协议）

`agent()` 调用会 park 住等真人：引擎把请求写到 `<runDir>/pending/<callId>.json`，人把答案写到 `<runDir>/inbox/<callId>.json` 即完成作答：

```bash
# 1. 看问题
cat .qoder/workflow-runs/<runId>/pending/c000-xxxxxxxx.json
# 2. 作答（ok:true + text）
echo '{"ok":true,"text":"你的回答"}' > .qoder/workflow-runs/<runId>/inbox/c000-xxxxxxxx.json
```

默认 park 窗口 900 秒；脚本里可按调用放宽：`await agent('...', { timeoutMs: 1500000 })`（`timeoutMs` 不参与 callId 哈希，同一 prompt 的 callId 稳定）。`ask()` 的问题走卡片上的输入框作答。

### 1.4 看护与自愈

看护每 15 秒决策一次：4231 活 → 不动；4231 死且宿主 CDP 活 → 自动重启 sidecar；宿主不在 → 不空跑。日志：`mmx-workflow-pipeline/logs/sidecar-watchdog.log`（单轮试跑：`node …/sidecar-watchdog.mjs --once`）。看护带 `--no-launch` 语义，**永远不会启动或替换宿主进程**。

---

## 二、DSH（DSH Desktop，壳 2.0.17 / core 0.2.0-rc.2）

### 2.1 一次性部署

DSH 端是**原生 cordis 插件**（非注入），装进 profile：

```bash
P=~/.dsh/profiles/desktop   # 生产 profile（先备份 package.json / pnpm-lock.yaml）

# ① 在 $P/package.json 里加两处：
#    "dependencies": { "@dsh-external/dsh-workflow-pipeline": "file:<本仓>/dsh-workflow-pipeline", ... }
#    "dsh": { "profile": { "bundles": [ ..., "@dsh-external/dsh-workflow-pipeline" ] } }
#    （第三方 bundle 会被宿主 desktopBundleList 保留追加，默认组合不丢；bundle 必须带 dsh.bundle 声明）

# ② 安装依赖（只在 DSH 关闭时做；绝不在官方 app 运行中写 node_modules）
cd "$P" && pnpm install

# ③ 配置扫描根：本仓 dsh-workflow-pipeline/cordis.patch.yml 的 config.roots 改成你的工作区
#    （每根扫描自身及下一层项目的 .qoder/workflow-runs）

# ④ 重启 DSH Desktop（Host 半生效）；只改 client.js 时原生 Ctrl+R 即可
```

已在 Desktop 2.0.17（内置 core 0.2.0-rc.2）实机验证：组合零错误、`/dsh-workflow-pipeline/api/runs` 200、客户端 bundle 注册+物化。

### 2.2 日常使用

与 MMX 卡片同一套交互：运行卡片（阶段/子代理/统计/四入口）+ **侧栏会话行下的进度线**（仅对显式绑定的运行显示，绝不猜测归属）。API 与宿主 webserver 同端口同守卫（带 token 才可访问）：

```
GET /dsh-workflow-pipeline/api/runs[?cwd=…]   # 运行列表
GET  /script?run=<id> | /result?run=<id>      # 脚本 / out.json
POST /stop?run=<id> | /resume?run=<id> | /answer?run=<id>&q=<qId>
```

Host 逻辑更新需原生重启 Harness；宿主更新后按 [`dsh-workflow-pipeline/README.md`](./dsh-workflow-pipeline/README.md) 的兼容基线复核。

---

## 三、引擎 wf.mjs CLI 参考

```
wf.mjs run <script.js> [--name L] [--args JSON|--args-file f] [--backend cli|file|echo]
           [--concurrency N] [--cwd DIR] [--run-id ID] [--max-calls N] [--script-timeout MS]
           [--yes] [--trusted] [--saved NAME --scope project|global]
wf.mjs check <script.js> [--args JSON]   # 静态检查，不分发
wf.mjs save <script.js> --name N         # 存为可复用工作流
wf.mjs list | status [runId] | result <runId> | paths
wf.mjs resume <runId> [--backend file] [--force]   # 注意：file 后端 resume 必须带 --backend file
wf.mjs stop <runId> [--force]
wf.mjs steer <runId> "<note>"            # 运行中注入提示
wf.mjs trust <name> | untrust <name>
wf.mjs ui [--port N]                     # 本项目运行的实时看板（127.0.0.1:4230）
```

退出码：`0` 成功 · `1` 运行失败/命令出错 · `2` 用法/脚本被拒（未分发）· `3` 安全拒绝（活进程占 runId、已结算、resume 参数不符等，`--force` 可覆盖部分）。

**脚本 API**（沙箱内：禁 `setTimeout`/`Date.now`，提供 `agent/ask/publish/parallel/pipeline/notes/phase/log/args/meta`）：

```js
export const meta = { name: 'my-flow', description: '…' };
phase('阶段A');
const a = await agent('子代理提示词', { timeoutMs: 1500000 });   // 返回文本
const b = await ask('给用户的问题');                              // 卡片输入框作答
const rs = await parallel([() => agent('x'), () => agent('y')]);  // 扇出
return { a };                                                     // out.json 的 result
```

三种后端：`echo`（回显，秒回，测链路）、`file`（真人 parked 作答，见 1.3）、`cli`（默认，走宿主 CLI）。

---

## 四、排障速查

| 症状 | 处置 |
| --- | --- |
| MMX 里没有卡片 | ① `netstat -ano \| findstr 4231` 有无 LISTEN；② sidecar 日志末行有无 `workflow renderer attached`；③ 宿主是否带 `--remote-debugging-port=9331` 启动；④ 看护是否在跑（`logs/sidecar-watchdog.log`） |
| 4231 被占 | 固定端口纪律会报错退出——找到占用方（`netstat` 的 PID），不要换端口 |
| 宿主重启后卡片消失 | sidecar 会自动重注入；若 sidecar 本身死了，看护会拉活；都没装就手动跑 `node mmx-workflow-pipeline/sidecar.mjs` |
| MMX 卡上显示「未绑定」 | 点卡片底部「🔗 绑定当前会话」；原生 hook 通道当前有宿主侧 HOOK_TIMEOUT 问题（所有本地插件同样超时，非本插件问题） |
| DSH 改了 Host 文件没生效 | Host 半需重启 Harness；只改 client.js 可 Ctrl+R；`patchReload: "live"` 的 profile 上 patch 改动等一次原生重载 |
| DSH 启动报 "profile bundle … declares no dsh.bundle" | 该 bundle 的 package.json 缺 `dsh.bundle` 声明（2.0.17 起强制） |
| DSH 升级后插件不兼容 | 先读 [`dsh-workflow-pipeline/README.md`](./dsh-workflow-pipeline/README.md) 兼容基线节；对宿主安装树跑 `test/host-0.2.0-rc.2-contract.test.mjs` 类只读断言 |
| 回滚 | MMX：sidecar/看护直接停；DSH：恢复 profile 的 package.json + pnpm-lock 备份，安装副本内的 `.bak-*` 目录是逐字节原件 |

---

## 安全设计要点

- **capability 不入源码**：sidecar 运行时随机生成，注入时才替换占位符 `__MMXDWF_CAPABILITY__`；MMX Host 校验 capability + Origin（`app://./archon` 回显），缺证一律 `403`。
- **写盘边界**：`wx` 独占创建、OWNER 存活检查、startedAt 代际差 ≤2s fail-closed、runDir realpath 身份绑定、缓存命中与最终写盘前双重身份重核。
- **DSH 侧**：不修改宿主源码/app.asar；profile 内 file: 依赖指向本仓；官方 app 运行中绝不写其 node_modules。

## 测试

零第三方依赖（仅 Node 内置）。逐文件 `node --test <路径>/*.test.mjs`。2026-10-10 实测：DSH 套件 **99/99**；MMX 套件（20 文件）**469/477**——8 个红全部是 `deployment-safety.test.mjs` 既有夹具漂移（历史文档化红，不放宽求绿）；引擎套件全绿。**两个禁跑文件**（历史夹具写共享 Temp）：`mmx-workflow-pipeline/test/host-lifecycle.test.mjs`、`plugins/dynamic-workflow/test/wf.test.mjs`。

## 本机锚定声明

本工程为特定工作区定制：`relay.mjs` 按整条路径钉死工作区引擎（当前为 `g:/mmx-project/zcode动态工作流-原else/...`）、DSH 扫描根、测试夹具均引用本机绝对路径。这是设计的一部分（精确路径匹配、防 basename 泛化）；换机部署需按实际路径同步修改。

## 授权与边界

见 [`1004.md`](./1004.md) §0 与 §10.5：不改宿主源码、零第三方依赖、固定端口不漂移、仅 MMX 与 DSH 两端、业务 `ask` 真实等待真人、不代官方 `pending_review` 审批。
