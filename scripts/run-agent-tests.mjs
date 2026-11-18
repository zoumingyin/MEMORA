#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Agent 工具测试运行器：不新增依赖。
 * 1. 用 tsconfig.test.json 把 tests + 被测源码编译到 .test-build（CommonJS）；
 * 2. 写入 {"type":"commonjs"}，绕开根 package.json 的 "type": "module"；
 * 3. node --test 执行编译产物。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const buildDir = join(root, '.test-build')

rmSync(buildDir, { recursive: true, force: true })

const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.test.json'],
  { cwd: root, stdio: 'inherit' },
)
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

mkdirSync(buildDir, { recursive: true })
writeFileSync(join(buildDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

const testDir = join(buildDir, 'tests')
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => join(testDir, name))
const tests = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(tests.status ?? 1)
