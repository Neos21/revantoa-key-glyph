import fs from 'node:fs'
import path from 'node:path';

(() => {
  const buildClientDirectoryName = './build/client';
  
  // `build/client/assets/manifest-XXX.js` の内容を置換しつつコピー生成する
  const assetDirectoryName = path.join(buildClientDirectoryName, 'assets');
  const files = fs.readdirSync(assetDirectoryName);
  const manifestFileName = files.find(file => (/^manifest-.*\.js$/).test(file));
  if(manifestFileName == null) {
    console.error('Manifest File Not Found');
    return process.exit(1);
  }
  
  const beforeString = '/assets/manifest-';
  const afterString  = '/';
  
  const manifestFilePath = path.join(assetDirectoryName, manifestFileName);
  const manifestFile = fs.readFileSync(manifestFilePath, 'utf-8');
  const replacedManifestFile = manifestFile.replaceAll(beforeString, afterString);
  
  const afterManifestFileName = manifestFileName.match((/^manifest-(.*\.js)$/))![1];
  const afterManifestFilePath = path.join(buildClientDirectoryName, afterManifestFileName);
  console.log(afterManifestFileName, afterManifestFilePath);
  fs.writeFileSync(afterManifestFilePath, replacedManifestFile, 'utf-8');
  
  // 元ファイルをディレクトリごと消す
  fs.rmSync(assetDirectoryName, { recursive: true, force: true });
  
  // `index.html` 内にも記述があるので置換する
  const indexFilePath = path.join(buildClientDirectoryName, 'index.html');
  const indexFile = fs.readFileSync(indexFilePath, 'utf-8');
  const replacedIndexFile = indexFile
    .replaceAll(beforeString, afterString)
    .replaceAll('  ', '')  // ついでに余計な余白と改行を消す
    .replaceAll('\n', '');
  fs.writeFileSync(indexFilePath, replacedIndexFile, 'utf-8');
  
  console.log(`\`${manifestFilePath}\` Has Replaced. Check Using \`$ npm run preview-only\`.`);
})();
