# 后端认证开发规则

先读 [后端规则](../../AGENTS.md)、[会话和授权](../../../docs/global/business-rules.md#iam-001-会话与登录边界) 与 [账号验证入口](../../../docs/features/accounts.md#实现与验证)。变更会话签发或撤销时核对 HTTP、浏览器标签页、通知设备和实时连接，测试匿名例外及已有会话的兼容性。
