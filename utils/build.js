const path = require('path');
const es = require('esbuild');
const fs = require('fs');
const less = require('less');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(projectRoot, 'dist');

const DIST_FILES = [
  'index.html',
  'app.html',
  'conversion-table.html',
  'privacy-policy.html',
  'sitemap.xml',
  'main.js',
  'main.min.js',
];

const DIST_DIRECTORIES = [
  'assets',
  'images',
  'styles',
  'third-party',
];

async function compileLess() {
  const sourcePath = path.resolve(projectRoot, 'styles/main.less');
  const outputPath = path.resolve(projectRoot, 'styles/main.css');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = await less.render(source, {
    filename: sourcePath,
    paths: [path.dirname(sourcePath)],
    javascriptEnabled: true,
  });

  fs.writeFileSync(outputPath, result.css);
}

function copyDirectory(sourcePath, targetPath) {
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function copyFileIfExists(sourcePath, targetPath) {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function copyDirectoryIfExists(sourcePath, targetPath) {
  if (fs.existsSync(sourcePath)) {
    copyDirectory(sourcePath, targetPath);
  }
}

function prepareDist() {
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(distRoot, { recursive: true });

  DIST_FILES.forEach((fileName) => {
    copyFileIfExists(
      path.resolve(projectRoot, fileName),
      path.resolve(distRoot, fileName)
    );
  });

  DIST_DIRECTORIES.forEach((directoryName) => {
    copyDirectoryIfExists(
      path.resolve(projectRoot, directoryName),
      path.resolve(distRoot, directoryName)
    );
  });

  fs.writeFileSync(path.resolve(distRoot, '.nojekyll'), '');
}

async function build() {
  await compileLess();

  es.buildSync({
    entryPoints: [path.resolve(projectRoot, 'src/index.js')],
    bundle: true,
    outfile: path.resolve(projectRoot, 'main.js')
  });

  es.buildSync({
    entryPoints: [path.resolve(projectRoot, 'src/index.js')],
    bundle: true,
    minify: true,
    outfile: path.resolve(projectRoot, 'main.min.js')
  });

  prepareDist();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});