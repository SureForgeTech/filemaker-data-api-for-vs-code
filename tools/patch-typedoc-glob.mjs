// TypeDoc 0.28.20 uses matchOne, removed by the patched minimatch 11 API.
// Refuse an unknown upstream file rather than applying a loose text patch.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

const root = realpathSync(new URL('..', import.meta.url));
const require = createRequire(new URL('../extension/package.json', import.meta.url));
const target = realpathSync(join(dirname(require.resolve('typedoc')), 'node-utils.js'));
if (!target.startsWith(root + sep) || !target.includes(sep + 'node_modules' + sep) || !lstatSync(target).isFile()) {
  throw new Error('Refusing to patch TypeDoc outside this project installation');
}
const originalHash = '44982772d80190c9065e29081826b9586c2f65ab71a8d4dd0bbfdeecfecd9ebc';
const patchedHash = 'd58f25b6974c17e28f55ae4a52afb91b6402ec7aa2aba2c773a664129e61e104';
const hash = text => createHash('sha256').update(text).digest('hex');
const source = readFileSync(target, 'utf8');
if (![originalHash, patchedHash].includes(hash(source))) throw new Error('Unknown TypeDoc source; review the compatibility patch before updating');
const typedocRequire = createRequire(require.resolve('typedoc'));
if (typedocRequire('minimatch/package.json').version !== '11.0.8') throw new Error('Unexpected TypeDoc matcher; regenerate the dependency lock before installing');
if (hash(source) !== patchedHash) {
  if (hash(source) !== originalHash) throw new Error('Unknown TypeDoc source; review the compatibility patch before updating');
  const before = `      return mini.set.some((row) => mini.matchOne(
        childPath,
        row,
        /* partial */
        true
      ));`;
  const patched = source
    .replace('const mini = new Minimatch2(pattern);', 'const mini = new Minimatch2(pattern);\n  const recurse = new Minimatch2(mini.pattern, { nonegate: true });')
    .replace(before, '      return recurse.match(childPath.join("/"), true);');
  if (hash(patched) !== patchedHash) throw new Error('TypeDoc compatibility patch did not produce the expected source');
  const temporary = `${target}.patch-${process.pid}`;
  try {
    writeFileSync(temporary, patched, { flag: 'wx', mode: lstatSync(target).mode & 0o777 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
console.log('TypeDoc glob traversal is compatible with minimatch 11');
