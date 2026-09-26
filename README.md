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

## 快速开始

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

## 数据存储（纯文本，无数据库）

所有数据保存在可配置的数据目录（默认 `~/x-post-data`）：

```
x-post-data/
├── tweets/                     # 每条推文一个 JSON 元信息文件
│   └── 1234567890123456789.json
├── media/
│   ├── images/                 # 推文图片（原始 jpg/png/webp）
│   ├── videos/                 # 推文视频（mp4）
│   └── avatars/                # 用户头像（按 handle 命名）
```

推文 JSON 示例：

```json
{
  "id": "1234567890123456789",
  "url": "https://x.com/test_user/status/1234567890123456789",
  "userName": "显示昵称",
  "userId": "test_user",
  "avatar": "media/avatars/test_user.jpg",
  "title": "",
  "content": "推文正文……",
  "tweetTime": "2026-09-20T00:00:00.000Z",
  "savedAt": "2026-09-26T10:00:00.000Z",
  "quotedTweet": null,
  "media": [
    { "kind": "image", "url": "https://pbs.twimg.com/media/xxx?format=jpg&name=orig",
      "path": "media/images/1234567890123456789-1.jpg", "width": 1200, "height": 800 },
    { "kind": "video", "url": "https://video.twimg.com/xxx.mp4",
      "path": "media/videos/1234567890123456789-2.mp4",
      "poster": "https://pbs.twimg.com/xxx", "posterPath": "media/images/1234567890123456789-2-poster.jpg",
      "duration": 12.3 }
  ]
}
```

- `savedAt` 决定时间线排序（保存顺序，新的在前）
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

## 开发

```bash
node tools/make-icons.js     # 重新生成扩展图标
node tools/test-store.js     # 存储与接口的离线集成测试（不需要 Electron）

cd electron-app
XPOST_SMOKE=1 npx electron . # 冒烟测试：启动 6 秒后自动退出并输出 SMOKE_OK
```

### 项目结构

```
x-post/
├── electron-app/
│   ├── main.js               # 主进程：窗口、IPC、启动本地服务
│   ├── preload.js            # contextBridge
│   ├── lib/
│   │   ├── config.js         # ~/.x-post.json 配置读写
│   │   ├── server.js         # 127.0.0.1:24680 HTTP 接口
│   │   └── store.js          # 纯文本存储：JSON 元信息 + 媒体下载落盘
│   └── renderer/             # 时间线界面（仿 X 深色样式）
├── extension/
│   ├── manifest.json         # MV3
│   ├── background.js         # 图标点击 → 通知页面抓取；负责与本地应用通信
│   ├── content.js            # 抓取推文信息 + 页面内临时提示
│   └── inject.js             # 主世界脚本：捕获视频 mp4 直链
└── tools/
    ├── make-icons.js
    └── test-store.js
```
