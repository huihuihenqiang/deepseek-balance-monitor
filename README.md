# AI Usage Monitor

> 🎯 专为 **Claude Code + DeepSeek API** 组合打造的用量监控插件，无需打开网页，直接在 VS Code 侧边栏实时掌握余额和 Token 消耗。

[English](README_EN.md)

## 为什么你需要它

使用 Claude Code 配置 DeepSeek API 后，有两个痛点：
- 想知道余额还剩多少 → 必须打开浏览器登录 DeepSeek 平台
- 想知道用了多少 Token → 无处可查，只能看月底账单

**本插件一次性解决：余额 + Token 消耗，全在 VS Code 里看。**

## 功能

### DeepSeek 余额面板
- 实时显示当前余额（赠送余额 / 充值余额分开）
- 7 天余额趋势图
- 1h / 24h / 7d 消耗统计
- 余额未变化时的智能提示（官方数据可能有延迟）

### Claude Code 用量面板
- **Token 总量** — 输入 / 输出 / Cache 分项统计
- **调用次数** — 你调了多少次 API
- **Cache 命中率** — Prompt Caching 省了多少 Token 一目了然
- **柱状图** — 7 天 Token 消耗趋势
- **模型分布饼图** — 各个模型各用了多少 Token
- **项目排行** — 哪个项目最吃 Token，一看便知
- **月度预测** — 基于加权历史数据的智能预测，预估本月 Token 消耗

## 安装

1. 从 [Releases](https://github.com/huihuihenqiang/deepseek-balance-monitor/releases) 下载最新 `.vsix` 文件
2. 打开 VS Code → `Ctrl+Shift+P` → 输入 `vsix` → 选择 `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件
4. 重载 VS Code

## 配置

`Ctrl+,` → 搜索 `deepseek`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `Api Key` | （空） | 你的 DeepSeek API key，在 [这里](https://platform.deepseek.com/api_keys) 创建 |
| `Refresh Interval` | `30` | 自动刷新间隔（分钟），范围 5-120 |
| `Currency` | `auto` | 币种：`CNY` / `USD` / `auto` |

## 使用

1. 设置 API Key 后，点击左侧活动栏的 📈 **AI Usage** 图标
2. 上半部分是 DeepSeek 余额，下半部分是 Claude Code 用量
3. 点 `⟳ Refresh` 手动刷新（同时更新余额和用量）
4. 用量数据自动从 `~/.claude/projects/` 下的本地会话日志中提取，**无需额外配置**

## 隐私

- API Key 仅存储在本地 VS Code 设置中，只发送到 `api.deepseek.com`
- 只调用 `GET /user/balance` 接口，不读写任何其他数据
- Claude Code 会话数据仅在本地读取，**不上传任何内容**
- 无遥测、无追踪、无第三方服务

## 从源码构建

```bash
npm install
npm run compile
npx vsce package --allow-star-activation --allow-missing-repository
```

## License

MIT
