# 后端开发规则

完整 NSOJ 工作区先读 [根目录规则](../AGENTS.md) 和 [文档索引](../docs/INDEX.md)。后端负责认证、授权、持久化和业务规则。新增或修改功能同步更新功能文档与测试。

- 从 controller、DTO、service、entity 和调用链核对改动。变更 Nest 模块依赖时，验证正常启动及循环依赖，参照 `yarn test:bootstrap`。
- 接口变更检查 Swagger、前端生成客户端和各功能客户端。涉及公开投影、错误和权限时，从 HTTP 与实时入口一起核对。数据库、Redis 及兼容要求见 [工程规范](../docs/global/engineering.md)。
- 后端代码改动交付或推送前，使用 [`.nvmrc`](.nvmrc) 的 Node.js，核对 [CI 配置](.github/workflows/ci.yml)，按工作流顺序安装依赖并检查。工作流更新时以其命令为准。

```sh
CI=true yarn build
CI=true yarn lint
CI=true yarn check-style
```

改动涉及 Codeforces 或 AtCoder 远端评测时，再运行 `yarn test:remote-judge`。其他改动运行对应功能文档中的回归。逐项报告结果，失败或无法运行时写明命令和原因，全部通过后才报告 CI 检查已完成。
