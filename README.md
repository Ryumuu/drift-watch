# drift-watch 偏航观测

Claude Code 插件：对照「最初目标 → 计划 → 实际每一步」，算偏航指数。偏了先提醒你和 Claude，再犯就暂停，等你选「继续」或「换个思路」（写好航行日志，开一个干净的新会话接手）。

- 输入框上方一条小条：是否跑偏、偏离度、当前阶段和总目标的进度
- `/drift` 打开面板：结论、航迹图、每一步的偏离角、跑偏记录
- 判断用小模型（默认 Haiku），纠偏由会话本身的模型来做

## 安装

```bash
claude --plugin-dir /path/to/drift-watch
```

或把目录加进 `CLAUDE_CODE_PLUGIN_DIRS`。

## 设置（都可不填）

| 设置 | 作用 | 默认 |
| --- | --- | --- |
| `escalation` | 提醒过还再犯时：`remind` 再提醒 / `pause` 暂停 / `block` 拦下 | `pause` |
| `judgeModel` | 判断跑偏用的小模型：`haiku` / `sonnet` / `off` | `haiku` |
| `logDir` | 航行日志放哪个文件夹（绝对路径） | `~/.claude/drift-watch/航行日志` |
| `apiKeychainService` / `apiKeychainAccount` | macOS 钥匙串里你自己的 Anthropic API 密钥条目；填了就直连 API 调小模型 | 空 |

不填密钥时也能用：先看环境变量 `DRIFT_WATCH_API_KEY`，没有就走 Claude Code 自带的模型通道。

在 `/config` 里改，或写进 `settings.json`：

```json
"pluginConfigs": { "drift-watch": { "options": { "logDir": "/path/to/logs" } } }
```

小条的按钮采用固定布局，默认按桌面版一行约 883px 宽设置；窗口宽度或其他插件的布局不同时，可以用插件目录下的 `band-pos.json` 覆盖位置。

## 检查

```bash
claude plugin validate .
claude plugin test .
```
