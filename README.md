# 杨大杰轻量级文件分发服务

轻量级 Node.js 文件分发与多媒体在线预览站，保留原有 UI 和本地 Node.js 运行方式，并增加 **腾讯云 COS 全量推送**

## 运行方式

### 1. 本地 Node.js 运行

```bash
pnpm i
pnpm start
```

默认访问：

```text
http://localhost:3000
```

Node.js 模式直接读取 `files/`，支持：

- 文件夹浏览
- 搜索
- 图片预览
- 视频播放
- 音频播放
- PDF / 文本预览
- 下载
- HTTP Range 大文件播放
- 中文文件名

### 2. 生成静态网站

```bash
pnpm run build
```

保持原有构建流程：`files/` 中的所有文件都会复制到 `dist/files/`，**没有程序设置的 25 MB 限制**。

例如 900 MB 视频：

```text
files/
└── 视频/
    └── 900MB.mp4
```

构建后：

```text
dist/
└── files/
    └── 视频/
        └── 900MB.mp4
```

因此 `dist` 本身就是完整的静态发布目录，可以交给 Nginx、IIS、COS、其他对象存储或静态网站服务器。

### 3. 使用 http-server 本地验证 dist

```bash
pnpm run build
pnpm dlx http-server dist
```

静态模式会读取 `dist/file-manifest.json`，不会请求 Node.js 的 `/api/list`。

## 腾讯云 COS：pnpm run deploy

`pnpm run deploy` 的逻辑非常简单：

```text
pnpm run deploy
      │
      ├── 1. 执行原来的 pnpm run build
      │
      ├── 2. 得到完整 dist/
      │      ├── index.html
      │      ├── app.js
      │      ├── style.css
      │      ├── file-manifest.json
      │      └── files/（包括 900MB/GB 视频）
      │
      └── 3. 将 dist/ 内所有文件全量上传到 COS
```

**COS 的唯一上传源就是 `dist/`。**

不会再单独从 `files/` 上传，也不会修改原来的 build 流程。

### 配置

PowerShell：

```powershell
$env:COS_SECRET_ID="你的SecretId"
$env:COS_SECRET_KEY="你的SecretKey"
$env:COS_BUCKET="example-1250000000"
$env:COS_REGION="ap-guangzhou"
$env:COS_PREFIX=""
$env:COS_DELETE_STALE="true"
$env:COS_CONCURRENCY="4"
```

然后：

```powershell
pnpm run deploy
```

### COS 中最终结构

如果 `COS_PREFIX` 留空：

```text
COS Bucket/
├── index.html
├── app.js
├── style.css
├── favicon.webp
├── file-manifest.json
├── build-report.json
└── files/
    ├── 视频/
    │   └── 900MB.mp4
    ├── 音源/
    │   └── 墨澜音乐源v2.2.js
    └── 软件/
        └── xxx.zip
```

如果设置：

```powershell
$env:COS_PREFIX="file-center"
```

则所有内容都会放到：

```text
COS Bucket/
└── file-center/
    ├── index.html
    ├── app.js
    └── files/
        └── ...
```

### 全量同步 / 删除旧文件

默认：

```text
COS_DELETE_STALE=true
```

表示 COS 中对应前缀的内容最终与 `dist/` 一致。

例如本地删除：

```text
files/视频/B.mp4
```

再次执行：

```powershell
pnpm run deploy
```

COS 中对应的 `files/视频/B.mp4` 也会被删除。

如果 COS 桶中还有其他业务文件，建议使用独立的 `COS_PREFIX`，例如：

```powershell
$env:COS_PREFIX="file-center"
```

这样清理只会作用于 `file-center/`。

如不希望删除 COS 旧对象：

```powershell
$env:COS_DELETE_STALE="false"
pnpm run deploy
```

## 大文件

程序自身不限制单文件大小。

`pnpm run build` 会直接复制文件，因此：

```text
900 MB MP4
2 GB ZIP
4 GB MKV
```

都可以进入 `dist/files/`，具体能否上传成功取决于 COS、网络、磁盘空间等外部条件。

COS 上传使用腾讯云 COS Node.js SDK 的 `uploadFile`，配置了分块阈值，因此大文件不会一次性读入 Node.js 内存。

## EdgeOne + COS

如果你后续使用 EdgeOne 加速 COS，推荐让 EdgeOne 的源站指向 COS。这样：

```text
用户
 ↓
EdgeOne
 ↓
COS
```

网站和视频等静态资源都可以从 COS 提供，不需要把 900 MB 视频放进 EdgeOne Pages/Makers 的构建产物限制里。

本项目**不包含 COS 更新后自动触发 EdgeOne 重建/刷新**逻辑。每次只需要：

```powershell
pnpm run deploy
```

即可把最新的完整 `dist/` 推送到 COS。

## 安全

不要把 `COS_SECRET_ID`、`COS_SECRET_KEY` 写入前端代码或提交到代码仓库。

建议使用权限尽可能小的 CAM 子账号/密钥，并只授权目标 COS 桶/目录需要的对象操作权限。
