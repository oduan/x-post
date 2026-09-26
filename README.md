# X-Post · 本地推文收藏

由两部分组成：

1. **Chrome 浏览器扩展**（`extension/`）：在 X(Twitter) 的推文详情页点击扩展图标，即可把当前推文的
   用户名、用户 ID、标题、正文、图片、视频等信息发送给本地 X-Post 应用。发送失败时会在页面上显示
   几秒后自动消失的临时提示。
2. **Electron 桌面应用**（`electron-app/`）：按保存时间线顺序展示已收藏的推文，样式模仿 X 官网的
   推文卡片（头像、昵称、@handle、时间、正文、图片九宫格、视频、引用推文），但没有点赞/评论等交互。
   它在本地固定高位端口 `24680` 上监听 HTTP 接口接收推文数据。

```
┌─────────────┐  点击图标抓取推文   ┌──────────────┐  POST http://127.0.0.1:24680/api/tweets
│   Chrome    │ ─────────────────▶ │ 扩展后台脚本  │ ────────────────────────────────▶ ┐
│  (x.com)    │   content.js       │ background.js │                                  │
└─────────────┘ ◀───────────────── └──────────────┘ ◀────────────────────────────────┘
                  页面内临时提示          保存成功 / 失败结果                        │
                                                                                  ▼
                                                                     ┌────────────────────┐
                                                                     │  X-Post (Electron) │
                                                                     │  本地端口 24680     │
                                                                     │  时间线界面 + 存储   │
                                                                     └────────────────────┘
```

## 下载安装（普通用户）

到 [GitHub Releases](https://github.com/oduan/x-post/releases) 下载对应平台的最新版本：

| 文件 | 平台 | 说明 |
| ---- | ---- | ---- |
| `X-Post-Setup-x.y.z.exe` | Windows | 安装包（NSIS），双击安装，桌面快捷方式自动创建 |
| `X-Post-x.y.z-arm64.dmg` / `X-Post-x.y.z.dmg` | macOS (Apple Silicon / Intel) | 拖入「应用程序」即可 |
| `x-post-extension-vx.y.z.zip` | Chrome 扩展 | 解压后以「加载已解压的扩展程序」方式安装 |

**macOS 首次打开**：当前构建未做代码签名，首次打开会被 Gatekeeper 拦截。在应用图标上**右键 → 打开 → 打开**，或在终端执行
`xattr -dr com.apple.quarantine /Applications/X-Post.app` 后再打开。

**应用内自动更新**：

- 应用会在**启动时**和**每 4 小时**自动检查新版本
- 发现新版本时顶栏出现蓝色「发现新版本 v1.x.x」按钮：
  - **Windows**：点击开始下载（按钮显示进度），下载完成后变为「重启更新」，再点击即自动安装并重启
  - **macOS**：因构建未签名无法自动更新，点击按钮会打开 Releases 页，手动下载 dmg 替换即可

## 快速开始（开发运行）

### 1. 启动 Electron 应用

```bash
cd electron-app
npm install
npm start
```

首次启动会自动创建：

- 数据目录（默认）：`C:\Users\<你>\x-post-data`（可在应用内 ⚙ 设置里更改）
- 配置文件：`C:\Users\<你>\.x-post.json`

### 2. 安装 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `extension` 目录
4. **刷新已打开的 x.com 页面**（视频直链捕获脚本需要随页面加载注入）

### 3. 保存推文

1. 让 X-Post 应用保持运行
2. 在 Chrome 打开某条推文的详情页（链接形如 `https://x.com/某人/status/123456...`）
3. 点击工具栏中的 X-Post 图标
4. 页面底部会出现提示：绿色「已保存到 X-Post」/ 红色「保存失败…」（几秒后自动消失）

推文会实时出现在 X-Post 窗口中（新的在前）。媒体在扩展端下载完成后卡片即带本地文件。界面为亮色主题，媒体区是固定尺寸的横向条带（箭头整页切换，点击进入窗口级查看器），窗口大小与位置会被记住（写入 ~/.x-post.json 的 window 字段）。

每条推文右上角有 **⋯ 按钮**：点击弹出菜单，选择「删除」并确认后，该推文及其保存的
图片/视频/封面文件会一并从数据目录中删除（头像按用户保存、可能被多条推文共用，会保留）。

### 窗口与托盘行为

- 点击窗口的**关闭按钮不会退出**，而是最小化到任务栏（系统托盘区），首次会弹气泡提示；
  此时应用和本地接口继续在后台运行，仍可接收推文
- **左键点击托盘图标**：显示 / 隐藏主窗口
- **右键托盘图标**：菜单提供「显示主窗口」和「退出」，点「退出」才会真正结束进程
- 再次启动应用不会开新窗口，而是唤出已运行实例的主窗口

## 数据存储（SQLite + 媒体文件）

所有数据保存在可配置的数据目录（默认 `~/x-post-data`）：

```
x-post-data/
├── xpost.db                    # 推文元信息数据库（SQLite，WAL 模式；另有 -wal/-shm 伴生文件）
├── media/
│   ├── images/                 # 推文图片（原始 jpg/png/webp）
│   ├── videos/                 # 推文视频（mp4）
│   └── avatars/                # 用户头像（按 handle 命名）
└── tweets.bak-<时间>/          # 旧版逐条 JSON 存档导入数据库后的改名备份（若有）
```

推文元信息存于 `xpost.db` 的 `tweets` 表（引用推文与媒体数组以 JSON 列存储），媒体项的数据结构与
旧版 JSON 存档一致：

```json
{ "kind": "image", "url": "https://pbs.twimg.com/media/xxx?format=jpg&name=orig",
  "path": "media/images/1234567890123456789-1.jpg", "width": 1200, "height": 800 }
```

- `saved_at` 决定时间线排序（保存顺序，新的在前），建有索引；用户视图按 `user_id + 发帖时间` 索引
- 界面按 50 条一页从数据库 keyset 游标分页读取（无限滚动），新增/删除推文以增量事件更新界面，
  不再全量重拉
- 旧版本 `tweets/*.json` 存档在首次启动时自动导入数据库，原目录改名为 `tweets.bak-<时间>` 保留
- 媒体字段同时保留原始 URL 与本地相对路径 `path`；下载失败时 `path` 为 `null`，界面回退显示远程地址

## 配置文件

`~/.x-post.json`（用户目录下的点开头文件）：

```json
{
  "dataDir": "C:\\Users\\oisin\\x-post-data",
  "port": 24680
}
```

- `dataDir`：数据保存位置，也可以在应用内 设置 → 更改目录 修改（不会迁移已有数据）
- `port`：本地接口端口，默认 `24680`，与扩展约定一致。如需修改，必须同时修改
  `extension/background.js` 顶部的 `PORT` 常量并重载扩展

## 本地接口

只监听 `127.0.0.1`，不对外网开放：

| 方法   | 路径                    | 说明 |
| ------ | ----------------------- | ---- |
| GET    | `/api/ping`             | 健康检查 |
| GET    | `/api/tweets/exists?id=`| 查询某条推文是否已保存（扩展在下载前先查重） |
| POST   | `/api/media`            | 上传媒体二进制（请求头 `X-Tweet-Id` / `X-Media-Index` / `X-Media-Role: main\|poster` / `X-Media-Ext`），先存入 `.staging` |
| POST   | `/api/tweets`           | 提交推文元信息；暂存媒体随之移入正式目录，重复推文 ID 返回 `{ ok: true, duplicate: true }` |

媒体下载由**浏览器扩展**完成（带进度）：扩展先流式下载图片/视频（页面底部显示进度条），
逐个上传给应用暂存，全部完成后再提交元信息——此时时间线里出现的推文就已带可播放的本地媒体，
页面提示「已保存到 X-Post」。扩展下载失败的项目会保留 URL，由应用端兜底下载。

## 已知限制与说明

- **视频**：X 页面里的 `<video>` 是 blob 地址，直链需要从数据层获取。扩展按以下顺序捕获 mp4 直链
  （`content.js` / `inject.js`）：① 主世界钩子钩住 `fetch`/`XMLHttpRequest` 捕获 GraphQL 接口响应
  （从时间线点进详情页的 SPA 场景）；② 扫描页面内联脚本中服务端渲染的推文数据（直接打开详情页的
  场景）；③ Performance 资源加载记录（视频播放过）；④ `og:video` 元信息兜底。
  极少数情况下（如纯 HLS 直播回放，variants 里只有 m3u8）只能保存视频封面，卡片上会标注
  「未捕获到视频直链」。多视频推文按清晰度从高到低分配直链。
- **标题**：普通推文没有标题字段，仅长文/文章类推文会提取标题，其余为空。
- 必须在推文**详情页**（URL 含 `/status/`）点击图标；在时间线页面点击会得到提示。
- 安装/更新扩展后，已打开的 x.com 标签页需要刷新一次。
- **启动时提示端口监听失败（EACCES）**：Windows 上 Hyper-V/WSL 会随机保留一些高位端口区间，
  固定端口可能恰好落在其中。可用 `netsh interface ipv4 show excludedportrange protocol=tcp`
  查看保留区间，选择区间之外的端口（同时修改 `~/.x-post.json` 的 `port` 与
  `extension/background.js` 的 `PORT`），或重启电脑后保留区间通常会变化。

## 发布新版本（维护者）

推送 `v*` 格式的 tag 即可触发 GitHub Actions 自动发布：

```bash
git tag v1.0.1
git push origin v1.0.1
```

流水线（`.github/workflows/release.yml`）会：

1. 从 tag 名提取版本号写入 `electron-app/package.json` 与 `extension/manifest.json`
2. Windows 上打包 NSIS 安装包（`X-Post-Setup-x.y.z.exe` + electron-updater 的 `latest.yml` 更新元数据）
3. macOS 上打包 dmg/zip（Apple Silicon + Intel，未签名）
4. 打包浏览器扩展 zip（版本号随 tag）
5. 以上产物自动发布到该 tag 对应的 GitHub Release

## 开发

```bash
node tools/make-icons.js     # 重新生成扩展图标
node tools/test-store.js     # 存储与接口的离线集成测试（自动切换到 Electron 运行时执行）

cd electron-app
XPOST_SMOKE=1 npx electron . # 冒烟测试：启动 6 秒后自动退出，结果写入 xpost-smoke-ok.txt 并输出 SMOKE_OK
```

### 项目结构

```
x-post/
├── .github/workflows/release.yml  # 推送 v* tag 触发：打包三端产物并发 Release
├── electron-app/
│   ├── main.js               # 主进程：窗口、IPC、本地服务、应用内更新
│   ├── preload.js            # contextBridge
│   ├── electron-builder.yml  # 打包配置（NSIS/dmg，GitHub Releases 发布源）
│   ├── build/icon.png        # 应用图标（1024px，由 make-icons.js 生成）
│   ├── lib/
│   │   ├── config.js         # ~/.x-post.json 配置读写
│   │   ├── server.js         # 127.0.0.1:24680 HTTP 接口
│   │   └── store.js          # SQLite 存储（xpost.db）：元信息 + keyset 分页 + 媒体下载落盘
│   └── renderer/             # 时间线界面（仿 X 亮色样式）
├── extension/
│   ├── manifest.json         # MV3
│   ├── background.js         # 图标点击 → 通知页面抓取；负责与本地应用通信
│   ├── content.js            # 抓取推文信息 + 页面内临时提示
│   └── inject.js             # 主世界脚本：捕获视频 mp4 直链
└── tools/
    ├── make-icons.js         # 生成扩展图标与应用图标（纯 Node，无依赖）
    ├── set-version.js        # CI 用：把 tag 版本号写入 package.json / manifest.json
    └── test-store.js
```
