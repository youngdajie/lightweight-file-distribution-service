require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const COS = require('cos-nodejs-sdk-v5');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const CONFIG_FILE = path.join(ROOT, 'file-center.config.json');

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function normalizePrefix(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function required(name, value) {
  if (!value) throw new Error(`缺少 COS 配置：${name}`);
}

const config = readConfig();
const cosConfig = config.cos || {};

const SecretId = process.env.COS_SECRET_ID || cosConfig.secretId;
const SecretKey = process.env.COS_SECRET_KEY || cosConfig.secretKey;
const Bucket = process.env.COS_BUCKET || cosConfig.bucket;
const Region = process.env.COS_REGION || cosConfig.region;
const Prefix = normalizePrefix(process.env.COS_PREFIX ?? cosConfig.prefix ?? '');
const DeleteStale = String(process.env.COS_DELETE_STALE ?? cosConfig.deleteStale ?? 'true') !== 'false';
const Concurrency = Math.max(1, Number(process.env.COS_CONCURRENCY || cosConfig.concurrency || 4));

required('COS_SECRET_ID', SecretId);
required('COS_SECRET_KEY', SecretKey);
required('COS_BUCKET', Bucket);
required('COS_REGION', Region);

function call(method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => err ? reject(err) : resolve(data));
  });
}

function allFiles(dir, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...allFiles(full, rel));
    else result.push({ full, rel: rel.replace(/\\/g, '/') });
  }
  return result;
}

function objectKey(rel) {
  return Prefix ? `${Prefix}/${rel}` : rel;
}

function cacheControl(rel) {
  const lower = rel.toLowerCase();
  // 这些文件描述当前版本，上传后不要让浏览器长期缓存旧版本。
  if (lower === 'index.html' || lower === 'file-manifest.json' || lower === 'build-report.json') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (lower.endsWith('.js') || lower.endsWith('.css') || lower.endsWith('.webp') || lower.endsWith('.svg')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

function contentDisposition(rel) {
  const lower = rel.toLowerCase();
  // 浏览器可直接播放/展示的媒体保持 inline，其他文件由浏览器自行决定。
  const inline = [
    '.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif',
    '.pdf', '.txt', '.md', '.json', '.xml', '.csv', '.log', '.js', '.ts', '.css', '.html'
  ];
  return inline.some(ext => lower.endsWith(ext)) ? 'inline' : undefined;
}

async function uploadOne(file) {
  const Key = objectKey(file.rel);
  const disposition = contentDisposition(file.rel);
  const headers = {
    'Content-Type': mime.lookup(file.full) || 'application/octet-stream',
    'Cache-Control': cacheControl(file.rel)
  };
  if (disposition) headers['Content-Disposition'] = disposition;

  await call('uploadFile', {
    Bucket,
    Region,
    Key,
    FilePath: file.full,
    // COS SDK 会根据文件大小自动选择普通上传或分块上传。
    // 900MB、GB 级视频无需读入 Node.js 内存。
    SliceSize: 10 * 1024 * 1024,
    Headers: headers
  });
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function listAllObjects() {
  const objects = [];
  let Marker = '';
  const PrefixForList = Prefix ? `${Prefix}/` : '';

  while (true) {
    const data = await call('getBucket', {
      Bucket,
      Region,
      Prefix: PrefixForList,
      Marker,
      MaxKeys: 1000
    });

    for (const item of data.Contents || []) objects.push(item.Key);
    if (!data.IsTruncated) break;

    Marker = data.NextMarker || (data.Contents?.length
      ? data.Contents[data.Contents.length - 1].Key
      : '');
    if (!Marker) break;
  }
  return objects;
}

async function deleteObjects(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await call('deleteMultipleObject', {
      Bucket,
      Region,
      Objects: chunk.map(Key => ({ Key }))
    });
    console.log(`  已删除旧对象 ${Math.min(i + chunk.length, keys.length)}/${keys.length}`);
  }
}

const cos = new COS({ SecretId, SecretKey });

async function main() {
  console.log('\n======================================');
  console.log(' COS 全量推送 dist');
  console.log('======================================');
  console.log(`Bucket: ${Bucket}`);
  console.log(`Region: ${Region}`);
  console.log(`Prefix: ${Prefix || '(根目录)'}`);
  console.log(`Concurrency: ${Concurrency}`);
  console.log('');

  // 保持原有部署流程：先完整执行 pnpm run build。
  // build 会把 files/（包括 900MB/GB 视频）完整复制到 dist/files/。
  const build = spawnSync(process.execPath, [path.join(ROOT, 'build.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status || 1);

  if (!fs.existsSync(DIST)) throw new Error('dist 不存在，构建失败。');

  // 唯一上传源：dist。
  // 不再单独上传 files/，因此 COS 上的内容与最终 dist 完全一致。
  const files = allFiles(DIST);
  console.log(`准备全量上传 dist：${files.length} 个文件`);

  let done = 0;
  await mapLimit(files, Concurrency, async file => {
    await uploadOne(file);
    done++;
    console.log(`  [${done}/${files.length}] ${file.rel}`);
  });

  if (DeleteStale) {
    const desired = new Set(files.map(file => objectKey(file.rel)));
    const existing = await listAllObjects();
    const stale = existing.filter(key => !desired.has(key));

    if (stale.length) {
      console.log(`\n发现 ${stale.length} 个 COS 旧对象，执行清理...`);
      await deleteObjects(stale);
    } else {
      console.log('\nCOS 中没有需要清理的旧对象。');
    }
  } else {
    console.log('\nCOS_DELETE_STALE=false：不删除 COS 中的旧对象。');
  }

  console.log('\n======================================');
  console.log(' COS 全量推送完成');
  console.log(` dist 文件数：${files.length}`);
  console.log(` COS 路径：${Prefix || '(根目录)'}`);
  console.log('======================================\n');
}

main().catch(err => {
  console.error('\nCOS 部署失败：');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
