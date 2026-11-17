# lan-media-server

一个零依赖的局域网影音服务：把电脑硬盘上的视频目录变成网页，在手机、平板、其他电脑的浏览器里直接看。

- 只需要 Node.js 和 ffmpeg，不用安装数据库、不用 npm install
- 单个 `server.js` + 单个 `index.html`，适合放在下载目录旁边自己改

## 功能

- **浏览**：按文件夹浏览（只含一个视频的文件夹直接显示视频），"最新"列表，"继续观看"，文件名搜索；按时间 / 名称 / 大小 / 时长排序，文件夹与视频混排
- **缩略图与时长**：后台用 ffmpeg 自动生成，缓存在 `.cache/`
- **播放**：浏览器能直接放的格式（H.264/HEVC/VP9 + AAC/Opus 等）直接拖动播放；放不了的（avi、wmv、rmvb、10bit、PCM 音频……）自动转成 HLS 实时转码，支持 NVIDIA NVENC 硬件编码，拖动进度会从对应位置重新转码
- **记忆进度**：每个视频记住看到哪里，下次接着播；上一个 / 下一个 / 自动连播
- **字幕**：同目录下 `视频名.xxx.ass/ssa/srt/vtt` 自动挂载，也能提取 mkv 内嵌的文字字幕；GBK / UTF-16 编码自动识别
  - **保留 ASS 样式**：字体、字号、颜色、描边、阴影、粗斜体、对齐、边距、`\pos` 定位与常见行内标签，按画面等比缩放，排版与 libass 一致
  - 用网页里的"⛶ 全屏"全屏时字幕样式仍在；iPhone 只能用系统播放器全屏，此时退回浏览器自带的字幕渲染
- **从列表移除**：不想看到的视频 / 文件夹从列表隐藏，文件保留，可随时恢复
- **删除**：删除视频或整个文件夹，移到 Windows 回收站（可恢复），可在配置里关闭
- **刷新**：下载了新视频后点"⟳ 刷新"立即重新扫描；另外每隔一段时间后台自动扫描一次
- 可选访问密码

## 运行

需要：

- Node.js 20 或更新
- ffmpeg / ffprobe 在 `PATH` 里（Windows 可 `winget install ffmpeg`）
- 删除功能目前只支持 Windows（通过 `recycle.ps1` 调用系统回收站）

```bash
git clone https://github.com/yanzaocheng/lan-media-server.git
cd lan-media-server
cp config.example.json config.json   # 按需修改
node server.js                       # Windows 也可以双击 start.bat
```

启动后终端会打印本机的局域网地址，比如 `http://192.168.1.10:8090`，手机连同一个 Wi-Fi 打开即可。
iPhone 在 Safari 里"添加到主屏幕"后用起来像个 App。

Windows 第一次运行时如果弹出防火墙提示，要允许 Node.js 在"专用网络"（以及你所在网络的类型）上通信，否则手机连不上。

## 配置 `config.json`

| 字段 | 说明 | 默认 |
|---|---|---|
| `root` | 媒体目录 | `E:\` |
| `port` | 端口 | `8090` |
| `password` | 访问密码，留空则不需要密码 | `""` |
| `exclude` | 扫描时跳过的文件夹名（任意层级，不区分大小写） | 回收站、系统目录、本程序目录 |
| `rescanMinutes` | 后台自动重新扫描的间隔（分钟） | `10` |
| `allowDelete` | 是否允许在网页上删除 | `true` |

改完配置需要重启服务。

> 没设密码时，同一局域网里的任何人都能打开网页（包括删除）。家里以外的网络请设置密码或关闭删除。

## 文件

```
server.js           服务端：扫描、缩略图、视频流、HLS 转码、字幕转换、删除/隐藏
public/index.html   网页（单文件）
public/hls.min.js   hls.js，用于非 Safari 浏览器播放 HLS
recycle.ps1         把文件移到 Windows 回收站（无弹窗）
start.bat           Windows 启动脚本
.cache/             缩略图、探测结果、转码分片（自动生成，可随时删除）
hidden.json         "从列表移除"的记录（自动生成）
```

## 许可

MIT。`public/hls.min.js` 来自 [hls.js](https://github.com/video-dev/hls.js)，Apache-2.0 许可。
