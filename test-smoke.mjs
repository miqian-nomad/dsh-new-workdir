/**
 * dsh-new-workdir 离线冒烟测试（不启动 DSH）。
 *
 *   node test-smoke.mjs
 *
 * 覆盖：
 *   1. host 半区：claimDir / scanDirs / sanitizeLabel / 三个 HTTP handler
 *      （含 CSRF 与 enabled:false 分支）
 *   2. pruneEmpty 白名单语义：只删点名的、root 内的、时间戳命名的、磁盘上真空的
 *   3. client 半区：把 window.__ModuleLoader__ 与 fetch 打桩，让流程真的跑完
 *      mkdir → workspaces.create → sessions.create → openSession
 *   4. 复用规则：只复用「本次页面会话里刚建的、还没聊过」那一个；别人的旧空会话 /
 *      已归档 / 已聊过 / 填了名字 → 一律新建
 *   5. 清理规则：只挑「会话全空白 + 不是当前」的；聊过的目录进 keep；退不掉的
 *      工作区记账，下次清理先补
 *   6. 边界与并发（曾经的盲区）：`..` 穿越 / root 内链接指到外面 / 并发建房
 *   7. 版本一致：package.json 的 version 与 src/index.js 的 VERSION
 *   8. 快照不可信时清理必须 fail-closed（不发 sweep），UI 入口接线（chip / 设置页卡片）
 *   9. loopback 加固：body 上限 413、日志轮转与每分钟限流
 *
 * 全程在临时根目录里操作，不碰 D:/work-harness。
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { mkdir, readFile, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const TMPBASE = join(tmpdir(), 'new-workdir-smoke')
const ROOT = join(TMPBASE, String(Date.now()))
const OUTSIDE = join(TMPBASE, 'outside-' + Date.now())
await mkdir(ROOT, { recursive: true })

let passed = 0
function ok(label) {
  passed += 1
  console.log('  ✓ ' + label)
}
async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// host 半区
// ---------------------------------------------------------------------------
const host = await import('./src/index.js')

// 版本号只有一份真相：package.json 和运行时的 VERSION 必须对得上，否则排查会瞎。
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
assert.equal(pkg.version, host.VERSION, 'package.json 与 src/index.js 的 VERSION 必须一致')
ok('版本一致：package.json ' + pkg.version + ' = VERSION ' + host.VERSION)

console.log('host: 纯函数')
assert.equal(host.sanitizeLabel('fix login'), 'fix-login')
assert.equal(host.sanitizeLabel('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
assert.equal(host.sanitizeLabel('  ..名字  '), '名字')
assert.equal(host.sanitizeLabel(''), '')
assert.equal(host.stamp(new Date(2026, 8, 28, 13, 5, 12)), '2026-09-28-13-05-12')
assert.equal(host.prettyTitle(new Date(2026, 8, 28, 13, 5, 12)), '2026-09-28 13:05:12')
assert.equal(host.dirName('', new Date(2026, 8, 28, 13, 5, 12)), '2026-09-28-13-05-12')
assert.equal(host.dirName('fix-login', new Date(2026, 8, 28, 13, 5, 12)), '2026-09-28-13-05-12-fix-login')
assert.equal(host.isOwnDir('2026-09-28-13-05-12'), true)
assert.equal(host.isOwnDir('2026-09-28-13-05-12-x'), true)
assert.equal(host.isOwnDir('my-notes'), false)
assert.equal(host.underRoot('D:\\work-harness\\2026-09-28-13-05-12', 'D:/work-harness'), true)
assert.equal(host.underRoot('D:/work-harness', 'D:/work-harness'), false)
assert.equal(host.underRoot('D:/work-harness-2/x', 'D:/work-harness'), false)
assert.equal(host.underRoot('D:/', 'D:/work-harness'), false)
assert.equal(host.underRoot('D:/work-harness/x', ''), false, 'root 是空串 → 一律不算')
assert.equal(host.underRoot('D:/work-harness/./2026-09-28-13-05-12', 'D:/work-harness'), true, '`.` 归一后仍在里面')
// `..` 必须按段落算，只比字符串前缀会被 `root/../outside/x` 骗过去
assert.equal(host.underRoot('D:/work-harness/../outside/2026-01-01-00-00-00', 'D:/work-harness'), false)
assert.equal(host.underRoot('D:/work-harness/sub/../../outside/2026-01-01-00-00-00', 'D:/work-harness'), false)
assert.equal(host.underRoot('D:/work-harness/../work-harness-2/x', 'D:/work-harness'), false)
assert.equal(host.hasDotDot('D:/a/../b'), true)
assert.equal(host.hasDotDot('D:\\a\\..\\b'), true)
assert.equal(host.hasDotDot('D:/a/..b/c'), false, '名字里夹着 .. 但不是 `..` 段')
assert.equal(host.hasDotDot('D:/a/b'), false)
assert.equal(host.baseName('D:\\work-harness\\2026-09-28-13-05-12'), '2026-09-28-13-05-12')
ok('stamp / prettyTitle / sanitizeLabel / dirName / isOwnDir / underRoot / baseName')

console.log('host: claimDir + scanDirs')
const first = await host.claimDir(ROOT, '')
assert.match(first.name, /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)
assert.equal((await stat(first.path)).isDirectory(), true)
ok('claimDir 建出时间戳目录 ' + first.name)

const second = await host.claimDir(ROOT, 'fix-login')
assert.match(second.name, /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-fix-login/)
ok('带标签目录 ' + second.name)

console.log('host: 并发建房（同一个时间戳被四个请求同时抢）')
const CROOT = join(TMPBASE, 'race-' + Date.now())
const sameSecond = new Date(2026, 8, 28, 13, 5, 12)
const race = await Promise.all([1, 2, 3, 4].map(() => host.claimDir(CROOT, '', sameSecond)))
const raceNames = race.map((r) => r.name)
assert.equal(new Set(raceNames).size, 4, '四个请求必须拿到四个不同目录，实际：' + raceNames.join(' '))
assert.deepEqual(raceNames.slice().sort(), [
  '2026-09-28-13-05-12', '2026-09-28-13-05-12-2',
  '2026-09-28-13-05-12-3', '2026-09-28-13-05-12-4',
].sort())
for (const made of race) assert.equal((await stat(made.path)).isDirectory(), true)
ok('并发 claimDir：不再撞 EEXIST，四个请求各拿各的（-2 -3 -4）')

const fifth = await host.claimDir(CROOT, '', sameSecond)
assert.equal(fifth.name, '2026-09-28-13-05-12-5', '并发过后编号仍然接着排')
ok('再接一个 → -5（号码不重不乱）')

await mkdir(join(ROOT, 'not-ours'), { recursive: true })
const scanned = await host.scanDirs(ROOT, 10)
assert.equal(scanned.total, 2, '只认自己的目录，not-ours 不计入')
assert.equal(scanned.items.length, 2)
const all = await host.scanDirs(ROOT, Infinity)
assert.equal(all.items.length, all.total)
assert.equal((await host.scanRecent(ROOT, 1)).items.length, 1)
ok('scanDirs / scanRecent 只认自己的目录（total=' + scanned.total + '）')

console.log('host: 标签的 Windows 边界（保留设备名够不着）')
// 目录名永远是「时间戳 + '-' + 标签」，所以 CON / NUL / COM1 这类保留名永远不可能是
// 完整目录名（Windows 只对「整个名字」判定保留）。结尾空格 / 点也必须清掉：Windows
// 会悄悄把它们截掉，于是磁盘上的名字和我们记的对不上。
assert.equal(host.sanitizeLabel('nul.'), 'nul', '结尾的点清掉')
assert.equal(host.sanitizeLabel('名字   '), '名字', '结尾空白不留')
assert.equal(host.dirName(host.sanitizeLabel('CON'), new Date(2026, 8, 28, 13, 5, 12)), '2026-09-28-13-05-12-CON')
const reserved = await host.claimDir(ROOT, host.sanitizeLabel('con'))
assert.equal((await stat(reserved.path)).isDirectory(), true, '标签叫 con 也建得出来（前面有时间戳挡着）')
await rmdir(reserved.path)
ok('标签边界：时间戳打头 → 保留设备名够不着；结尾空格 / 点不留')

console.log('host: pruneEmpty 白名单')
const pA = await host.claimDir(ROOT, 'cli-empty')
const pB = await host.claimDir(ROOT, 'cli-keep')
const pC = await host.claimDir(ROOT, 'cli-current')
await writeFile(join(pB.path, 'note.txt'), 'x', 'utf8')
await mkdir(OUTSIDE, { recursive: true })
const pOut = await host.claimDir(OUTSIDE, 'outside')

const prune = await host.pruneEmpty(ROOT, [pA.path, pB.path, pOut.path, 'D:/work-harness', join(ROOT, 'not-ours')])
assert.deepEqual(prune.removed, [pA.path], '只有空的那个被删')
const reasons = new Map(prune.skipped.map((s) => [s.path, s.reason]))
assert.equal(reasons.get(pB.path), 'not-empty')
assert.equal(reasons.get(pOut.path), 'outside-root')
assert.equal(reasons.get('D:/work-harness'), 'not-ours')
assert.equal(reasons.get(join(ROOT, 'not-ours')), 'not-ours')
assert.equal(await exists(pA.path), false, '空目录已删')
assert.equal(await exists(pB.path), true, '有文件的目录没动')
assert.equal(await exists(pC.path), true, '没点名的目录没动')
assert.equal(await exists(pOut.path), true, 'root 之外的目录没动')
ok('pruneEmpty：只删「点名的 + root 内的 + 时间戳命名的 + 真空的」')

console.log('host: pruneEmpty 扫尾（sweep）')
const SWEEP_ROOT = join(TMPBASE, 'sweep-' + Date.now())
const swKeep = await host.claimDir(SWEEP_ROOT, 'keep-me')
const swGo = await host.claimDir(SWEEP_ROOT, 'go')
const swFile = await host.claimDir(SWEEP_ROOT, 'has-file')
await writeFile(join(swFile.path, 'a.txt'), 'x', 'utf8')
await mkdir(join(SWEEP_ROOT, '别人的目录'), { recursive: true })
const swept = await host.pruneEmpty(SWEEP_ROOT, [], { sweep: true, keep: [swKeep.path] })
assert.equal(await exists(swKeep.path), true, 'keep 名单里的不动')
assert.equal(await exists(swGo.path), false, '没人认领的空目录被收掉')
assert.equal(await exists(swFile.path), true, '有文件的不动')
assert.equal(await exists(join(SWEEP_ROOT, '别人的目录')), true, '不是时间戳命名的目录不动')
assert.equal(swept.removed.length, 1)
ok('pruneEmpty sweep：只收「我们命名 + 真空 + 不在 keep 名单」的')

console.log('host: root 边界（路径穿越 + 链接）')
const TRAV = join(TMPBASE, 'trav-' + Date.now())
const travRoot = join(TRAV, 'root')
const travOut = join(TRAV, 'outside')
await mkdir(travRoot, { recursive: true })
const victim = join(travOut, '2026-01-01-00-00-00')
await mkdir(victim, { recursive: true })
// 这一行的前缀恰好是 travRoot + '/'，但它其实落在 root 外面 —— 曾经能靠它删掉别人的空目录
const evil = travRoot + '/../outside/2026-01-01-00-00-00'
assert.equal(host.underRoot(evil, travRoot), false, '带 `..` 的路径不算 root 内')
const sneaked = await host.pruneEmpty(travRoot, [evil])
assert.deepEqual(sneaked.removed, [], '一个都不许删')
assert.equal(sneaked.skipped.length, 1)
assert.equal(sneaked.skipped[0].reason, 'outside-root')
assert.equal(await exists(victim), true, 'root 外的空目录必须原封不动')
ok('pruneEmpty 拒绝 `..` 穿越（root/../outside/… 不再能删）')

// 纯算术挡不住链接：root 里放个指到 root 外的 junction，得靠 realpath 才能识别
const linkPath = join(travRoot, '2026-01-02-00-00-00')
try {
  await symlink(travOut, linkPath, 'junction')
  const viaLink = await host.pruneEmpty(travRoot, [linkPath])
  assert.deepEqual(viaLink.removed, [], '链接指到外面 → 不删')
  assert.equal(viaLink.skipped[0].reason, 'outside-root')
  assert.equal(await exists(victim), true, '链接那头的目录还在')
  try { await rmdir(linkPath) } catch { /* 收不掉就算了，在临时目录里 */ }
  ok('pruneEmpty 拒绝「root 内的链接指到 root 外」')
} catch (error) {
  console.log('  · 跳过链接用例（当前环境建不了 junction：' + (error && error.code) + '）')
}

console.log('host: HTTP handler')
const routes = {}
const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { routes[route.path] = route; return () => { delete routes[route.path] } } },
  logger: { info() {} },
}
host.apply(ctx, { root: ROOT, recent: 5 })
assert.deepEqual(Object.keys(routes).sort(), ['/api/new-workdir/log', '/api/new-workdir/mkdir', '/api/new-workdir/prune', '/api/new-workdir/state'])
ok('apply 注册了四个路由')

function fakeReq(method, headers, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: headers || {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
function fakeRes() {
  const out = { status: 0, headers: undefined, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { out.body = text },
  }
}
async function call(path, method, headers, body) {
  const res = fakeRes()
  await routes[path].handler(fakeReq(method, headers, body), res)
  return { status: res.out.status, json: JSON.parse(res.out.body) }
}
const HEAD = { 'x-dsh-plugin': 'new-workdir' }

const expectedCount = (await host.scanDirs(ROOT, Infinity)).total
let r = await call('/api/new-workdir/state', 'GET')
assert.equal(r.status, 200)
assert.equal(r.json.root, ROOT)
assert.equal(r.json.count, expectedCount)
ok('GET /state → count=' + r.json.count + ', enabled=' + r.json.enabled)

r = await call('/api/new-workdir/mkdir', 'POST', {}, {})
assert.equal(r.status, 403)
assert.equal(r.json.error.code, 'CSRF')
ok('POST /mkdir 无插件头 → 403 CSRF')

r = await call('/api/new-workdir/prune', 'POST', {}, {})
assert.equal(r.status, 403)
assert.equal(r.json.error.code, 'CSRF')
ok('POST /prune 无插件头 → 403 CSRF')

// 请求体上限：这几个接口的 body 只有几个短字段，超过 64 KB 直接 413，不往内存里堆
r = await call('/api/new-workdir/prune', 'POST', HEAD, { paths: ['x'.repeat(80 * 1024)] })
assert.equal(r.status, 413)
assert.equal(r.json.error.code, 'BODY_TOO_LARGE')
ok('POST /prune body 超过 64 KB → 413 BODY_TOO_LARGE')

r = await call('/api/new-workdir/mkdir', 'POST', HEAD, { name: 'smoke case' })
assert.equal(r.status, 200)
assert.match(r.json.name, /-smoke-case$/)
assert.equal((await stat(r.json.path)).isDirectory(), true)
ok('POST /mkdir 带头 → ' + r.json.name)

const smokePath = r.json.path
r = await call('/api/new-workdir/prune', 'POST', HEAD, { paths: [smokePath, pB.path] })
assert.equal(r.status, 200)
assert.deepEqual(r.json.removed, [smokePath])
assert.equal(await exists(smokePath), false)
assert.equal(await exists(pB.path), true)
ok('POST /prune 带头 → 删 1 个空目录，有文件的不动')

// 走 HTTP 也是同一道闸：穿越的路径只会被 skip，不会落地删除
const httpTag = 'outside-http-' + Date.now()
const httpVictim = join(TMPBASE, httpTag, '2026-01-03-00-00-00')
await mkdir(httpVictim, { recursive: true })
r = await call('/api/new-workdir/prune', 'POST', HEAD, { paths: [ROOT + '/../' + httpTag + '/2026-01-03-00-00-00'] })
assert.equal(r.status, 200)
assert.deepEqual(r.json.removed, [])
assert.equal(r.json.skipped[0].reason, 'outside-root')
assert.equal(await exists(httpVictim), true, 'HTTP 这条路也删除不到 root 外面')
ok('POST /prune 收到 `..` 路径 → 只 skip，不删')

r = await call('/api/new-workdir/state', 'POST', HEAD)
assert.equal(r.status, 405)
ok('GET 路由拒绝 POST → 405')

const offRoutes = {}
host.apply({
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { offRoutes[route.path] = route } },
}, { root: ROOT, enabled: false })
const offRes = fakeRes()
await offRoutes['/api/new-workdir/mkdir'].handler(fakeReq('POST', HEAD, {}), offRes)
assert.equal(offRes.out.status, 403)
assert.equal(JSON.parse(offRes.out.body).error.code, 'DISABLED')
const offRes2 = fakeRes()
await offRoutes['/api/new-workdir/prune'].handler(fakeReq('POST', HEAD, { paths: [pC.path] }), offRes2)
assert.equal(offRes2.out.status, 403)
assert.equal(JSON.parse(offRes2.out.body).error.code, 'DISABLED')
assert.equal(await exists(pC.path), true)
ok('enabled:false → mkdir / prune 都 403 DISABLED')

console.log('host: 多根（root + roots）')
const R1 = join(TMPBASE, 'multi-a-' + Date.now())
const R2 = join(TMPBASE, 'multi-b-' + Date.now())
assert.deepEqual(
  host.normalizeRoots({ root: R1, roots: [R2, R1.toUpperCase(), '', null, '  '] }).roots,
  [R1, R2],
  '去重（大小写不敏感）+ 去空 + 保留配置顺序',
)
assert.equal(host.normalizeRoots({}).roots.length, 0)
assert.equal(host.normalizeRoots({}).defaultRoot, undefined)
assert.equal(host.pickRoot([R1, R2], ''), R1, '不传 root → 默认根（第一个）')
assert.equal(host.pickRoot([R1, R2], R2), R2)
assert.equal(host.pickRoot([R1, R2], R2.toUpperCase()), R2, '大小写不同也算命中')
assert.equal(host.pickRoot([R1, R2], 'D:/nope'), undefined)
// 默认根不写死盘符：DSH_WORKDIRS → ~/.dsh/workdirs
assert.equal(host.defaultRoot().includes('work-harness'), false, '默认根不该再写死 D:/work-harness')
process.env.DSH_WORKDIRS = join(TMPBASE, 'env-root-smoke')
assert.equal(host.defaultRoot(), join(TMPBASE, 'env-root-smoke'))
delete process.env.DSH_WORKDIRS
ok('normalizeRoots / pickRoot / defaultRoot：清单化 + 不写死盘符')

const multiRoutes = {}
host.apply({
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { multiRoutes[route.path] = route; return () => {} } },
  logger: { info() {} },
}, { root: R1, roots: [R2] })
async function callMulti(path, method, headers, body) {
  const res = fakeRes()
  await multiRoutes[path].handler(fakeReq(method, headers, body), res)
  return { status: res.out.status, json: JSON.parse(res.out.body) }
}

let mr = await callMulti('/api/new-workdir/state', 'GET')
assert.equal(mr.json.root, R1)
assert.equal(mr.json.roots.length, 2)
assert.equal(mr.json.roots[0].isDefault, true)
assert.equal(mr.json.roots[0].path, R1)
assert.equal(mr.json.roots[1].path, R2)
ok('/state 每个根报一份，顶层仍是默认根（兼容旧客户端）')

mr = await callMulti('/api/new-workdir/mkdir', 'POST', HEAD, {})
assert.equal(mr.status, 200)
assert.equal(mr.json.root, R1, '不传 root → 落在默认根')
assert.equal(host.underRoot(mr.json.path, R1), true)
const mk1 = mr.json.path

mr = await callMulti('/api/new-workdir/mkdir', 'POST', HEAD, { root: R2, name: 'in-b' })
assert.equal(mr.status, 200)
assert.equal(mr.json.root, R2)
assert.equal(host.underRoot(mr.json.path, R2), true, '落在第二个根下')
const mk2 = mr.json.path

mr = await callMulti('/api/new-workdir/mkdir', 'POST', HEAD, { root: 'D:/nope' })
assert.equal(mr.status, 400)
assert.equal(mr.json.error.code, 'ROOT')
ok('POST /mkdir：不传=默认根、传清单内的=那个根、清单外 → 400 ROOT')

mr = await callMulti('/api/new-workdir/prune', 'POST', HEAD, { paths: [mk1, mk2, 'D:/outside/2026-01-05-00-00-00'] })
assert.equal(mr.status, 200)
assert.deepEqual(mr.json.removed.slice().sort(), [mk1, mk2].sort(), '两个根下点名的空目录都删掉了')
assert.equal(mr.json.skipped[0].reason, 'outside-root')
assert.equal(await exists(mk1), false)
assert.equal(await exists(mk2), false)
ok('POST /prune：白名单路径命中任何一个根都算合格，清单外仍然只 skip')

// 扫尾要覆盖所有根
const sweepA = join(R1, '2026-01-06-00-00-00')
const sweepB = join(R2, '2026-01-06-00-00-00')
await mkdir(sweepA, { recursive: true })
await mkdir(sweepB, { recursive: true })
mr = await callMulti('/api/new-workdir/prune', 'POST', HEAD, { sweep: true })
assert.equal(await exists(sweepA), false, '第一个根的孤儿被收')
assert.equal(await exists(sweepB), false, '第二个根的孤儿也被收')
ok('POST /prune sweep：每个根都扫一遍')

console.log('host: /log 留痕')
const LOG_HOME = join(TMPBASE, 'dshhome-' + Date.now())
process.env.DSH_HOME = LOG_HOME
r = await call('/api/new-workdir/log', 'POST', {}, { level: 'error', message: 'x' })
assert.equal(r.status, 403)
r = await call('/api/new-workdir/log', 'GET', HEAD)
assert.equal(r.status, 405)
r = await call('/api/new-workdir/log', 'POST', HEAD, { level: 'error', message: '客户端报错了：sessions.create 挂了' })
assert.equal(r.status, 200)
const errLog = await readFile(join(LOG_HOME, 'logs', 'new-workdir.err.log'), 'utf8')
assert.match(errLog, /client\[error\] 客户端报错了/)
ok('POST /log：无插件头 403、GET 405、带头的写进 ~/.dsh/logs/new-workdir.err.log')

r = await call('/api/new-workdir/log', 'POST', HEAD, { level: 'info', message: '普通留痕' })
assert.match(await readFile(join(LOG_HOME, 'logs', 'new-workdir.log'), 'utf8'), /client\[info\] 普通留痕/)
const offLog = fakeRes()
await offRoutes['/api/new-workdir/log'].handler(fakeReq('POST', HEAD, { level: 'error', message: 'enabled:false 也要留痕' }), offLog)
assert.equal(offLog.out.status, 200, '/log 故意不受 enabled 约束')
assert.match(await readFile(join(LOG_HOME, 'logs', 'new-workdir.err.log'), 'utf8'), /enabled:false 也要留痕/)
ok('enabled:false 时 /log 仍记账（关停后也能看到客户端报错）')

console.log('host: 真 HTTP（绑一个临时 loopback 端口，跑真请求）')
const liveRoutes = {}
host.apply({
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { liveRoutes[route.path] = route; return () => {} } },
  logger: { info() {} },
}, { root: ROOT })
const server = createServer((req, res) => {
  const route = liveRoutes[String(req.url).split('?')[0]]
  if (!route) { res.writeHead(404); res.end('nope'); return }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500); res.end(String(error && error.message))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const liveBase = 'http://127.0.0.1:' + server.address().port + '/api/new-workdir'
const liveHead = { 'Content-Type': 'application/json', 'x-dsh-plugin': 'new-workdir' }

const liveState = await fetch(liveBase + '/state')
assert.equal(liveState.status, 200)
assert.equal((await liveState.json()).version, host.VERSION)
ok('GET /state over TCP → 200，version 对得上')

const liveNoHead = await fetch(liveBase + '/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
assert.equal(liveNoHead.status, 403)
ok('POST /mkdir over TCP 缺 CSRF 头 → 403')

const liveMade = await fetch(liveBase + '/mkdir', {
  method: 'POST', headers: liveHead, body: JSON.stringify({ name: 'live http' }),
})
assert.equal(liveMade.status, 200)
const liveMadeJson = await liveMade.json()
assert.match(liveMadeJson.name, /-live-http$/)
assert.equal((await stat(liveMadeJson.path)).isDirectory(), true)
ok('POST /mkdir over TCP → 真的建出目录 ' + liveMadeJson.name)

const liveTag = 'outside-live-' + Date.now()
const liveVictim = join(TMPBASE, liveTag, '2026-01-04-00-00-00')
await mkdir(liveVictim, { recursive: true })
const liveEvil = await fetch(liveBase + '/prune', {
  method: 'POST',
  headers: liveHead,
  body: JSON.stringify({ paths: [ROOT + '/../' + liveTag + '/2026-01-04-00-00-00'] }),
})
assert.equal(liveEvil.status, 200)
const liveEvilJson = await liveEvil.json()
assert.deepEqual(liveEvilJson.removed, [])
assert.equal(liveEvilJson.skipped[0].reason, 'outside-root')
assert.equal(await exists(liveVictim), true, 'TCP 这条路也删除不到 root 外面')
ok('POST /prune over TCP 收到 `..` → 只 skip，不删')

const livePrune = await fetch(liveBase + '/prune', {
  method: 'POST', headers: liveHead, body: JSON.stringify({ paths: [liveMadeJson.path] }),
})
assert.deepEqual((await livePrune.json()).removed, [liveMadeJson.path])
assert.equal(await exists(liveMadeJson.path), false)
ok('POST /prune over TCP → 点名的空目录真的删了')

await new Promise((resolve) => server.close(resolve))

// ---------------------------------------------------------------------------
// client 半区
// ---------------------------------------------------------------------------
console.log('client: 打桩跑完整条链')
let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
await import('./src/client.js')
assert.equal(loaded.id, 'dsh-new-workdir')

const stubReact = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }
const client = loaded.factory((name) => {
  if (name === 'react') return stubReact
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof client.apply, 'function')
assert.deepEqual(client.inject, ['slots'])
assert.equal(typeof client.createWorkdir, 'function')
assert.equal(typeof client.openOrCreateWorkdir, 'function')
assert.equal(typeof client.pruneCandidates, 'function')
assert.equal(typeof client.pruneEmptyWorkdirs, 'function')
ok('client 包壳：id/apply/inject 齐备')

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  const handler = routes[url]
  if (!handler) return { status: 404, async text() { return 'not found' } }
  const res = fakeRes()
  const headers = Object.assign({}, (init && init.headers) || {})
  const req = fakeReq((init && init.method) || 'GET', headers, init && init.body ? JSON.parse(init.body) : undefined)
  await handler.handler(req, res)
  return { status: res.out.status, async text() { return res.out.body } }
}
const mkdirCalls = () => calls.filter((c) => c.url === '/api/new-workdir/mkdir')

let opened
const wsCalls = []
const deletedIds = []
/**
 * 一整套桩服务 = 一个「页面」。同一个 ctx 反复 get 必须拿到同一个对象：插件就是拿
 * sessions 服务当锚点分页面状态的（另一个 ctx = 另一次页面会话，状态不许串）。
 * __setSnapshot 用来模拟 store 更新 —— 同一个页面，快照变了但页面状态不变。
 */
function makeCtx(overrides) {
  const snap = {
    items: (overrides && overrides.items) || [],
    blankRows: (overrides && overrides.blankRows) || {},
    archived: (overrides && overrides.archived) || [],
  }
  const services = {
    workspaces: {
      list: { getSnapshot: () => ({ items: snap.items, archivedSessionIds: snap.archived }) },
      async create(input) { wsCalls.push(input); return { workspaceId: 'ws-new', path: input.path } },
      async rename(id, title) { wsCalls.push({ rename: id, title }) },
      async delete(id) { deletedIds.push(id) },
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: Object.keys(snap.blankRows), byId: snap.blankRows }) },
      async create(opts) { wsCalls.push(opts); return 'sess-new' },
    },
    uiWorkspace: { openSession(id) { opened = id } },
  }
  return {
    __setSnapshot(next) {
      const n = next || {}
      snap.items = n.items || []
      snap.blankRows = n.blankRows || {}
      snap.archived = n.archived || []
    },
    get(name) { return services[name] },
  }
}

const bareCtx = makeCtx()
const out = await client.createWorkdir(bareCtx, 'e2e check')
assert.match(out.path, /-e2e-check$/)
assert.equal((await stat(out.path)).isDirectory(), true)
assert.equal(out.workspaceId, 'ws-new')
assert.equal(out.sessionId, 'sess-new')
assert.equal(opened, 'sess-new', 'openSession 应该被调用')
assert.equal(calls[0].url, '/api/new-workdir/mkdir')
assert.equal(calls[0].init.headers['x-dsh-plugin'], 'new-workdir')
ok('createWorkdir: mkdir → workspaces.create → sessions.create → openSession')

console.log('client: 复用规则（只认「本次页面会话里刚建、还没聊过」的那一个）')
assert.equal(mkdirCalls().length, 1, '前置条件：到这里只建过 1 个目录')

// createWorkdir 刚跑完 → lastClaim 就是它；快照把这个工作区/会话原样报回来 = 能复用
const blankPath = out.path
const reuseCtx = bareCtx
reuseCtx.__setSnapshot({
  items: [{ workspaceId: 'ws-new', path: blankPath, sessionIds: ['sess-new'] }],
  blankRows: { 'sess-new': { id: 'sess-new', blank: true, cwd: blankPath, retainedBy: { mainView: 1 } } },
})
opened = undefined
let res = await client.openOrCreateWorkdir(reuseCtx, '', false)
assert.equal(res.reused, true)
assert.equal(res.sessionId, 'sess-new')
assert.equal(res.path, blankPath)
assert.equal(opened, 'sess-new')
assert.equal(mkdirCalls().length, 1, '复用时不建目录')
ok('刚建的空目录还是空的 → 切回去，不建目录（连点只多一个目录）')

// 另一个页面（另一套服务）有自己的状态：不许把上一个页面的 lastClaim 拿过来复用
const otherPage = makeCtx({
  items: [{ workspaceId: 'ws-new', path: blankPath, sessionIds: ['sess-new'] }],
  blankRows: { 'sess-new': { id: 'sess-new', blank: true, cwd: blankPath, retainedBy: { mainView: 1 } } },
})
assert.equal(client.findReusableBlank(otherPage, [ROOT]), undefined, '别的页面没有 lastClaim，不许复用')
assert.equal(client._pendingCount(otherPage), 0)
ok('页面之间状态隔离：另一个 ctx 不会复用本页刚领的目录')

// 回归：root 下另一个工作区里挂着一个「别人的」旧空会话 —— 以前它会成为候选，把
// 用户从当前位置拽过去（点「新对话」却掉进几天前的旧工作区，一个目录都没建）。
const hijackCtx = bareCtx
hijackCtx.__setSnapshot({
  items: [
    { workspaceId: 'ws-old', path: join(ROOT, '2020-01-01-00-00-00'), sessionIds: ['sess-old-blank'] },
    { workspaceId: 'ws-new', path: blankPath, sessionIds: ['sess-used-up'] },
  ],
  blankRows: {
    'sess-old-blank': { id: 'sess-old-blank', blank: true, cwd: join(ROOT, '2020-01-01-00-00-00'), retainedBy: {} },
    'sess-used-up': { id: 'sess-used-up', blank: false, cwd: blankPath, retainedBy: {} },
  },
})
opened = undefined
res = await client.openOrCreateWorkdir(hijackCtx, '', false)
assert.equal(res.reused, false, '不能跳到旧工作区里那个空会话')
assert.equal(mkdirCalls().length, 2, '该新建就新建')
ok('root 下别人的旧空会话 → 绝不复用（就是今天这起事故）')

const archivedCtx = bareCtx
archivedCtx.__setSnapshot({
  items: [{ workspaceId: 'ws-new', path: res.path, sessionIds: ['sess-new'] }],
  blankRows: { 'sess-new': { id: 'sess-new', blank: true, cwd: res.path, retainedBy: {} } },
  archived: ['sess-new'],
})
res = await client.openOrCreateWorkdir(archivedCtx, '', false)
assert.equal(res.reused, false)
assert.equal(mkdirCalls().length, 3, '刚建的那个被归档了 → 不复用')
ok('刚建的那个被归档了 → 不复用，照常新建')

const usedCtx = bareCtx
usedCtx.__setSnapshot({
  items: [{ workspaceId: 'ws-new', path: res.path, sessionIds: ['sess-new'] }],
  blankRows: { 'sess-new': { id: 'sess-new', blank: false, cwd: res.path, retainedBy: { mainView: 1 } } },
})
res = await client.openOrCreateWorkdir(usedCtx, '', false)
assert.equal(res.reused, false)
assert.equal(mkdirCalls().length, 4, '刚建的那个已经聊过了 → 不复用')
ok('刚建的那个已经聊过了 → 不复用（不会一直困在同一个目录）')

const foreignCtx = bareCtx
foreignCtx.__setSnapshot({
  items: [{ workspaceId: 'ws-new', path: 'D:/work-harness/我的笔记', sessionIds: ['sess-new'] }],
  blankRows: { 'sess-new': { id: 'sess-new', blank: true, cwd: 'D:/work-harness/我的笔记', retainedBy: {} } },
})
res = await client.openOrCreateWorkdir(foreignCtx, '', false)
assert.equal(res.reused, false)
assert.equal(mkdirCalls().length, 5)
ok('目录名不是我们的时间戳格式 → 不复用（安全网）')

opened = undefined
res = await client.openOrCreateWorkdir(reuseCtx, 'force-me', true)
assert.equal(res.reused, false)
assert.equal(mkdirCalls().length, 6)
ok('面板里填了名字 → 跳过复用，强制新建')

console.log('client: 清理规则')
const pShell = await host.claimDir(ROOT, 'cli-shell')
const pGhost = await host.claimDir(ROOT, 'cli-ghost')
const pruneCtx = makeCtx({
  items: [
    { workspaceId: 'ws-shell', path: pShell.path, sessionIds: [] },
    { workspaceId: 'ws-ghost', path: pGhost.path, sessionIds: ['s-ghost'] },
    { workspaceId: 'ws-empty', path: pA.path, sessionIds: ['s-empty'] },
    { workspaceId: 'ws-keep', path: pB.path, sessionIds: ['s-used'] },
    { workspaceId: 'ws-cur', path: pC.path, sessionIds: ['s-cur'] },
  ],
  blankRows: {
    // s-ghost 故意不入列表：还没落盘的空会话也应该能收
    's-empty': { id: 's-empty', blank: true, cwd: pA.path, retainedBy: {} },
    's-used': { id: 's-used', blank: false, cwd: pB.path, retainedBy: {} },
    's-cur': { id: 's-cur', blank: true, cwd: pC.path, retainedBy: { mainView: 1 } },
  },
})
const picked = client.pruneCandidates(pruneCtx, ROOT)
assert.deepEqual(picked.candidates.map((c) => c.workspaceId), ['ws-shell', 'ws-ghost', 'ws-empty'])
assert.deepEqual(picked.keep.slice().sort(), [pB.path, pC.path].sort())
ok('pruneCandidates：空壳会话 / 列表里查不到的空会话也能收；聊过的和当前的进 keep')

await mkdir(pA.path, { recursive: true })
const pruned = await client.pruneEmptyWorkdirs(pruneCtx, ROOT)
assert.ok(pruned.removed >= 5, '白名单 3 个 + 扫尾至少 2 个，实际 ' + pruned.removed)
const leftNames = (await host.scanDirs(ROOT, Infinity)).items.map((i) => host.baseName(i.path)).sort()
assert.deepEqual(leftNames, [host.baseName(pB.path), host.baseName(pC.path)].sort(), '剩下的一律是「有内容」或「正在用」')
assert.deepEqual(deletedIds, ['ws-shell', 'ws-ghost', 'ws-empty'])
assert.equal(await exists(pA.path), false, '空目录被删掉')
assert.equal(await exists(pShell.path), false, '空壳工作区的目录被删掉')
assert.equal(await exists(pGhost.path), false, '没落盘会话的目录被删掉')
assert.equal(await exists(pB.path), true, '有文件的目录还在')
assert.equal(await exists(pC.path), true, '当前会话的目录还在')
assert.equal(await exists(first.path), false, '扫尾把前面遗留的空目录也收了')
assert.equal(await exists(second.path), false, '扫尾把带标签的遗留空目录也收了')
assert.equal(await exists(join(ROOT, 'not-ours')), true, '不是我们命名的目录一律不动')
const pruneReq = calls.filter((c) => c.url === '/api/new-workdir/prune').pop()
const pruneBody = JSON.parse(pruneReq.init.body)
assert.deepEqual(pruneBody.paths, [pShell.path, pGhost.path, pA.path], '白名单只发我们点名的路径')
assert.equal(pruneBody.sweep, true, '带上扫尾开关')
assert.deepEqual(pruneBody.keep.slice().sort(), [pB.path, pC.path].sort(), 'keep 名单随请求一起交给 host')
ok('pruneEmptyWorkdirs：删目录 + 退工作区，且只发白名单路径')

console.log('client: 快照不可信 → 清理整体跳过（fail-closed）')
// 官方客户端服务形状变了（ctx.get 拿不到服务）：以前这里照样发
// { paths: [], keep: [], sweep: true } → host 把每个根下所有空的时间戳目录全收掉，
// 而且 path → workspace 对不上，一个工作区都退不掉（侧栏一排死行，还不会自愈）。
const degradedCtx = { get: () => undefined }
const degradedBefore = calls.length
const degraded = await client.pruneEmptyWorkdirs(degradedCtx, ROOT)
assert.equal(degraded.degraded, true, '要明确告诉调用方「这次整体跳过了」')
assert.equal(degraded.removed, 0)
assert.equal(calls.length, degradedBefore, '一个请求都不发 —— 尤其不能发 sweep')
ok('读不到工作区 / 会话快照 → 清理整体跳过，不发扫尾请求')

// 快照在、但还没 ready（phase !== 'ready'）同样跳过：这时候名单也不可信
const loadingBase = makeCtx()
const loadingCtx = {
  get(name) {
    if (name === 'workspaces') {
      return Object.assign({}, loadingBase.get(name), {
        list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], phase: 'loading' }) },
      })
    }
    return loadingBase.get(name)
  },
}
const loadingBefore = calls.length
const loading = await client.pruneEmptyWorkdirs(loadingCtx, ROOT)
assert.equal(loading.degraded, true)
assert.equal(calls.length, loadingBefore, 'phase 不是 ready 也不发请求')
ok('快照 phase 不是 ready → 同样一个请求都不发')
const pickedWhenDegraded = client.pruneCandidates(degradedCtx, ROOT)
assert.equal(pickedWhenDegraded.snapshotOk, false, '名单不可信要如实报出来')
assert.deepEqual(pickedWhenDegraded.candidates, [])
ok('pruneCandidates：快照不可信 → snapshotOk=false、候选为空')

console.log('client: 多根')
const multiRoots = [join(ROOT, 'multi-a'), join(ROOT, 'multi-b')]
await mkdir(join(multiRoots[0], '2026-02-01-00-00-00'), { recursive: true })
await mkdir(join(multiRoots[1], '2026-02-02-00-00-00'), { recursive: true })
const multiCtx = makeCtx({
  items: [
    { workspaceId: 'ws-ma', path: join(multiRoots[0], '2026-02-01-00-00-00'), sessionIds: [] },
    { workspaceId: 'ws-mb', path: join(multiRoots[1], '2026-02-02-00-00-00'), sessionIds: [] },
    { workspaceId: 'ws-mc', path: join('D:/elsewhere-smoke', '2026-02-03-00-00-00'), sessionIds: [] },
  ],
})
const pickedMulti = client.pruneCandidates(multiCtx, multiRoots)
assert.deepEqual(pickedMulti.candidates.map((c) => c.workspaceId).sort(), ['ws-ma', 'ws-mb'], '两个根下的都算候选；清单外的第三个根不算')
ok('pruneCandidates 收多根：清单外的根一律不算（哪怕目录名也是时间戳）')

// createWorkdir 会把 root 带进 /mkdir 请求体；清单外由 host 拒（不在这里删）
await assert.rejects(
  () => client.createWorkdir(makeCtx(), 'multi-label', 'D:/not-in-list-smoke'),
  /root 不在允许清单里/,
)
const lastMkdirBody = JSON.parse(calls.filter((c) => c.url === '/api/new-workdir/mkdir').pop().init.body)
assert.equal(lastMkdirBody.root, 'D:/not-in-list-smoke')
assert.equal(lastMkdirBody.name, 'multi-label')
ok('createWorkdir 把 root 带进 /mkdir body；不在清单里的根 → host 400 ROOT')

console.log('client: 接管官方「新建会话」（startSession）')
const bridgeOfficial = []
const bridgeOpened = []
const bridgeUi = {
  startSession(id) { bridgeOfficial.push(id) },
  openSession(id) { bridgeOpened.push(id) },
}
// 服务对象必须是稳定的：插件拿 sessions 服务当「页面」锚点分状态（单飞槽就在那里）
const bridgeServices = {
  workspaces: {
    list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
    async create(input) { return { workspaceId: 'ws-bridge', path: input.path } },
    async rename() {},
    async delete() {},
  },
  sessions: {
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
    async create() { return 'sess-bridge' },
  },
  uiWorkspace: bridgeUi,
}
const bridgeCtx = { get(name) { return bridgeServices[name] } }
const mkdirsBefore = mkdirCalls().length
assert.equal(client.installNewSessionBridge(bridgeCtx), true)
assert.equal(client.installNewSessionBridge(bridgeCtx), true, '重复装不会叠层')
bridgeUi.startSession('ws-explicit')
assert.deepEqual(bridgeOfficial, ['ws-explicit'], '带了工作区 id（工作区行的 ⊕）→ 原样交给官方')
assert.equal(mkdirCalls().length, mkdirsBefore, '官方那条路不建目录')
bridgeUi.startSession()
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(mkdirCalls().length, mkdirsBefore + 1, '不带 id（新对话 / ⌘N）→ 领一个新目录')
assert.deepEqual(bridgeOpened.slice(-1), ['sess-bridge'], '切到新目录里的新会话')
assert.deepEqual(bridgeOfficial, ['ws-explicit'], '接管那条路不会再去调官方实现')
ok('startSession 接管：不带工作区 id → 新目录；带 id → 官方不变')

console.log('client: 失败路径')
const noService = { get: () => undefined }
await assert.rejects(() => client.createWorkdir(noService, ''), /workspaces 服务/)
ok('缺少 workspaces 服务时抛错且提示目录位置')

const downFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
await assert.rejects(() => client.createWorkdir(noService, ''), /ECONNREFUSED/)
globalThis.fetch = downFetch
ok('host 不可达时 fail-soft 抛错（不静默）')

console.log('client: 会话创建失败 → 回滚空目录 + 留痕')
const brokenDeleted = []
const brokenCtx = {
  get(name) {
    if (name === 'workspaces') {
      return {
        list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
        async create(input) { return { workspaceId: 'ws-broken', path: input.path } },
        async delete(id) { brokenDeleted.push(id) },
      }
    }
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        async create() { throw new Error('sessions.create 挂了') },
      }
    }
    return undefined
  },
}
await assert.rejects(() => client.createWorkdir(brokenCtx, 'rollback'), /sessions\.create 挂了/)
assert.deepEqual(brokenDeleted, ['ws-broken'], '工作区退注册表（不留下死目录）')
const leftover = (await host.scanDirs(ROOT, Infinity)).items.filter((i) => i.name.endsWith('-rollback'))
assert.equal(leftover.length, 0, '刚建的空目录已经回滚掉')
assert.match(await readFile(join(LOG_HOME, 'logs', 'new-workdir.err.log'), 'utf8'), /会话创建失败（回滚空目录/)
ok('sessions.create 连续失败 → 退工作区 + 删目录 + 写 .err.log')

console.log('client: 连点（同一 tick 两下）只领一个目录')
const clickBefore = mkdirCalls().length
const clickCtx = makeCtx()
const [clickA, clickB] = await Promise.all([
  client.openOrCreateWorkdir(clickCtx, '', false),
  client.openOrCreateWorkdir(clickCtx, '', false),
])
assert.equal(mkdirCalls().length, clickBefore + 1, '两次并发调用只发一次 mkdir')
assert.equal(clickA.path, clickB.path, '两个调用拿到同一份结果')
ok('连点两下只领一个目录（单飞在 openOrCreateWorkdir 里）')

const bridgeBefore = mkdirCalls().length
bridgeUi.startSession()
bridgeUi.startSession()
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(mkdirCalls().length, bridgeBefore + 1, '官方「新会话」快速两下也只领一个目录')
ok('官方「新会话」连点：同样单飞，不堆目录')

console.log('client: 工作区退不掉 → 记账 + 下次清理自动补')
const pendDir = await host.claimDir(ROOT, 'pending')
const pendDeleted = []
let deleteBroken = true
const pendBase = makeCtx({
  items: [
    { workspaceId: 'ws-pend', path: pendDir.path, sessionIds: ['s-pend'] },
    { workspaceId: 'ws-cur2', path: pC.path, sessionIds: ['s-cur'] },
  ],
  blankRows: {
    's-pend': { id: 's-pend', blank: true, cwd: pendDir.path, retainedBy: {} },
    's-cur': { id: 's-cur', blank: true, cwd: pC.path, retainedBy: { mainView: 1 } },
  },
})
const pendGet = pendBase.get
pendBase.get = (name) => {
  const svc = pendGet(name)
  if (name !== 'workspaces') return svc
  return Object.assign({}, svc, {
    async delete(id) {
      if (deleteBroken) throw new Error('workspaces.delete 挂了')
      pendDeleted.push(id)
    },
  })
}
const firstPrune = await client.pruneEmptyWorkdirs(pendBase, ROOT)
assert.equal(firstPrune.unregisterFailed, 1, '退不掉的那次要被记下来')
assert.equal(firstPrune.pending, 1)
assert.equal(await exists(pendDir.path), false, '目录该删还是删了')
assert.equal(client._pendingCount(pendBase), 1, '欠账本里有 1 笔')
ok('workspaces.delete 三次都失败 → 记账、不静默（pending=1）')

deleteBroken = false
const secondPrune = await client.pruneEmptyWorkdirs(pendBase, ROOT)
assert.deepEqual(pendDeleted, ['ws-pend'], '下次清理先补欠账')
assert.equal(secondPrune.pending, 0)
assert.equal(client._pendingCount(pendBase), 0)
ok('下次点「清理空目录」自动补上（侧栏那行空壳自愈）')

console.log('client: UI 入口接线（slot 注册 + 按钮真的能走完整条流程）')

/** 够用的 React 打桩：state 跨渲染保留，effect 可选执行（面板里有 15s 定时器，绝不能执行）。 */
function makeReactStub(runEffects) {
  const state = []
  const ranEffects = []
  const pending = []
  let cursor = 0
  let effectCursor = 0
  return {
    createElement: (type, props, ...children) => {
      // 跟 React 一样：额外参数收进 props.children；本插件里的 Btn 就是这么把文字透出去的
      const merged = Object.assign({}, props || {})
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      const element = {
        type: type,
        props: merged,
        children: (merged.children === undefined || merged.children === null ? [] : [merged.children]).flat(),
      }
      // 函数组件就地展开（本插件里的 Btn / FolderPlusIcon 不带 hook，展开顺序无影响）
      if (typeof type === 'function') return type(merged)
      return element
    },
    useState(init) {
      const index = cursor
      cursor += 1
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect(fn) {
      const index = effectCursor
      effectCursor += 1
      if (!runEffects || ranEffects[index]) return
      ranEffects[index] = true
      pending.push(fn)
    },
    render(component) {
      cursor = 0
      effectCursor = 0
      pending.length = 0
      const element = component({})
      const runs = pending.slice()
      pending.length = 0
      for (const run of runs) run()
      return element
    },
  }
}

function collectText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  return collectText(node.children)
}

function findButtons(node, out) {
  const acc = out || []
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) findButtons(child, acc); return acc }
  if (node.type === 'button') acc.push(node)
  for (const child of node.children || []) findButtons(child, acc)
  return acc
}

const uiSlots = {}
const uiInjected = []
function makeUiCtx(services, slots) {
  return {
    slots: {
      inject(name, cb) { uiInjected.push(name); cb(); return () => {} },
      register(options, component) { slots[options.name] = { options: options, component: component }; return () => {} },
    },
    inject(deps) { uiInjected.push('inject:' + deps.join(',')) },
    effect(fn) { fn(); return () => {} },
    get(name) { return services.get(name) },
  }
}
function loadClient(react) {
  return loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
}

const chipReact = makeReactStub(true)
const uiServices = makeCtx()
loadClient(chipReact).apply(makeUiCtx(uiServices, uiSlots), {})
assert.ok(uiSlots['conversation.input.right'], '输入框右侧的 chip 注册上了')
assert.ok(uiSlots['settings.section'], '设置页卡片注册上了')
assert.deepEqual(uiInjected, ['inject:uiWorkspace', 'conversation.input.right', 'settings.section'])
ok('apply：两个入口都走 slots.inject，并向 uiWorkspace 请求注入（接管用）')

const chipBefore = mkdirCalls().length
const chipEl = chipReact.render(uiSlots['conversation.input.right'].component)
assert.equal(chipEl.type, 'button', 'chip 渲染出来是个 button')
assert.equal(chipEl.props.disabled, false)
opened = undefined
await chipEl.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(mkdirCalls().length, chipBefore + 1, '点一下 → 真的领了一个新目录')
assert.equal(opened, 'sess-new', '并且切到新会话')
ok('chip 点击 → mkdir → workspaces.create → sessions.create → openSession')

// enabled:false：按钮必须置灰写「已停用」，别让人点下去才撞 403
const offReact = makeReactStub(true)
const offSlots = {}
const offClient = loadClient(offReact)
offClient.apply(makeUiCtx(makeCtx(), offSlots), {})
const fetchForUi = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (url === '/api/new-workdir/state') {
    return { status: 200, async text() { return JSON.stringify({ ok: true, enabled: false, root: ROOT, count: 0, recent: [] }) } }
  }
  return fetchForUi(url, init)
}
offReact.render(offSlots['conversation.input.right'].component)
await new Promise((resolve) => setTimeout(resolve, 30))
const offEl = offReact.render(offSlots['conversation.input.right'].component)
globalThis.fetch = fetchForUi
assert.equal(offEl.props.disabled, true, 'enabled:false → 置灰')
const offLabel = (offEl.children || []).find((child) => child && child.type === 'span')
assert.equal(offLabel.children[0], '已停用')
ok('chip：enabled:false → 置灰显示「已停用」')

// 设置页卡片：还没读到 state 时也要渲染得出来（读不到就崩是最常见的 UI 事故）
const panelReact = makeReactStub(false)
const panelSlots = {}
loadClient(panelReact).apply(makeUiCtx(makeCtx(), panelSlots), {})
const panelEl = panelReact.render(panelSlots['settings.section'].component)
const panelText = collectText(panelEl)
assert.ok(panelText.includes('新目录会话 ・ 每个会话一个目录'), '卡片标题在')
const panelPrune = findButtons(panelEl).find((button) => collectText(button).includes('清理'))
assert.ok(panelPrune, '找到「清理空目录」按钮')
assert.equal(panelPrune.props.disabled, true, 'state 还没到 → 先置灰')
ok('settings.section 卡片：状态未就绪时渲染不崩、清理按钮先置灰')

console.log('host: /log 轮转与限流（放最后：限流窗口是进程级的）')
const bigLogPath = join(LOG_HOME, 'logs', 'new-workdir.log')
await writeFile(bigLogPath, 'x'.repeat(5 * 1024 * 1024 + 16), 'utf8')
const rotateRes = fakeRes()
await routes['/api/new-workdir/log'].handler(fakeReq('POST', HEAD, { level: 'info', message: 'after-rotate' }), rotateRes)
assert.equal(rotateRes.out.status, 200)
assert.equal(await exists(bigLogPath + '.1'), true, '老的挪成 .1')
const rotated = await readFile(bigLogPath, 'utf8')
assert.ok(rotated.includes('after-rotate'), '新文件里是这一次写入')
assert.ok(rotated.length < 1000, '新文件是全新的一行，不是接着 5 MB 长')
ok('日志轮转：单文件超过 5 MB → 先挪成 .1，只留一代')

let spamStatus = 0
for (let i = 0; i < 130; i += 1) {
  const spamRes = fakeRes()
  await routes['/api/new-workdir/log'].handler(fakeReq('POST', HEAD, { level: 'info', message: 'spam ' + i }), spamRes)
  spamStatus = spamRes.out.status
}
assert.equal(spamStatus, 200, '被限流也照常回 200，调用方不用关心')
const spamLines = (await readFile(bigLogPath, 'utf8')).split('\n').filter((line) => line.includes('spam ')).length
assert.ok(spamLines < 130, '不能 130 行全落盘，实际 ' + spamLines)
// 这个窗口前面已经用掉一些额度（其它用例的审计日志也算），所以不一定正好 120 行；
// 只要没少到把正常写入全掐掉（比如被改成 10 行/分钟）就算对。
assert.ok(spamLines >= 60, '也不该把正常写入全掐掉，实际 ' + spamLines)
ok('POST /log 连刷 130 行 → 只落 ' + spamLines + ' 行（每分钟 120 行上限）')

// ---------------------------------------------------------------------------
await rm(ROOT, { recursive: true, force: true })
await rm(OUTSIDE, { recursive: true, force: true })
await rm(LOG_HOME, { recursive: true, force: true })
await rm(SWEEP_ROOT, { recursive: true, force: true })
await rm(CROOT, { recursive: true, force: true })
await rm(R1, { recursive: true, force: true })
await rm(R2, { recursive: true, force: true })
await rm(TRAV, { recursive: true, force: true })
await rm(join(TMPBASE, httpTag), { recursive: true, force: true })
await rm(join(TMPBASE, liveTag), { recursive: true, force: true })
console.log('\n全部通过：' + passed + ' 项（临时目录已清理：' + ROOT + '）')
