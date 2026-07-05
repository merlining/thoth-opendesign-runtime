// Build a self-contained open-design runtime bundle for thoth 的浏览器功能库(「装入功能库」P2)。
//
// 病根:开发态 open-design 后端 = 姊妹 checkout 的软链,其原生依赖(better-sqlite3 等)ABI 随
// "谁 pnpm install 的、哪个 node" 漂移;打包后该 checkout 根本不在 → daemon 崩。本脚本把 daemon 连它的
// workspace + prod 依赖 + web 静态导出 + 一个匹配 ABI 的 relocatable node,固化成一个自足目录,thoth 解压到
// 沙盒即用,不再借外部 checkout。全流程已在 docs/plans/opendesign-builtin-install.md 逐步实证。
//
// 产物布局(**布局是承重的**:daemon 必须落在 <out>/apps/daemon,这样 open-design 的 project-root.js
// resolveProjectRoot(dist)=<out>,其 STATIC_DIR=<out>/apps/web/out 才解析得到、web 才 serve):
//   <out>/apps/daemon/   ← `pnpm --filter @open-design/daemon deploy --prod --legacy`(~150M;workspace 依赖
//                          摊平进 node_modules;含 better-sqlite3 + node-pty prebuilt 原生;不含 sharp=web-only)
//   <out>/apps/web/out/  ← Next 静态导出(~50M;纯静态,daemon 用 express.static 直供,无需 Next server 进程)
//   <out>/node/bin/node  ← nodejs.org 官方静态构建(relocatable;major 24 = 对齐原生 ABI 137)。
//                          ⚠ 别用 homebrew node:它动态链接 libnode.*.dylib,拷出来即 dyld 失败。
//   <out>/manifest.json  ← {version, platform, arch, node, builtAt}
//
// 前置:node 24 + corepack pnpm@10.33.2(open-design 仓 pin 这俩)+ 一个 open-design checkout(且其
// apps/web/out 已构建)。单次一个平台(CI matrix 每目标各跑一次,--platform/--arch 指定)。
// ponytail: 只实现 darwin/linux(node tar.gz);win32 抛错提示(升级路径 = 取 .zip 解 node.exe)。web 需预先
// 构建好(不在此自动 next build,那要整套 web 工具链);缺 apps/web/out 时报错give 命令。

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const NODE_VERSION = arg('node', 'v24.18.0')
const PNPM_VERSION = arg('pnpm', '10.33.2')
const PLATFORM = arg('platform', process.platform) // darwin | linux | win32
const ARCH = arg('arch', process.arch) // x64 | arm64
const OD_REPO = resolve(arg('repo', join(repoRoot, 'node_modules', 'open-design')))
const OUT = resolve(arg('out', join(repoRoot, 'dist-opendesign-runtime', `${PLATFORM}-${ARCH}`)))
// 官方 release 版本(如 0.13.0,CI 从 od_tag 传入)。空 → 回退 daemon package.json 版本。**用 release 版本更对**:
// monorepo 里 daemon 包版本(如 0.12.1)≠ 官方发布版本(0.13.0),用户认的是 release 版本,upstream 比对也据此。
const RELEASE_VERSION = arg('version', '')

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { stdio: 'inherit', ...opts })
}

// 前置校验:node 24 + open-design checkout(含已构建的 apps/web/out)。
function preflight() {
  const major = Number(process.versions.node.split('.')[0])
  if (major !== 24) {
    throw new Error(`本脚本须用 node 24 跑(open-design 仓 pin engines.node ~24);当前 ${process.version}。` +
      `装了官方 node24 后:PATH=/usr/local/bin:$PATH node tools/build-opendesign-runtime.mjs …`)
  }
  if (PLATFORM === 'win32') {
    throw new Error('win32 未实现(node 取 .zip 而非 tar.gz)。升级路径见文件头注。')
  }
  if (!existsSync(join(OD_REPO, 'apps', 'daemon', 'bin', 'od.mjs'))) {
    throw new Error(`open-design checkout 无效:${OD_REPO}(没有 apps/daemon/bin/od.mjs)。--repo 指定其路径。`)
  }
  const webOut = join(OD_REPO, 'apps', 'web', 'out')
  if (!existsSync(webOut)) {
    throw new Error(`缺 web 静态导出:${webOut}。先在 open-design 仓构建 web(pnpm --filter @open-design/web build)。`)
  }
}

// ① daemon 自足包:pnpm deploy 把 @open-design/* workspace 依赖 + prod npm 依赖摊平进 <out>/apps/daemon。
function deployDaemon() {
  const dest = join(OUT, 'apps', 'daemon')
  rmSync(dest, { recursive: true, force: true })
  run('corepack', [`pnpm@${PNPM_VERSION}`, '--filter', '@open-design/daemon', 'deploy', '--prod', '--legacy', dest], {
    cwd: OD_REPO,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  })
}

// ② web 静态导出:拷贝到 <out>/apps/web/out(布局承重,见头注)。
function copyWeb() {
  const dest = join(OUT, 'apps', 'web', 'out')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(OD_REPO, 'apps', 'web', 'out'), dest, { recursive: true })
}

// ③ relocatable 官方 node:下载 tar.gz、解出 bin/node 到 <out>/node/bin/node。
function embedNode() {
  const narch = ARCH === 'arm64' ? 'arm64' : 'x64'
  const name = `node-${NODE_VERSION}-${PLATFORM}-${narch}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz`
  const work = join(tmpdir(), `od-node-${PLATFORM}-${narch}-${NODE_VERSION}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const tgz = join(work, 'node.tar.gz')
  run('curl', ['-fsSL', '-o', tgz, url])
  run('tar', ['-xzf', tgz, '-C', work, '--strip-components=1'])
  const src = join(work, 'bin', 'node')
  if (!existsSync(src)) throw new Error(`node tar 无 bin/node:${url}`)
  const binDir = join(OUT, 'node', 'bin')
  mkdirSync(binDir, { recursive: true })
  cpSync(src, join(binDir, 'node'))
  rmSync(work, { recursive: true, force: true })
}

// ④ manifest:版本比对(P3 升级)+ 平台标识。daemon 版本从其 package.json 读。
function writeManifest() {
  const pkg = JSON.parse(readFileSync(join(OUT, 'apps', 'daemon', 'package.json'), 'utf8'))
  const manifest = {
    version: RELEASE_VERSION || pkg.version, // 官方 release 版本优先(CI 传);缺 → daemon 包版本。对齐 checkUpdate tag 比对
    platform: PLATFORM,
    arch: ARCH,
    node: NODE_VERSION,
    builtAt: new Date().toISOString()
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

preflight()
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
console.log(`[build-od-runtime] repo=${OD_REPO}`)
console.log(`[build-od-runtime] out=${OUT}  target=${PLATFORM}-${ARCH}  node=${NODE_VERSION}  pnpm=${PNPM_VERSION}`)
deployDaemon()
copyWeb()
embedNode()
const m = writeManifest()
console.log(`[build-od-runtime] DONE  ${JSON.stringify(m)}`)
console.log(`[build-od-runtime] 验证: OD_DATA_DIR=/tmp/od-verify NODE_ENV=production \\`)
console.log(`  ${join(OUT, 'node', 'bin', 'node')} ${join(OUT, 'apps', 'daemon', 'bin', 'od.mjs')} \\`)
console.log('  daemon start --serve-web --no-open --host 127.0.0.1 --port 7456   # → /api/health {ok}, GET / 200')
