/**
 * dsh-new-workdir — Client half.
 *
 * 手写 __ModuleLoader__ 包壳（与 dsh-tool-registry / dsh-skill-source-switch 同构），
 * 零构建步骤。三个入口，共用同一条流程：
 *
 *   1. 输入框右侧的「新目录」小按钮   → slots: conversation.input.right（kind: list）
 *   2. 设置页的「新目录会话」卡片     → slots: settings.section
 *   3. 官方「新对话」/ ⌘N（不带工作区 id 的 session.new）
 *                                     → 客户端运行时给 uiWorkspace.startSession
 *                                       包一层，走同一条「领新目录」流程；只在内存里，
 *                                       官方文件零改动。带 workspaceId 的调用原样
 *                                       透传官方；bridgeNewSession: false 可关。
 *
 * 流程（插件自己这条路全部是公开接口，官方文件零改动）：
 *   GET  /api/new-workdir/state            先问一句 root 在哪
 *   ↳ 已经有空目录会话？直接切过去，不建新目录（连点不会堆空目录）
 *   POST /api/new-workdir/mkdir            host 用 node:fs 建目录
 *   ctx.workspaces.create({ path })        官方 Remote：注册工作区
 *   ctx.sessions.create({ workspaceId })   官方 Remote：开一个干净会话
 *   ctx.uiWorkspace.openSession(id)        切过去（方法没了就静默退化，会话已在侧栏）
 *   POST /api/new-workdir/prune            回收空目录（只删磁盘上真的空、且没聊过的）
 *
 * 设计取向：DSH 每两三天发一版，所以这里不碰任何既有服务对象，只在自己的按钮
 * 和这一处运行时包装上挂着；slot 名字变了顶多是入口不显示（slots.inject 永不
 * 触发），startSession 变了顶多是包装失效、退回官方行为，都不会报错。
 */
window.__ModuleLoader__.load({
  id: 'dsh-new-workdir',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const API = '/api/new-workdir'
    const HEADERS = { 'x-dsh-plugin': 'new-workdir' }

    /** 本插件目录的命名：时间戳打头，可带一段自定义标签。 */
    const OWN_DIR_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-.+)?$/

    // 官方设计令牌：浅色 / 深色主题自动跟随，不再自带 font-family
    const T = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      borderL3: 'var(--dsw-alias-border-l3)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      code: 'var(--ds-font-family-code)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', width: '100%' },
      title: { margin: '0 0 6px', fontSize: 16, fontWeight: 500, lineHeight: '24px', color: T.primary },
      intro: { margin: '0 0 16px', fontSize: 13, lineHeight: '20px', color: T.tertiary },
      row: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '0.5px solid ' + T.border, borderRadius: 12 },
      rowTitle: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: T.primary },
      rowDesc: { fontSize: 12, lineHeight: '18px', color: T.secondary },
      meta: { fontSize: 11, lineHeight: '16px', color: T.tertiary, marginTop: 2 },
      group: { margin: '18px 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px', color: T.primary },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      empty: { padding: '12px 14px', border: '0.5px dashed ' + T.borderL3, borderRadius: 12, fontSize: 12, lineHeight: '18px', color: T.tertiary },
      footer: { marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      tip: { fontSize: 12, lineHeight: '18px', color: T.tertiary },
      note: { margin: '6px 0 0', fontSize: 11, lineHeight: '16px', color: T.tertiary },
      rootRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
      rootPath: { flex: '1 1 240px', minWidth: 0, fontFamily: T.code, fontSize: 11, lineHeight: '16px', color: T.secondary, overflowWrap: 'anywhere' },
      input: {
        height: 28, flex: '1 1 200px', minWidth: 120, padding: '0 10px',
        border: '0.5px solid ' + T.borderL3, borderRadius: 14, background: 'transparent',
        font: 'inherit', fontSize: 12, lineHeight: '18px', color: T.primary,
      },
      msg: { marginTop: 10, fontSize: 12, lineHeight: '18px', minHeight: 18, color: T.error },
      ok: { marginTop: 10, fontSize: 12, lineHeight: '18px', minHeight: 18, color: T.success, overflowWrap: 'anywhere' },
    }

    function msgOf(error) {
      return error && error.message ? error.message : String(error)
    }

    /** 失败也留个痕：写进 host 的 ~/.dsh/logs/new-workdir.log（记不上就算了）。 */
    function reportFailure(message, error) {
      try {
        const text = message + (error === undefined ? '' : ' :: ' + msgOf(error))
        console.warn('[new-workdir] ' + text)
        request('/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'error', message: text }),
        }).catch(function () { /* 记不上就算了 */ })
      } catch (ignored) { void ignored }
    }

    function fmtTime(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    async function request(path, init) {
      const res = await fetch(API + path, Object.assign({}, init, {
        headers: Object.assign({}, HEADERS, (init && init.headers) || {}),
      }))
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      if (json === undefined) throw new Error(path + ' 返回了非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200))
      if (!json.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status))
      return json
    }

    function readState() {
      return request('/state', { headers: { 'Cache-Control': 'no-store' } })
    }

    /** 领目录。root 省略 = host 那边的默认根（清单里的第一个）。 */
    function claimDir(name, root) {
      return request('/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || '', root: root || '' }),
      })
    }

    /** /state 里的根清单（老 host 只有单个 root 时凑一个出来）。 */
    function rootsOf(state) {
      if (state && Array.isArray(state.roots) && state.roots.length > 0) {
        return state.roots.map((item) => String(item && item.path ? item.path : item)).filter((item) => item !== '')
      }
      return state && state.root ? [String(state.root)] : []
    }

    function norm(p) {
      return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** 输入里有没有 `..` 段 —— 和 host 半区同一条规矩：带 `..` 的一律不当自己人。 */
    function hasDotDot(p) {
      return String(p == null ? '' : p).replace(/\\/g, '/').split('/').some((seg) => seg === '..')
    }

    /**
     * 路径在不在 root 之下。客户端这层只用来「挑候选」，真正的删除边界在 host
     * （那边 resolve + realpath 都做了）；两边同一套判断，免得我们点错了人。
     */
    function underRoot(path, root) {
      if (hasDotDot(path)) return false
      const a = norm(path)
      const b = norm(root)
      return b !== '' && (a === b || a.indexOf(b + '/') === 0)
    }

    /** 在不在「任意一个允许的根」之下（多 root 时用）。 */
    function underRootAny(path, roots) {
      const list = Array.isArray(roots) ? roots : [roots]
      return list.some((root) => underRoot(path, root))
    }

    function baseName(p) {
      const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
      const at = s.lastIndexOf('/')
      return at === -1 ? s : s.slice(at + 1)
    }

    /**
     * 复用提示写在模块作用域：会话切换会重建 composer 子树、组件状态会被丢掉，
     * 放组件里会看不到提示。订阅者收到通知后各自 forceUpdate 一次。
     */
    const flash = { text: '', until: 0, listeners: new Set(), timer: undefined }

    function setFlash(text, ms) {
      flash.text = text
      flash.until = Date.now() + ms
      for (const fn of flash.listeners) fn()
      if (flash.timer !== undefined) clearTimeout(flash.timer)
      flash.timer = setTimeout(() => {
        flash.text = ''
        flash.until = 0
        for (const fn of flash.listeners) fn()
      }, ms)
    }

    function useFlash() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        flash.listeners.add(listener)
        return () => { flash.listeners.delete(listener) }
      }, [])
      return flash.until > Date.now() ? flash.text : ''
    }

    /**
     * 建目录 → 注册工作区 → 开新会话 → 切过去。永远新建（设置页填了名字时用它）。
     * @param ctx - client root context.
     * @param name - optional directory label.
     * @returns { path, workspaceId, sessionId }
     */
    async function createWorkdir(ctx, name, rootPath) {
      const made = await claimDir(name, rootPath)
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      if (!workspaces || typeof workspaces.create !== 'function') {
        throw new Error('客户端没有 workspaces 服务（目录已建好：' + made.path + '）')
      }
      if (!sessions || typeof sessions.create !== 'function') {
        throw new Error('客户端没有 sessions 服务（目录已建好：' + made.path + '）')
      }
      const workspace = await workspaces.create({ path: made.path })
      let sessionId
      try {
        sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
      } catch (first) {
        // 偶发失败（比如和别的建会话动作撞车）再试一次；还不行就把刚建的空壳回滚掉，
        // 免得侧栏留下一堆「有工作区、没会话」的死目录。
        await new Promise(function (resolve) { setTimeout(resolve, 350) })
        try {
          sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
        } catch (second) {
          reportFailure('会话创建失败（回滚空目录 ' + made.path + '）', second)
          // 顺序要紧：先把工作区退掉，再删目录。退不掉就留着目录 —— 宁可在磁盘上
          // 留一个空目录（下次清理的扫尾会收），也不要在侧栏留一行指向不存在目录。
          const gone = await unregisterWorkspace(workspaces, workspace.workspaceId)
          if (gone) {
            try {
              await request('/prune', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: [made.path] }),
              })
            } catch (error) { console.warn('[new-workdir] 回滚空目录失败:', error) }
          } else {
            reportFailure('回滚时工作区没退掉，空目录先留着（下次点「清理空目录」会收）：' + made.path)
          }
          throw second
        }
      }
      try {
        if (typeof workspaces.rename === 'function') await workspaces.rename(workspace.workspaceId, made.title)
      } catch (error) {
        console.warn('[new-workdir] 工作区改名失败（不影响使用）:', error)
      }
      rememberClaim(ctx, { path: made.path, workspaceId: workspace.workspaceId, sessionId: sessionId })
      reveal(ctx, workspace.workspaceId, sessionId)
      return { path: made.path, workspaceId: workspace.workspaceId, sessionId: sessionId, root: made.root }
    }

    /** 当前主视图里的会话 id（拿不到就 undefined）。 */
    function currentSessionId(ctx) {
      const sessions = ctx.get('sessions')
      if (!sessions || !sessions.list) return undefined
      const ss = sessions.list.getSnapshot()
      if (!ss || !ss.ids) return undefined
      for (const id of ss.ids) {
        const row = ss.byId && ss.byId[id]
        if (row && row.retainedBy && row.retainedBy.mainView) return id
      }
      return undefined
    }

    /**
     * 本次页面会话里，我们自己最近一次领出来的那个工作区/会话。复用只认它。
     *
     * 以前这里扫的是「root 下所有时间戳目录里的空会话」—— 结果把用户自己几天前
     * 留下的空会话也算成了候选：点「新对话」会被拽到旧工作区里，而且一个目录都没
     * 建。所以现在复用只限于「刚刚自己建、而且还没聊过」的那一个。
     */
    /**
     * 每个「页面客户端实例」一份状态：最近领的目录、单飞槽、退注册欠账。
     *
     * 锚点用 sessions 服务对象：同一个页面里，chip 拿的是根 ctx、bridge 拿的是 inject
     * scope，两边 `get('sessions')` 返回同一个对象 —— 于是它们的单飞和 lastClaim 仍然
     * 共享（连点两下只领一个目录），而另一套服务（另一个页面 / 测试里的另一套桩）互不干扰。
     * 服务拿不到（降级）时就退回 ctx 自己当锚点；再没有 ctx 才用全局那一份兜底。
     */
    const pageStates = new WeakMap()
    let fallbackPageState = null

    function newPageState() {
      return { lastClaim: null, inFlightClaim: null, pendingUnregisters: new Map() }
    }

    function stateOf(ctx) {
      let anchor
      try {
        anchor = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      } catch (error) {
        anchor = undefined
      }
      if (anchor === null || anchor === undefined || (typeof anchor !== 'object' && typeof anchor !== 'function')) {
        anchor = ctx
      }
      if (anchor === null || anchor === undefined) {
        if (fallbackPageState === null) fallbackPageState = newPageState()
        return fallbackPageState
      }
      let state = pageStates.get(anchor)
      if (state === undefined) {
        state = newPageState()
        pageStates.set(anchor, state)
      }
      return state
    }

    /** createWorkdir 成功后调：记住这个刚领出来的目录/工作区/会话。 */
    function rememberClaim(ctx, result) {
      stateOf(ctx).lastClaim = {
        path: result.path,
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
      }
    }

    /**
     * 能不能复用（少了这一步就连点会堆一堆空目录）：只认 lastClaim，而且它还得
     *   ① 仍然在 root 之下、目录名是我们的时间戳格式
     *   ② 会话还在、还是 blank（一次都没聊过）、没被归档
     * 其它任何空会话（哪怕它在 root 下、名字也对）一律不碰 —— 那是用户自己的。
     * 客户端服务形状变了就返回 undefined（退化成新建，不会报错）。
     */
    function findReusableBlank(ctx, roots) {
      const lastClaim = stateOf(ctx).lastClaim
      if (lastClaim === null) return undefined
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      if (!workspaces || !workspaces.list || !sessions || !sessions.list) return undefined
      const ws = workspaces.list.getSnapshot()
      const ss = sessions.list.getSnapshot()
      if (!ws || !ss || !ws.items) return undefined
      const item = ws.items.find((w) => w && w.workspaceId === lastClaim.workspaceId)
      if (item === undefined) return undefined
      if (!underRootAny(item.path, roots) || !OWN_DIR_RE.test(baseName(item.path))) return undefined
      if (norm(item.path) !== norm(lastClaim.path)) return undefined
      if ((ws.archivedSessionIds || []).indexOf(lastClaim.sessionId) !== -1) return undefined
      const row = ss.byId && ss.byId[lastClaim.sessionId]
      if (row === undefined || row.blank !== true) return undefined
      if (row.cwd !== undefined && norm(row.cwd) !== norm(item.path)) return undefined
      return { sessionId: lastClaim.sessionId, workspaceId: item.workspaceId, path: item.path }
    }

    /**
     * 同一次「领目录」只跑一个：连点、或者官方「新会话」桥接和按钮撞在一起时，
     * 第二个调用直接等第一个的结果（不是并排再去建一个目录）。key 只跟
     * (强制, 名字) 有关：填了不同名字的两次创建本来就该各建一个。
     */
    function openOrCreateWorkdir(ctx, name, force, rootPath) {
      const state = stateOf(ctx)
      const key = (force ? '1' : '0') + '|' + String(name == null ? '' : name) + '|' + String(rootPath == null ? '' : rootPath)
      if (state.inFlightClaim !== null && state.inFlightClaim.key === key) return state.inFlightClaim.promise
      const promise = openOrCreateWorkdirOnce(ctx, name, force, rootPath)
      const slot = { key: key, promise: promise }
      state.inFlightClaim = slot
      const clear = () => { if (state.inFlightClaim === slot) state.inFlightClaim = null }
      promise.then(clear, clear)
      return promise
    }

    /**
     * 真正干活的那一步：先看能不能复用（= 本次页面会话里刚领的那个目录还空着、
     * 还没归档），能就切回去；否则建新目录。
     * force=true（面板里填了名字）时跳过复用，强制新建。
     * @returns { reused, path, workspaceId, sessionId }
     */
    async function openOrCreateWorkdirOnce(ctx, name, force, rootPath) {
      const state = await readState()
      const roots = rootsOf(state)
      if (!force && !name) {
        const reusable = findReusableBlank(ctx, roots)
        if (reusable !== undefined) {
          reveal(ctx, reusable.workspaceId, reusable.sessionId)
          return {
            reused: true,
            path: reusable.path,
            workspaceId: reusable.workspaceId,
            sessionId: reusable.sessionId,
          }
        }
      }
      const made = await createWorkdir(ctx, name, rootPath)
      return { reused: false, path: made.path, workspaceId: made.workspaceId, sessionId: made.sessionId, root: made.root }
    }

    /**
     * 把官方「新建会话」接到本插件这条流程上 —— 官方那个 + / 新对话 / ⌘N 也变成
     * 「领一个新目录 + 新工作区 + 新会话」。
     *
     *   startSession()             不带工作区 id → 走我们这条流程（新目录）
     *   startSession(workspaceId)  带了工作区 id → 原样交给官方
     *                             （工作区行上的 ⊕ = 在那个目录里开会话，官方语义）
     *
     * 官方文件一个字没改：只在这一个客户端服务方法外面包一层，带幂等标记。任何
     * 异常都原样调回官方实现；DSH 升级后万一形状变了，最坏也只是这层包装失效、
     * 退回官方行为，不会报错。不想要这层接管就把它关掉（见 apply 里的 bridge）。
     */
    function installNewSessionBridge(scope) {
      const ui = scope.get('uiWorkspace')
      if (!ui || typeof ui.startSession !== 'function') return false
      if (ui.startSession.__newWorkdirBridge === true) return true
      const original = ui.startSession
      const bridged = function (workspaceId) {
        if (workspaceId !== undefined && workspaceId !== null && workspaceId !== '') {
          return original.call(ui, workspaceId)
        }
        openOrCreateWorkdir(scope, '', false).then(function (out) {
          console.info('[new-workdir]', out.reused ? '已切到现有空目录会话:' : '新建目录会话:', out)
          if (out.reused) setFlash('已回到刚建的空目录', 2600)
        }).catch(function (error) {
          reportFailure('接管官方「新会话」失败，已回退官方行为', error)
          try {
            original.call(ui, workspaceId)
          } catch (fallback) {
            console.warn('[new-workdir] 回退官方 startSession 也失败了:', fallback)
          }
        })
        return undefined
      }
      bridged.__newWorkdirBridge = true
      bridged.__newWorkdirOriginal = original
      try {
        ui.startSession = bridged
      } catch (error) {
        console.warn('[new-workdir] 「新会话」接管装不上（跳过，官方文件未动）:', error)
        return false
      }
      console.info('[new-workdir] 已接管官方「新建会话」：点它 = 领一个新目录（工作区行上的 ⊕ 仍是官方行为）')
      return true
    }

    /**
     * 这份快照能不能信：服务在、phase 是 ready（老客户端没这字段）、items / byId 都在。
     * 信不过就一律「不许扫尾」—— 扫尾名单本来要拿快照对账（谁在用、谁有内容），
     * 快照缺席时这份账是空的，扫尾会把 root 下所有空的时间戳目录当成孤儿收掉，
     * 还一个工作区都退不掉。宁可这一次什么都不做。
     */
    function snapshotUsable(ws, ss) {
      if (!ws || !ss) return false
      if (!Array.isArray(ws.items)) return false
      if (!ss.byId || typeof ss.byId !== 'object') return false
      if (ws.phase !== undefined && ws.phase !== 'ready') return false
      if (ss.phase !== undefined && ss.phase !== 'ready') return false
      return true
    }

    /**
     * 挑出「可以清理的空目录」：root 下的时间戳目录 + 会话全是空白（没聊过）+
     * 不是当前正在用的那个。其余路径进 keep，host 端一律不碰。
     * snapshotOk=false 表示这份名单不可信，调用方不许据此扫尾。
     * @returns { candidates: [{ workspaceId, path }], keep: [path], snapshotOk: boolean }
     */
    function pruneCandidates(ctx, rootOrRoots) {
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      const candidates = []
      const keep = []
      const nothing = { candidates: candidates, keep: keep, snapshotOk: false }
      if (!workspaces || !workspaces.list || !sessions || !sessions.list) return nothing
      const ws = workspaces.list.getSnapshot()
      const ss = sessions.list.getSnapshot()
      if (!snapshotUsable(ws, ss)) return nothing
      const archived = new Set(ws.archivedSessionIds || [])
      const currentId = currentSessionId(ctx)
      for (const item of ws.items) {
        if (!item || !underRootAny(item.path, rootOrRoots) || !OWN_DIR_RE.test(baseName(item.path))) continue
        const ids = item.sessionIds || []
        if (currentId !== undefined && ids.indexOf(currentId) !== -1) { keep.push(item.path); continue }
        // 有内容就留着：这号会话在列表里、而且开过 turn（blank !== true）；归档的一律留。
        // 「还没落盘所以列表里查不到」的空会话、以及 sessionIds 本来就是空的壳，都可以收。
        const hasContent = ids.some(function (id) {
          const row = ss.byId && ss.byId[id]
          return row !== undefined && row.blank !== true
        }) || ids.some(function (id) { return archived.has(id) })
        if (hasContent) keep.push(item.path)
        else candidates.push({ workspaceId: item.workspaceId, path: item.path })
      }
      return { candidates: candidates, keep: keep, snapshotOk: true }
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    /**
     * 把工作区从侧栏退掉。重试 3 次（间隔 150/300/450ms）：官方这个 Remote 偶发
     * 报错时，别让侧栏和工作目录对不上。
     * @returns true = 退掉了；false = 三次都没成（调用方要负责补偿）
     */
    async function unregisterWorkspace(workspaces, workspaceId) {
      if (!workspaces || typeof workspaces.delete !== 'function') return false
      let last
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await workspaces.delete(workspaceId)
          return true
        } catch (error) {
          last = error
          await sleep(150 * (attempt + 1))
        }
      }
      console.warn('[new-workdir] workspaces.delete 连续失败:', workspaceId, last)
      return false
    }

    // 欠账本（pendingUnregisters）：目录已经删了、但工作区那一次没退掉（workspaces.delete
    // 三次都挂）。那一刻侧栏会留一行指向不存在的目录；下次点「清理空目录」会先把它补掉。
    // 它跟着页面状态走 —— 见上面的 stateOf()。

    /**
     * 清理空目录：host 只删磁盘上真的空的目录，客户端再把对应工作区退注册。
     * 顺序是「先删目录、后退工作区」，退了三次没成的那几个记进欠账本（下次先补），
     * 并在面板上报出来 —— 不静默。
     *
     * fail-closed：读不到工作区 / 会话快照（官方客户端服务形状变了，或者快照还没 ready）
     * 时连扫尾开关都不发，整体跳过。以前这条路会带着 sweep:true + keep:[] 打过去，
     * host 就会把每个根下所有「时间戳命名 + 磁盘真空」的目录全收掉，而且因为
     * path → workspace 对不上，一个工作区都退不掉 —— 侧栏留下一排指向不存在目录的行，
     * 还不会自愈。宁可这次什么都不做，也不能扫错。
     * @returns { removed, skipped, unregisterFailed, pending, degraded }
     */
    async function pruneEmptyWorkdirs(ctx, rootOrRoots) {
      const picked = pruneCandidates(ctx, rootOrRoots)
      const pendingUnregisters = stateOf(ctx).pendingUnregisters
      const workspaces = ctx.get('workspaces')
      const snap = workspaces && workspaces.list ? workspaces.list.getSnapshot() : undefined
      const byPath = new Map()
      for (const item of (snap && snap.items) || []) {
        if (item && item.path) byPath.set(norm(item.path), item)
      }

      // 先补上次的欠账：那些目录早就没了，只是侧栏那一行还挂着。
      // 快照拿不到（官方服务形状变了）就先不动欠账本，免得把别人的 id 当成自己的。
      if (snap && Array.isArray(snap.items)) {
        const alive = new Set(snap.items.map((item) => item && item.workspaceId))
        for (const [id, path] of Array.from(pendingUnregisters)) {
          if (!alive.has(id)) { pendingUnregisters.delete(id); continue }
          if (await unregisterWorkspace(workspaces, id)) pendingUnregisters.delete(id)
          else console.warn('[new-workdir] 欠账还没补上（下次再试）:', id, path)
        }
      }

      const degraded = !picked.snapshotOk
      if (degraded) {
        // 快照不可信 —— 不发扫尾，也不发白名单（这份名单同样来自那份快照）。
        console.warn('[new-workdir] 读不到工作区 / 会话快照，本次清理整体跳过（不发扫尾，避免扫掉正在用的空目录）')
        return {
          removed: 0,
          skipped: 0,
          unregisterFailed: 0,
          pending: pendingUnregisters.size,
          degraded: true,
        }
      }

      const result = await request('/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // paths = 白名单（会话空着的那些）；keep = 一律不动的（有内容 / 正在用）；
        // sweep = 顺手把所有根下其它「我们命名的 + 磁盘上真空」的目录也收掉
        // （历次建会话失败留下的孤儿目录就靠它）。只有快照可信时才带 sweep。
        body: JSON.stringify({
          paths: picked.candidates.map((c) => c.path),
          keep: picked.keep,
          sweep: true,
        }),
      })
      let removed = 0
      let unregisterFailed = 0
      for (const path of result.removed || []) {
        removed += 1
        const hit = byPath.get(norm(path))
        if (hit === undefined) continue
        if (await unregisterWorkspace(workspaces, hit.workspaceId)) continue
        // 目录没了、工作区还在 → 侧栏留一行空壳。记账，下次清理先补。
        unregisterFailed += 1
        pendingUnregisters.set(hit.workspaceId, path)
        reportFailure('目录已删但工作区没退掉（' + path + '），已记账，下次清理先补')
      }
      return {
        removed: removed,
        skipped: (result.skipped || []).length,
        unregisterFailed: unregisterFailed,
        pending: pendingUnregisters.size,
        degraded: false,
      }
    }

    /**
     * 切到新会话。uiWorkspace 是官方 ui 插件提供的服务；方法名变了 / 会话还没同步
     * 到客户端时静默退化，用户自己点侧栏即可（工作区和会话都已经真实存在）。
     */
    function reveal(ctx, workspaceId, sessionId) {
      const ui = ctx.get('uiWorkspace')
      if (!ui) return
      /** 兜底：会话在客户端打不开时，至少把工作区打开（会话已经真实存在，用户点侧栏也行）。 */
      const fallback = (reason) => {
        console.warn('[new-workdir] ' + reason + '，请在侧栏点开新会话：', sessionId)
        if (typeof ui.openWorkspace !== 'function') return
        try {
          Promise.resolve(ui.openWorkspace(workspaceId)).catch((error) => console.warn('[new-workdir] openWorkspace 失败:', error))
        } catch (error) {
          console.warn('[new-workdir] openWorkspace 失败:', error)
        }
      }
      // 官方形状变了（连方法都没有）就别干等 3 秒 —— 直接兜底。
      if (typeof ui.openSession !== 'function') { fallback('uiWorkspace.openSession 不存在'); return }
      let attempt = 0
      const tryOpen = () => {
        attempt += 1
        try {
          ui.openSession(sessionId)
          return
        } catch (error) {
          // 新会话可能还没同步到客户端列表：隔 150ms 再试，最多 20 次（约 3 秒）
          if (attempt >= 20) fallback('openSession 连续失败（' + msgOf(error) + '）')
          else setTimeout(tryOpen, 150)
        }
      }
      tryOpen()
    }

    /**
     * 文件夹 + 加号图标（lucide folder-plus 的路径数据）。
     * 不用 emoji：🗂 在中文 Windows 的字体回退里会渲染成一坨黑块，也不跟主题色。
     */
    function FolderPlusIcon(size) {
      return h('svg', {
        key: 'icon',
        width: size || 15, height: size || 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { flex: 'none', display: 'block' },
      }, [
        h('path', { key: 'f', d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }),
        h('path', { key: 'v', d: 'M12 10v6' }),
        h('path', { key: 'h', d: 'M9 13h6' }),
      ])
    }

    function Btn(props) {
      const style = {
        height: 28, padding: '0 10px', border: '0.5px solid ' + T.borderL3, borderRadius: 14,
        background: 'transparent', font: 'inherit', fontSize: 12, lineHeight: '18px',
        display: 'inline-flex', alignItems: 'center', gap: 5,
        color: props.danger ? T.error : T.primary,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.4 : 1,
      }
      const rest = Object.assign({}, props)
      delete rest.danger
      return h('button', Object.assign({ type: 'button', style: style }, rest))
    }

    function apply(ctx, config) {
      /**
       * 接管官方「新建会话 / 新对话 / ⌘N」（startSession 不带工作区 id 的那条路）。
       * config.bridgeNewSession === false 或 window.__dshNewWorkdirBridge === false 可关掉。
       */
      const bridge = !(config && config.bridgeNewSession === false) &&
        !(typeof window !== 'undefined' && window.__dshNewWorkdirBridge === false)
      /**
       * 输入框右侧的小按钮。连点不会堆空目录：已经有空目录会话就直接切过去，
       * 只有当前会话已经聊过东西（或没有空目录会话）时才建新目录。
       */
      function NewWorkdirChip() {
        const [busy, setBusy] = useState(false)
        const [fail, setFail] = useState('')
        const [off, setOff] = useState(false)
        const [rootPath, setRootPath] = useState('')
        const note = useFlash()

        // 读一次 enabled / 默认根：关掉了就别让按钮看着能用（点下去只会撞 403）；
        // 根目录写进 tooltip，多根的时候能一眼看出这个按钮会建到哪。
        useEffect(() => {
          let alive = true
          readState()
            .then((next) => {
              if (!alive) return
              setOff(next.enabled === false)
              setRootPath(String(next.root || ''))
            })
            .catch(() => {})
          return () => { alive = false }
        }, [])

        const onClick = async () => {
          if (busy) return
          setBusy(true)
          setFail('')
          try {
            const out = await openOrCreateWorkdir(ctx, '', false)
            console.info('[new-workdir]', out.reused ? '已切到现有空目录会话:' : '新建目录会话:', out)
            if (out.reused) setFlash('已回到刚建的空目录', 2600)
          } catch (error) {
            reportFailure('点按钮新建失败', error)
            setFail(msgOf(error))
          } finally {
            setBusy(false)
          }
        }

        const disabled = busy || off
        const label = off ? '已停用' : (busy ? '新建中…' : (note ? note : (fail ? '失败' : '新目录')))
        const at = rootPath === '' ? '' : '\n根目录：' + rootPath
        const hint = off
          ? '已在 cordis.patch.yml 里关掉（enabled: false）'
          : (fail
            ? '新建独立工作目录失败：' + fail + at
            : (note
              ? '刚建的那个空目录还在，切回去 —— 不会重复建目录' + at
              : '开一个独立工作目录的新会话；连点两下只多一个目录' + at))

        return h('button', {
          type: 'button',
          disabled: disabled,
          onClick: onClick,
          title: hint,
          style: {
            height: 28, width: 96, flex: 'none', padding: '0 8px', whiteSpace: 'nowrap',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            border: '0.5px solid ' + T.borderL3, borderRadius: 14, background: 'transparent',
            font: 'inherit', fontSize: 12, lineHeight: '18px',
            color: fail ? T.error : T.primary,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          },
        }, [
          fail || off ? null : FolderPlusIcon(15),
          h('span', { key: 'label' }, label),
        ])
      }

      /** 设置页卡片：同样的动作，外加根目录、最近目录、可选标签、清理空目录。 */
      function NewWorkdirPanel() {
        const [state, setState] = useState(null)
        const [empties, setEmpties] = useState([])
        const [name, setName] = useState('')
        const [busy, setBusy] = useState(false)
        const [msg, setMsg] = useState('')
        const [done, setDone] = useState('')
        const note = useFlash()

        const refresh = async (silent) => {
          try {
            const next = await readState()
            setState(next)
            setEmpties(pruneCandidates(ctx, rootsOf(next)).candidates)
            if (!silent) setMsg('')
          } catch (error) {
            if (!silent) setMsg('读取失败：' + msgOf(error))
          }
        }

        useEffect(() => {
          refresh(true)
          const timer = setInterval(() => refresh(true), 15000)
          return () => clearInterval(timer)
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        // enabled:false 时按钮已经置灰，但回车 / 程序化调用还是会走到这两个函数 ——
        // 所以在这里把同一道闸再拦一次，给一句人话而不是一个 403。
        const isOff = state !== null && state.enabled === false
        const offNote = '插件已在 cordis.patch.yml 里关掉（enabled: false），打开后再操作。'

        /** rootPath 省略 = 默认根（清单里的第一个）。 */
        const create = async (rootPath) => {
          if (busy) return
          if (isOff) { setMsg(offNote); return }
          setBusy(true)
          setMsg('')
          setDone('')
          try {
            const forced = name.trim() !== ''
            const out = await openOrCreateWorkdir(ctx, name, forced, rootPath)
            if (out.reused) setFlash('已回到刚建的空目录', 2600)
            setDone(out.reused
              ? '已切到现有的空目录会话：' + out.path + '（没有新建目录）'
              : '已建：' + out.path + '（工作区 ' + out.workspaceId + '，会话 ' + out.sessionId + '）')
            setName('')
            await refresh(true)
          } catch (error) {
            reportFailure('设置页新建失败', error)
            setMsg('新建失败：' + msgOf(error))
          } finally {
            setBusy(false)
          }
        }

        const prune = async () => {
          if (busy || state === null) return
          if (isOff) { setMsg(offNote); return }
          setBusy(true)
          setMsg('')
          setDone('')
          try {
            const out = await pruneEmptyWorkdirs(ctx, rootsOf(state))
            if (out.degraded) {
              // 整体跳过时说清楚，别让人以为「已经清理干净了」
              setMsg('读不到工作区 / 会话列表（客户端服务可能变了），这次没有清理、也没有扫尾 —— 不会误删正在用的空目录。')
              return
            }
            const head = out.removed > 0
              ? ('已清理 ' + out.removed + ' 个空目录（目录里一个文件都没有、会话也没聊过的那种）')
              : '没有可清理的空目录'
            // 工作区没退掉的那几笔要报出来：不然用户只看到侧栏多了一行空壳，不知道怎么回事。
            const tail = out.unregisterFailed > 0
              ? '；有 ' + out.unregisterFailed + ' 个工作区没退掉（目录已删，已记账，下次点清理会先补）'
              : (out.pending > 0 ? '；还有 ' + out.pending + ' 笔退注册欠账没补上' : '')
            setDone(head + tail)
            await refresh(true)
          } catch (error) {
            reportFailure('清理空目录失败', error)
            setMsg('清理失败：' + msgOf(error))
          } finally {
            setBusy(false)
          }
        }

        const recent = (state && state.recent) || []
        // /state 里每个根一份；老 host 没这字段时就从 root 凑一个。
        const roots = state === null
          ? []
          : (Array.isArray(state.roots) && state.roots.length > 0
            ? state.roots.map((item) => ({
              path: String(item && item.path ? item.path : item),
              count: Number(item && item.count) || 0,
              isDefault: item && item.isDefault === true,
            }))
            : [{ path: String(state.root || ''), count: Number(state.count) || 0, isDefault: true }])

        return h('div', { style: S.page }, [
          h('h2', { key: 'title', style: S.title }, '新目录会话 ・ 每个会话一个目录'),
          h('p', { key: 'intro', style: S.intro },
            '一键在根目录下领一个没人用过的时间戳目录，把它注册成工作区，并在里面开一个干净会话 —— ' +
            '目录即沙盒边界，不同任务的产物不再混在一起。全程只调用官方接口，官方文件零改动。'),

          h('div', { key: 'root', style: S.row }, [
            h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 'label', style: S.rowTitle },
                '根目录' + (roots.length > 1 ? '（' + roots.length + ' 个，★ 是默认根）' : '')),
              roots.length === 0
                ? h('div', { key: 'loading', style: S.meta }, '读取中…')
                : roots.map((item) => h('div', { key: 'r-' + item.path, style: S.rootRow }, [
                    h('div', { key: 'p', style: S.rootPath },
                      (item.isDefault ? '★ ' : '　 ') + item.path + '　已建 ' + item.count + ' 个'),
                    h(Btn, {
                      key: 'new',
                      onClick: () => create(item.path),
                      disabled: busy || isOff,
                      title: '在这个根下面领一个新目录（输入框里填了名字就用那个名字）',
                    }, '在这里新建'),
                  ])),
              h('div', { key: 'count', style: S.meta },
                state && !state.enabled ? '当前 enabled: false，建目录接口已关闭' : ''),
            ]),
            h(Btn, { key: 'refresh', onClick: () => refresh(false), disabled: busy }, '刷新'),
          ]),

          h('div', { key: 'action', style: Object.assign({}, S.row, { marginTop: 8, flexWrap: 'wrap' }) }, [
            h('input', {
              key: 'name',
              value: name,
              placeholder: '可选：给目录起个名，如 fix-login',
              onChange: (event) => setName(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') create() },
              style: S.input,
            }),
            h(Btn, {
              key: 'go',
              onClick: () => create(),
              disabled: busy || (state !== null && state.enabled === false),
              title: state && state.enabled === false
                ? '已在 cordis.patch.yml 里关闭（enabled: false）'
                : '在默认根（★）下领新目录；想在别的根下建，就用那一行的「在这里新建」',
            }, busy ? [FolderPlusIcon(14), h('span', { key: 'l' }, '新建中…')]
              : [FolderPlusIcon(14), h('span', { key: 'l' }, '新建目录 + 开新会话')]),
          ]),

          h('p', { key: 'rule', style: S.note },
            '规则：复用只认「本次页面会话里刚建、而且还没聊过」的那一个 —— 连点两下只多一个目录；' +
            '在里面发了消息（或刷新过页面）之后，下一个点击就是崭新的目录。不想用复用就在输入框里填个名字（= 强制新建）。'),

          h('p', { key: 'roots-note', style: S.note },
            '多个根目录：cordis.patch.yml 里 root（主根，= 默认根）+ roots（额外的根）。' +
            '建目录只会落在清单里的根下；清理 / 扫尾会每个根都扫一遍；body 里传的 root 不在清单里会被拒（400）。'),

          h('p', { key: 'bridge', style: S.note },
            '已接管官方左上角「新对话」与 ⌘N（session.new）：点它们同样领新目录，'
            + '不会再掉进当前工作区。工作区行上的 ⊕ 保持官方语义（在那个目录里开会话）。'
            + '官方文件零改动，这层接管可关：cordis.patch.yml 里 bridgeNewSession: false。'),

          h('div', { key: 'prune', style: Object.assign({}, S.row, { marginTop: 8 }) }, [
            h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 'label', style: S.rowTitle }, '清理空目录'),
              h('div', { key: 'desc', style: S.rowDesc },
                (note === '' ? '' : '（' + note + '）') +
                '只收「目录里一个文件都没有」的：正在用、聊过、放过东西的一律不动；'
                + '顺手把历次遗留下来、没有工作区认领的空目录也一并收掉。'),
              h('div', { key: 'count', style: S.meta }, state ? ('当前可清理 ' + empties.length + ' 个') : ''),
            ]),
            h(Btn, {
              key: 'prune-go',
              onClick: prune,
              disabled: busy || state === null || isOff,
              title: isOff
                ? offNote
                : '删掉空目录（含没工作区认领的孤儿目录），并把对应工作区从侧栏退掉',
            }, busy ? '清理中…' : (empties.length > 0 ? ('清理 ' + empties.length + ' 个') : '清理空目录')),
          ]),

          done ? h('div', { key: 'done', style: S.ok }, done) : null,
          msg ? h('div', { key: 'msg', style: S.msg }, msg) : null,

          h('h3', { key: 'recent-title', style: S.group }, '最近目录'),
          h('div', { key: 'recent', style: S.list },
            recent.length
              ? recent.map((item) => h('div', { key: item.path, style: S.row }, [
                  h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                    h('div', { key: 'name', style: Object.assign({}, S.rowTitle, { fontFamily: T.code }) }, item.name),
                    h('div', { key: 'path', style: Object.assign({}, S.meta, { overflowWrap: 'anywhere' }) }, item.path),
                    h('div', { key: 'time', style: S.meta }, fmtTime(item.mtime)),
                  ]),
                ]))
              : [h('div', { key: 'none', style: S.empty }, state ? '（这个根目录下还没有本插件建的目录）' : '读取中…')]),

          h('p', { key: 'note', style: S.note },
            '入口二：输入框右侧的「新目录」小按钮，点一下同样跑完整条流程。' +
            '开关 / 根目录写在 D:\\dsh-plugins\\dsh-new-workdir\\cordis.patch.yml（enabled / root），' +
            '改完重启 dsh web 或桌面端生效。'),
        ])
      }

      if (bridge && typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], (scope) => {
          installNewSessionBridge(scope)
        })
      }

      ctx.effect(() =>
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'new-workdir', order: 60 }, NewWorkdirChip),
        ),
      )

      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'new-workdir', order: 17, label: () => '新目录会话' }, NewWorkdirPanel),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 给离线单测留的后门（浏览器里没人用）
    exports.createWorkdir = createWorkdir
    exports.openOrCreateWorkdir = openOrCreateWorkdir
    exports.findReusableBlank = findReusableBlank
    exports.installNewSessionBridge = installNewSessionBridge
    exports.pruneCandidates = pruneCandidates
    exports.pruneEmptyWorkdirs = pruneEmptyWorkdirs
    exports._pendingCount = (ctx) => stateOf(ctx).pendingUnregisters.size
    exports._rememberClaim = rememberClaim
    exports._request = request
    return module.exports
  },
})
