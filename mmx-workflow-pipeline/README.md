# mmx-workflow-pipeline

MiniMax Code 的 ZCode 风格工作流进度外挂：侧栏进度行、并行运行卡片、阶段时间线、子代理状态与 tokens/耗时、脚本、发现看板、结果、历史、提问和停止/恢复。

**2026-10-05 只读复核（未部署、未重启、未做真实客户端验收）。** 下列值分栏标注，不混写：

- **源码**：`client-inject.js` 的 `CLIENT_VERSION = 11`（不是 4，也不是历史文档里的 3）；引擎 `plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs` 的 `ENGINE_VERSION = 0.8.1`；`install-skills.mjs` 的 `EXPECTED_ENGINE = '0.8.1'`。
- **磁盘**：`~/.minimax/skills/mmx-workflow/SKILL.md` 已安装，与工作区源 `mmx-workflow-pipeline/skills/mmx-workflow/SKILL.md` 逐字节相同（sha256 `56e72c06…13f2af`），该目录**只有** `SKILL.md`（安装器刻意不带引擎副本，运行时驱动的是工作区引擎）。`~/.minimax/skills` 下已无 `dynamic-workflow` 实体，只剩安装器隔离出的 `dynamic-workflow.bak-2026-10-02T07-16-28-…` 备份目录（在 skills 树之外）。
- **运行状态**：本轮只读复核没有 attach、没有重新注入、没有启停任何宿主进程；下述 API 实测值来自临时端口上的隔离 sidecar（生产 4231 未被绑定）。
- **历史**（2026-09-30 当时记录）：0.2.4 候选全套隔离回归 **274/274，0 fail，0 skip**（[full-024-r3-integration.log](../workflow-ui-evidence-20260929/full-024-r3-integration.log)）。该段当时的 "注入 bundle `CLIENT_VERSION = 4`" 已被上面的源码值取代，其余候选描述未复核。0.2.3 的实机验收记录是历史，见[验收报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md)。

〔首轮回填·历史，未在本轮重验〕本地 `mcode` CLI 为 **0.5.6**，官方市场 `latest` 为 **0.6.2**，两者属**不同版本空间**，不可互相推定；CLI 版本也不代表 Desktop 版本。

MiniMax Code 当前界面有“插件”入口，市场中可见“动态工作流”。本工程采用 **CDP sidecar**，并未迁移到该市场插件，也没有证明市场提供了等价的 renderer 扩展接口。旧文档“MiniMax 没有插件机制，因此只能外挂”的推断已撤回。

## 边界与架构

- 不修改 `G:\MiniMax\`、app.asar 或宿主源码；〔历史〕2026-09-29/30 的 0.2.3→0.2.4 生命周期修复未修改 dynamic-workflow 引擎。
- Node **>= 22**，仅 `node:` 内置模块、原生 `fetch`/`WebSocket`；零第三方依赖。
- 生产 API 固定 `127.0.0.1:4231`，CDP 固定 `127.0.0.1:9331`，不漂移端口。
- `sidecar.mjs` 扫描运行文件并提供 API，通过 CDP 向 `app://./archon` 注入 `client-inject.js`。
- 引擎数据位于 `<workspace>/.qoder/workflow-runs/<runId>/`；`run-lifecycle.mjs` 处理进程身份和恢复握手。
- 注入器使用 `Page.addScriptToEvaluateOnNewDocument` 和初始化时 `Runtime.evaluate`；断线 5 秒重试，10 秒检查 target。客户端通常每 2 秒更新一次。后台窗口可能受 Electron 节流影响，这不是实时性保证。

## 安全启动

### 已有 MiniMax Code 调试实例

先确认 `9331` 确实属于目标 MiniMax Code、`4231` 空闲；若已有健康 sidecar，直接复用，不要启动第二份。

在本项目目录执行：

```bash
node sidecar.mjs --root G:/qoder-intl-project/else
```

可重复 `--root <dir>`；扫描根本身及其下一层目录。**健康判断看 sidecar 自己的启动行**（`API :4231 | CDP :9331 | roots … | injector started, confirmation pending`）与注入器的 target 确认行，不要用裸 `curl` 探活：

```bash
curl -i http://127.0.0.1:4231/runs
```

裸请求会得到 `403 {"ok":false,"error":"forbidden: missing or invalid workflow capability"}`，**这是预期拒绝，不是服务不健康**：API 要求每次启动随机生成、只留在内存里的 capability（`x-workflow-capability` 头，由注入器写进 bundle），并只对可信 Origin（`app://.`、`app://./archon`、`null`）回显 CORS。**不要**把真实 capability 写进本文档、提交或日志。

若 MiniMax 未带调试端口，应先保存工作并从原生界面退出，再以 `--remote-debugging-port=9331` 启动指定 exe。不要因一个超时就强杀全部同名进程、删除单例锁或更换端口。`9331` 已被无关进程占用时应停止排障，不能接入或杀掉无关进程。

### 旧启动器与技能安装器

- `launch-mmcode.mjs`、`sidecar.mjs --launch` 以及 `docs/launch-cdp.mjs` 保留着可能执行 `taskkill /IM ... /T /F` 的启动路径；**不作为健康实例升级的默认方式**。前两个在 CDP 已可达时会复用实例，`--no-launch` 时 CDP 不可达会以 `CDP_UNAVAILABLE` 失败而不是启动或停止任何进程。
- `--no-launch` 与 `--kill-on-exit` **当前都被真实解析并接线**：`launch-policy.mjs` 的 `parseLaunchArgs` 与 `sidecar.mjs` 的 `parseArgs` 都返回它们（实测 `parseArgs(['--no-launch','--kill-on-exit'])` → `{launch:false,noLaunch:true,roots:[],killOnExit:true,apiPort:4231,cdpPort:9331}`），`--kill-on-exit` 在退出路径里只停止**本启动器自己创建并核对过身份**的进程。这**不等于**整套 argv 无条件安全：`--launch` 路径仍可能树杀同名进程，`docs/launch-cdp.mjs` 未复核。安全复用仍用上面的 `node sidecar.mjs`（不加 `--launch`），不要同时启动第二份 sidecar。
- `install-skills.mjs` 锁的是 **`EXPECTED_ENGINE = '0.8.1'`**（不是 0.7.1），只安装 `skills/mmx-workflow/SKILL.md` 到 `~/.minimax/skills/mmx-workflow`，不装引擎。它会把预置的通用 `dynamic-workflow` 目录移出 skills 树（`--skip-legacy` 可跳过），所以运行前先看 `--help`、确认目标目录。本轮**没有运行**它，也没有覆盖任何安装目录。插件运行时驱动的是工作区中已存在的 `plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs`。

## 升级与停止

1. 先检查自有 sidecar 的完整命令行、创建时间及 `4231` 监听 PID，一致后才停该进程；不能照抄历史 PID。
2. 更新自有 bundle，重新启动 sidecar，使其重新 attach 并读入新版文件。仅保存文件不会触发已有连接的热注入。
3. 新 bundle 会调用旧实例 teardown、移除自己的旧样式/模态框；相同或更高 `__mmxDwfVersion` 已加载时不重复初始化。
4. 从 MiniMax 窗口重载，再检查实际卡片。注入日志只是初始化证据，不代替 UI 验收。
5. 正常 sidecar 控制台 `Ctrl+C` 关闭 API/注入器，不关闭宿主。已经注册的脚本/当前 renderer UI 不保证立即卸载；停用后正常退出并重新打开不带调试端口的宿主可清除 renderer 会话。

卡片 ⏹ 请求引擎取消；终态 × 只隐藏此客户端中的卡片，不删除运行文件，也不从历史列表删除。两客户端 localStorage 独立，关闭状态不会跨客户端同步。

## 当前交互

- 四个入口：`>_ 脚本`、`发现看板（按严重度）`、`结果`、`历史`。
- 运行卡可同时显示多个工作流；已经显示的卡片没有 TTL，完成后仍保留，由 × 手动关闭。持久化依赖宿主 localStorage；运行文件需仍在扫描范围内。
- 第一次加载显示所有运行中任务及最新未关闭终态；较老、从未显示过的终态仍可从历史查询，并非首次就展示全部历史卡。
- 侧栏按 `startedAt` 选取最新匹配运行，旧运行的后续更新不会抢回进度行；匹配仍是标题/cwd basename 近似关系，不是精确 session ID。
- 回答的提交中、已提交状态随轮询保持；重复点不再重复 POST，拒绝提交保留草稿并显示错误。普通草稿在同一页面更新中保留，不承诺整页重载后恢复草稿。
- 恢复保留 `backend`、并发和调用预算，确认新引擎生命周期后才回报接受；不是 spawn 成功就算恢复成功。
- 运行中计时在引擎未产生新事件时仍推进，终态冻结；完成统计使用 settled 子代理数。分钟格式不再出现 `1分60秒`。
- 浅/深色按宿主背景选择配色；本轮真实截图为浅色主题。

## API

基址 `http://127.0.0.1:4231`。完整合同见[共同 SPEC](../workflow-ui-v2-SPEC.md)。

| 端点 | 作用 |
|---|---|
| `GET /runs[?cwd=...]` | 按 updatedAt 降序返回扫描到的运行，不再截成 60 条 |
| `GET /script?run=<id>` | 脚本路径与内容 |
| `GET /result?run=<id>` | 真实 out.json；未生成返回 404 |
| `POST /stop?run=<id>` | 写 CANCEL；200 只代表请求写入 |
| `POST /resume?run=<id>` | 最多等待 8 秒确认新 PID/startedAt 生命周期 |
| `POST /answer?run=<id>&q=<qId>` | JSON `{ "answer": "中文答案" }`；独占写入，重复或过期提交返回 409 |

`/resume` 的 `accepted:true` 不等于最终业务完成。`PID_REUSED_ENGINE_GUARD` 表示旧 PID 已被其它进程复用，插件拒绝继续、不杀进程、不改历史；`ENGINE_REJECTED` 表示引擎未接受；`RESUME_UNCONFIRMED` 表示超时未确认，可能仍有进程运行，不应盲目重复点击。

## 测试与证据

从工作区根执行：

```bash
node --test mmx-workflow-pipeline/test/client-lifecycle.test.mjs mmx-workflow-pipeline/test/sidecar.test.mjs dsh-workflow-pipeline/test/client-contract.test.mjs
node --check mmx-workflow-pipeline/client-inject.js
node --check mmx-workflow-pipeline/sidecar.mjs
node --check mmx-workflow-pipeline/run-lifecycle.mjs
```

Host 侧套件（`host-lifecycle.test.mjs` 等）会真的拉起本机引擎，见各自文件头的说明。**固定 `4231` 的占用协调已不再需要**：`sidecar.test.mjs` 在 `127.0.0.1:0`（临时端口）上起 Host，`EADDRINUSE` 用被占用的临时端口在子进程里验，文件头明确写着「固定生产端口 4231 从不被绑定」。因此**不要**为了跑测试去暂停一个健康的 sidecar——生产 sidecar 在跑时测试也能跑。〔历史〕2026-09-29 的 86/86、0 skip 是在当时先核对并暂停自有 sidecar 后取得的，日志见 [plugin-023-tests.log](../workflow-ui-evidence-20260929/plugin-023-tests.log)；那是历史验收，不是今天的执行方式。不要重跑带旧哈希/旧 PID 的部署脚本。

- [验收报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md)
- [证据索引](../workflow-ui-evidence-20260929/INDEX.md)
- [机器可读核验](../workflow-ui-evidence-20260929/evidence-audit-023.json)
- [开发文档](DEVELOPMENT.md)

六条本机验收都使用真实引擎 `file` 后端，但没有外部模型调用。两条并行展示用例的 **320 tokens 是测试回执字段，不是真实模型计费**。中文问题答案通过真实客户端输入和按钮提交。

## 已知限制与安全提示

1. session 关联近似；卡片是扫描根视图，不保证当前宿主会话隔离。多根同 runId 冲突尚未处理。
2. 文件 artifact 仅显示路径 tooltip，不能点击打开本地文件；URL 链接的新窗口行为本轮未实测。
3. 无 agent 的已完成阶段仍可能是灰/黑节点；不能据此声称与 ZCode 的阶段颜色语义完全一致。既有卡 DOM 顺序也不保证每次按更新时间重排。
4. 卡片展示最近 24 个 calls、最近 4 条日志；引擎日志字段保留最近 50 条；结果模态框超过 65,536 个 JS 字符时截断并提示查看 out.json。
5. localStorage 写失败暂未给出可见错误；请求 pending 状态只在当前 document 保存。stop 缺即时 pending/失败反馈，Host 也未禁止终态写 CANCEL。
6. PID 创建时间查询失败或旧 state 缺 startedAt 时退回裸 PID 判断；非 Windows 创建时间路径本轮未测。引擎 OWNER 的裸 PID 限制未修改。
7. CDP 的新文档脚本注册尚未回收旧 identifier。未来宿主版本/选择器变化需重测；后台 UI 可能延迟显示，不能把旧截图当最新结果。
8. **（已修正）** API 不是「无认证 + CORS `*`」：只接受 loopback Host，请求必须带本次启动的 `x-workflow-capability`，CORS 只对可信 Origin 回显其自身。临时端口实测：无 capability `403`（无 CORS 头）、错 capability `403`、合成有效 capability `200`、有效 capability + `Origin: app://./archon` 回显 `access-control-allow-origin: app://./archon`（**不是 `*`**）、不可信 Origin `403`（无 CORS 头）、可信预检 `204`、不可信预检 `403`。CDP 仍有高权限；本方案仍只面向受信本机调试环境，**不得**转发到局域网或公网，也**不等于**已完成本机跨源安全加固（capability 只在内存、不防同机其它进程读取注入后的 renderer）。停止 sidecar 不等于关闭 CDP。
9. 未重新取得原始红箭头参考图做像素级比对，也没有重新验证 0.2.3 全量宿主进程退出/重开。页面重载、跨页重新挂载和本轮交互均已有实机证据。
