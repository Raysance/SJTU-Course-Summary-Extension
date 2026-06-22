# SJTU 课堂概要导出 Chrome 扩展

这是一个纯 Chrome 扩展版工具，适用于：

```text
https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/
```

扩展从已登录的课堂视频页读取页面上已经渲染出的平台 AI 字幕、概要和章节导航，按日期合并导出；同一天的多段课视为一个单位。可选调用 DeepSeek `deepseek-v4-flash` 生成简明考试要点。

## 核心流程

1. 在 Chrome 中正常登录并打开课程视频页。
2. 点击扩展图标，打开“SJTU 课堂概要导出”页面。
3. 第一次使用时填入 DeepSeek API Key，并点击“长期保存”。
4. 在“导出范围”中选择“全选”或某一天。
5. 点击“导出所选范围”。
6. 扩展会逐节切换回放、读取字幕与概要，并按天下载 Markdown 文件。

不需要运行 Python、`.command`、本地服务、FFmpeg、Whisper 或任何额外脚本。

## 安装

1. 解压 ZIP。
2. 打开 Chrome 的 `chrome://extensions`。
3. 启用“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的 `chrome-extension` 文件夹。

更新版本时，在 `chrome://extensions` 中点击该扩展卡片上的“重新加载”，再刷新课程视频页。

扩展包含固定公开 key，用于保持 Chrome 扩展 ID 稳定；正常更新或从新版文件夹重新加载时，本机保存的 DeepSeek API Key 不会因为扩展 ID 变化而丢失。

## 导出结果

扩展会在 Chrome 下载目录中创建课程文件夹，包含：

- `课程概要索引.md`：导出日期、成功节次和失败节次。
- `YYYY-MM-DD-考试要点与课堂概要.md`：当天合并后的 DeepSeek 考试要点、平台概要、章节导航和可展开字幕。
- 关闭 DeepSeek 开关时，文件名为 `YYYY-MM-DD-课堂概要.md`，只整理平台内容。

## 隐私说明

扩展不会读取或导出：

- Cookie、Session Storage、Local Storage；
- `tokenId` 或访问令牌；
- 学校账号、密码；
- 视频媒体签名。

DeepSeek API Key 长期保存在本机 Chrome 扩展存储中；正常更新或重新加载扩展不会清除，卸载扩展会删除。开启 DeepSeek 总结时，扩展会把当天的课堂字幕、概要和章节导航发送到 DeepSeek API；关闭开关则完全不调用外部 AI。

## 故障排查

- **找不到课程页面**：确认课程视频页仍在 Chrome 中打开，且地址以 `https://v.sjtu.edu.cn/jy-application-canvas-sjtu-ui/` 开头。
- **读取不到回放**：刷新课程视频页，等待回放列表和“语音/概要”内容加载完成，再点扩展页面里的“重新读取”。
- **某节课失败**：扩展会跳过该节，并写入 `课程概要索引.md`；可在“导出范围”中选择具体日期后补导。
- **DeepSeek 失败**：检查 API Key、额度和网络；也可以先关闭 DeepSeek 开关，只导出平台概要。
