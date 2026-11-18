# 按实验选择 doctor 下载探针

GSM8K 使用本地 SimpleAgent 时只检查 Hugging Face。之前 `doctor` 固定探测多个包源，宿主缺少 `uv` 时还会因未处理的进程启动事件提前退出。

由诊断命令根据解析后的 Benchmark、Solver、Verifier 和环境配置选择可确定的探针。Ray 节点复用同一份选择。包源探针读取索引，具体任务镜像、Dockerfile 和外部 Bundle 的依赖仍由 `warmup` 验证。POSIX 子进程启动失败交给现有的事件处理路径，保留原始错误码。

验收项包括本地 GSM8K 只探测 Hugging Face、本地数据不触发远端数据探针、Terminal-Bench 4 试读实际归档，以及缺少可执行文件时返回 `ENOENT`。已在 WSL 中运行本机已注册的 CLI，确认缺少 `pip`、`uv` 时仍生成完整报告。Hugging Face 镜像返回上游缓存，按原规则记录为 `not-checked`。

在只包含本次改动的 WSL 构建目录通过构建、类型检查和依赖边界检查。默认测试集 2457 项通过，96 项跳过。未连接真实 Ray 集群验证。
