# MMX 生产 GUI 真实验收记录 · 2026-10-09

主会话在生产 MiniMax Code 窗口（真 GUI）完成的端到端验收。所有点击/按键均通过
CDP `Input.dispatchMouseEvent`（Chromium 真实输入管线，与物理点击同路径）驱动，
非 DOM `el.click()` 合成。所有 DOM 读取为只读 `Runtime.evaluate` 探针。

## 环境

| 项 | 值 |
| --- | --- |
| 宿主 | MiniMax Code 3.1.1（Electron 42.8 / Chrome 148），主进程 PID 58288，窗口可见、2048px 后被用户/宿主还原为 1028px（不影响验收） |
| CDP | 127.0.0.1:9331（宿主启动参数 `--remote-debugging-port=9331`，owner=58288） |
| sidecar | 127.0.0.1:4231（PID 30736），capability/Origin 双守卫生效（裸 `/healthz` 回 `forbidden: missing or invalid workflow capability`） |
| 引擎 | wf.mjs 0.8.1，SHA-256 `21bdcb2fec01061eb559774958d52a7699ee1890a64f09f20425fc302c2f545e` |
| 注入客户端 | ver 11，`installed:true`；会话路由 `conversation`，anchor `[data-testid="message-list"]` 存在 |

## 验收运行（r3）

- 脚本：`.qoder/workflow-drafts/ui-acceptance-file-20261009.js`（两阶段，各 1 次
  `agent()` 调用，per-call `timeoutMs:1500000`）
- 命令（cwd=仓库根，exit 0）：
  `node plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs run .qoder/workflow-drafts/ui-acceptance-file-20261009.js --backend file --yes --run-id ui-acceptance-file-r3 --name "UI验收-file-r3" --concurrency 1 --max-calls 2`
- 时间线（UTC，来自 pending/out 产物）：
  - 09:48:04 阶段A park，callId `c000-992cf8cc`（同 prompt key 恒定，opts 不入 key）
  - 09:50:53 阶段A 回填 `{"ok":true,"text":"UI_ACCEPT_A_20261009"}` → 阶段B park `c000-d435748c`
  - 09:51:1x 阶段B 回填 `UI_ACCEPT_B_20261009` → **completed**（2 agentCalls，总时长 3分11秒）
- runKey `0c4e8e28ebc35c0c7f6e69ec3043ee033037e7ee05aef45c26759d78900ba4cc`

## GUI 逐项证据

1. **LIVE 卡片**：`⚙工作流运行中 · UI验收-file-r3 · 未绑定 · 1 个阶段 · 1 个子代理工作中 · 32.5秒 · ⏹⤢ · 阶段A·验收 0/1` + 底部 📋发现看板/📄结果/🗂历史/🔗绑定当前会话 四 pill。视觉通道（远端视觉模型读 PNG）独立确认卡片真实上屏。
2. **阶段推进实时渲染**：A 回填后卡片自动更新为 `2 个阶段 · 1 个子代理工作中 · 2分55秒 · 阶段A·验收 1/1(已完成) · 阶段B·验收 0/1`（轮询驱动，无人工刷新）。
3. **完成态**：`✓工作流已完成 · 2 个子代理已结束 · 3分11秒 · 两阶段 1/1`，正文内联 resultPreview 直接显示 `{"A":"UI_ACCEPT_A_20261009","B":"UI_ACCEPT_B_20261009",…}`。
4. **📄 结果 modal（真点击 603,368）**：标题 `结果 · UI验收-file-r3`，正文完整 out JSON，`hasA/hasB` 均真。✕ 真点击 (921,464) 关闭（display:none 实测）。
5. **📋 发现看板（真点击）**：标题 `发现看板（按严重度） · UI验收-file-r3`；无 findings 数组时正确降级显示原文。
6. **🗂 历史（真点击）**：标题 `工作流历史（全局）`，列表真实渲染（r3 已完成 2/2·3分11秒·未绑定·绑定当前会话·子代理 2；r1/r2 失败行也在）。
7. **>_ 脚本（真点击，带 elementFromPoint 命中预检）**：标题 `脚本 · UI验收-file-r3`。
8. 全部 modal ✕ 均真实点击关闭成功。

截图（本地保留，不入库——含用户桌面/任务列表内容）：
`.qoder/workflow-runs/ui-acceptance-file-r3/shot-live.png`、`shot-live2.png`（LIVE）、
`shot-completed.png`（完成态）、`shot-result-modal.png`（结果 modal）、`shot-script-modal.png`（脚本 modal）。

## 测试独立复跑（主会话亲测）

- `node --test test/ui-isolation-observer.test.mjs test/ui-isolation-tools.test.mjs test/ui-isolation-fixture-result.test.mjs`（cwd=mmx-workflow-pipeline）→ **63/63 pass, 0 fail**。
- `test/iso/launch-isolated.ps1`：PSParser 语法通过（2252 tokens）；UTC 时基修复在源码层核实（`ConvertTo-UtcInstant` RoundtripKind+ToUniversalTime；`$processStartUtc` 统一 UTC 比较，含 -2s 容差）。

## 测量陷阱记录（方法论）

- `closeModal()` 仅置 `display:none`，modal 元素常驻 DOM——判"已关"必须测 `style.display`，不能测 `getElementById` 是否存在。
- modal 标题在关闭后保留旧值——判"打开了哪个视图"必须同时看 display 与 title。
- 宿主会话列表有滚动回吸（pinned bottom）：`scrollIntoView` 后坐标会在秒级失效，点击前必须重取坐标（带 `elementFromPoint` 命中预检最稳）。

## 未验边界（如实）

- ⏹ 停止 / ↻ 恢复 / ✕ 移除：LIVE 与失败卡片上按钮真实呈现（截图可证），本轮未实际触发（停止会杀运行、恢复会再起 25 分钟 park 窗口）；行为由 63 例隔离测试与历史轮次覆盖。
- 业务问答（chat 侧）不在本轮 GUI 验收范围。
- 生产 sidecar（4231）与注入 UI 验收后保持运行（供用户直接查看）；CDP 9331 为本轮重启宿主时显式加入的参数。
