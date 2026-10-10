# dsh-workflow-pipeline

DSH 团队版的原生插件：通过 Cordis Host API 和 `window.__ModuleLoader__.load` 客户端模块，显示 ZCode 风格的工作流侧栏进度与对话区运行卡片。不修改 dsh-desktop 源码或 app.asar，零第三方依赖。

## 兼容基线（2026-10-10 只读读码复核）

目标宿主 = DSH Desktop 2.0.17 壳，内置 core `@deepseek-ai/dsh` **0.2.0-rc.2**，宿主只读代码位于
`C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/`。

**`package.json` 里没有注释是刻意的。** 宿主 `dsh-client-modules/lib/index.js:711` 用
`JSON.parse(readFileSync(pkgPath, "utf8"))` 严格解析每个包的 manifest，任何注释都会让它抛错、
整个包扫描失败。兼容基线因此记在这里和 `test/host-0.2.0-rc.2-contract.test.mjs` 的文件头，
而不是写进 manifest。

`dsh.client.inject` 从 `["@deepseek-ai/dsh-client-runtime"]` 改为 `[]`（2026-10-10）：

- 旧目标 `@deepseek-ai/dsh-client-runtime` 在 0.2.0-rc.2 安装树里**已不存在**（模块系统已并入
  `dsh-client-modules`），保留它是一条指向死包的图排序元数据。
- 读码判定它**不会**让组合失败：`dsh-client-modules/lib/client.js:656-659` 的
  `arriveGraphRow` 只在 `this.graphRows.get(packageName) !== void 0` 时才 await 依赖，
  缺失目标被静默跳过。所以改成 `[]` 是**删除死引用**，不是修一个会崩的 bug。
- `dsh-client-modules` 自身的 `package.json` 也正是 `"inject": []`，与本改动一致。
- `inject` 本就只是图排序元数据：`client.js` 的 factory **零 `require` 调用**。

**没有加 `dsh.manifestVersion`。** 全树 grep（`@deepseek-ai/**`、`app/lib`、`app/build`）
`manifestVersion` **零命中** —— 0.2.0-rc.2 没有任何读取方，加它只是一个自说自话的字段。

**0.2.0-rc.2 实机验证（2026-10-10）。** 无头 core（`DSH_HOME=<隔离home> node @deepseek-ai/dsh/lib/bin.js
--profile webflow --host 127.0.0.1 --port <p> --no-open`）装载本插件后：webserver 就绪零错误、
`GET /dsh-workflow-pipeline/api/runs`（带 token）**200** 且返回真实运行数据；真实浏览器打开 web UI 后
`window.__ModuleLoader__` 待注册队列**为空**（全图注册成功）、本插件 factory **已物化**
（`dwf-pipeline-style` 注入页面）。对话卡片未在无登录环境验证：新 home 无法登录，home 路由无
`viewArea` 锚点，本插件按契约不猜、正确地不渲染任何表面。**部署通道（2.0.17 实测）**：profile
bundle 必须声明 `dsh.bundle`（缺失即 `loadRecoveryFilteredProfile` 报错）；第三方 bundle 列表由
`desktopBundleList` 归一为 `[...REQUIRED_BUNDLES, ...thirdParty]`（自定义 bundle 保留追加，默认组合
不丢）；profile 依赖用 pnpm 装入 `<profile>/node_modules`。**生产部署（休眠）**：`~/.dsh/profiles/desktop`
的安装副本已于 2026-10-10 从史前 0.2.6 同步为 0.2.7（五件套逐字节核验，原件备份于副本内
`.bak-027-*`），profile manifest 依赖路径已从旧根改指新根；UI 半在原生 Ctrl+R 后生效，Host 半需一次
Harness 重启（由用户择时，重启前生产行为零变化）。**诚实边界**：桌面壳在「全新 home + 未登录」的
隔离环境里 renderer boot health 恒超时（与插件无关：无插件纯净 profile 同样超时，生产已登录壳每日
正常），故壳内 GUI 终验需在生产壳重启后由用户目视；另本机出现数个 DSH 僵尸进程（内核态不可杀，
重启自清）。

**2026-10-05 只读复核。** 「当前版本」分栏标注，不再是一个混写的数字：

- **源码**：工作区 `dsh-workflow-pipeline/package.json` 版本为 **0.2.7**（0.2.6 见下方 2026-10-05 历史记录）。引擎 `ENGINE_VERSION = 0.8.1`。
- **磁盘**：本机**存在**一份 0.2.6 安装副本，在 dev harness profile `C:/Users/datoo/AppData/Roaming/dsh-desktop-dev/harness/profiles/web/node_modules/@dsh-external/dsh-workflow-pipeline/`（`package.json` 版本读作 0.2.6）。2026-10-05 与工作区源逐件只读比对：`package.json`、`cordis.patch.yml` **一致**；`client.js`、`index.mjs`、`run-lifecycle.mjs` **不一致**（部署件 mtime 2026-10-01，工作区源已在本轮改动）。**所以“未部署”要按实例分开说：磁盘上有一份旧部署，活跃实例上没有。**
- **运行状态（活跃实例）**：活跃 home 是 `C:/Users/datoo/.dsh-zcode-dev`，其 profile `web` **没有** `@dsh-external` 依赖（`node_modules/@dsh-external` 不存在），`cordis.patch.yml` 里也没有本插件条目 → **活跃实例未部署本插件**。该 profile 声明 `"patchReload": "live"`，即 patch 层改动需要一次原生重载才会生效，这也是下文“Host 更新要重启 Harness”的依据。
- **运行状态（核心与壳）**：监听 `127.0.0.1:3188` 的进程跑的是 `C:/Users/datoo/.dsh-zcode-dev/runtime-dsh015/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3188 --no-open`，该运行时锁定 `@deepseek-ai/dsh ^0.1.5-rc.2`，实装 **0.1.5-rc.2**。两个壳并存：`C:\Program Files\DSH Desktop` 的 `ProductVersion` 为 **2.0.13.0**，`C:\Users\datoo\AppData\Local\Programs\DSH Desktop` 为 **2.0.4.0**。**壳版本 ≠ core 版本；升级壳不等于 core 升级。**
- **发布线**：`npm view @deepseek-ai/dsh dist-tags`（2026-10-05 实读）→ `latest = 0.2.0-rc.2`、`next = 0.2.0-rc.2`、`alpha = 0.2.1-alpha.1`。官方 `latest` 不等于本机活跃 core（0.1.5-rc.2）。
- **历史**：本文原先的“0.2.4 候选（未部署）”与 **274/274** 隔离回归（[full-024-r3-integration.log](../workflow-ui-evidence-20260929/full-024-r3-integration.log)）是 2026-09-30 当时的记录；0.2.3 的实机验收记录同为历史。原生会话归因（引擎 `DSH_SESSION_ID` → `hostSession`，客户端把 native origin 当精确绑定）是当前实现。DSH 原生侧栏仍无逐行公开扩展点（已只读核实 16 个客户端 UI 包），“session 标题下进度行”仍未达成。

## 原生装载与文件

| 文件 | 作用 |
|---|---|
| `package.json` | exports及`dsh.client`/`dsh.bundle.patch`发现声明 |
| `cordis.patch.yml` | 原生Host注册，注入webServer及扫描根 |
| `index.mjs` | `/dsh-workflow-pipeline/api`前缀API |
| `run-lifecycle.mjs` | 进程身份、保留后端的恢复握手 |
| `client.js` | 原生客户端模块、卡片、侧栏与交互 |

dev harness 实例的安装目录（**不是**活跃实例；活跃 home 见上方「运行状态」）：

```text
C:/Users/datoo/AppData/Roaming/dsh-desktop-dev/harness/profiles/web/node_modules/@dsh-external/dsh-workflow-pipeline/
```

活跃 home 与扫描根（`C:/Users/datoo/.dsh-zcode-dev/profiles/web`）：每根扫描自身及下一层项目。

当前Cordis补丁扫描根：`G:/mmx-project/zcode动态工作流-原else`、`G:/qoder-intl-project/dsh团队版`、`G:/zcode-project`，每根扫描自身及下一层项目。

这份目录是历史验收时的安装实例，不是对所有DSH版本的通用安装路径承诺。应走对应客户端原生插件发现机制，不另写宿主源码、workspace hook或第三方patch。

## 安全更新

1. 检查目标确为本插件；先对照现有部署清单核验，发现外部改动就停止覆盖。
2. 备份这五个文件，再从自有源同步；源与安装副本逐件核对SHA256。
3. **Host逻辑更新需要原生“重启 Harness”**；只拷文件不能证明旧Host已退出。
4. 仅UI更新时，使用原生应用菜单“重新加载 Ctrl+R”，然后检查真实卡片。

〔历史〕0.2.3的Host/helper/patch与0.2.2相同，实际更新client.js和包版本；当时已做页面重载并确认正确统计与持久化。五文件哈希见 [deployment-023.json](../workflow-ui-evidence-20260929/deployment-023.json)，只读复核见 [evidence-audit-023.json](../workflow-ui-evidence-20260929/evidence-audit-023.json)。**2026-10-05 的只读复核已把这两份历史记录从“现状”降级**：当前五文件中只有 `package.json`、`cordis.patch.yml` 与工作区源一致，另三件不一致（见顶部「磁盘」栏），本轮不部署。不要照抄历史PID、删除SingletonLock或杀其它DSH实例。

## API

dev harness 实例的 appserver 为 `43130`，其只读地址：

```text
http://127.0.0.1:43130/dsh-workflow-pipeline/api/runs
```

**这属于 dev harness 实例，不是活跃 home。** 活跃 home（`C:/Users/datoo/.dsh-zcode-dev`）当前跑的是 `127.0.0.1:3188` 的 core 0.1.5-rc.2，且未部署本插件，所以那里**没有**本插件路由。两个端口都属于各自宿主实例，插件本身不另起HTTP监听；换实例前先确认端口归属，不要把 43130 的地址当成通用地址。

`/api/dwf-pipeline/runs`不是本插件路由。端口属于该DSH实例，插件本身不另起HTTP监听。

相对于`/dsh-workflow-pipeline/api`：

- `GET /runs[?cwd=...]`：扫描到的运行列表，不再按60条截断。
- `GET /script?run=<id>`：脚本路径和内容。
- `GET /result?run=<id>`：out.json，未产生时404。
- `POST /stop?run=<id>`：写CANCEL，200仅表示请求写入。
- `POST /resume?run=<id>`：保留backend/concurrency/maxAgentCalls，确认新PID/startedAt生命周期后回200/accepted；引擎拒绝409、8秒未确认504。
- `POST /answer?run=<id>&q=<qId>`：JSON非空字符串answer；仅有效running的waiting问题；独占写inbox，重复/过期409。

完整字段和错误码见 [共同SPEC](../workflow-ui-v2-SPEC.md)。`PID_REUSED_ENGINE_GUARD`是安全拒绝，未杀复用PID的其它进程，也未改历史。

## 卡片与侧栏

- 四入口：脚本、按严重度的发现看板、结果、历史；含阶段时间线、agent状态、总量及单agent tokens/耗时、问题、产物和日志。
- 已经显示过的完成卡没有自动消失计时器；×只隐藏本客户端卡片，不删除运行记录，历史中仍能找到。
- `dwf-pipeline-visible-runs`、`dwf-pipeline-dismissed`持久化已显示/已关闭集合；其它新运行完成不会替换掉旧卡。首次加载仍只额外选择最新未关闭终态，不将所有历史一次性展开。
- 侧栏进度无TTL，按startedAt选择较新的匹配运行；目前标题/cwd basename近似匹配，不是真session ID关联。
- 回答pending/submitted跨普通轮询保持，失败保留草稿和可见错误；整页重载不承诺草稿恢复。
- 运行中时间随客户端时钟推进，不依赖新journal事件；终态冻结。完成统计已修为settled子代理数量。
- 两客户端有独立localStorage；在DSH关闭，不会同步隐藏MiniMax里的同run卡。

## 验证

在`G:/mmx-project/zcode动态工作流-原else`运行：

```bash
node --test dsh-workflow-pipeline/test/api.test.mjs dsh-workflow-pipeline/test/client-contract.test.mjs
node --check dsh-workflow-pipeline/client.js
node --check dsh-workflow-pipeline/index.mjs
node --check dsh-workflow-pipeline/run-lifecycle.mjs
```

〔已修正〕**不再需要为测试协调暂停 MiniMax sidecar**：MMX 侧 Host 测试已在 `127.0.0.1:0` 临时端口上运行，固定生产端口 4231 从不被绑定（见 `mmx-workflow-pipeline/README.md` 的「测试与证据」）。〔历史〕86/86、0 skip 是 2026-09-29 在“先暂停后恢复”条件下取得的完整测试证据，保留为历史记录；它不表示今天的套件规模，也不用静态标记代替Host/UI行为。

真实计时用例：DSH在2分02秒和2分32秒两时点保持中文草稿，之后从界面提交，out/journal确认completed/file。普通并行展示的320 tokens是本机测试回执，不是模型计费。

[完整报告](../workflow-ui-evidence-20260929/ACCEPTANCE-023.md) · [证据索引](../workflow-ui-evidence-20260929/INDEX.md) · [测试原日志](../workflow-ui-evidence-20260929/plugin-023-tests.log)

## 已知限制

- **本插件未部署到活跃实例**：活跃 home 的 profile 没有本插件依赖，磁盘上那份 0.2.6 副本属于 dev harness profile 且与工作区源有三件不一致。本轮只做只读复核，**未部署、未重启 Harness、未做真实客户端验收**。
- 不宣称像素级1:1：未重新取得红箭头参考图。无agent的已完成阶段仍可能灰/黑。
- 卡片按扫描根显示，session隔离近似；同runId跨root冲突和既有卡排序未解决。
- 文件artifact仅路径tooltip；URL新窗未本轮实测。卡片仅最近24个calls/4条logs，结果模态框超过65,536个JS字符截断。
- localStorage失败静默；pending只在当前document；stop缺即时失败反馈并允许终态写CANCEL。
- DSH模块teardown未完整移除modal/style；更新通过原生重载（活跃 profile 的 `patchReload: "live"` 意味着 patch 改动要等一次原生重载才生效），不以热卸载验证代替。
- 创建时间查询失败/缺startedAt时回退裸PID；非Windows路径未实测。引擎OWNER裸PID保护未改。
- 后台窗口可能节流或暂现旧截图；操作后需要前台真实观察再判定，不能重复未知结果的停止/回答动作。
- 历史181秒启动超时根因未定位，0.2.3全宿主退出重开和深色实机主题未重测。
