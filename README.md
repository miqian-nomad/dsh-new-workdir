# dsh-new-workdir ・ 新目录会话

一键「领一个独立工作目录 + 开一个干净会话」的 DSH 插件。目录即沙盒边界：
每个任务一个目录，产物不再互相污染；工作区标题就是时间戳，侧栏一眼能认出。

**官方文件零改动。** 全部走公开接口（slot 注册 + 官方 Remote + 一个 loopback
HTTP 端点），只额外在客户端包了一个 `uiWorkspace.startSession`（见下文）。
DSH 每两三天发一版，升级后最坏也只是那层包装失效、退回官方行为，不会报错。

**English** — One click gives you a fresh timestamped working directory under your
chosen root, registered as a DSH workspace with a clean session inside it.
*Directory = sandbox boundary*, so different tasks stop polluting each other.
**Zero changes to official files**: public slot registration + official Remote calls
+ one loopback HTTP endpoint (plus a single client-side wrapper around
`uiWorkspace.startSession`, which one config line turns off).

---

## 入口一览

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 文件夹+加号 新目录 | 输入框右侧（模型选择器左边） | 一次点击跑完整条流程，适合日常 |
| 新目录会话 | 设置页左侧列表 | 同样的动作，外加根目录 / 已建数量 / 最近目录 / 可选目录名 |
| 新对话 / ⌘N / Ctrl+Alt+N | 侧栏顶部（官方入口） | 已接管：官方「新建会话」现在也领新目录 |
| 工作区行上的 ⊕ | 侧栏工作区行右侧 | **保持官方**：在**那一个**目录里开会话（目录里已有空会话时官方会直接复用那个） |

这两个官方入口长得像、语义不一样，别搵：顶部那个是「给我个新地方干活」
（已接管成领新目录）；行内 ⊕ 是「就在这个目录里再开一个会话」（官方语义，

图标是内联 SVG（lucide `folder-plus` 的 path 数据），跟 `currentColor` 走主题色。
这里故意不用 emoji：`🗂` 在中文 Windows 的字体回退链里会渲染成一坨黑块。

---

## 点一下发生了什么

```
POST /api/new-workdir/mkdir          host 半区用 node:fs 在 root 下领一个目录
GET  /api/new-workdir/state          先问一句 root；已经有空目录会话就直接切过去
ctx.workspaces.create({ path })      官方 Remote：把目录注册成工作区
ctx.sessions.create({ workspaceId }) 官方 Remote：在里面开一个干净会话
ctx.uiWorkspace.openSession(id)      切过去（方法不在就静默退化，会话已在侧栏）
POST /api/new-workdir/prune          回收空目录（只删磁盘上真的空的）
```

**连点不会堆目录**：复用**只认「本次页面会话里刚建、而且还没聊过」的那一个**
（内存里记着，刷新页面就清空）。连点两下 → 第二下回到刚建的那个；一旦在里面
发了消息（不再是空会话）或者刷新过页面 → 下一个点击就是崭新的目录。
面板里填了名字 = 强制新建。

**不会把你拽到旧工作区**（0.3.2 修的）：复用**不再**去扫 root 下其它旧空会话。
以前那一条会把用户几天前留下的空会话当成候选，点「新对话」直接切过去、
一个目录都不建 —— 看起来就像「新会话跑到旧工作区里去了」。

**不会留下死目录**：`sessions.create` 失败会重试一次，还失败就把刚建的工作区退
注册表、把空目录收回去，并往 `new-workdir.err.log` 记一行。

**官方「新建会话」也走这条路**：DSH 的 `session.new`（侧栏顶部按钮 / ⌘N）最终
调 `uiWorkspace.startSession()`。不带工作区 id 时我们接管 —— 先领新目录；带了
工作区 id（工作区行上的 ⊕、工作区选择器里选一个）则原样交给官方。
所以「点新建会话 → 却掉进当前工作区」不会再发生。
`cordis.patch.yml` 里 `bridgeNewSession: false`（或 `window.__dshNewWorkdirBridge = false`）
可整层关掉，关掉后官方入口一字不变。

**这层接管到底盖住了谁**（0.4.1 补充，之前 README 写得太省）：官方客户端里
`uiWorkspace.startSession()` 是**共享方法**，无参调用点不止一个，包了它 =
下面这些地方一起变：

| 调用点 | 位置 | 接管后的行为 |
| --- | --- | --- |
| `session.new` 命令 | 侧栏顶部「新对话」/ ⌘N | 领新目录（本插件的目标行为） |
| `onNewTask` | 任务管理面板的「新建任务」 | 领新目录（符合「新任务 = 新地方」，但请注意它也会建目录） |
| `startCreatorDraft` | 设置页「让 Agent 帮我创建预设模式」（需开发者工具） | ⚠️ 也会领新目录，且官方那段是**同步**顺序：`seat.stage(...) → startSession() → seat.apply()`；包壳后 `startSession` 变成异步，`seat.apply()` 会跑在新会话出现之前，暂存的 preset 可能落到旧会话上 |
| 侧栏工作区行的 ⊕ / 工作区选择器 | 带工作区 id 调用 | 原样透传给官方，行为不变 |
| 其它插件调 `startSession()` | 任意 | 一样会被接管（方法本身没有「谁点的」这种信息） |

要绝对安全就关掉这层：`bridgeNewSession: false`。插件自己的两个入口（输入框右侧 chip、
设置页卡片）不依赖它，照常工作；关掉后官方「新对话」退回官方语义（留在当前工作区）。

目录名 = `YYYY-MM-DD-HH-MM-SS`（可选 `-自定义标签`），与 `D:\work-harness`
下的历史目录同构；工作区标题 = `YYYY-MM-DD HH:MM:SS`（官方默认标题是目录名
basename，这里顺手改名成人读格式）。

任何一步失败都会 fail-soft 并把原因回显在按钮上 / 面板里，目录不会半途丢掉。

---

## 安全说明（给审计的人看）

| 会碰什么 | 边界 |
| --- | --- |
| **删目录**（唯一会删东西的地方） | `POST /api/new-workdir/prune` → `pruneEmpty()`，只 `rmdir` **空目录**，且必须同时满足四条：① 路径 `resolve()` 算术归位 + `realpath()` 后确实落在配置的根目录之下（挡 `..` 和指向外面的 junction）② 目录名是本插件的时间戳格式 ③ `readdir` 结果为空 ④ 不在 `keep` 名单里。任一条不满足只记一笔 `skipped`，绝不下手 |
| **子进程 / 动态执行** | 无。不 `spawn`、不 `eval`、不下载执行；静态扫描能力面 `hasExec: false` |
| **网络** | 只有 loopback：两个 HTTP 端点注册在 DSH 自己的 webServer 上，客户端 `fetch` 的目标恒为同源 `/api/new-workdir/*`，没有外部端点 |
| **凭据** | 不读 `.credentials.yaml`、不读任何密钥环境变量；只读 `DSH_HOME` / `DSH_WORKDIRS` 这类路径变量 |
| **一键停用** | `enabled: false` → mkdir / prune 直接 403（只留只读展示）；`bridgeNewSession: false` → 完全不碰官方「新会话」 |

自动化静态扫描（`@jieai/dsh-plugin-vet`，就是 [dsh.so](https://www.dsh.so/zh/) 提交页用的那套）：
**`verdict: clean`，无 high / critical**；唯一的 medium 是 `rmdir` 这一族 —— 它的边界就是上表第一行。
`rmdir` 在 `src/index.js` 只出现两处，都在 `pruneEmpty()` 内、前面各有一道 `resolveUnderAny()` 闸。

---

## 安装

```powershell
# 从 GitHub 装（推荐：按 tag 固定版本）
dsh plugin --profile web add github:miqian-nomad/dsh-new-workdir#v0.4.1

# 本机开发用这个：link 到源码目录，改完即时生效
dsh plugin --profile web add link:D:/dsh-plugins/dsh-new-workdir
```

web profile 由 CLI 托管，上面的命令会自动建 junction / 拉取仓库，并把包名写进
`dsh.profile.bundles`。安装后到设置页「新目录会话」里把 `root` 改成你自己的
工作目录（默认的 `D:/work-harness` 只是示例）。

**desktop profile 例外**：它由 Electron 应用独占管理，`dsh plugin` 会直接
拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
手动两步：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-new-workdir" `
  -Target "D:\dsh-plugins\dsh-new-workdir"
# 然后往 ~/.dsh/profiles/desktop/package.json 的 dependencies 加
#   "dsh-new-workdir": "link:D:/dsh-plugins/dsh-new-workdir"
# 并往 dsh.profile.bundles 里加一行 "dsh-new-workdir"
```

改完重启 `dsh web` / 桌面端。

---

## 配置

`D:\dsh-plugins\dsh-new-workdir\cordis.patch.yml`：

```yaml
- insert:
    - id: new-workdir
      name: dsh-new-workdir
      config:
        enabled: true          # false = mkdir 接口 403，只保留只读展示
        root: D:/work-harness  # 主根 = 默认根（不带 root 参数的建目录落这里）
        roots:                 # 可选：额外的根，按顺序排在面板里
          - D:/work-sandbox
          - E:/tmp/workdirs
        # recent: 8            # 每个根回显的最近目录条数
```

`root` 不写时的后备：`DSH_WORKDIRS` 环境变量 → 再没有就 `~/.dsh/workdirs`
（0.4.0 起不再写死 `D:/work-harness`）。

**多个根到底会怎样**（`root` + `roots`，见表里每一行）：

| 行为 | 单根 | 多根 |
| --- | --- | --- |
| 建目录 | 都落在 root | 默认根是 `root`（第一个）；面板每个根一行、各自一个「在这里新建」 |
| 顶部「新对话」/ ⌘N | 领新目录（root 下） | 同上，落在默认根 |
| 面板的「已建 N 个」 | 一个数 | 每个根一个数 |
| 清理空目录 | 只扫 root | **每个根都扫一遍**（白名单路径命中任何一个根都算合格） |
| 请求里传了清单外的 root | — | 直接拒（HTTP 400 `ROOT`），不会往任何地方写 |
| 复用（刚建的那个） | root 内校验 | 清单内任意一个根都行 |

注意：**“根”是这个插件的概念，DSH 本身不分区**。换根之后，旧根下的目录仍然是
DSH 的工作区（照旧显示在侧栏），但只有清单里的根会被清理扫到 —— 所以要把旧根
也收进去（写成 `roots` 的一项），而不是只改 `root`。

包名已在 profile 的 `bundles` 里，所以**不要**再往 profile 自己的
`cordis.patch.yml` 里插一条同样的 id（会变成重复 loader entry）。

---

## 接口（loopback）

```
GET  /api/new-workdir/state
     → { ok, enabled, root, roots:[{ path, isDefault, count, recent[] }],
         count, recent:[{ name, path, mtime }], version }
       （顶层 root/count/recent = 默认根，老客户端也认）

POST /api/new-workdir/mkdir      header: x-dsh-plugin: new-workdir
     body: { name?: "可选标签", root?: "清单里的某个根" }
     → { ok, path, name, title, root }     root 不在清单里 → 400 ROOT
POST /api/new-workdir/prune      header: x-dsh-plugin: new-workdir
     body: { paths?: ["白名单路径"], keep?: ["不许动的"], sweep?: true }
     → { ok, removed: [path], skipped: [{ path, reason }] }

POST /api/new-workdir/log        header: x-dsh-plugin: new-workdir
     body: { level?: "info|error", message: "…" }   → { ok }
```

三个 POST 的请求体上限 **64 KB**，超了回 413 `BODY_TOO_LARGE`（不再把任意大的 body
读进内存）。日志**每分钟最多 120 行**、单文件超过 **5 MB** 先轮转成 `.1`（只留一代），
被限流丢掉的条数会在下一次正常写入时记一笔。

`prune` 的删条件（host 强制，客户端说啥都越不过）：**① 算术归位 + realpath 之后
真的在 root 之下 ② 目录名是我们的时间戳格式 ③ 磁盘上一个条目都没有**。
① 故意不是字符串前缀比较：`D:/root/../outside/x` 的前缀恰好是 `D:/root/`，
但它落在 root 外面。所以先 `resolve()` 把 `..` 算掉，再用 `relative()` 判断
（结果以 `..` 开头 / 是绝对路径 / 是空串一律拒），目录真的存在时再 `realpath()`
一次，把「root 里那个名字其实是个 junction / 符号链接，指到外面」也挡掉。
越界的路径只进 `skipped`（`reason: outside-root`），绝不下手删。
`keep` 名单里的路径一律跳过；`sweep: true` 时额外扫一遍 root，把没工作区认领的
孤儿空目录也收掉。
`/log` 故意不受 `enabled` 约束 —— 关掉功能后仍然能看到客户端报的错。

`mkdir` 必带插件头（与 `dsh-search-switch` 等自家面板同款 CSRF 约定），
只对 loopback + 同源页面开放。

**客户端这边还有一道 fail-closed（0.4.1）**：清理前要先拿工作区 / 会话快照算出
「哪些空目录可以收、哪些一律别动」。快照拿不到（官方客户端服务形状变了，或者 `phase`
还不是 `ready`）时客户端**一个请求都不发** —— 既不点名的白名单、也不开扫尾，面板直接
说「这次没有清理、也没有扫尾」。以前它会照样发 `sweep: true` + `keep: []`，host 就把
每个根下所有空的时间戳目录全收掉，而工作区一个都退不掉（路径对不上号），侧栏留下一排死行。
**扫尾开关宁可不用，也不能扫错。**

日志：`~/.dsh/logs/new-workdir.log`（建 / 删各一行），错误另记 `new-workdir.err.log`
（host 侧失败 + 客户端 `reportFailure` 都走 `POST /log`）。

---

## 验证 / 回滚

```powershell
# 离线冒烟（不启动 DSH）：64 项 —— host handler（假 req/res + 真 TCP 各一遍）、
# 复用/清理规则、失败回滚、startSession 接管、路径穿越、链接指到外面、并发建房、
# 多根（root + roots）、版本一致、快照不可信时清理 fail-closed、body 超限 413、
# 日志轮转与限流、UI 入口接线（chip / 设置页卡片）。临时目录用 os.tmpdir()，不写死盘符
# 也可以直接 npm test（package.json 里就是这么写的）
# 真机（在临时 root 上跑，不动 D:/work-harness）：
#   官方「新建会话」→ 新目录；面板「清理空目录」→ 孤儿目录被扫尾收掉；
#   多根：点 b 那行的「在这里新建」→ 落在 b；再清理 → a 的空目录被收、b 的留着
node D:\dsh-plugins\dsh-new-workdir\test-smoke.mjs

# 装配检查
dsh --profile web --dump-config | Select-String 'new-workdir' -Context 0,4

# 实时接口
Invoke-WebRequest http://127.0.0.1:4180/api/new-workdir/state -UseBasicParsing | % Content
```

停用：`cordis.patch.yml` 里 `enabled: false`（或删 `bundles` 里的那一行）。
回滚 profile 改动：`~/.dsh/profiles/<profile>/package.json.bak-before-new-workdir-*`。

---

## 为什么不用 monkey-patch

老插件 `dsh-session-folder` 的做法是覆盖 `ctx.sessionController.create`，
好让「点工作区 / 点 + / 打开页面自动连」这三条**不带 cwd** 的调用路径也领新
目录。代价：

- `create` 的形状、调用点、`attachSession` 校验规则一变就崩，属于跟着版本
  跑的补丁；
- 它和本插件会抢同一次 `create`，把新目录会话再套一层目录；
- 复用空会话的分支不排除 `archivedSessionIds`，与客户端 `clearArchivedCurrent`
  来回打转。

本插件把「自动」换成「一键」：不去拦会话创建本身，入口都在自己注册的 slot 里
（外加一处显式的客户端包壳，见下）。`session-folder` 保留在 profile 里
（`enabled: false`），随时可改回 `true` 复活。

本插件只包了一个方法 —— `uiWorkspace.startSession`，而且：

- 只在**不带工作区 id** 时接管；带 id 的调用（工作区行 ⊕ / 选择器）直接
  `original.call(ui, id)` 转给官方，行为一字不改；
- 接管那条路自己抛错时，catch 里再调一次官方实现兜底，并把原因写进
  `new-workdir.err.log`；
- 官方改了方法名 / 形状，最坏就是这层包装失效、退回官方行为，插件不会因此崩；
- 幂等标记 `__newWorkdirBridge` 防重复包装，配置里一句话可整层关掉。

和 session-folder 的本质区别：它拦的是**会话创建**（`sessionController.create` 是所有
调用路径的必经之地），还和 host 端校验耦合；我们包的是**客户端服务的一个方法**
（`startSession`），创建本身仍走官方 Remote。代价是包壳会盖住所有无参调用点
（见上面那张表），而不只是「用户点新对话」这一条 —— 官方自己的「新建任务」和
「创建预设」也走同一个方法。

## 0.4.0：多个根 + 不再写死盘符

- **`roots`**：`root` 是主根（= 默认根），`roots` 是额外的根。建目录只能落在清单里；
  清理 / 扫尾每个根都扫一遍；`/mkdir` 传清单外的 root → HTTP 400 `ROOT`。
  `/state` 每根报一份 `{ path, isDefault, count, recent }`，顶层 `root/count/recent`
  仍是默认根（旧客户端不受影响）。
- 面板：根目录那张卡片变成「每个根一行 + 各自一个『在这里新建』」，各自显示已建数量。
- **不再写死 `D:/work-harness`**：`root` 不写 → `DSH_WORKDIRS` → `~/.dsh/workdirs`。
- 测试也不再写死 `D:/tmp`：临时目录改用 `os.tmpdir()`（换机器 / 跨平台能跑）。
- 多根的删除边界仍然只有一层：`resolveUnderAny()` —— 路径必须落在清单里某个根之下
  （resolve 算术归位 + realpath），否则只记 `skipped`；而清单只来自配置，不接受请求方自报。

真机验证（两个临时根 a / b）：起点 `a=0 b=0`；点官方「新建会话」→ `a=1`；
在面板 b 那一行点「在这里新建」→ `b=1`；点「清理空目录」→ `a=0 b=1`
（a 那个空的被收，b 那个正在用 → 留着）。

## 0.4.1：清理 fail-closed + loopback 加固 + UI 冒烟

- **清理改成 fail-closed（真 bug 修复）**：以前客户端读不到工作区 / 会话快照（官方客户端
  服务形状变了、或快照还没 ready）时，`pruneCandidates` 返回空名单，可请求照样带着
  `sweep: true` + `keep: []` 发出去 —— host 会把**每个根下所有「时间戳命名 + 磁盘真空」
  的目录**全收掉，而且因为 path → workspace 对不上号，一个工作区都退不掉：侧栏留下一排
  指向不存在目录的行，还不会自愈（欠账本没记上）。现在快照不可信就整体跳过，一个请求都不发
  （`snapshotOk=false` → `degraded: true`），面板明说「这次没有清理、也没有扫尾」。
  这个 bug 有专门的复现脚本验证过：修之前发出去的是 `{"paths":[],"keep":[],"sweep":true}`。
- **body 上限**：三个 POST 的请求体超过 64 KB 直接 413 `BODY_TOO_LARGE`，不再把任意大的
  body 读进内存。
- **日志兜底**：`/log` 与审计日志每分钟最多 120 行，单文件超过 5 MB 先轮转成 `.1`（只留一代），
  被限流丢掉的条数会在下一次正常写入时记一笔；`/log` 仍然不受 `enabled` 约束。
- **mkdir 报错说人话**：`EACCES` / `EPERM` / `ENOSPC` / `ENAMETOOLONG` / `EROFS` 等错误码
  前面加一句中文说明（原始 message 保留在括号里），不再把 `EPERM` 原样甩给用户。
- **接管范围写清楚了**：`startSession()` 是官方共享方法，无参调用点不止「新对话」一个
  （还有任务面板的「新建任务」和设置页的「让 Agent 帮我创建预设模式」）—— 见上面的表。
  这是行为事实，不是配置项；要绝对干净就 `bridgeNewSession: false`。
- **测试补到 64 项**：新增「快照不可信 → 不发 sweep」「phase 不是 ready → 不发请求」
  「body 超限 413」「日志轮转 + 限流」「chip 点击真的跑完 mkdir → 建工作区 → 开会话」
  「enabled:false 置灰显示已停用」「设置页卡片状态未就绪时不崩」
  「标签的 Windows 边界（保留设备名够不着、结尾空格/点不留）」。
- **状态按页面隔离**：`lastClaim`（刚领的目录）、单飞槽、退注册欠账本以前是模块级的，
  现在都挂在「页面锚点」（该客户端的 `sessions` 服务对象）上 —— 另一个客户端 ctx 不会串；
  而 chip（根 ctx）和 bridge（inject scope）拿到的是同一个 sessions 服务，所以「连点两下只领
  一个目录」的行为一个字没变。页面隔离有专门的用例盯着。
- **`reveal` 不再空等**：官方 `openSession` 根本不存在时（形状变了）直接兜底到
  `openWorkspace`，不再干等 20 × 150ms；只有真的抛错才重试。
- **补 `LICENSE`（MIT）与 `npm test`**。

## 0.3.2：复用规则收窄（一次真事故）

**事故**：点侧栏顶部「新建会话」，却被切到了 `2026-09-27 16:30:32` 那个旧工作区
里一个 9/27 就躺着的空会话，而且一个目录都没建 —— 看起来就是「新会话跑到旧工作
区下面新建了一个」。

**原因**：复用那一步扫的是「root 下所有时间戳目录里的空会话」。而用户自己历年留
下的工作区目录全都符合这个形状，于是第一个命中的旧空会话就成了候选。

**现在**：复用只认 `lastClaim` —— **本次页面会话里、由这个插件刚领出来的**那一个
（还得仍然空白、未归档）。刷新页面 = 内存清空 = 下一个点击必定新建目录。别人的旧
空会话、归档过的、已经聊过的，一律不碰。

真机验证（临时 root，刷新页面后再点）：第 1 次 → 新建 A（count 1）；刷新；再点 →
新建 B（count 2，不再被 A 掳回去）；紧接着再点 → 复用 B（count 仍 2）；面板建 C
后再点 → 只复用 C（count 仍 3）。

## 0.3.1：按代码审查改的五处

| 问题 | 原来 | 现在 |
| --- | --- | --- |
| **root 边界可被 `..` 绕过**（严重） | `underRoot` 只比字符串前缀，`D:/root/../outside/<时间戳>` 能骗过白名单，`prune` 会把 root 外的空目录 rmdir 掉 | `hasDotDot` 先拒 + `resolve()` 算术归位 + `relative()` 判断 + `realpath()` 挡链接；越界只记 `skipped` |
| 并发建房竞争 | 先 `pathExists()` 再 `mkdir()`，中间有窗口：两个请求同时抢同一时间戳，第二个直接 `EEXIST` 失败 | 直接 `mkdir()`，把 `EEXIST` 当「名字被占」；同一个 root 的建房动作串行排队；客户端再加一层单飞，连点两次只领一个目录 |
| 清理顺序会留下悬挂工作区 | 先删目录、再 `workspaces.delete()`，后者失败只 `console.warn` → 侧栏留一行指向不存在的目录 | `workspaces.delete` 重试 3 次（150/300/450ms）；三次都失败就记进欠账本，**下次点清理先补**，并写 err.log；回滚路径同样改成「退不掉就不删目录」 |
| `enabled: false` 没贯彻到 UI | 输入框回车 / chip 照样发请求，用户看到的是失败而不是按钮置灰 | chip 读一次 state，关掉时置灰显示「已停用」；面板的建 / 清理都先拦一道，回一句人话 |
| 版本号两处不一致 | `package.json` 写 0.1.0，运行时 `VERSION` 是 0.3.0 | 统一 0.3.1，并加了一条测试盯着这两处 |

修完的验证：`node test-smoke.mjs` **45 项全绿**（含 `..` 穿越、junction 指到
root 外、四个并发建房、退注册失败 → 下次补上的用例）；另在临时 root 上跑了一遍
真机（官方「新建会话」→ 新目录；面板清理 → 孤儿目录被扫尾收掉；再建一个目录
后重清 → 上一个目录连侧栏行一起消失）。你的 `D:\work-harness` 全程没被碰。

## 边界

DSH 的会话 cwd 是**创建期元数据**，创建后没有原地换目录的接口 —— 这也是为
什么「新目录会话」只能是新建会话，而「把这个对话搬进新目录」不在本插件范围内
（要自建 fork + `agents.create({ meta.cwd })` 流程）。

几个要知道的边界（0.4.1 补写）：

- **loopback 接口不等于鉴权**：`x-dsh-plugin` 头是 CSRF 约定，挡的是「别的网页顺手打这个
  端口」，不是「本机别的进程」。本机任何进程都能调 `/mkdir`、`/prune`、`/log`；
  能造成的后果也被限制在「配置清单内的根目录」里（`/prune` 还只删空目录）。
- **`/state` 不带头也能读**，它会把这台机器上的绝对路径回给你 —— 只在本机端口上暴露，
  别把这个端口转发到公网。
- **接管的副作用**：只要桥接开着，任何调 `uiWorkspace.startSession()`（不带工作区 id）的
  代码都会领一个新目录，包括官方自己的「新建任务」和「创建设置预设」两条路（见上表）。
- DSH 的会话 cwd 是**创建期元数据**，创建后没有原地换目录的接口 —— 这也是为什么
  「新目录会话」只能是新建会话，而「把这个对话搬进新目录」不在本插件范围内
  （要自建 fork + `agents.create({ meta.cwd })` 流程）。
