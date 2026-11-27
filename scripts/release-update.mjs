#!/usr/bin/env node
/**
 * 生成在线升级所需的 latest.json（Tauri updater v1 格式）。
 *
 * 用法：先完成发布构建（安装包 + .sig 签名文件在 src-tauri/target/release/bundle/nsis/），
 * 然后运行：node scripts/release-update.mjs [版本号]
 *   版本号省略时从 src-tauri/tauri.conf.json 读取。
 *
 * 输出 build-release/latest.json + 上传步骤说明。
 * 发布流程：
 *   1. TAURI_SIGNING_PRIVATE_KEY="C:/Users/zmy/.tauri/memora-updater.key" pnpm tauri:build
 *      （私钥见 C:/Users/zmy/.tauri/memora-updater.key；丢失则无法再签发更新）
 *   2. node scripts/release-update.mjs
 *   3. 在 GitHub 仓库创建 Release（tag = v版本号），上传：
 *      - latest.json
 *      - NSIS 安装包 .exe
 *      - 对应的 .nsis.zip 与 .nsis.zip.sig（updater 实际下载的文件）
 *   4. latest.json 中的 url 必须指向 Release 资产的可下载地址；
 *      updater 端点配置为 https://github.com/<owner>/<repo>/releases/latest/download/latest.json
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf-8'))
const version = process.argv[2] ?? conf.version
const nsisDir = join(root, 'src-tauri/target/release/bundle/nsis')

if (!existsSync(nsisDir)) {
  console.error(`未找到构建产物目录：${nsisDir}\n请先运行 pnpm tauri:build`)
  process.exit(1)
}

// 产物：-x64-setup.exe（安装包）、.nsis.zip（updater 下载用）、.nsis.zip.sig（签名）
const files = readdirSync(nsisDir).filter((f) => statSync(join(nsisDir, f)).isFile())
const zip = files.find((f) => f.endsWith('.nsis.zip'))
const sig = files.find((f) => f.endsWith('.nsis.zip.sig'))
const setup = files.find((f) => f.endsWith('-setup.exe'))

if (!zip || !sig || !setup) {
  console.error('产物不完整，需要同时存在：\n  *-setup.exe\n  *.nsis.zip\n  *.nsis.zip.sig\n实际：', files)
  process.exit(1)
}

// v1.1.0 起版本号进入文件名；沿用产物名避免手工映射错误
const releaseBase = `https://github.com/OWNER/REPO/releases/download/v${version}`
const signature = readFileSync(join(nsisDir, sig), 'utf-8').trim()
const url = `${releaseBase}/${encodeURIComponent(zip)}`

const latest = {
  version,
  notes: `${conf.productName} v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url,
    },
  },
}

const outDir = join(root, 'build-release')
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n')

const sha256 = (f) =>
  createHash('sha256').update(readFileSync(join(nsisDir, f))).digest('hex')

console.log(`已生成 build-release/latest.json（v${version}）`)
console.log(`  安装包: ${setup}`)
console.log(`  更新包: ${zip}（updater 下载）`)
console.log(`  签 名: ${sig}`)
console.log(`  zip SHA256: ${sha256(zip)}`)
console.log(`  exe SHA256: ${sha256(setup)}`)
console.log('\n⚠️  latest.json 的 url 使用占位 OWNER/REPO，上传前请改成实际 GitHub 仓库地址。')
console.log('上传清单（GitHub Release tag=v' + version + '）：')
console.log(`  1. build-release/latest.json`)
console.log(`  2. ${join(nsisDir, zip)}`)
console.log(`  3. ${join(nsisDir, sig)}`)
console.log(`  4. ${join(nsisDir, setup)}（可选，供完整安装下载）`)
