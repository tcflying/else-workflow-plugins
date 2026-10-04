# workflow-ui v2 SPEC：当前插件合同与验收范围

更新于 **2026-10-05**（只读复核；2026-09-30 版的历史段落原样保留）。覆盖恢复、结果全文、log叙述、历史、artifacts、提问闭环、生命周期修复及原生会话归因。字段与行为以当前实现和真实证据为准。

**当前状态（2026-10-05 只读复核，未部署、未做真实客户端验收）。** 按栏位取值，不混写：

| 栏位 | 值 | 依据 |
|---|---|---|
| 源码 | 引擎 `0.8.1`；插件源 `0.2.6`（`dsh-workflow-pipeline/package.json`）；MMX 注入 bundle `CLIENT_VERSION = 11`；安装器 `EXPECTED_ENGINE = 0.8.1` | 各自源文件 |
| 磁盘 | dev harness profile 有一份 `0.2.6` 安装副本（`…/dsh-desktop-dev/harness/profiles/web/node_modules/@dsh-external/dsh-workflow-pipeline`），与工作区源逐件比对：`package.json`、`cordis.patch.yml` 一致，`client.js`/`index.mjs`/`run-lifecycle.mjs` **不一致**；`~/.minimax/skills/mmx-workflow/SKILL.md` 与源逐字节相同 | 2026-10-05 sha256 比对 |
| 运行状态 | 活跃 DSH home `~/.dsh-zcode-dev` 的 profile `web` **无本插件依赖**（未部署），其 `"patchReload": "live"`；监听 `3188` 的 core 实装 `0.1.5-rc.2`；两个壳并存（`2.0.13.0` / `2.0.4.0`） | 目录与进程只读复核 |
| 发布线 | `npm view @deepseek-ai/dsh dist-tags`（2026-10-05）→ `latest = next = 0.2.0-rc.2`，`alpha = 0.2.1-alpha.1` | npm registry |
| 历史 | 2026-09-30 的 0.2.4 候选与 274/274 隔离回归、2026-09-29 的 0.2.3 与 86/86 及真实客户端验收，**均为历史记录**，不代表当前值已验收 | 本文与两份 README |

〔首轮回填·历史，未在本轮重验〕本地 `mcode` CLI 为 0.5.6，官方市场 `latest` 为 0.6.2，属**不同版本空间**，不可互相推定。

本文 2026-09-29 段落描述的 0.2.3 及其 86/86、真实客户端验收是**历史记录**。当前插件源（0.2.6）**尚未部署**到活跃 DSH 实例或 MiniMax renderer，尚未做真实客户端操作、截图或与原图的对照；部署前必须完成安全部署流程与实机验收。0.2.4 相对 0.2.3 的变化（历史编号，供对照）：

1. **生命周期最后窗口闭合**（两端 host）：`/stop`、`/answer` 在最后 await 之后、写盘之前**同步**重读 progress 与 state；state 按 `startedAt/pid/runId/cwd/scriptPath/backend/concurrency/maxAgentCalls` 逐字段核身份（`sameStateIdentity`），progress 按 startedAt 独立核对；state/progress 各保留自身时间戳，正常毫秒差不是异常（>2s 的 handoff 窗口仍 fail-closed）。同目录重启落入任何 await 窗口均返回 409 `STALE_LIFECYCLE`，CANCEL/inbox 不落入新生命周期。
2. **resume 双快照**：`resumeRun` 在 identity await 之前、之后各同步读一次 state/progress；await 后重新校验身份与期望 startedAt，spawn 基于第二快照。旧状态决策不再跨 await 使用。
3. **注入器 stop 语义**：`stop()` 返回 Promise，等待在途 attach 完成清理；CDP 命令有界（默认3秒超时，`commandTimeoutMs` 可调），清理卸载 doc-script、尽量 teardown renderer UI（`__mmxDwfTeardown`）再关 socket；清理未确认时明确报告"需要原生页面重载"。清理等待有界，不会无限悬挂。
4. **原生会话归因（hostSession）**：引擎 0.8.1 起在 state/progress/journal `run_started`/out/status 携带可选 `hostSession={host,sessionId,source}`。DSH 读内置 `DSH_SESSION_ID`（native-shell）；MMX 经原生 PreToolUse hook（候选件 `plugins/mmx-native-session-hook/`，**未安装**）对匹配本工作区引擎的 `run` 命令追加显式 `--host-session`（native-hook）。resume 严格保留原归属，`--host-session` 不能改归属；无效/冲突来源在建 run 目录之前失败。宿主 `/runs` 原样透传该字段。两客户端将 native origin 视为精确绑定：只匹配 `host+sessionId`，跨宿主同名 session 不认领；本地手动绑定只对无 native origin 的 legacy 运行生效；损坏的归属数据隔离标注"归属数据无效"，不冒充未绑定。
5. **仅运行期可见的边界**：DSH 侧栏逐行公开扩展点仍不存在（已核实 16 个客户端 UI 包），“session 标题下进度行”在 DSH 上仍是未完成项；native origin 使卡片/会话池的归因精确，但行内注入仍受宿主 slot 限制。
6. **安装器/启动安全**（0.2.4 前已并入）：installer 锁 owner 元数据、盘符根路径修复、11 项部署边界测试；安全启动 16 项（默认不杀宿主、身份核验后仅停止自有 child）。
7. 版本（**已按 2026-10-05 重核**）：引擎 `0.8.1`（manifest 同步）、插件源 `0.2.6`、MMX 注入 bundle `CLIENT_VERSION = 11`、hook 候选件 0.1.0（未安装）。安装器 `EXPECTED_ENGINE = 0.8.1`。


## 0. 版本与修改边界

- 引擎：`ENGINE_VERSION = 0.8.1`；原v2阶段由0.7.1升级。〔历史〕0.2.3→0.2.4 那一轮生命周期修复未修改引擎或引擎清单。
- DSH：`@dsh-external/dsh-workflow-pipeline@0.2.6`（工作区源），原生Cordis/client-module。
- MiniMax：与 DSH 同源，`CLIENT_VERSION = 11`是注入迭代号，不是npm包版本。
- 不改 dsh-desktop、`G:\MiniMax\`、app.asar或第三方配置；不改provider/凭据绕过验证码；零第三方依赖。
- 生产MMX API4231/CDP9331固定；dev harness 实例 appserver 43130/CDP9223，**活跃 home 是另一实例**（`~/.dsh-zcode-dev`，core 跑在 `3188`）且未部署本插件。测试可用临时localhost端口，不能作为生产漂移方案。
- [DSH说明](dsh-workflow-pipeline/README.md)、[MiniMax说明](mmx-workflow-pipeline/README.md)、[开发文档](mmx-workflow-pipeline/DEVELOPMENT.md)、[验收报告](workflow-ui-evidence-20260929/ACCEPTANCE-023.md)。

## 1. 引擎0.8.1数据合同（只读核对）

运行目录：`<cwd>/.qoder/workflow-runs/<runId>/`，包含`state.json`、`progress.json`、`journal.jsonl`、`out.json`、`OWNER`、`pending.json`、`pending/`、`inbox/`及可选`CANCEL`。

### 1.1 progress扩展字段

```jsonc
{
  "logs": [{ "ts": "ISO", "text": "…" }],
  "questions": [{
    "qId": "q000-<hash8>", "question": "…", "state": "waiting|answered|failed",
    "askedAt": "ISO", "answeredAt": "ISO|null", "answerPreview": "…"
  }],
  "artifacts": [{
    "id": "a<n>-<hash8>", "title": "…", "kind": "file|document|dashboard|text",
    "path": "string|null", "url": "http(s)://…|null", "text": "…",
    "primary": true, "publishedAt": "ISO"
  }]
}
```

日志字段最多50条；answerPreview最多200个JS字符；artifact text最多4000个JS字符。`path`由脚本提供，引擎不强制转成绝对路径。progress随journal事件更新，不是每秒定时写盘。

### 1.2 ask

`ask(question, opts={}) -> Promise<string>`：

- 仅`file`后端。其它后端错误为：`ask() 仅 --backend file 可用：cli/echo 后端没有宿主可回答`。
- question为非空字符串。`base=sha256(question)`，`key=sha256(base+'\0'+nth)`，nth按相同question累计。
- 成功的`ask_result`按key缓存；恢复命中产生`ask_replay`并返回原答案。失败不缓存。
- `ask_dispatch`带`seq/key/qId/question`，随后登记`kind:"question"`的pending；等待`inbox/<qId>.json = {ok:true,text:"答案"}`。
- 代理应答器必须跳过`kind:"question"`，不能替用户自动回答。
- 默认timeoutMs3600000，可覆盖；finally移除该问题pending。取消抛错，不制造成功回执。
- 实际`ask_result`带`key/qId/ok/answer或error/result/ts`，不保证有seq。成功答案为全文。

### 1.3 publish与log

`publish({title,kind?,path?,url?,text?,primary?})`：title非空，kind默认text且只能是file/document/dashboard/text，url若提供需http(s)。生成artifact事件；第二个primary替换前一个primary标记，历史仍记录。`log(text)`产生log事件并维护有界日志列表。

### 1.4 历史与恢复

停止写CANCEL，由引擎感知并记录`run_cancelled`。恢复并非必有名为`run_resumed`的事件：本轮实际journal是`run_started`、`run_cancelled`、第二次`run_started`、成功`ask_result`、`run_completed`。不要杜撰事件名，也不要篡改state/journal使验收通过。

## 2. Host API

DSH基址：`http://127.0.0.1:43130/dsh-workflow-pipeline/api`（dev harness 实例；活跃 home 是另一实例，见 §0）。MMX基址：`http://127.0.0.1:4231`。DSH端口属于该宿主实例，不是插件另开的listener。

### 2.1 查询与停止

| 端点 | 合同 |
|---|---|
| `GET /runs[?cwd=...]` | `{ok:true,runs}`，按updatedAt降序；不再截60条；扫描根和下一层项目 |
| `GET /script?run=<id>` | `{ok:true,scriptPath,script}`；未知run404，路径缺失时script可为空 |
| `GET /result?run=<id>` | `{ok:true,out}`；未知run或out尚未产生404 |
| `POST /stop?run=<id>` | 写CANCEL，200表示请求已写入，不表示已停止 |

各查询/控制端点均支持首次`/runs`之前定位。`?cwd=`可以按路径或basename匹配，未保证严格隔离。Host遇到失效进程仅修正响应中的status/calls/questions，不重写progress或journal。

**（已修正）MMX 不是 CORS `*` + 无认证。** 访问边界：仅 loopback Host；可信 Origin 仅 `app://.`、`app://./archon`、字面量 `null`；每个实际请求必须带 `x-workflow-capability`（每次启动随机生成、只留内存）；CORS 头只逐请求回显可信 Origin 自身，**从不发 `*`**；被拒响应刻意不带 CORS 头；可信预检为无 body 的 204。2026-10-05 临时端口实测（合成 capability，未公开真实值）：无 capability `403`、错 capability `403`、有效 capability `200`、有效 + `Origin: app://./archon` → `access-control-allow-origin: app://./archon`、不可信 Origin `403`（无 CORS 头）、可信预检 `204`、不可信预检 `403`。**缺认证的 403 是预期拒绝，不是服务不健康。** 这仍只适合受信本机调试环境，capability 只在内存中，不等于已完成本机跨源安全加固。DSH复用原生路由。

### 2.2 回答

`POST /answer?run=<id>&q=<qId>`，body `{"answer":"…"}`：

1. 非空字符串；请求体超过262144个JS字符拒绝。
2. 运行有效状态必须running；qId仅字母、数字、下划线、短横线；问题必须waiting。
3. `inbox/<qId>.json`以`wx`独占创建，内容`{ok:true,text:answer}`。
4. 成功200；未知run/question404；非法body/id400；终态、非waiting、重复已写回执409。

200是Host接受答案文件，最终完成还需看progress/out。拒绝重复写入不能阻止已被引擎消费后的任何理论竞态；本版按当前progress和inbox合同处理，不宣称全局事务。

### 2.3 恢复与身份

两项目各自部署同内容`run-lifecycle.mjs`。

- Windows读取`Win32_Process.CreationDate`，其它平台实现用`ps -eo pid=,lstart=`。快照缓存5秒、去重在途查询；resume强制刷新。
- 创建时间比state.startedAt晚超过1秒判PID复用；查不到创建时间或无有效startedAt则保守退回裸PID。
- 活PID复用时返回`409 PID_REUSED_ENGINE_GUARD`，不spawn、不kill、不改历史；引擎OWNER仍是裸PID保护，本轮没改。
- 状态允许failed/cancelled/stale，或running且对应进程已不活；先检查scriptPath存在。
- 使用参数数组启动`wf.mjs resume <runId> --cwd <cwd>`并保留backend/concurrency/maxAgentCalls；stdout/stderr追加`pipeline-resume.log`。
- 最多8秒确认state.pid为新child.pid，且PID或startedAt与旧生命周期不同；然后返回`200 {ok:true,spawned:true,accepted:true,status}`。
- 引擎提前退出、未接受返回`409 ENGINE_REJECTED`；超时未确认返回`504 RESUME_UNCONFIRMED`，不杀可能仍启动中的child。
- `accepted:true`只代表新生命周期已被接受，不保证业务最终成功。不要在504后盲目重复点击。

## 3. UI合同

### 3.1 结构与显示

顺序：head → pills → questions → timeline → artifacts → agents → logs → result。

四个pill：`>_ 脚本`、`发现看板（按严重度）`、`结果`、`历史`。运行态有⏹和⤢；终态有×和⤢；failed/cancelled/stale另有↻。

- Head：阶段数、running子代理数或终态settled数、总tokens/耗时。运行计时使用`max(elapsedMs,Date.now()-startedAt)`，终态用elapsedMs冻结。
- timeline：阶段及完成/派发计数；无agent的completed阶段仍可能中性色，不能声称全部终态节点都绿。
- agents：最近24个calls，状态、预览、颜色头像、usage及duration。
- questions：waiting输入/回答、最近2条answered、失败问题可见。
- artifacts：类型图标、title、primary星号；URL为新窗链接，本地path只tooltip，**不是可打开本地文件**。
- logs：最近4条；总量取引擎最近50条；新行状态按runId分开。
- result预览可点击；完整结果弹窗实际限制65,536个JS字符，并提示去out.json查看全文。
- history读取API全量，点击行展开该run的calls。是打开时快照，不自动秒级计时。

### 3.2 回答与恢复状态

controls按runId/startedAt分代，answers按qId隔离。提交中/已提交禁用输入与按钮；轮询不能让控件重新可点或重复POST。失败保留草稿并显示可见错误。恢复请求中禁用，成功后保留3秒冷却；错误显示在卡片，而不是只有console.warn。

未改变的question DOM由分区diff保留，因此同run/其它run刷新及计时更新都不丢草稿、焦点、selection。此合同针对同一document；整页重载不承诺草稿/pending持久化。

### 3.3 多卡、×与侧栏常驻

- 全部live run可同时显示；首次额外选择最新未关闭终态；已经显示过的终态继续保留。
- visibleRuns与dismissed写入各自客户端localStorage，不按TTL或200条上限淘汰；×不删运行文件，history仍可见。
- localStorage写失败暂时静默，数据离开扫描根仍会消失。两宿主的关闭集合不相互同步。
- sidebar按startedAt排序选最新匹配项，旧任务更新不能夺回进度；无自动消失时间。
- 关联仍是标题子串/cwd basename近似，不是sessionId；卡片视图也不严格按当前会话隔离。精确一比一会话关联尚未完成。

### 3.4 MiniMax注入版本

`CLIENT_VERSION=11`。旧实例先teardown并清自己的modal/style，再安装；已有>=11版本不重复启动。新文档脚本在页面reload后自动执行。已有连接的10秒target检查不自动重读bundle，文件更新后需重新attach。〔历史〕该门控最初以 3 建立。

旧的Page.addScript注册identifier尚未回收。一般teardown也未全面重构；DSH需注意旧modal/style残留，使用原生页面重载验收。

## 4. 测试合同与当前结果

〔历史·2026-09-29〕当时的完整插件套件 **86/86，0失败、0跳过**，各文件分项如下；本轮未重跑这套，规模已各自扩展，不得把该数字当作今天的套件规模：

- `mmx-workflow-pipeline/test/client-lifecycle.test.mjs`：41项，两端真实bundle在fake DOM中的交互和持久化；包括6项统计/计时红测及MMX升级幂等行为。
- `mmx-workflow-pipeline/test/host-lifecycle.test.mjs`：22项，两端HTTP/进程身份/真实引擎恢复；测试恢复child自然退出后才删除临时cwd，避免Windows EPERM。
- `mmx-workflow-pipeline/test/sidecar.test.mjs`：19项。
- `dsh-workflow-pipeline/test/api.test.mjs`：4项。

**（已修正）不再有“为了跑测试先暂停健康 sidecar”这一步**：`sidecar.test.mjs` 现在在 `127.0.0.1:0` 临时端口上起 Host，`EADDRINUSE` 用被占用的临时端口在子进程里验，固定生产端口 4231 从不被绑定。历史日志里的“先核对并暂停、测试后恢复”保留为当时的执行方式记录。引擎95/95是前轮记录，未重跑，不能并入套件总数。

## 5. 实机验收与证据

主会话使用官方Computer Use真实控件操作，不用HTTP直接提交中文问答，不篡改journal。产品自身CDP注入仍保留，不能据此把raw CDP当验收自动化通道。

〔历史·2026-09-29 实机验收〕已完成：

1. 双端脚本、发现看板、结果全文、历史、历史call明细。
2. 普通中文回答2条：均completed/file，含两agent并行展示与primary产物。
3. 停止恢复2条：真实⏹、↻、中文提交；journal有取消和第二次run_started，backend保持file。
4. ×关闭自有终态卡后reload不复活；其它已显示终态仍在；history保留关闭项。
5. 新版计时草稿2条：DSH2分02秒→2分32秒、MMX41.7秒→2分56秒；草稿未丢，之后通过UI提交并完成。
6. 安装源/副本五文件SHA256一致、双端API200、六条真实run全部completed/file。

第 6 条是**当时**的一致性结论：2026-10-05 只读复核已显示部署副本与工作区源**不再是五件全等**（`client.js`/`index.mjs`/`run-lifecycle.mjs` 不一致），不得再把“五文件一致”当现状引用。

这是本机引擎/UI集成验收，不是外部模型质量测试。普通并行用例的320 tokens来自模拟回执，不能报告为真实计费用量。

证据目录：[workflow-ui-evidence-20260929](workflow-ui-evidence-20260929/INDEX.md)。旧`dsh-script-022.png`是后台旧画面，不作为脚本弹窗通过图；应采用`dsh-script-confirmed-022.png`。旧失败记录保留，最新0.2.3截图不能被旧图代替。

## 6. 未完成的一比一项与未测边界（当前插件源 0.2.6；2026-10-05 只读复核）

- 当前插件源（0.2.6）**未部署**到活跃 DSH 实例，MiniMax renderer 侧本轮也未重新注入；无新版实机截图，无与原始红箭头参考图的像素级对照。部署与实机验收是发布门。
- 磁盘上那份 0.2.6 部署副本属于 dev harness profile，且与工作区源有三件不一致；“磁盘已装”≠“活跃实例已加载”。
- DSH 无侧栏逐行公开扩展点（已只读核实16个客户端UI包）；"session标题下常驻进度行"未达成，native origin 只精确化卡片归属，不解决行内注入缺口。
- MiniMax 原生 hook 候选件未安装、未取得 discovery→握手→真实调用证据；sidecar 注入路径仍是当前 MMX 通道。
- 官方 Computer Use 当前会话工具注册缺口未恢复，真实 UI 验收被阻塞（见 COMPUTER-USE-REGISTRATION-DIAGNOSIS.md）。
- 同runId跨root冲突、既有卡DOM排序已解决的部分以外：URL新窗口、非Windows进程创建时间、整宿主退出重开、深色主题实机、后台节流仍未在新版复测。
- 历史遗留：DSH历史181秒启动超时根因未定位；0.2.3及更早的记录保持原样，不并入任何通过声明。

结论只覆盖有证据的通过项，不得写成“1:1完美”“所有遗漏清零”或“验证码失败的独立审查已通过”。
