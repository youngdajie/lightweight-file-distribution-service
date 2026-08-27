const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const FILES = path.join(ROOT, "files");
const DIST = path.join(ROOT, "dist");
const CONFIG_FILE = path.join(ROOT, "file-center.config.json");

let config = {};
if (fs.existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) { console.warn("Warning: file-center.config.json 读取失败，将使用默认配置。"); }
}

const FILE_BASE_URL = String(process.env.FILE_BASE_URL ?? config.fileBaseUrl ?? "").replace(/\/$/, "");
const MANIFEST_URL = String(process.env.MANIFEST_URL ?? "").replace(/\/$/, "");

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

const video = new Set([".mp4", ".webm", ".ogg", ".ogv", ".mov", ".m4v", ".mkv", ".avi", ".wmv", ".flv"]);
const audio = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".oga", ".wma"]);
const image = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif"]);
const text = new Set([".txt", ".md", ".json", ".xml", ".csv", ".log", ".ini", ".yaml", ".yml", ".js", ".ts", ".css", ".html"]);

function getType(name, directory) {
  if (directory) return "directory";
  const ext = path.extname(name).toLowerCase();
  if (video.has(ext)) return "video";
  if (audio.has(ext)) return "audio";
  if (image.has(ext)) return "image";
  if (text.has(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  return "file";
}

function walkFiles(dir, relative = "", items = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
    const stat = fs.statSync(full);
    const item = {
      name: entry.name,
      path: rel,
      type: getType(entry.name, entry.isDirectory()),
      size: entry.isDirectory() ? 0 : stat.size,
      sizeText: entry.isDirectory() ? "" : formatSize(stat.size),
      mtime: stat.mtime.toISOString(),
      extension: entry.isDirectory() ? "" : path.extname(entry.name).toLowerCase()
    };
    items.push(item);
    if (entry.isDirectory()) walkFiles(full, rel, items);
  }
  return items;
}

cleanDir(DIST);
copyDir(PUBLIC, DIST);

// 标记 dist 为纯静态运行模式。
// 这样前端不会尝试请求 /api/list，避免使用 http-server、Nginx、Pages 等静态服务器时出现 404。
const distIndex = path.join(DIST, "index.html");
if (fs.existsSync(distIndex)) {
  let html = fs.readFileSync(distIndex, "utf8");
  if (/<html\b[^>]*>/i.test(html)) {
    html = html.replace(/<html\b([^>]*)>/i, (m, attrs) => {
      const cleaned = attrs.replace(/\sdata-mode=(?:"[^"]*"|'[^']*')/i, "");
      return `<html${cleaned} data-mode="static">`;
    });
  }
  if (MANIFEST_URL) {
    const manifestUrl = `${MANIFEST_URL}/file-manifest.json`;
    const meta = `<meta name="file-manifest-url" content="${manifestUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
    html = html.replace(/<head>/i, `<head>${meta}`);
  }
  fs.writeFileSync(distIndex, html, "utf8");
}

const COPY_FILES_TO_DIST = String(process.env.COPY_FILES_TO_DIST ?? "true") !== "false";
const distFiles = path.join(DIST, "files");
if (COPY_FILES_TO_DIST) fs.mkdirSync(distFiles, { recursive: true });

const manifest = {
  version: 2,
  generatedAt: new Date().toISOString(),
  fileBaseUrl: FILE_BASE_URL,
  items: []
};

if (fs.existsSync(FILES)) {
  manifest.items = walkFiles(FILES);

  // 默认把 files/ 原样复制到 dist/files/。
  // deploy 模式会设置 COPY_FILES_TO_DIST=false，避免大文件在本地重复复制，直接由 deploy.js 上传 files/。
  if (COPY_FILES_TO_DIST) {
    for (const item of manifest.items) {
      if (item.type === "directory") continue;
      const target = path.join(distFiles, ...item.path.split("/"));
      const source = path.join(FILES, ...item.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

fs.writeFileSync(
  path.join(DIST, "file-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

const report = {
  copiedFiles: manifest.items.filter(x => x.type !== "directory").length,
  copiedBytes: manifest.items.filter(x => x.type !== "directory").reduce((n, x) => n + x.size, 0),
  copiedSizeText: formatSize(manifest.items.filter(x => x.type !== "directory").reduce((n, x) => n + x.size, 0)),
  fileBaseUrl: FILE_BASE_URL,
  copyFilesToDist: COPY_FILES_TO_DIST,
  note: "本程序不人为限制单文件大小；deploy 模式可直接将 files/ 全量同步到 COS。"
};

fs.writeFileSync(
  path.join(DIST, "build-report.json"),
  JSON.stringify(report, null, 2),
  "utf8"
);

console.log("\nNode File Center build complete.");
console.log(`Output: ${DIST}`);
console.log(`Files copied: ${report.copiedFiles}`);
console.log(`Total size: ${report.copiedSizeText}`);
if (FILE_BASE_URL) console.log(`External file base URL: ${FILE_BASE_URL}`);
