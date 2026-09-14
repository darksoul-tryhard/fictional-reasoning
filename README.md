# Fictional Reasoning

> 将一段案件文本交给 AI，在证词、证物与矛盾之间找出真相。

**Fictional Reasoning** 是一款本地运行的 AI 推理审讯游戏。玩家导入 TXT 案件材料，选择断案难度后，在 Persona 5 Royal 风格的审讯界面中逐一询问人物、出示证物、比对证词，并决定是否申请逮捕。

## 主要功能

- 导入 UTF-8、GBK 或 GB18030 编码的 TXT，自动提取案件标题。
- 针对长篇文本分段解析；解析失败会自动缩小分段后重试。
- 困难（20 点）、普通（40 点）、简单（80 点）与练手（不限）四档行动点。
- 每位嫌疑人拥有独立的审讯记录、信任、敌意与已出示证物状态。
- 证物袋、话术选项、矛盾板、当面对质与逮捕结局。
- 自动存档与手动存档均写入本地 `save` 文件夹，可从首页继续案件。
- 案件原文、真相、玩家存档和模型密钥仅留在本机，不会提交到仓库。

## 快速开始

需要 **Node.js 22.12+** 与 npm 10+。

```powershell
git clone https://github.com/darksoul-tryhard/fictional-reasoning.git
cd fictional-reasoning
Copy-Item .env.example .env
npm install
npm run dev
```

打开终端提示的本地网址。在首页的“API 配置”填写兼容 OpenAI Chat Completions 的 Base URL、模型名称和 API Key，然后导入案件 TXT 即可开始。

`.env` 不会被 Git 跟踪；请勿把真实 API Key 提交到仓库或截图分享。

## 常用命令

```powershell
npm run dev          # 同时启动前端与后端开发服务
npm run lint         # 静态检查
npm test             # 运行测试
npm run build        # 构建前端与后端发布文件
npm run start:server # 启动已构建的后端
```

## Windows 发布包

执行 `npm run build` 后，可使用 `build-launcher.bat` 编译无控制台窗口的 Windows 启动器（需要 MinGW-w64）。发布目录需包含：

```text
虚构推理/
├─ 虚构推理.exe
├─ dist/
├─ dist-server/
├─ runtime/
└─ save/
```

启动器会在后台启动本地服务并打开游戏；关闭游戏页面后会结束本次后台服务。发布时保留空的 `save` 文件夹即可，切勿附带 `save.json`、`.env`、`.data` 或浏览器缓存。

## 项目结构

```text
src/       React 前端与 P5R 风格界面
server/    Express API、案件解析、审讯与存档逻辑
tests/     Node 测试
save/      本地玩家存档（仅保留 .gitkeep）
```

## 协作约定

- 不提交 `.env`、`.data`、`save/*.json`、浏览器缓存或本地日志。
- 提交前运行 `npm run lint` 与 `npm test`。
- 需要发布 Windows 版本时，使用单独的干净发布目录打包。
