#!/usr/bin/env node
/**
 * 自动更新 Gitee tag=latest 滚动发行版的附件（配合 release-update.mjs 使用）。
 *
 * Gitee 端点是 updater 的优先端点，每次发版必须替换该发行版的三个附件，
 * 否则用户会拿到旧版本。本脚本把这件事自动化：
 *   1. 找到（或创建）tag=latest 的发行版
 *   2. 删除现有全部附件
 *   3. 上传 latest.json（由 build-release/latest-gitee.json 改名）+ 安装包 + 签名
 *   4. 回读校验文件名与大小
 *
 * 用法：node scripts/release-gitee.mjs [版本号]
 *   版本号省略时从 src-tauri/tauri.conf.json 读取（仅用于日志）。
 *   前置：已运行 pnpm tauri:build 与 node scripts/release-update.mjs。
 *
 * Token（需要 projects 权限的私人令牌）二选一：
 *   - 环境变量 GITEE_TOKEN
 *   - 文件 ~/.gitee/memora-token（第一行即 token）
 *
 * owner/repo 从 build-release/latest-gitee.json 的下载 url 解析，无需硬编码。
 */
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const API = 'https://gitee.com/api/v5'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf-8'))
const version = process.argv[2] ?? conf.version

const giteeManifest = JSON.parse(readFileSync(join(root, 'build-release/latest-gitee.json'), 'utf-8'))
const downloadUrl = giteeManifest.platforms?.['windows-x86_64']?.url
if (!downloadUrl?.includes('gitee.com')) {
  console.error('✗ latest-gitee.json 缺少 Gitee 下载地址，请先运行 node scripts/release-update.mjs')
  process.exit(1)
}
// .../repos/download/latest/文件名 → owner/repo
const urlParts = new URL(downloadUrl).pathname.split('/')
const repoIndex = urlParts.indexOf('releases')
const owner = urlParts[1]
const repo = urlParts[repoIndex - 1]
if (!owner || !repo) {
  console.error(`✗ 无法从 url 解析 owner/repo：${downloadUrl}`)
  process.exit(1)
}

/** token：环境变量优先，其次 ~/.gitee/memora-token */
function loadToken() {
  if (process.env.GITEE_TOKEN) return process.env.GITEE_TOKEN.trim()
  const tokenFile = join(homedir(), '.gitee', 'memora-token')
  try {
    const line = readFileSync(tokenFile, 'utf-8').split(/\r?\n/).find((l) => l.trim())
    if (line) return line.trim()
  } catch {
    // 文件不存在走错误提示
  }
  console.error(
    '✗ 缺少 Gitee 私人令牌。请到 Gitee → 设置 → 安全设置 → 私人令牌，\n' +
      '  勾选 projects 权限生成后，写入 ~/.gitee/memora-token（或设环境变量 GITEE_TOKEN）',
  )
  process.exit(1)
}

const token = loadToken()
const base = `${API}/repos/${owner}/${repo}`

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  if (!response.ok) {
    // Gitee 错误结构不固定（message/error/error_base 等字段），整体脱敏后展示
    const detail = JSON.stringify(data) ?? String(data)
    const safePath = path.replace(/access_token=[^&]+/g, 'access_token=***')
    throw new Error(`Gitee API ${response.status}（${safePath}）：${detail.slice(0, 300)}`)
  }
  return data
}

const nsisDir = join(root, 'src-tauri/target/release/bundle/nsis')
const setupName = `MEMORA_${version}_x64-setup.exe`
const assets = [
  { name: 'latest.json', path: join(root, 'build-release/latest-gitee.json') },
  { name: setupName, path: join(nsisDir, setupName) },
  { name: `${setupName}.sig`, path: join(nsisDir, `${setupName}.sig`) },
]

for (const asset of assets) {
  statSync(asset.path) // 缺文件直接抛错中止
}

console.log(`仓库：gitee.com/${owner}/${repo}，目标版本 v${version}`)

/** 找 tag=latest 的发行版，不存在则创建。
 * Gitee 语义：tag 无发行版时 GET 返回 200 + null（不是 404），两者都要走创建分支。 */
async function findOrCreateRelease() {
  let release = null
  try {
    release = await api('/releases/tags/latest?access_token=' + encodeURIComponent(token))
  } catch (error) {
    if (!String(error).includes('404')) throw error
  }
  if (release?.id) return release
  console.log('tag=latest 发行版不存在，创建中…')
  const created = await api(`/releases?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: 'latest',
      target_commitish: 'main',
      name: 'MEMORA 在线更新（滚动最新版）',
      body: 'updater Gitee 优先端点使用的滚动发行版，附件随每次发版替换。',
      prerelease: false,
    }),
  })
  if (!created?.id) {
    throw new Error(`创建发行版失败：${JSON.stringify(created).slice(0, 200)}`)
  }
  return created
}

const release = await findOrCreateRelease()
console.log(`发行版 id=${release.id}（tag_name=${release.tag_name}）`)

/** 删除现有全部附件 */
const existing = await api(`/releases/${release.id}/attach_files?access_token=${encodeURIComponent(token)}`)
for (const file of existing) {
  await api(`/releases/${release.id}/attach_files/${file.id}?access_token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
  })
  console.log(`已删除旧附件：${file.name}`)
}

/** 上传附件（Gitee 附件端点只接受 multipart file 字段）。
 * 必须用完整 Buffer 构造 Blob：流式 Blob 会被 undici 的 multipart 编码器
 * 字符串化成 "[object ReadableStream]"（23 字节坏文件），Gitee 元数据 size 也只有 23。 */
async function upload(asset) {
  const size = statSync(asset.path).size
  const form = new FormData()
  form.append('access_token', token)
  form.append('file', new Blob([readFileSync(asset.path)]), asset.name)
  const response = await fetch(`${base}/releases/${release.id}/attach_files`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) {
    throw new Error(`上传 ${asset.name} 失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  console.log(`已上传：${asset.name}（${size} 字节）`)
}

for (const asset of assets) {
  await upload(asset)
}

/** 回读校验：文件名与字节数都要匹配（Gitee attach_files 的 size 字段为真实记录大小） */
const verify = await api(`/releases/${release.id}/attach_files?access_token=${encodeURIComponent(token)}`)
const problems = assets
  .map((asset) => {
    const remote = verify.find((file) => file.name === asset.name)
    if (!remote) return `${asset.name}：附件缺失`
    const remoteSize = Number(remote.size ?? remote.file_size ?? NaN)
    if (remoteSize !== statSync(asset.path).size) {
      return `${asset.name}：Gitee 记录 ${remoteSize} 字节 ≠ 本地 ${statSync(asset.path).size} 字节（上传可能损坏）`
    }
    return null
  })
  .filter(Boolean)
if (problems.length > 0) {
  console.error('✗ 校验失败：\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log(`✓ 校验通过（文件名与字节数一致）：Gitee tag=latest 发行版附件已更新到 v${version}`)
console.log(`  端点：https://gitee.com/${owner}/${repo}/releases/download/latest/latest.json`)
