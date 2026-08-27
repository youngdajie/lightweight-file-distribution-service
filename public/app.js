const state = {
  path: "",
  searchTimer: null,
  manifest: null,
  // 构建后的 dist/index.html 会写入 data-mode="static"。
  // Node.js 开发服务器则保持 data-mode="node"。
  mode: document.documentElement.dataset.mode === "static" ? "static" : "node"
};
const $ = (s) => document.querySelector(s);
const fileGrid = $("#fileGrid");
const loading = $("#loading");
const empty = $("#empty");
const breadcrumb = $("#breadcrumb");
const count = $("#count");
const search = $("#search");
const searchPanel = $("#searchPanel");
const searchResults = $("#searchResults");
const viewer = $("#viewer");
const viewerBody = $("#viewerBody");
const viewerTitle = $("#viewerTitle");
const viewerDownload = $("#viewerDownload");
const viewerOpen = $("#viewerOpen");

const icons = { directory:"📁", video:"🎬", audio:"🎵", image:"🖼️", pdf:"📕", text:"📄", file:"📦" };
function escapeHtml(str) { return str.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function encodedPath(p) { return p.split("/").map(encodeURIComponent).join("/"); }
function fileUrl(item) {
  const base = state.manifest?.fileBaseUrl || "";
  return base ? `${base}/${encodedPath(item.path)}` : `/files/${encodedPath(item.path)}`;
}
function downloadUrl(item) { return fileUrl(item); }

function renderBreadcrumb(currentPath) {
  breadcrumb.innerHTML = "";
  const parts = currentPath ? currentPath.split("/") : [];
  const root = document.createElement("button");
  root.className = "crumb" + (!currentPath ? " active" : "");
  root.textContent = "首页"; root.onclick = () => (async () => {
  try {
    await detectMode();
    await loadDirectory("");
  } catch (e) {
    loading.textContent = "初始化失败：" + e.message;
  }
})(); breadcrumb.appendChild(root);
  let acc = "";
  parts.forEach((part, i) => {
    const sep = document.createElement("span"); sep.textContent = " / "; sep.style.color = "var(--muted)"; breadcrumb.appendChild(sep);
    acc += (acc ? "/" : "") + part;
    const btn = document.createElement("button"); btn.className = "crumb" + (i === parts.length - 1 ? " active" : ""); btn.textContent = part;
    const target = acc; btn.onclick = () => loadDirectory(target); breadcrumb.appendChild(btn);
  });
}

function renderItems(items, target) {
  target.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "file-card " + (item.type === "directory" ? "directory" : "");
    card.innerHTML = `<div class="file-type">${escapeHtml(item.extension || item.type)}</div><div class="file-icon-wrap"><div class="file-icon">${icons[item.type] || icons.file}</div></div><div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div><div class="file-meta">${item.type === "directory" ? "文件夹" : item.sizeText} · ${new Date(item.mtime).toLocaleDateString()}</div>`;
    card.onclick = () => item.type === "directory" ? loadDirectory(item.path) : openViewer(item);
    target.appendChild(card);
  }
}

function localItems(dir) {
  const prefix = dir ? dir + "/" : "";
  const map = new Map();
  for (const item of state.manifest.items) {
    if (!item.path.startsWith(prefix)) continue;
    const rest = item.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) map.set(rest, item);
    else {
      const name = rest.slice(0, slash);
      if (!map.has(name)) map.set(name, {name, path: prefix + name, type:"directory", size:0, sizeText:"", mtime:item.mtime, extension:""});
    }
  }
  return [...map.values()].sort((a,b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, "zh-CN", {numeric:true, sensitivity:"base"});
  });
}

async function loadManifest() {
  const configured = document.querySelector('meta[name="file-manifest-url"]')?.content;
  const url = configured || "/file-manifest.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("找不到 file-manifest.json");
  state.manifest = await res.json();
}

async function detectMode() {
  // 不再通过“请求 API 看看是否存在”的方式判断运行模式。
  // 静态 dist 明确标记为 static，Node 开发服务器明确标记为 node。
  // 因此 http-server / Nginx / Pages 下不会再产生 /api/list 的 404。
  if (state.mode === "static") {
    await loadManifest();
  }
}

async function loadDirectory(p) {
  state.path = p;
  search.value = "";
  searchPanel.classList.add("hidden");
  $("#content").classList.remove("hidden");
  loading.classList.remove("hidden");
  fileGrid.innerHTML = "";
  empty.classList.add("hidden");

  try {
    let items;

    if (state.mode === "static") {
      items = localItems(p);
    } else {
      const res = await fetch("/api/list?path=" + encodeURIComponent(p));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取失败");
      items = data.items;
    }

    loading.classList.add("hidden");
    renderBreadcrumb(p);
    count.textContent = `${items.length} 项`;
    if (!items.length) empty.classList.remove("hidden");
    else renderItems(items, fileGrid);
  } catch (e) {
    loading.textContent = "读取失败：" + e.message;
  }
}

function openViewer(item) {
  const url = fileUrl(item); viewerTitle.textContent = item.name; viewerDownload.href = downloadUrl(item); viewerOpen.href = url; viewerBody.innerHTML = "";
  if (item.type === "video") { const v=document.createElement("video"); v.controls=true; v.autoplay=true; v.preload="metadata"; v.src=url; viewerBody.appendChild(v); }
  else if (item.type === "audio") { const a=document.createElement("audio"); a.controls=true; a.autoplay=true; a.src=url; viewerBody.appendChild(a); }
  else if (item.type === "image") { const img=document.createElement("img"); img.src=url; img.alt=item.name; viewerBody.appendChild(img); }
  else if (item.type === "pdf") { const iframe=document.createElement("iframe"); iframe.src=url; viewerBody.appendChild(iframe); }
  else if (item.type === "text") { const pre=document.createElement("pre"); pre.textContent="正在读取…"; viewerBody.appendChild(pre); fetch(url).then(r=>r.text()).then(t=>pre.textContent=t.slice(0,500000)).catch(()=>pre.textContent="无法预览该文件"); }
  else { const box=document.createElement("div"); box.style.padding="60px"; box.innerHTML=`<div style="font-size:60px;display: flex;justify-content: center;">📦</div><p>什么勾八东西，派蒙不知道哦</p>`; viewerBody.appendChild(box); }
  viewer.classList.remove("hidden");
}
function closeViewer(){ viewer.classList.add("hidden"); viewerBody.innerHTML=""; }

async function doSearch(q) {
  q = q.trim();
  if (!q) {
    searchPanel.classList.add("hidden");
    $("#content").classList.remove("hidden");
    return;
  }

  $("#content").classList.add("hidden");
  searchPanel.classList.remove("hidden");
  searchResults.innerHTML = `<div class="loading">搜索中…</div>`;

  try {
    let items;

    if (state.mode === "static") {
      const key = q.toLowerCase();
      items = state.manifest.items.filter(x =>
        x.name.toLowerCase().includes(key) || x.path.toLowerCase().includes(key)
      );
    } else {
      const res = await fetch("/api/search?q=" + encodeURIComponent(q));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "搜索失败");
      items = data.items;
    }

    searchResults.innerHTML = "";
    if (!items.length) {
      searchResults.innerHTML = `<div class="loading">没有找到匹配的文件</div>`;
      return;
    }
    renderItems(items, searchResults);
  } catch {
    searchResults.innerHTML = `<div class="loading">搜索失败</div>`;
  }
}

search.addEventListener("input",()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>doSearch(search.value),250);});
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();search.focus();}if(e.key==="Escape")closeViewer();});
$("#viewerClose").onclick=closeViewer; $(".viewer-backdrop").onclick=closeViewer;
$("#themeBtn").onclick=()=>{document.body.classList.toggle("light");localStorage.setItem("file-center-theme",document.body.classList.contains("light")?"light":"dark");};
if(localStorage.getItem("file-center-theme")==="light")document.body.classList.add("light");
(async () => {
  try {
    await detectMode();
    await loadDirectory("");
  } catch (e) {
    loading.textContent = "初始化失败：" + e.message;
  }
})();
