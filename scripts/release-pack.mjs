import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${pkg.version}`
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, tag, 'Tag must match package.json version')
}

const destination = '.artifacts/release'
rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
execFileSync('pnpm', ['pack', '--pack-destination', destination], { stdio: 'inherit' })

const filename = `${pkg.name}-${pkg.version}.tgz`
const tarball = join(destination, filename)
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
assert(!entries.some(entry => /^package\/(node_modules|src|tests|scripts|\.artifacts|\.github)\//u.test(entry)), 'Archive contains development files')

const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(packed.name, pkg.name)
assert.equal(packed.version, pkg.version)
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, version] of Object.entries(packed[section] ?? {})) {
    assert(!/^(file:|link:|workspace:)/u.test(version), `Nonportable dependency: ${name}`)
  }
}

const exportTargets = Object.values(packed.exports).flatMap(value =>
  typeof value === 'string' ? [value] : Object.values(value),
)
for (const target of [packed.main, packed.dsh.bundle.patch, ...exportTargets]) {
  assert(entries.includes(`package/${target.replace(/^\.\//u, '')}`), `Missing published entry: ${target}`)
}

const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(join(destination, 'SHA256SUMS'), `${digest}  ${filename}\n`)
writeFileSync(join(destination, 'release-notes.md'), [
  `Prebuilt ${pkg.name} ${pkg.version}.`,
  '',
  'Validated against DSH service packages 0.1.5-rc.2 and Cordis 4.0.2.',
  '',
  'Install with the user-level DSH CLI:',
  '',
  '```sh',
  `dsh plugin --profile web add https://github.com/TTTPOB/dsh-progressive-tools/releases/download/${tag}/${filename}`,
  'dsh --profile web --dump-config',
  '```',
  '',
  'Restart the Host after installation.',
  '',
].join('\n'))
console.log(`Verified ${tarball}: ${entries.length} entries, SHA-256 ${digest}`)
