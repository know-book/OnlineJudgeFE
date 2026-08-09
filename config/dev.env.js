let date = require('moment')().format('YYYYMMDD')
// Prefer FE_COMMIT when it is set. Building inside Docker there is no .git to
// read — as a submodule it is a gitlink file pointing outside the build context
// — and this execSync is fatal, not a fallback. Unset, behaviour is unchanged.
let commit = (process.env.FE_COMMIT || require('child_process').execSync('git rev-parse HEAD').toString()).slice(0, 5)
let version = `"${date}-${commit}"`

console.log(`current version is ${version}`)

module.exports = {
  NODE_ENV: '"development"',
  VERSION: version,
  USE_SENTRY: '0'
}
