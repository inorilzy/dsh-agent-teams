# T05 最终验收与二分定位可见性验收记录

2026-11-24，macOS 27.0.1（26A434，Darwin 27.0.0 arm64），Node.js v24.22.1，Git 2.56.0，Google Chrome 158.0.8127.38。`git merge integration/final-verify-visibility` 输出 `Already up to date.`，随后 `git rev-parse HEAD integration/final-verify-visibility` 均返回 `da6204e863e0dcfff8f8d60f895f3faff1ed6b1a`。T01–T04 集成提交分别为 `fc76a06`、`da6204e`、`eb6a9cc`、`acc74c2`。

## 验收结论

| # | 工单验收项 | 结果与实测证据 |
| --- | --- | --- |
| 1 | macOS Chrome 中的 `final`、`bisect`、宽窄侧栏和会话卡片 | **PARTIAL**。两阶段均呈现正确的状态徽章、横幅、检查号、耗时及上限。已挂载的会话卡片在侧栏切入二分后保持旧状态，304 px 窄栏依赖图区产生横向溢出。浏览器命令退出码为 0，日志显示 `browser warnings and uncaught exceptions []`。见下方三张截图。 |
| 2 | 截图落盘并逐张目检 | **VERIFIED**。Chrome `Page.captureScreenshot` 生成三张 928 × 842 PNG，`read_image` 逐张核对文案、颜色、对齐、换行及边界，记录了第 1 项的两处偏差。绝对路径列于截图表。 |
| 3 | 仓库报告及本地副本 | **VERIFIED**。仓库报告同步到主仓库验收目录，`cmp -s` 退出码为 0。两份报告含实测命令、结果和截图绝对路径。[验收报告副本](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/report.md>) |
| 4 | 全量 Node 回归与跨平台静态排查 | **VERIFIED**（macOS 平台无关测试和静态排查）。`node --test` 为 368 项、361 通过、0 失败、7 跳过，`node --check` 为 9/9。额外的 Windows/Linux 运行态为 **NOT RUN (deferred: Windows/Linux)**。 |
| 5 | 结束验收进程并保持工单 worktree 清洁 | **VERIFIED**。三次浏览器夹具的 Chrome PID、监听端口和临时目录均已消失。`git status --porcelain=v1 --untracked-files=all --ignored` 在写报告前无输出，报告提交后再次运行。 |

## macOS Chrome 实测

在工单 worktree 根目录运行。夹具复用 [协调器集成测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/final-verify-coordinator.test.mjs>) 的文件门控方式。临时 Git 仓库的两个工单均实际集成。`Coordinator` 运行真实检查子进程，SQLite 记录事件，`RunCatalog.read` 提供实时 HTTP 响应。Chrome 用 React / ReactDOM 19.2.0 开发版挂载原样的 [客户端入口](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/client.js>) 及其注册的侧栏和会话组件。夹具提供外围布局、worker 启动适配器和通知接收回调。已安装的 DSH GUI 中加载此次工单版本以及实际 `agent.followup` 消息入会话为 **NOT RUN**，本次证据覆盖协调器到通知回调以及真实浏览器中的插件组件。

```bash
set -o pipefail
node '/Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/verify-browser.mjs' 2>&1 | tee '/Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/browser.log'
```

[浏览器夹具](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/verify-browser.mjs>) · [完整浏览器日志](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/browser.log>)

| 场景 | 结果 | 浏览器实测输出 |
| --- | --- | --- |
| `final` 阶段状态和数据 | **VERIFIED** | 摘要与所选详情 `finalPhase` 相同，`INTEGRATED=2`、`complete=false`。蓝色「最终验收中」徽章、蓝色横幅 `data-dag-final="final"`、`integration-web-regression-suite 3/3`、`已失败：lint-contract` 和 `已耗时 0:29 / 上限 2:00`。全数集成提示可见，待验收分段为蓝色扫光。两种宽度的计时从 `0:00` 增至 `0:01`，减少动态效果模式下两个动画的计算值均为 `none`。 |
| `bisect` 阶段状态和数据 | **VERIFIED** | 摘要和详情都显示 `step=1`、`lint-contract 1/1`、两个失败项。琥珀色「二分定位中」徽章与横幅可见，横幅显示 `第 1 步 · lint-contract 1/1`、`已耗时 0:05 / 上限 2:00`、`已失败：lint-contract、integration-web-regression-suite`。 |
| 548 px 宽栏 / 304 px 窄栏 `compact` | **PARTIAL** | 宽栏侧栏 `clientWidth/scrollWidth=531/531`。窄栏的依赖图排在工单列表前，横幅正文均为 3 行且文字裁剪计数为 0。窄栏侧栏为 `287/305`，依赖图区为 `261/292`，内层图为 `277/388`，两阶段均可见侧栏底部横向滚动条，依赖图区右侧内容需要横向滚动。 |
| 会话卡片 `RunCard` | **PARTIAL** | 首次挂载在 `final` 时两张卡片均显示「最终验收中 · 2 张工单」。保持同一挂载，侧栏出现「二分定位中」后再等待 4200 ms，两张卡片仍显示「最终验收中」。重新挂载后均显示「二分定位中 · 2 张工单」。两种宽度的卡片文字和按钮均在边界内。 |
| 账本与进展通知 | **VERIFIED**（协调器通知回调） | 使用默认 30 秒通知宽限期。长检查发送一次 `final_verify_running`，包含 `integration-web-regression-suite (3/3)`。释放长检查使其失败，二分门控仍关闭时收到一次 `final_verify_bisecting`，列出两个失败项。完整事件顺序为 `final_verify_started → final_verify_running → final_verify_bisecting → bisect_step → final_verify_failed`。 |

### 逐图核对

| 截图绝对路径 | `read_image` 观察 |
| --- | --- |
| [final-wide-compact.png](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/final-wide-compact.png>) | 两栏蓝色状态色调一致，横幅图标与首行对齐。宽栏一行阅读检查名，窄栏断行后仍能读完检查名、序号和耗时。两张卡片状态和按钮可读，窄栏底部出现横向滚动条。 |
| [bisect-wide-compact.png](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/bisect-wide-compact.png>) | 两栏琥珀色徽章、左边框和环色一致。较长的失败项在窄栏自然换行，保留完整内容。重新挂载后的会话卡片状态正确，窄栏依赖图区仍在右边界被裁切。 |
| [bisect-stale-card.png](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/.scratch/final-verify-visibility/acceptance/bisect-stale-card.png>) | 同屏上方侧栏已经是「二分定位中」，下方保持原挂载的两张卡片均为「最终验收中」。在截图中可直接对照两处状态。 |

复现卡片状态偏差时，保持 `final` 卡片的 DOM 挂载，等待二分横幅读到 `bisect` 并经过两次侧栏轮询间隔，再读 `data-dag-run-state`。卡片仅在 `sessionId` 或 `runId` 变化、或重新挂载时读取快照。复现窄栏偏差时，保留两张有依赖的工单、展开依赖区并把侧栏开到 304 px，对比侧栏和依赖区的 `clientWidth` / `scrollWidth`。本次没有判定窄栏偏差相对前一版本的起点。[RunCard 读取逻辑](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/client.js#L2928>) · [侧栏 `compact` 分支](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/client.js#L2786>)

## Node 回归与跨平台静态排查

```text
$ node --test
ℹ tests 368
ℹ suites 1
ℹ pass 361
ℹ fail 0
ℹ cancelled 0
ℹ skipped 7
ℹ todo 0
ℹ duration_ms 43415.410708
```

跳过的 7 项为 Windows `.cmd` 用例 1 项、DSH 访问控制 1 项、DSH SDK 4 项、DSH Web 1 项。`DSH_TEST_BIN`、`DSH_TEST_CHROME`、`DSH_TEST_PUPPETEER` 均为 `unset`。其余可执行用例已全部结束，包括快速通过不通知、`end` / `worker-end` 延迟通知、重启幂等、取消和关闭清理计时器、摘要透出、旧快照兼容与浏览器计时逻辑。

```bash
git diff --check 3809334 HEAD
for p in src/store.mjs src/coordinator.mjs src/dashboard.mjs src/client.js test/final-verify-{store,coordinator,dashboard,client}.test.mjs test/integration-end.test.mjs; do node --check "$p" || exit; done
```

`git diff --check` 无输出且退出码为 0，循环命令退出码为 0。逐文件复核 `git diff 3809334 HEAD -- src/store.mjs src/coordinator.mjs src/dashboard.mjs src/client.js` 及 `git diff --unified=0 3809334 HEAD -- src test` 的改动，结果如下。

- 生产增量使用 SQLite SQL、ECMAScript、Node 定时器与 AbortSignal，以及浏览器 DOM / CSS。检查开始时间采用 epoch 毫秒，显示以服务端快照差值与浏览器本地增量计算。没有发现新增操作系统专属原生 API 或本地文件路径分隔符依赖。[存储](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/store.mjs>) · [协调器](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/coordinator.mjs>) · [看板](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/dashboard.mjs>) · [客户端](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/src/client.js>)
- 新测试的临时路径使用 `tmpdir()`、`join()` 和文件 URL。协调器夹具显式按平台选 `NUL` / `/dev/null` 并给 Windows 加长等待窗口。另有存储测试使用 `/work`、`/worktree/A` 等内存元数据字符串，不访问这些路径。对通知边界的验证使用模拟定时器和文件门控。真实子进程和资源较慢时有等待上限，Windows/Linux 时序仍待实机验证。[存储测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/final-verify-store.test.mjs>) · [协调器测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/final-verify-coordinator.test.mjs>) · [看板测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/final-verify-dashboard.test.mjs>) · [客户端测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/final-verify-client.test.mjs>) · [既有集成测试](</Users/inorilzy/Documents/deepseek-harness/default-workspace/dsh-ticket-dag/test/integration-end.test.mjs>)

Windows / Linux **NOT RUN (deferred: Windows/Linux)**。后续实机清单如下。

1. 在两套宿主上核对 Node、Git、Chrome 版本后执行 `node --test`，记录环境跳过项。Windows 另确认 `.cmd` 路径确实执行，Linux 检查进程树取消、关闭和定时器退出。
2. 将 `DAG_ACCEPTANCE_CHROME` 设为各自主机的 Chrome / Chromium 路径，用同一文件门控夹具或本机浏览器运行 final → bisect。分别检查 548 px、304 px 和系统缩放下的横幅换行、侧栏滚动和卡片同一挂载期间的状态更新。逐张读取截图并检查浏览器控制台。
3. 在对应平台的兼容 DSH 宿主配置 `DSH_TEST_BIN`、`DSH_TEST_CHROME`、`DSH_TEST_PUPPETEER` 后运行 `node --test test/dsh-e2e.mjs test/dashboard.test.mjs test/web-panel.mjs`。在真实 DSH 会话走一轮同类 `end` 计划，核对 30 秒进度、二分即时通知及一次性投递。

## 清理记录

浏览器夹具首轮记录到窄栏溢出，第二轮的布局选择器误算了嵌套工单区。第三轮按直接子区块测量并保留溢出证据。三轮均释放浏览器与协调器，第三轮输出 `Chrome exit 0`、`HTTP fixture closed true`、`coordinator open runs 0`。用 `ps -axo pid=,comm=,args=` 核对 Chrome PID `40764`、`41274`、`41747` 及对应临时 profile，无残留进程，三个临时目录均已不存在。对 HTTP 端口 `63049`、`63104`、`63127` 分别运行 `lsof -nP -iTCP:<端口> -sTCP:LISTEN`，均退出 1，未发现监听者。本地夹具、日志、截图和报告副本仅存于主仓库验收目录。
