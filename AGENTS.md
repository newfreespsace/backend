# 后端交付检查

修改后端代码后，交付或推送前先核对 [GitHub Actions 的 CI 配置](.github/workflows/ci.yml)，使用 `.nvmrc` 指定的 Node.js 版本，并按工作流顺序执行当前的检查。CI 配置变更时，以工作流中的命令为准。

```sh
CI=true yarn build
CI=true yarn lint
CI=true yarn check-style
```

改动涉及 Codeforces 或 AtCoder 远端评测时，再运行 `yarn test:remote-judge`。

交付时逐项报告检查结果。遇到失败或无法运行的检查，说明对应命令和原因。全部 CI 检查通过后，才报告 CI 检查已完成。
