// SPDX-License-Identifier: MIT
/**
 * dsh-new-workdir — Host half.
 *
 * 一键「新目录会话」的后端半区。全是普通文件操作 + 两个 loopback HTTP 端点，
 * 不接触任何既有服务：
 *
 *   1. mkdir  在 root 下领一个没人用过的时间戳目录（node:fs/promises）；
 *   2. prune  回收「目录里一个文件都没有」的空目录（rmdir，非空一律不动）；
 *   3. audit  往 ~/.dsh/logs/new-workdir.log 记一行，方便回溯。
 *
 * root 是 prune 唯一的删除边界，而它必须经得住「调用方报上来的路径」：
 *   ① 先 resolve() 把 `..` 算术掉，再用 relative() 判断是否真的在 root 里
 *      （不能只比字符串前缀 —— `D:/root/../outside/x` 的前缀恰好也对）；
 *   ② 目录真的存在时再 realpath 一次，挡掉「root 里那个名字其实是个链接 /
 *      junction，指到 root 外面」；
 *   ③ 任何越界的路径只记一笔 skipped，绝不落地删除。
 *
 * 为什么 host 半区不注册工作区、也不开会话：
 *   这两步都由客户端调用官方 Remote 完成
 *     ctx.workspaces.create({ path })        → 注册工作区
 *     ctx.sessions.create({ workspaceId })   → 开一个干净会话
 *   于是本插件既不覆盖也不劫持任何既有服务方法。DSH 每两三天一个版本也不会
 *   打到我们：官方文件零改动，升级后重新加载即可。
 *
 * HTTP（loopback，前缀 /api/new-workdir）：
 *   GET  /state  → { ok, enabled, root, roots:[{ path, isDefault, count, recent[] }],
 *                    count, recent, version }     顶层那三个 = 默认根（兼容旧客户端）
 *   POST /mkdir  → { ok, path, name, title, root }  body: { name?, root? }
 *                   body.root 只能从允许清单里挑（不传 = 默认根）
 *   POST /prune  → { ok, removed:[path], skipped:[{ path, reason }] }
 *                   body: { paths:[…], keep:[…], sweep?: true } —— 白名单路径命中
 *                   任何一个允许的根都算合格；sweep 会把所有根都扫一遍
 *   POST /log    → { ok }  body: { level, message }  客户端失败也留痕（enabled 关了也记）
 *                  三个 POST 都要 x-dsh-plugin: new-workdir（与其它 dsh-* 面板
 *                  同款 CSRF 约定；这是 CSRF 约定不是鉴权 —— 见 README「边界」）。
 *   请求体上限 64 KB，超了回 413 BODY_TOO_LARGE；日志每分钟最多 120 行、
 *   单文件 5 MB 后轮转成 .1（防止本机进程把日志刷爆）。
 *
 * 配置（见 cordis.patch.yml）：
 *   enabled: true             false = 只读展示，两个 POST 都返回 403
 *   root:    D:/work-harness  主根（= 默认根），不存在会自动创建；不写就用
 *                             DSH_WORKDIRS，再没有就 ~/.dsh/workdirs（不写死盘符）
 *   roots:   [E:/sandbox]     可选：额外的根。第一个是默认根，顺序就是面板里的顺序
 *   recent:  8                面板里每个根回显的最近目录条数
 */
import { appendFile, mkdir, readdir, realpath, rename, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'new-workdir'
export const inject = ['webServer']

export const VERSION = '0.4.1'

const PREFIX = '/api/new-workdir'
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_ID = 'new-workdir'
const CONFLICT_LIMIT = 500

/** 请求体上限：这几个接口的 body 都只有几个短字段，64 KB 已经很宽裕。 */
const MAX_BODY_BYTES = 64 * 1024
/** 单个日志文件上限，超了就轮转成 .1（只留一代）。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024
/** 每分钟最多写多少行日志 —— 本机进程拿 /log 刷盘时的兜底。 */
const LOG_MAX_PER_MINUTE = 120

const DEFAULTS = { enabled: true, recent: 8 }

/** 常见的磁盘 / 权限错误码 → 人话，别把 EPERM 原样甩给用户。 */
const MKDIR_HINTS = {
  EACCES: '没有权限在这个根目录下建目录',
  EPERM: '被权限或系统策略挡住了',
  EROFS: '目标盘是只读的',
  ENOSPC: '磁盘空间不足',
  ENAMETOOLONG: '目录名太长',
  ENOENT: '父目录不存在',
  ENOTDIR: '路径里有一段不是目录',
  EBUSY: '目录被占用',
  EMFILE: '打开的文件 / 句柄太多',
}

/** 认领本插件建的目录：时间戳打头，尾部可以挂一段自定义标签。 */
const OWN_DIR_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-.+)?$/

function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * 目录名：2026-09-28-13-05-12（与 D:\work-harness 下的历史目录同构）。
 * @param date - optional clock override (tests).
 */
export function stamp(date) {
  const d = date || new Date()
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    '-' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
}

/**
 * 工作区标题：2026-09-28 13:05:12。带空格冒号，人读着舒服，也一眼能认出
 * 是本插件建的（官方默认标题是目录名 basename）。
 */
export function prettyTitle(date) {
  const d = date || new Date()
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/**
 * 标签消毒：Windows 非法字符与控制符换成 '-'，空白压成单个 '-'，两端点号去掉，
 * 限长 40。空串表示不加标签（纯时间戳目录名）。
 */
export function sanitizeLabel(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
    .slice(0, 40)
    .replace(/[.\-]+$/, '')
}

/** 目录名 = 时间戳 [+ '-' + 标签]。 */
export function dirName(label, date) {
  const s = stamp(date)
  return label ? s + '-' + label : s
}

export function isOwnDir(name) {
  return OWN_DIR_RE.test(String(name == null ? '' : name))
}

/** 路径归一（比较用）：反斜杠转正斜杠、去尾斜杠、小写。 */
export function normPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 一个 root 都没配时的默认值：不写死盘符/盘路径。
 *   DSH_WORKDIRS 环境变量 → 否则 ~/.dsh/workdirs
 * （之前这里写死 'D:/work-harness'，换机器/换盘符就得改代码。）
 */
export function defaultRoot() {
  const fromEnv = String(process.env.DSH_WORKDIRS || '').trim()
  return fromEnv !== '' ? fromEnv : join(dshHome(), 'workdirs')
}

/**
 * root 允许清单：cfg.root 是主根（兼容旧配置），cfg.roots 是额外的根（可选）。
 * 第一个就是「默认根」—— 不带 root 参数的 mkdir 落在这里。
 * 去重（Windows 不区分大小写）、去空、保留配置里的顺序。
 * 重要：这个清单同时是 prune 的删除边界 —— 只有清单里的根才删得到东西。
 * @returns { roots: string[], defaultRoot: string }
 */
export function normalizeRoots(cfg) {
  const list = []
  const push = (raw) => {
    const value = String(raw == null ? '' : raw).trim()
    if (value === '') return
    const key = normPath(value)
    if (list.some((item) => normPath(item) === key)) return
    list.push(value)
  }
  if (cfg && typeof cfg === 'object') {
    push(cfg.root)
    if (Array.isArray(cfg.roots)) for (const item of cfg.roots) push(item)
  }
  return { roots: list, defaultRoot: list[0] }
}

/** 从允许清单里挑一个根；不给 / 给空 → 默认根。找不到返回 undefined。 */
export function pickRoot(roots, wanted) {
  if (!Array.isArray(roots) || roots.length === 0) return undefined
  const value = String(wanted == null ? '' : wanted).trim()
  if (value === '') return roots[0]
  const key = normPath(value)
  return roots.find((item) => normPath(item) === key)
}

/** 日志限流状态：窗口起点、窗口内已写行数、被丢掉的条数。 */
let logWindowStart = 0
let logWindowCount = 0
let logDropped = 0

function logAllowed(now) {
  if (now - logWindowStart >= 60000) {
    logWindowStart = now
    logWindowCount = 0
  }
  if (logWindowCount >= LOG_MAX_PER_MINUTE) {
    logDropped += 1
    return false
  }
  logWindowCount += 1
  return true
}

/** 单文件超过上限就挪成 .1（只留一代，不做无限轮转）。 */
async function rotateIfHuge(file) {
  try {
    const info = await stat(file)
    if (info.size > LOG_MAX_BYTES) await rename(file, file + '.1')
  } catch {
    /* 文件还不存在 / 挪不动：都不影响这次写入 */
  }
}

async function audit(line, isError) {
  const now = Date.now()
  if (!logAllowed(now)) return
  try {
    const dir = join(dshHome(), 'logs')
    await mkdir(dir, { recursive: true })
    const file = join(dir, isError ? 'new-workdir.err.log' : 'new-workdir.log')
    await rotateIfHuge(file)
    const prefix = logDropped > 0 ? '[限流丢弃 ' + logDropped + ' 行] ' : ''
    logDropped = 0
    await appendFile(file, new Date(now).toISOString() + ' ' + prefix + line + '\n', 'utf8')
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** body 超限时抛这个；handler 统一回 413，而不是把内存吃光。 */
class BodyTooLarge extends Error {
  constructor() {
    super('请求体超过 ' + MAX_BODY_BYTES + ' 字节上限')
    this.code = 'BODY_TOO_LARGE'
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/** 读 body；超限直接写 413 并返回 undefined —— 调用方看到 undefined 就 return。 */
async function readBodyChecked(req, res) {
  try {
    return await readBody(req)
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      fail(res, 'BODY_TOO_LARGE', 413, error.message)
      return undefined
    }
    throw error
  }
}

function fail(res, code, httpCode, message) {
  sendJson(res, httpCode, { ok: false, error: { code: code, message: message } })
}

/**
 * 在 root 下领一个可用目录（已存在就往后加 -2 / -3 …）。
 * @param root - absolute parent directory.
 * @param label - sanitized label, may be ''.
 * @returns { path, name, title }
 */
async function claimOnce(root, label, date) {
  await mkdir(root, { recursive: true })
  const base = dirName(label, date)
  for (let i = 1; i <= CONFLICT_LIMIT; i += 1) {
    const candidate = i === 1 ? join(root, base) : join(root, base + '-' + i)
    try {
      // 直接 mkdir、拿 EEXIST 当「这个名字被占了」：先 stat 再 mkdir 中间有窗口，
      // 两个并发请求会同时 stat 到「不存在」，然后第二个一头撞上 EEXIST 直接失败。
      await mkdir(candidate)
      return { path: candidate, name: basename(candidate), title: prettyTitle(date) }
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('连续 ' + CONFLICT_LIMIT + ' 个目录名都被占用，检查 root 是否被别的东西塞满了：' + root)
}

/** 同一个 root 上的建目录动作排队（单进程内），并发时不会抢同一个时间戳。 */
const claimChains = new Map()

export function claimDir(root, label, date) {
  const key = normPath(root)
  const prev = claimChains.get(key) || Promise.resolve()
  const run = prev.then(() => claimOnce(root, label, date), () => claimOnce(root, label, date))
  const tail = run.then(() => {}, () => {})
  claimChains.set(key, tail)
  tail.then(() => { if (claimChains.get(key) === tail) claimChains.delete(key) })
  return run
}

/** 扫 root 下属于本插件的目录，新的在前。limit 省略 = 全部。 */
export async function scanDirs(root, limit) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { total: 0, items: [] }
    throw error
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isOwnDir(entry.name)) continue
    const full = join(root, entry.name)
    let mtime
    try { mtime = (await stat(full)).mtime.toISOString() } catch { mtime = undefined }
    items.push({ name: entry.name, path: full, mtime: mtime })
  }
  items.sort(function (a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0 })
  const cap = limit === undefined ? 8 : limit
  return { total: items.length, items: cap === Infinity ? items : items.slice(0, cap) }
}

/** 兼容旧名字（面板的 /state 与单测都用它）。 */
export function scanRecent(root, limit) {
  return scanDirs(root, limit)
}

/** 取路径最后一段（接受反斜杠）。 */
export function baseName(p) {
  const s = normPath(p)
  const at = s.lastIndexOf('/')
  return at === -1 ? s : s.slice(at + 1)
}

/** 输入里有没有 `..` 段（防穿越的第一道闸）。 */
export function hasDotDot(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').split('/').some((seg) => seg === '..')
}

/**
 * path 在 root 之下（不含 root 自己）。
 *
 * 必须先把 `.` / `..` 算术掉再比，不能只比字符串前缀：`D:/root/../outside/x`
 * 的字符串前缀确实是 `D:/root/`，但它落地在 root 外面 —— 只比前缀的话，prune
 * 会被一个报上来的路径骗着删掉 root 外的目录。所以先 resolve()，再用
 * relative() 判断：结果不能以 `..` 开头、不能是绝对路径（跨盘符时 relative
 * 会给一个绝对路径）、也不能是空串（空串 = 就是 root 自己）。
 */
export function underRoot(target, root) {
  const rawRoot = String(root == null ? '' : root)
  if (rawRoot.trim() === '') return false
  const a = resolve(String(target == null ? '' : target))
  const b = resolve(rawRoot)
  if (normPath(a) === normPath(b)) return false
  const rel = relative(b, a)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * underRoot 的加强版：目录真的存在时再 realpath 一次，把「root 里那个名字是
 * 个符号链接 / junction，指到 root 外面」这种情况也挡掉（纯算术挡不住链接）。
 * @returns { ok: true, resolved } | { ok: false, reason } —— reason 直接进 skipped。
 */
export async function resolveUnder(target, root) {
  const p = String(target == null ? '' : target)
  if (hasDotDot(p)) return { ok: false, reason: 'outside-root' }
  if (!underRoot(p, root)) return { ok: false, reason: 'outside-root' }
  const wanted = resolve(p)
  let realRoot
  try { realRoot = await realpath(resolve(String(root))) } catch { realRoot = resolve(String(root)) }
  let realTarget
  try {
    realTarget = await realpath(wanted)
  } catch (error) {
    const code = error && error.code
    // 不存在 / 不是目录：交给后面的 readdir 去报（正常会被 skip 掉）
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, resolved: wanted }
    return { ok: false, reason: String(code || error) }
  }
  if (!underRoot(realTarget, realRoot)) return { ok: false, reason: 'outside-root' }
  return { ok: true, resolved: realTarget }
}

/**
 * 在「一组允许的根」里找 path 的归属：命中任何一个都算合格（多 root 时用）。
 * 顺序无关，命中的那个根同时用来做 realpath 比较。
 * @returns { ok: true, resolved, root } | { ok: false, reason }
 */
export async function resolveUnderAny(target, roots) {
  const list = Array.isArray(roots) ? roots : [roots]
  let reason = 'outside-root'
  for (const root of list) {
    const safe = await resolveUnder(target, root)
    if (safe.ok) return { ok: true, resolved: safe.resolved, root: root }
    if (safe.reason !== 'outside-root') reason = safe.reason
  }
  return { ok: false, reason: reason }
}

/**
 * 回收空目录。白名单语义：只动调用方点名的目录，而且必须同时满足
 *   ① 算术归位 + realpath 之后真的在 root 之下（resolveUnder，带不了 `..` 和链接）
 *   ② 目录名是我们的时间戳格式  ③ 磁盘上真的一个条目都没有。
 * 这样即使 root 里混着别人的 / 没注册的空目录（比如插件装上之前留下的），
 * 也不会被顺手删掉；即使调用方（或者别的什么）报上来一个带 `..` 的路径，
 * 也只会拿到一笔 skipped。
 * @returns { removed, skipped }
 */
export async function pruneEmpty(rootOrRoots, paths, options) {
  const opts = options && typeof options === 'object' ? options : {}
  // root 可以是一个根，也可以是一组根（多 root 配置）—— 白名单路径命中任何一个都算合格。
  const roots = (Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots]).filter((item) => String(item == null ? '' : item).trim() !== '')
  const removed = []
  const skipped = []
  const done = new Set()
  for (const raw of Array.isArray(paths) ? paths : []) {
    const target = String(raw == null ? '' : raw)
    if (!isOwnDir(baseName(target))) { skipped.push({ path: target, reason: 'not-ours' }); continue }
    // 边界：算术归位后必须在 root 之内；目录存在时还会再 realpath 一次（挡链接）。
    // 任何越界路径只记一笔 skipped，绝不下手删。
    const safe = await resolveUnderAny(target, roots)
    if (!safe.ok) { skipped.push({ path: target, reason: safe.reason }); continue }
    const dir = safe.resolved
    let entries
    try {
      entries = await readdir(dir)
    } catch (error) {
      skipped.push({ path: target, reason: String((error && error.code) || error) })
      continue
    }
    if (entries.length > 0) { skipped.push({ path: target, reason: 'not-empty' }); continue }
    try {
      await rmdir(dir)
      // removed 回的是调用方给的原串（客户端拿它去对工作区行），去重两种写法都记一份。
      done.add(normPath(target))
      done.add(normPath(dir))
      removed.push(target)
    } catch (error) {
      skipped.push({ path: target, reason: String((error && error.code) || error) })
    }
  }
  // 扫尾（可选）：把 root 下「我们的命名 + 磁盘上真空 + 不在 keep 名单」的目录一并收掉
  // （历次建会话失败留下的孤儿目录就属于这一类）。keep 名单由客户端给。
  if (opts.sweep === true) {
    const keep = new Set((Array.isArray(opts.keep) ? opts.keep : []).map((p) => normPath(p)))
    const scanned = []
    for (const one of roots) {
      try {
        const result = await scanDirs(one, Infinity)
        for (const item of result.items) scanned.push(item)
      } catch {
        // 这个根读不到（不存在 / 没权限）就跳过，不影响其它根
      }
    }
    for (const item of scanned) {
      if (done.has(normPath(item.path))) continue
      if (keep.has(normPath(item.path))) { skipped.push({ path: item.path, reason: 'kept' }); continue }
      // 扫尾名单是自己 readdir 出来的，本来就不可能越界；这里再走一遍同一道闸，
      // 免得以后有人把 scanned 换成别的来源（比如 root 里放了个链接指出去）。
      const safe = await resolveUnderAny(item.path, roots)
      if (!safe.ok) { skipped.push({ path: item.path, reason: safe.reason }); continue }
      let entries
      try {
        entries = await readdir(safe.resolved)
      } catch (error) {
        skipped.push({ path: item.path, reason: String((error && error.code) || error) })
        continue
      }
      if (entries.length > 0) { skipped.push({ path: item.path, reason: 'not-empty' }); continue }
      try {
        await rmdir(safe.resolved)
        removed.push(item.path)
      } catch (error) {
        skipped.push({ path: item.path, reason: String((error && error.code) || error) })
      }
    }
  }
  return { removed, skipped }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  // roots = 允许操作的根目录清单（第一个是默认根）；一个都没配就用可移植的默认值。
  const configured = normalizeRoots(cfg).roots
  const roots = configured.length > 0 ? configured : [defaultRoot()]
  const root = roots[0]
  const enabled = cfg.enabled !== false
  const recentLimit = Number.isFinite(Number(cfg.recent)) && Number(cfg.recent) > 0 ? Number(cfg.recent) : DEFAULTS.recent

  function info(message) {
    try { if (ctx.logger && ctx.logger.info) ctx.logger.info('new-workdir: ' + message) } catch { /* noop */ }
  }

  /** 两个 POST 共用的前置检查；返回 true 表示可以继续。 */
  function guard(req, res) {
    if (req.method !== 'POST') { fail(res, 'METHOD', 405, 'POST only'); return false }
    if (req.headers[PLUGIN_HEADER] !== PLUGIN_ID) { fail(res, 'CSRF', 403, 'missing plugin header'); return false }
    if (!enabled) { fail(res, 'DISABLED', 403, 'new-workdir 已在 cordis.patch.yml 里关掉（enabled: false）'); return false }
    return true
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return fail(res, 'METHOD', 405, 'GET only')
        try {
          // 每个根各自报一份；顶层的 root / count / recent 等于默认根（兼容旧客户端）。
          const per = []
          for (const one of roots) {
            const scanned = await scanDirs(one, recentLimit)
            per.push({ path: one, isDefault: one === root, count: scanned.total, recent: scanned.items })
          }
          sendJson(res, 200, {
            ok: true,
            enabled: enabled,
            root: root,
            roots: per,
            count: per[0].count,
            recent: per[0].recent,
            version: VERSION,
          })
        } catch (error) {
          await audit('state error: ' + (error && error.message), true)
          fail(res, 'STATE_FAILED', 500, String((error && error.message) || error))
        }
      },
    }))

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/mkdir',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readBodyChecked(req, res)
        if (body === undefined) return
        const label = sanitizeLabel(body.name)
        // body.root 可选：只能从允许清单里挑，挑不到就拒 —— 不允许任意路径。
        const targetRoot = pickRoot(roots, body.root)
        if (targetRoot === undefined) {
          return fail(res, 'ROOT', 400, 'root 不在允许清单里（检查 cordis.patch.yml 的 root / roots）')
        }
        try {
          const made = await claimDir(targetRoot, label)
          await audit('created ' + made.path + (label ? ' (label=' + label + ')' : ''))
          sendJson(res, 200, {
            ok: true,
            path: made.path,
            name: made.name,
            title: made.title,
            root: targetRoot,
          })
        } catch (error) {
          await audit('mkdir error: ' + (error && error.message), true)
          const raw = String((error && error.message) || error)
          const hint = MKDIR_HINTS[(error && error.code) || '']
          fail(res, 'MKDIR_FAILED', 500, hint ? hint + '（' + raw + '）' : raw)
        }
      },
    }))

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/prune',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readBodyChecked(req, res)
        if (body === undefined) return
        try {
          const outcome = await pruneEmpty(roots, Array.isArray(body.paths) ? body.paths : [], {
            sweep: body.sweep === true,
            keep: body.keep,
          })
          if (outcome.removed.length > 0) await audit('pruned ' + outcome.removed.join(', '))
          sendJson(res, 200, { ok: true, removed: outcome.removed, skipped: outcome.skipped })
        } catch (error) {
          await audit('prune error: ' + (error && error.message), true)
          fail(res, 'PRUNE_FAILED', 500, String((error && error.message) || error))
        }
      },
    }))

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/log',
      handler: async (req, res) => {
        if (req.method !== 'POST') return fail(res, 'METHOD', 405, 'POST only')
        if (req.headers[PLUGIN_HEADER] !== PLUGIN_ID) return fail(res, 'CSRF', 403, 'missing plugin header')
        const body = await readBodyChecked(req, res)
        if (body === undefined) return
        const level = String(body.level == null ? 'info' : body.level)
        const message = String(body.message == null ? '' : body.message).slice(0, 500)
        await audit('client[' + level + '] ' + message, level === 'error')
        sendJson(res, 200, { ok: true })
      },
    }))

  info('armed: roots=' + roots.join(' | ') + (enabled ? '' : ' (disabled)'))
}

export default { name, inject, apply }
