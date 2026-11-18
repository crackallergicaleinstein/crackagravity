# 中文版 — V2EX / 即刻 / QQ 群 / 微信

## 标题

**把 Antigravity 的额度变成 OpenAI 兼容接口：一次请求 21830 token 的脚手架，砍到 6–38**

## 正文

用 Antigravity 的同学大概都有这个疑问：明明只是问一句话，额度怎么掉得这么快。
我抓了一次请求，答案在这里：

| 客户端塞进去的东西 | 开销 |
|---|---|
| `request.systemInstruction` 65891 字符 | 约 16.5k token |
| `request.tools` 14 个工具声明 | 约 5k token |
| 每次工具调用附带的 `agent_monitoring` 审核请求 | 2704 token |
| 每次请求启动 235MB 的 `agy.exe` | 约 7 秒 |

**这些全部在客户端构造**，上游 `v1internal:streamGenerateContent` 并不要求。
把脚手架去掉，同一个问题只要 **6–38 个 prompt token**，一次 `fetch`，没有子进程。

于是我把这条链路做成完整工具：

- OpenAI `chat/completions` + Claude `/v1/messages`，同一端口
- 流式、工具调用、SSE 心跳
- **思考预算用数字控制**：1024 / 8192 / 30000 → 实测 153 / 348 / 1218 个 thought token
- 模型列表按账号实时拉取，免费号 36 条 / 31 条可调用，付费档自动不同
- Windows 应用（API 标签页管理密钥、聊天标签页看思考流）+ CLI，`--selftest` 14/14

**说清楚没有做的事**：没有伪造官方客户端遥测，没有打包 TLS 指纹二进制，也**没有绕过 Gemini 的内容过滤**——服务端过滤和模型拒答照旧返回，README 里用粗体写明。

零依赖、无构建步骤，Windows + Node 20 即可：
https://github.com/crackallergicaleinstein/crackagravity

## 短版（群聊可用）

> Antigravity 每次请求自带 21830 token 的客户端脚手架，砍掉后同一问题只要 6–38 token。
> 做成 OpenAI/Claude 兼容本地接口 + Windows 应用，零依赖：
> https://github.com/crackallergicaleinstein/crackagravity
