const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BUILD_FORMAT = 1;

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`构建目录不能包含链接：${file}`);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

function inputFingerprint(frontendRoot) {
  const hash = createHash('sha256');
  hash.update(`scanner-build-${BUILD_FORMAT}:${process.versions.node}:${process.platform}:${process.arch}\0`);
  for (const key of Object.keys(process.env).filter(key => key.startsWith('VITE_')).sort()) {
    hash.update(`${key}\0${process.env[key]}\0`);
  }
  const rootInputs = fs.readdirSync(frontendRoot).filter(name =>
    /^(package(?:-lock)?\.json|index\.html|vite\.config\.[\w.]+|\.env(?:\..*)?)$/.test(name))
    .map(name => path.join(frontendRoot, name));
  const inputs = [...rootInputs, ...filesUnder(path.join(frontendRoot, 'src')), ...filesUnder(path.join(frontendRoot, 'public')),
    ...filesUnder(path.join(frontendRoot, 'config'))].sort();
  for (const file of inputs) {
    const content = fs.readFileSync(file);
    hash.update(path.relative(frontendRoot, file).split(path.sep).join('/') + '\0' + content.length + '\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

function artifactDigest(distRoot) {
  return filesUnder(distRoot).filter(file => !path.basename(file).startsWith('.scanner-build.json')).map(file => ({
    file: path.relative(distRoot, file).split(path.sep).join('/'),
    hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }));
}

function hasCachedBuild(frontendRoot, fingerprint) {
  try {
    const dist = path.join(frontendRoot, 'dist');
    const stamp = JSON.parse(fs.readFileSync(path.join(dist, '.scanner-build.json'), 'utf8'));
    return stamp.format === BUILD_FORMAT && stamp.inputHash === fingerprint &&
      fs.existsSync(path.join(dist, 'index.html')) &&
      JSON.stringify(stamp.artifacts) === JSON.stringify(artifactDigest(dist));
  } catch { return false; }
}

async function ensureFrontendBuild({ frontendRoot, build, onBuild = () => {} }) {
  const fingerprint = inputFingerprint(frontendRoot);
  if (hasCachedBuild(frontendRoot, fingerprint)) return { buildId: fingerprint, built: false };
  onBuild();
  await build();
  if (inputFingerprint(frontendRoot) !== fingerprint) throw new Error('构建期间前端文件发生变化，请重新启动。');
  const dist = path.join(frontendRoot, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('前端构建未生成页面。');
  const stamp = { format: BUILD_FORMAT, inputHash: fingerprint, artifacts: artifactDigest(dist) };
  const stampPath = path.join(dist, '.scanner-build.json');
  fs.writeFileSync(`${stampPath}.tmp`, JSON.stringify(stamp));
  fs.renameSync(`${stampPath}.tmp`, stampPath);
  return { buildId: fingerprint, built: true };
}

module.exports = { inputFingerprint, hasCachedBuild, ensureFrontendBuild };
