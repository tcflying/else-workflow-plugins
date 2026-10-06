# else-workflow-plugins


<!-- project-evidence-rules:20261006 -->
> 开发与验收接续：先读 [本目录 AGENTS](./AGENTS.md) 的“每轮推进与独立验收铁律”。每项目每轮记录真实推进/局部阻塞、原始证据、实际验证和未测边界；已授权下一步同步执行，旧证据不冒充新增，自报 PASS 不作为独立验收。失败/阻塞可诚实收束，不要求轮轮成功。统一 task 规范与证据 CLI 的本机路径、加载范围和无 Stop Hook 限制见该入口。
<!-- /project-evidence-rules:20261006 -->

MiniMax Code（MMX）与 DSH 双端实时工作流插件工程：两端各一个注入客户端 + 一个本地编排 Host，共享同一套文件后端引擎 `wf.mjs`（0.8.1），外加 MMX 原生会话 Hook 插件。

> 语言：中文（README）。代码注释与测试名以英文为主。

## 状态（2026-10-05）

- **W1—W7 全部波次（F01—F24）已改、已隔离测试、已通过独立复查**（详见 [`1004.md`](./1004.md)，§10 为波次终态）。
- **未部署**到任何宿主运行时；**真实 GUI / 真实宿主验收未测**。所有「通过」仅指工作区源码与隔离层。
- 主会话终审抽查（2026-10-05，27 个非禁用套件一次跑齐）：**468 pass / 9 fail**。
  - 8 fail = `deployment-safety.test.mjs` 既有夹具漂移（历史保留，不放宽求绿）；
  - 1 fail = `manifest-schema.test.mjs` 的 F22「安装副本待部署」文档化红（部署后自动转绿）。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `mmx-workflow-pipeline/` | MMX 端：`sidecar.mjs`（发现/编排/CDP 注入 Host）、`client-inject.js`（渲染器注入客户端）、`run-lifecycle.mjs`、`install-skills.mjs`、`skills/mmx-workflow/`（`/mmx-workflow` Skill） |
| `dsh-workflow-pipeline/` | DSH 端：`index.mjs`（Host）、`client.js`（客户端）、`run-lifecycle.mjs`、`skills/dsh-workflow/`（`/dsh-workflow` Skill） |
| `plugins/` | `plugins/dynamic-workflow/`（共享引擎 `runtime/wf.mjs` 0.8.1 + 引擎测试）、`plugins/mmx-native-session-hook/`（MMX 原生归属 Hook：manifest + relay）、`marketplace.json` |
| `workflow-pipeline-guide/` | 2026-10-03 归档基线（改动前客户端/引擎快照），独立复查用「未修实现实测跑红」的对照物。**以 submodule 引用**，正式仓库：[tcflying/workflow-pipeline-guide](https://github.com/tcflying/workflow-pipeline-guide)（本仓锁定 commit `dd6853c`） |
| `1004.md` | 24 项修复的授权边界、实施计划、逐波施工终态与台账（唯一权威记录） |
| `workflow-ui-v2-SPEC.md` | 工作流 UI v2 规范（含 >2s 代际 fail-closed 等约束） |

## 安全设计要点

- **capability 不入源码**：sidecar 运行时随机生成（`newCapability()`），注入客户端时才把占位符 `__MMXDWF_CAPABILITY__` 替换为真值；源码与仓库中不存在任何真实 capability。
- MMX Host 校验 capability + Origin（`app://./archon` 回显，非 `*`）；缺 capability 一律 `403` 且无 CORS 头。
- 写盘边界：`wx` 独占创建、OWNER 存活检查、startedAt 代际差 ≤2s fail-closed、runDir realpath 身份绑定、注册表缓存命中与最终写盘前双重身份重核。

## 测试

零第三方依赖（仅 Node 内置模块）。逐文件运行：

```bash
node --test mmx-workflow-pipeline/test/sidecar.test.mjs
node --test dsh-workflow-pipeline/test/client-contract.test.mjs
node --test plugins/dynamic-workflow/test/f21-resume-inheritance.test.mjs
# …（各 test/ 目录下 *.test.mjs 均可单独运行）
```

**两个禁跑文件**（历史原因，固定名写共享 Temp，勿运行）：

- `mmx-workflow-pipeline/test/host-lifecycle.test.mjs`
- `plugins/dynamic-workflow/test/wf.test.mjs`

## 本机锚定声明

本工程为特定工作区定制：`relay.mjs` 按整条路径钉死工作区引擎、测试夹具引用本机绝对路径（`G:/qoder-intl-project/else/…`、`C:/Users/datoo/…`）。这是设计的一部分（精确路径匹配、防 basename 泛化），不是可移植性问题；换机部署需按实际路径同步修改。

## 授权与边界

见 [`1004.md`](./1004.md) §0 与 §10.5：不改宿主源码、零第三方依赖、固定端口不漂移、仅 MMX 与 DSH 两端、业务 `ask` 真实等待真人、不代官方 `pending_review` 审批。
