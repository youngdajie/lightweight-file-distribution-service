const express = require("express");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// 默认文件目录：项目根目录/files
const FILE_ROOT = path.resolve(process.env.FILE_ROOT || path.join(__dirname, "files"));

if (!fs.existsSync(FILE_ROOT)) {
  fs.mkdirSync(FILE_ROOT, { recursive: true });
}

app.disable("x-powered-by");

function safeResolve(relativePath = "") {
  const decoded = decodeURIComponent(relativePath);
  const target = path.resolve(FILE_ROOT, decoded);
  if (target !== FILE_ROOT && !target.startsWith(FILE_ROOT + path.sep)) {
    const err = new Error("非法路径");
    err.status = 400;
    throw err;
  }
  return target;
}

function getType(name, isDirectory) {
  if (isDirectory) return "directory";

  const ext = path.extname(name).toLowerCase();
  const video = [".mp4", ".webm", ".ogg", ".ogv", ".mov", ".m4v", ".mkv", ".avi", ".wmv", ".flv"];
  const audio = [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".oga", ".wma"];
  const image = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif"];
  const text = [".txt", ".md", ".json", ".xml", ".csv", ".log", ".ini", ".yaml", ".yml", ".js", ".ts", ".css", ".html"];
  const document = [".pdf"];

  if (video.includes(ext)) return "video";
  if (audio.includes(ext)) return "audio";
  if (image.includes(ext)) return "image";
  if (text.includes(ext)) return "text";
  if (document.includes(ext)) return "pdf";
  return "file";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[i]}`;
}

function makeItem(name, stat, relativePath) {
  const type = getType(name, stat.isDirectory());
  return {
    name,
    path: relativePath.replace(/\\/g, "/"),
    type,
    size: stat.isDirectory() ? 0 : stat.size,
    sizeText: stat.isDirectory() ? "" : formatSize(stat.size),
    mtime: stat.mtime.toISOString(),
    extension: stat.isDirectory() ? "" : path.extname(name).toLowerCase()
  };
}

// 目录列表 API
app.get("/api/list", (req, res) => {
  try {
    const requested = String(req.query.path || "");
    const dir = safeResolve(requested);

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(404).json({ error: "目录不存在" });
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      const relative = path.relative(FILE_ROOT, full);
      items.push(makeItem(entry.name, stat, relative));
    }

    items.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
    });

    const parent = requested
      ? path.dirname(requested.replace(/\\/g, "/")).replace(/^\.\/?$/, "")
      : null;

    res.json({
      root: FILE_ROOT,
      path: requested.replace(/\\/g, "/"),
      parent,
      items
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "读取失败" });
  }
});

// 全局搜索
app.get("/api/search", (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q) return res.json({ items: [] });

    const results = [];
    const maxResults = 300;

    function walk(dir) {
      if (results.length >= maxResults) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const full = path.join(dir, entry.name);
        const relative = path.relative(FILE_ROOT, full).replace(/\\/g, "/");
        const stat = fs.statSync(full);

        if (entry.name.toLowerCase().includes(q)) {
          results.push(makeItem(entry.name, stat, relative));
        }
        if (entry.isDirectory()) walk(full);
      }
    }

    walk(FILE_ROOT);
    res.json({ items: results, truncated: results.length >= maxResults });
  } catch (err) {
    res.status(500).json({ error: "搜索失败" });
  }
});

// 静态兼容路径：前端在 build 后统一使用 /files/xxx
// Node.js 模式下也提供 /files/xxx，并保留 /file/xxx 兼容旧链接。
app.get("/files/*splat", (req, res) => {
  try {
    const requested = Array.isArray(req.params.splat)
      ? req.params.splat.join("/")
      : req.params.splat || "";
    const file = safeResolve(requested);
    if (!fs.existsSync(file)) return res.status(404).send("文件不存在");
    const stat = fs.statSync(file);
    if (!stat.isFile()) return res.status(400).send("这不是文件");

    const size = stat.size;
    const contentType = mime.lookup(file) || "application/octet-stream";
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (!range) {
      res.setHeader("Content-Length", size);
      return fs.createReadStream(file).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).set("Content-Range", `bytes */${size}`).end();
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  } catch (err) {
    res.status(err.status || 500).send(err.message || "文件读取失败");
  }
});

// 文件下载 / 在线预览，支持 HTTP Range
app.get("/file/*splat", (req, res) => {
  try {
    const requested = Array.isArray(req.params.splat)
      ? req.params.splat.join("/")
      : req.params.splat || "";

    const file = safeResolve(requested);
    if (!fs.existsSync(file)) return res.status(404).send("文件不存在");

    const stat = fs.statSync(file);
    if (!stat.isFile()) return res.status(400).send("这不是文件");

    const size = stat.size;
    const contentType = mime.lookup(file) || "application/octet-stream";
    const range = req.headers.range;

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (!range) {
      res.setHeader("Content-Length", size);
      return fs.createReadStream(file).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).set("Content-Range", `bytes */${size}`).end();

    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[2] ? Number(match[2]) : size - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    }

    end = Math.min(end, size - 1);

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);

    fs.createReadStream(file, { start, end }).pipe(res);
  } catch (err) {
    res.status(err.status || 500).send(err.message || "文件读取失败");
  }
});

// 下载接口，强制下载
app.get("/download/*splat", (req, res) => {
  try {
    const requested = Array.isArray(req.params.splat)
      ? req.params.splat.join("/")
      : req.params.splat || "";
    const file = safeResolve(requested);

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).send("文件不存在");
    }

    res.download(file, path.basename(file));
  } catch (err) {
    res.status(err.status || 500).send(err.message || "下载失败");
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

app.listen(PORT, HOST, () => {
  console.log("======================================");
  console.log(" 杨大杰轻量级文件分发服务 ");
  console.log(` Web: http://localhost:${PORT}`);
  console.log(` Files: ${FILE_ROOT}`);
  console.log("======================================");
});
