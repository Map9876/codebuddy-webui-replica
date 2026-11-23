# CB Terminal Bridge —— 手机 chatbot 对接 code-server 原生终端（热更新版）

把 code-server 里打开的原生终端，变成一个手机友好的可视化 chatbot 页面。
**不 patch 任何文件、不重启 ptyHost、不影响现有终端会话**——以独立客户端身份连上
code-server 的远程 IPC，直接调用 `remoteterminal` channel 的 API 读写终端。随开随停。

## 快速开始

```bash
# 启动（默认 7911）
bash /workspace/cb-chat/start.sh

# 验证
bash /workspace/cb-chat/验证.sh

# 停止（不影响 code-server / 终端）
bash /workspace/cb-chat/stop.sh
```

浏览器打开：
- 本机 `http://127.0.0.1:7911/`
- 公网 `https://<你的前缀>-7911.cnb.run/`（CNB 端口转发）

## 文件

| 文件 | 作用 |
|---|---|
| `bridge_hot.js` | 核心：从零握手连 code-server WS + 复刻 VS Code 远程 IPC 协议，调用 `remoteterminal` channel；内置 HTTP 7911 |
| `web/` | 手机 chatbot 前端（index.html / app.js / style.css） |
| `start.sh` / `stop.sh` / `验证.sh` | 启停与验证 |

## 为什么是热更新（原理）

code-server 的终端数据在服务端 ptyHost，浏览器通过 WebSocket + 远程 IPC 访问它。
本方案复刻了这个客户端：
1. 连 `ws://127.0.0.1:8686/stable-<commit>?reconnectionToken=<uuid>&reconnection=false&skipWebSocketFrames=false`
2. 握手：`auth`（auth=none 不校验）→ 收 `sign` → 回 `connectionType`（Management=1，不签名）
3. 帧格式（ipc.net.ts）：13 字节头 `TYPE + ID + ACK + LEN`，payload 为 VSBuffer 序列化
4. RPC（ipc.ts）：header `[type, reqId, channel, method]` + body；channel 名 `remoteterminal`

调用的 API（服务端注册于 `serverServices.ts:390`）：
- `$listProcesses` → 列 ptyHost 全部进程（仅用于发现 workspaceId，`/cb/api/processes`）
- `$getTerminalLayoutInfo` → **VS Code web 真正显示的终端列表**。终端按 workspaceId 分组（实测 `-391a2e43` 有4个、`4cce8db9` 有1个）；web 只显示当前 workspace 那组。桥遍历所有 workspaceId 的 layout 并合并（`/cb/api/terminals`），这才是 chatbot 该显示的——比 listProcesses 少（排除了不在任何 layout 的历史/orphan 进程），比单 workspace 多（覆盖全部）。
- `$serializeTerminalState` → 终端屏幕快照（`ptyService.ts:230`），解析 `replayEvent.events[].data`
- `$input` → 写入终端（`ptyService.ts:441`）

读输出用**快照轮询**（前端每 1.5s 拉一次 `$serializeTerminalState`）而非事件流——
因为独立管理客户端订阅 `onProcessData` 事件收不到 EventFire（事件只对 attach 的连接推）。
快照轮询零依赖、稳定，且天然支持多端（每个客户端各自拉）。

## 多端同步与多终端

- **多端**：每个浏览器打开 chatbot 各自轮询快照 + POST 输入，天然同步（都读写同一 ptyHost 终端）。
- **多终端**：顶部 tab 列出 `getTerminalLayoutInfo` 返回的所有终端，点击切换；每个终端独立快照/输入。

## 已验证

- 从零握手连上，`connected:true`；列出终端（id=11 CNB Welcome）
- `$input` 写入真实生效（echo 写文件验证通过）
- `$serializeTerminalState` 读到终端屏幕内容（ANSI 回显 + 提示符）
- Playwright 390×844 手机视口截图：tab、输出、输入框、发送按钮布局正常，无重叠/溢出/挤压

## 注意

- `/usr/lib` 与扩展目录不持久，但本方案**不依赖任何被改动的文件**——bridge_hot.js 在 `/workspace`（持久）。
- 环境重启后只需重跑 `start.sh`，不需要重装、不需要改 code-server。
- commit 写死在 `bridge_hot.js` 顶部（`59c988c...`），若 code-server 升级需更新；可用环境变量 `CB_COMMIT` 覆盖。
- `/workspace/cnb-local/panel` 是另一项目，与本方案无关。

详细源码级分析见 `源码级对接分析.md`。


## UI：完全复刻 VS Code 终端面板（浅色主题）

前端 `web/` 按 VS Code 1.138 终端面板逐字复刻，**色值取自实际渲染的 computed 主题变量**（非手写猜测）：

| 元素 | VS Code 变量 | 实际值 |
|---|---|---|
| 面板背景 | `--vscode-panel-background` | `#fafafd`（非纯白） |
| 编辑器/输入背景 | `--vscode-editor-background` | `#ffffff` |
| 前景色 | `--vscode-foreground` | `#202020` |
| 次要文字/图标 | `--vscode-tab-inactiveForeground` | `#606060` |
| 边框 | `--vscode-panel-border` | `#f0f1f2` |
| tab 激活/非激活背景 | `--vscode-tab-*` | `#ffffff` / `#fafafd` |
| 列表选中/hover | `--vscode-list-*` | `rgba(0,0,0,.14)` / `.08` |
| 链接色 | `--vscode-textLink-foreground` | `#0069cc` |

- **极简无气泡**：终端内容是纯文本行流（等宽字体），不是聊天气泡盒子。
- **工具栏**：`切换终端下拉(CNB Welcome ∨) + + + ∨ + 分栏 + 垃圾桶(Kill Terminal) + ··· + ^ + ×`，图标用真实 codicon 字体（`web/codicon.css` / `.ttf`）。
- **右侧抽屉**：点切换终端下拉展开终端列表（icon + 名称 + 序号，当前项高亮），逐字复制 VS Code 的 `terminal-tabs-entry`。
- **More Actions 菜单**：Scroll to Previous Command `Ctrl+↑` / Scroll to Next Command `Ctrl+↓` / Clear Terminal / Run Active File / Run Selected Text / Start Dictation / Go to Recent Directory... / Run Recent Command... —— 文案与快捷键取自 `terminalStrings.ts:43-44` 和 `terminalMenus.ts:526-568`。
- 保留 visualViewport 防软键盘鬼畜滚动。
- 效果截图：`vscode-style-1.png`（主界面）/`vscode-style-menu.png`（菜单）/`vscode-style-drawer.png`（抽屉）。


## 终端创建/删除（真实内核 RPC，2026-11-22 新增）

通过桥调用 code-server 远程 IPC 的 `remoteterminal` channel，**真正**创建/删除终端，同步到 VS Code web：

- `POST /cb/api/create?workspaceId=<id>&name=<名>` → `$createProcess`（参数结构来自 `remoteTerminalChannel.ts:21`，复用现有终端 shellLaunchConfig/processLaunchConfig）+ **`$start(id)`**（关键！createProcess 只建 PTY 对象，必须再 start 才 spawn shell——`remotePty.ts:27/37`）+ `$setTerminalLayoutInfo` 同步布局（web 刷新才看得到）。返回 `newId`。
- `POST /cb/api/kill?id=<id>` → `$shutdown(id,false)`。进程与 layout 自动清除。
- `POST /cb/api/cleanup` → 清理 pid=-1 僵尸 PTY（曾因漏 $start 产生）。
- `GET /cb/api/layout?workspaceId=<id>` → 按 workspace 查 layout（web 显示的真实依据）。

**关键坑（血泪）**：
1. createProcess 后**必须调 `$start`**，否则 PTY 对象存在但 pid=-1（进程没起）。
2. 终端按 **workspaceId 分组**（实测 -391a2e43 / 4cce8db9），`setTerminalLayoutInfo` 参数要带 `workspaceId` 字段。
3. web 前端 `_saveState` 会周期性/刷新时重写 layout（前端是权威）——所以新建终端要尽快写 layout，且 web 刷新后以它的状态为准。

UI 工具栏（本次改造）：删掉 ∨(Launch Profile) 和 ^(最大化)；`+` 接真实 create；垃圾桶从右上角移除（防误触），移到 `···` 菜单里做成双层确认（Kill Terminal → Kill this terminal? [Kill][Cancel]）。
验证：点 + 后 tabs 20→21，新终端 pid 真实、zsh -i 启动；`-391a2e43` workspace layout 含新 id；VS Code web 刷新可见。


## 终端协议 → Web DOM 渲染器（pdf.js 模式，2026-11-22）

**不用 xterm**——而是像 pdf.js 解析 PDF 那样，自写终端协议转换器把字节流渲染成朴素 chat DOM。

- `web/term-parser.js`：`TermBuffer` 类，VT/ANSI 状态机（ground/esc/csi/osc/str），解析 SGR 颜色（30-37/90-97/40-47/100-107/38;5;n/38;2;rgb）、CSI 光标/擦除、CR/LF/BS/TAB，维护字符网格（每格带 fg/bg/粗体/斜体/下划线/反色），`toHTML()` 输出带 `<span style=color>` 的朴素行。
- ANSI 色取 VS Code 2026-light 真实默认（`terminalColorRegistry.ts` light defaults）：黑#000 红#cd3131 绿#107C10 黄#949800 蓝#0451a5 品红#bc05bc 青#0598bc 白#555555；前景#202020 背景#fafafd。
- **不用 replay 的小 cols（6）硬折行**：`renderTerm` 用 cols=10000，只按 `\n` 分行，视觉换行交给 CSS `white-space:pre-wrap`——这是"chat 朴素"而非终端网格的关键。
- snapshot 返回加了 `cols/rows`（来自 replayEvent.events[0]）。
- 提示符（zsh 的 `➜ /workspace git:(main)`、不同系统的 zsh/csh/bash）**从数据解析**，不写死——因为颜色/形状在 ANSI 序列里，解析器还原。

## 全屏输入法 + 视口锁定（防鬼畜滚动）

- 隐藏 textarea（`.hidden-input`，position:fixed、1px、透明、z-index:-1）接收输入法；点终端任意处 `log.click → input.focus()` 调出系统键盘。
- **无底栏**：没有固定底部输入框；用户点终端任意处即可输入，正在输入的内容作为终端末尾的一行（`❯ <text>` + 光标块）直接显示，像原生终端；发送后由pty回显。
- **视口锁定**：启动时把 `#app` 高度固定为 px（`window.innerHeight`），键盘弹出时不再改高度、不平移（只在屏幕旋转/宽度变化时重锁）。实测 resize/输入后 appH=844px、首行 Y 位置完全不变——彻底杜绝上跳下抽。
- 验证：点 log→input 聚焦；输入实时显示；彩色保留；视口锁定 three-snapshot 全一致。


## 历史 scrollback（与原版 xterm 一致，可上下滑看 1000 行）

源码确认原版机制：
- 前端 xterm scrollback = `terminal.integrated.scrollback` 默认 **1000 行**（`terminalConfiguration.ts:320`）；ptyHost replay scrollback 默认 **100 行**（`ptyHostMain.ts:35`，本环境 `VSCODE_RECONNECT_SCROLLBACK=100`）。
- replay 是"当前屏幕重绘脚本"（含 `[10A` 等光标上移），只恢复当前屏幕，不是完整历史；完整对话历史在 codebuddy 的 `/root/.codebuddy/projects/workspace/*.jsonl`，不在终端 buffer。

我们的实现（app.js 前端累积）：
- `histories[activeId]` 累积每个终端的历史 segment 行，上限 `SCROLLBACK=1000`（与原版一致）。
- 每次 snapshot 用 TermBuffer 重放当前 data 得到行，用**锚点匹配**（hist 末尾实质行，跳过动态提示符）合并去重——跳过 replay 重复包含的旧行，只追加真正新增的行。
- 渲染累积的 history 而非当前屏幕 → 可上下滑看全部历史（实测跨批次 A/B 内容都在，不丢失）。


## 终端路由 + 输入即时回显 + TUI 空行压缩（2026-11-22）

- **路由**：每个终端独立 URL，`https://<前缀>-7911.cnb.run/1` `/3` 等直接打开对应终端（桥 SPA 回退 index.html，前端读 pathname 设 activeId，switchTo 时 replaceState 同步 URL）。方便标记/多网页打开。
- **输入即时回显**：send 后立即在终端末尾显示发送的命令，并立即 pollSnapshot + 400ms 后再拉一次；强制 lastSnapshot='' 确保即使 data 未变也重绘。解决"输入后看不到、要刷新"——实测 600ms 内可见中文输入。
- **TUI 空行压缩**：codebuddy TUI 用几十个空行做屏幕占位，导致 130 行里大量空白、内容显得"比 VS Code 少"。`compressBlank()` 把连续空行压到最多1个，43 行即完整显示分隔线/选项1-4/Submit/底部快捷键提示，颜色（RGB 38;2 + 48;2）正常解析。历史累积也在压缩后进行。
- **实时流限制（源码确认）**：服务端 `RemoteTerminalChannel.listen` 的 `OnProcessDataEvent` 返回 `_ptyHostService.onProcessData`，但独立管理客户端未 attach pty，收不到 EventFire（实测只有 201 确认、无 202 推送）——所以历史只能靠 snapshot replay + 前端累积，拿不到真正实时流。


## 实时事件流打通 + 完整历史（2026-11-22 关键突破）

之前"历史只有当前屏幕、比 VS Code 少"的**真正根因**（源码级）：
1. `PtyHostService` 是**懒连接**（`ptyHostService.ts:53` __connection 首次才建立，`:176` proxy.onProcessData 转发依赖连接已建立）。订阅事件前必须先触发一次 RPC（如 `$listProcesses`）建立连接，否则事件通道是死的。
2. `ResponseType.EventFire = 204`（`ipc.ts:71`），不是 202（202 是 PromiseError）——之前误判导致事件推送被丢弃。

修复后：桥能实时收到 `onProcessData`（实测 TUI spinner/输出），从零握手稳定。
- `/cb/api/history?id=N` 返回桥累积的**实时原始数据流**（`ptyHistory`，含 snapshot 基线 + 之后所有增量），真正与 VS Code xterm scrollback 一致。
- TermBuffer 升级支持 **scrollback**（视口固定 rows，超出的行移入 scrollback，上限1000=原版默认）+ OSC/CSI 完整解析。前端一次解析全部历史数据 → 可上下滑看完整历史。
- `/cb/api/history` 在该终端无实时数据时，按需用 `$serializeTerminalState` 的 replay 作基线（不依赖启动时 listProcesses 超时问题）。
- 结论：**不需要重编 VS Code / code-server、不需要重启 ptyHost**（曾试图改 persistentSessionScrollback 配置+重启，但在发现上面两个根因后证明不必要）。

备注：曾把 settings.json 的 `terminal.integrated.persistentSessionScrollback`/`scrollback` 改成 1000（备份 settings.json.cb-bak）——保留无害（让 snapshot 基线更完整），但热更新方案本身不依赖它。


## 滚动行为澄清 + 修复"上滑被拽回底部"（2026-11-22）

**原版机制（源码确认，不是滚动分页加载）**：xterm 的 scrollback 是固定大小的内存环形缓冲 —
`Buffer.ts:123` `rows + scrollback`（默认 scrollback=1000）。**全部历史一次性在本地内存**，滚动是纯本地无延迟的，
没有"滑到顶部向服务端请求下一页 200 行"的逻辑，也没有加载动画。你看到的无延迟滚动正源于此。
手机/电脑机制完全一致（同一 WS/同一 RPC，只是视口尺寸与触摸不同）。

**修复的 bug**：之前每 1.5s pollSnapshot 重建 DOM 后无条件 `scrollBottom()`，导致你上滑看历史时
被拽回底部。改为：重建前记录 `atBottom`（距底<=80px），只有本来就贴底才滚到底，否则保持 `scrollTop`。
实测滑到顶后等 4s，scrollTop 保持 0。

**关于 SSE 实时流**：桥已有 `/cb/api/stream?id=N` 在用 `onProcessData` EventFire 推实时数据。
当前前端用轮询 history 全量重建（流畅、够用）。若要进一步省资源，可改用 EventSource 增量 append，
避免 spinner 持续变化导致的反复全量重建——这是可选优化，不影响正确性。


## SSE 增量渲染（替代全量重建，2026-11-22 完成）

前端 app.js 重构为真正的增量渲染，彻底去掉每 1.5s 全量重建：
- 终端行走独立 `#lines` 容器（输入反馈行走 log，不干扰 diff 索引）。
- 每个终端一个**持久 TermBuffer**（`state[id]`），SSE chunk 到达后 `tb.write(chunk)` 增量写入。
- **公共前缀 diff**：只增删/替换变化的行 DOM（spinner 只改最后一行 → diff 极快），不全量重建。
- `switchTo` 先拉一次 history 建基线，再 `connectStream(id)` 开 EventSource 订阅 `/cb/api/stream?id=N` 实时流；不再有 pollTimer。
- send 后回显由 SSE 实时推送（无延迟），不再主动拉快照重建。
- 滚动位置天然保持：diff 只在贴底时才自动滚到底，上滑看历史时保持 scrollTop。
- 验证：初始完整加载、上滑5s不跳、贴底实时更新、无JS错误、手机截图正常。


## scrollback 上限放大（2026-11-22）

用户反馈"翻到顶历史不够多"。根因：TermBuffer 的 `maxScrollback` 原为 1000（原版默认值），
长会话中大量历史行被 `shift()` 丢弃（history 有 4694 chunks / 14万字符）。
改为 **5000**（`term-parser.js:42`）。效果：渲染行 911→4792，scrollH 17k→90k，
可翻到很早的历史。代价：更长会话 DOM 节点更多，但实测仍流畅。


## 对话历史导出（进行中，未完美）
- `export_doc.js <id> [输出]`：把终端历史导出成 Markdown。已能从桥 history API 拉数据并用轻量 VT 解析器处理。
- **未解决问题**：codebuddy TUI 用光标定位（CSI A/B/H）和 
 重绘，而非 
 换行，导致导出的 218K 字符只分成 2 行——内容挤在一起。需要更精确地模拟行列网格（用 TermBuffer 的最终屏幕 + scrollback），或按 TUI 的换行语义重写。
- 用户最终诉求：把长会话导出成可读文档，避免网页翻 5000 行。

## 用户最终目标（完全还原终端内核，未完成）
用户明确要求"完全还原 VS Code terminal 内核"，当前仍是 pdf.js 式朴素 chat 简化版：
1. **TUI 输入区**：原版 codebuddy TUI 在两条 ─── 横线之间显示可输入区（`⏵⏵ bypass permissions (⇧tab to cycle)`、`❯` 提示符），输入直接显示在那里。我们要把按键发给 PTY，让 TUI 回显到正确位置（内核信号对接），而不是前端自己在底部模拟一行。
2. **抽屉终端列表**：右侧切换终端抽屉的项也是 term 流渲染的一行，需同样还原。
3. **VT 信号**：Shift/Esc 等按键提示手机可不需要，但技术方案上要支持。
4. 关键技术方向：输入靠 PTY 回显（$input 发按键 → onProcessData → SSE → TermBuffer → 显示在 TUI 输入区），回车用 
（不是 \n）触发 TUI 执行。当前 send 发 v+'\n'，对 TUI 可能不对。


## 对话历史导出（已完成）
- `export_doc.js <id> [输出]`：用 TermBuffer 精确模拟行列+光标，把 history 原始流展开成完整对话 Markdown。
- 实测 id=3：2981662 字符 → 57523 行 → `对话历史-3.md`（1.2MB，`###` 对话节点/工具调用/git 输出结构清晰）。490ms 解析。
- 关键：必须用 TermBuffer（不是轻量正则），因为 codebuddy TUI 靠光标定位重绘、不是 \n 换行。

## 内核级输入（完全还原，已完成）
- 发现：TUI 输入区（两条 ─── 横线间的 `> 文字` + 光标块 + `⏵⏵ bypass permissions (⇧tab to cycle)`）本身是 PTY 回显的实时流（id=2 抓到原始序列）。
- 改造：移除前端模拟的 typing-line；改为用户打字时**逐字符实时发给 PTY**（`$input`，fire-and-forget），TUI 回显 → SSE → TermBuffer → 显示在 TUI 真实输入区。回车发 `\r`（终端 Enter 语义）。IME 组合期间不发、compositionend 一次性发。
- 验证：打字后 typingLines=0、input 清空、终端内容含输入（PTY 回显生效）、无 JS 错误。
- 意义：这是"完全还原终端内核"的核心——输入走真实终端信号，而非前端模拟。

## 内核还原续篇（2026-11-23）
本轮深度对照真实内核/Web UI 完成的能力（每项均经真实浏览器手机视口验证，详见 `导出与历史机制说明.md` 121-169 节）：

- **拆分终端**：`btn-split` 从死按钮变为完整能力——桥端真实新建同 workspace 终端，iframe 隔离实例并排显示（桌面左右/手机上下），可拖动 sash、双向关闭且无 PTY 残留。
- **TUI 交互补全**：`isTui()` 改用 codebuddy 标志（修复信任对话框无 `⏵⏵` 关键词被误判）；手机底部补 Esc/⇧Tab/Enter 辅助键；工具栏溢出修复。
- **编辑器**：全文内容搜索（grep API + 结果统计 + 点击定位行号）、dirty tab 未保存标记、多分组 tab 可切换文件；思考块 chunk 合并、工具调用按轮次聚合（"N 个工具调用 · M 已完成"）。
- **会话**：手机首屏默认展开会话列表、标题过滤系统注入乱码、活跃会话删除保护、侧栏内新对话入口。
- **资源修复**：补齐 Monaco codicon 字体（404）与 Devicon woff2 MIME（桥静态服务），浏览器 console 零错误、图标正常渲染。
- **验证体系**：8 个验证脚本 + `run_all_checks.sh` 一键门禁（含 `verify_assertions.js` 综合断言），一键 8/8 PASS。
