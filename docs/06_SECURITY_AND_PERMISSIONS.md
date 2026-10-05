# 06 — Security and Permissions

## Principles

Control Plane 不应该为了“无人值守”默认关闭所有保护。

## Secrets

不将以下内容写入 event DB：
- API token
- access token
- cookie
- auth header
- password
- private key

运行时需要认证时，优先沿用 Claude Code 官方认证。

## Dangerous operations

以下行为不自动化绕过：
- 付款
- 删除远程资源
- 发布/部署到生产
- 修改真实数据库
- 给外部人员发送消息
- 账号安全设置

## Permissions

UI 应能显示：
- runtime 正在等待权限
- 哪个 branch
- 哪个 tool/action
- 用户处理后继续

## Filesystem

Shared workspace 适合：
- 搜索
- 读取
- 数据分析
- 多 Agent 只读任务

Worktree 适合：
- 多分支同时改代码
- 不同实现路线
- 需要 merge 的实验

## Runtime Profiles

可以支持多个 profile，但：
- 不自动创建/切换第三方账号来绕过限制；
- 不保存账户密码；
- 不伪装请求来源；
- profile 只映射到用户合法配置好的 runtime。
