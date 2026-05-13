

<h1 align="center">AI Usage Monitor</h1>

<p align="center">
  <a href="https://github.com/huihuihenqiang/deepseek-balance-monitor/stargazers"><img src="https://img.shields.io/github/stars/huihuihenqiang/deepseek-balance-monitor?style=flat-square" alt="GitHub stars"></a>
  <a href="https://github.com/huihuihenqiang/deepseek-balance-monitor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/huihuihenqiang/deepseek-balance-monitor?style=flat-square" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-VS%20Code%201.85%2B-blue?style=flat-square" alt="Platform"></a>
</p>

<p align="center">
  <b>DeepSeek 余额 + Claude Code Token 消耗 · VS Code 侧边栏一站式监控</b>
</p>

<p align="center">
  <a href="https://github.com/huihuihenqiang/deepseek-balance-monitor/releases"><img src="https://img.shields.io/badge/Download-0.3.0-brightgreen?style=for-the-badge" alt="Download"></a>
</p>

---

## Why

使用 Claude Code + DeepSeek API 后有两个痛点：

- 想知道余额还剩多少 → 必须打开浏览器登录 DeepSeek
- 想知道 Token 用在哪、哪个项目花最多 → 无处可查

**本插件在 VS Code 侧边栏一次性解决。**

## Features

### DeepSeek 余额面板

![DeepSeek Balance Panel](image/1.png)

- 实时余额显示，低于阈值自动变红
- 预计可用天数（余额 ÷ 近7日均消耗）
- 7 天余额趋势（hover 看具体数值）
- 1h / 24h / 7d 消耗统计

### Claude Code 用量面板 — 四个 Tab

![Claude Code Usage Panel](image/2.png)

**Today** — 今天有没有异常？
- 每小时 Token 柱状图 + 昨日同时段对比线
- 每小时调用次数图
- Token Composition 堆叠条（Input / Output / Cache Read / Cache Write）
- 今日指标：Avg Tokens/Call、vs 7d Avg、Total Calls

**This Week** — 这周和上周比怎么样？
- 每日柱状图（周一~周日） + 上周同日对比
- Week-over-Week 对比表（Tokens / Calls / Avg/Call / Cache Hit）
- 本周预测总量

**This Month** — 这个月会不会爆？
- 每日 Token 柱状图 + 累计 & 预测折线图
- 日历热力图（一眼看出哪天最重）
- Export Monthly Report → Markdown 报告一键导出

**Cumulative** — 钱都花哪了？
- 月度对比柱状图
- Cache Hit Rate 趋势（85%-100% 纵轴）
- 模型分布饼图 + 项目排行（可点击打开文件夹）
- 总览指标：项目数 / 首次记录 / 月均 / 峰值月

## Install

1. 从 [Releases](https://github.com/huihuihenqiang/deepseek-balance-monitor/releases) 下载 `.vsix`
2. VS Code → `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

![Install](image/安装.png)

3. 选择文件 → 重载

## Configure

`Ctrl+,` → 搜索 `deepseek`：

| Setting | Default | Description |
|---------|---------|-------------|
| `Api Key` | — | DeepSeek API key |
| `Refresh Interval` | 30 | 刷新间隔（分钟） |
| `Currency` | auto | CNY / USD / auto |
| `Low Balance Threshold` | 5 | 余额低于此值变红 |
| `Low Days Threshold` | 5 | 剩余天数低于此值变红 |


## Topics

`claude-code` `claude` `ai-tools` `usage-dashboard` `token-usage` `developer-tools` `api-monitoring` `cost-monitoring`

## Privacy

- API Key 仅存本地，只发 `api.deepseek.com`
- 会话数据仅本地读取，零上传
- 无遥测、无追踪

## Build

```bash
npm install
npm run compile
npx vsce package --allow-star-activation
```

## License

MIT
