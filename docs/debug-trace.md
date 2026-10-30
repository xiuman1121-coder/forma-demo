# 本地 Debug Trace

默认关闭。仅排查任务时设置 `FORMA_DEBUG_TRACE=1`，重启 Forma 后对**新任务**生效；移除该变量或设为 `0` 并重启即可关闭。可在本地 `.env.local` 中配置，也可在启动命令前设置环境变量。不要公开 `.env.local` 或 Trace 文件。

Trace 位于 `.private/debug-traces/<jobId>.json`，不会通过 Forma HTTP 路由暴露。每个任务有同一 `jobId`，逐张执行的记录另带 `planItemId`。文件权限为 `0600`，目录为 `0700`；创建新 Trace 时清理超过 7 天的旧 Trace，每份文件最多 2 MiB、300 条事件。过大的记录会以 `trace_limit` 标记停止继续记录。现有 `.private/audit` 文件不受这个开关影响。

本机查看单个任务：

```sh
node -e 'const t=require(process.argv[1]); for (const e of t.events) console.log(e.at,e.stage,e.planItemId||"",JSON.stringify(e).slice(0,300))' .private/debug-traces/<jobId>.json
```

Trace 包括 Routing、Planning 输入与原始输出、Validation、Agent Context 与工具调用、Prompt 组装、Seedream 非敏感参数和文件检查。图片 base64、API Key、Authorization 和常见 Bearer 凭据会被替换为占位符。**用户需求、对话、文件名和生图 Prompt 仍可能含商业信息**，只应在本机受限账户下打开，不应上传或分享原文件。

用 Mock 验证开关不改变任务结果：

```sh
npm run check
node --test test/debug-trace.test.mjs
npm test
```
