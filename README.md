# SillyTavern 美化反馈助手

![美化反馈助手 Logo](assets/theme-feedback-logo.png)

作者：酒疫  
版本：0.1.2
最低 SillyTavern 版本：1.14.0

这是一个私人使用的 SillyTavern 前端扩展与服务端插件组合。它允许在手机酒馆中截取当前界面、用手指圈出问题、填写反馈，并把截图直接保存到运行酒馆的电脑。

## 能做什么

- 只有点击“截取当前界面”时才截图。
- 截图引擎支持现代 CSS `color()`、`color-mix()`、`oklch()` 等颜色语法。
- 只有预览后点击“上传到电脑反馈箱”才上传。
- 自动记录当前主题、主题订阅版本、目录 SHA-256、本地运行指纹和是否已修改。
- 自动识别主聊天、世界书、扩展设置、角色编辑、左右抽屉和弹窗等常见窗口，也允许手动改名。
- 按“主题名称 / 版本名称 / 反馈编号”归档。
- 保存截图、`feedback.json` 和全局 `feedback-index.jsonl`。
- 不使用公共图床、GitHub Issues 或第三方上传服务。

## 归档示例

```text
手机反馈/
└─ 春来（加了一抹绿）/
   └─ 初始版本/
      └─ 20260813.../
         ├─ screenshot.png
         └─ feedback.json
```

以后可以直接对 Codex 说：“查看手机反馈里春来初始版本的最新反馈。”

## 安全边界

- 上传接口位于当前 SillyTavern 的同源 `/api/plugins/theme-feedback`。
- 请求继续受 SillyTavern 登录、白名单和 CSRF 保护。
- 服务端额外拒绝非当前酒馆来源的浏览器请求。
- 服务端只接受安装时登记的酒馆用户 handle；默认是本机的 `default-user`。
- 客户端不能指定保存路径，主题名和版本名会经过 Windows 文件名清理。
- 单张图片默认上限为 15 MB。
- 仓库不保存反馈图片、私人聊天、Cookie、令牌或本机配置。

截图可能包含当前聊天内容，因此每次上传前必须由用户查看预览并主动确认。

## Windows 安装

先关闭 SillyTavern，然后在 PowerShell 中进入本仓库并执行：

```powershell
.\install.ps1 -SillyTavernRoot 'D:\SillyTavern' -FeedbackRoot 'C:\Users\凡人歌\Documents\酒馆美化\手机反馈' -EnableServerPlugins
```

如果以后更换酒馆用户目录，可额外传入 `-UserProfileName` 和 `-AllowedUserHandle`；两者默认都是 `default-user`。

预期输出会列出：

- 前端扩展目录
- 服务端插件目录
- 电脑反馈箱目录
- `ServerPluginsEnabled : True`
- `RestartRequired : True`

之后重新启动 SillyTavern。右下角出现相机按钮“美化反馈”即表示前端已加载。

## 使用

1. 切换到需要反馈的主题和问题窗口。
2. 点击右下角相机按钮。
3. 确认自动识别的主题、版本与状态。
4. 点击“截取当前界面”。
5. 用手指圈出问题，填写问题说明。
6. 点击“上传到电脑反馈箱”。
7. 记录成功提示中的反馈编号。

## 版本判断

- `与订阅版本一致`：当前主题内容与订阅器记录的远程版本一致。
- `本地已修改`：主题名称和订阅版本已识别，但当前运行内容存在变化。
- `本地主题`：没有找到对应的订阅器安装记录。

## 当前验证状态

源文件只能进行静态语法、路径、安全和数据格式检查。手机浏览器截图、触摸标注、真实上传和不同主题下的显示效果，需要安装并重启 SillyTavern 后进行运行时确认。
