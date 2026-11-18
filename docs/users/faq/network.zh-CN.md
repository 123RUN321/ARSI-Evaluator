# 检查网络与下载失败

> [English](network.md) | 中文

[网络配置入口](../network.zh-CN.md)

使用与评测相同的实验和网络文件：

```bash
# 查看实际生效的配置，不下载
arsi-evaluator inspect experiment.yaml --network network.yaml
# 检查工具和网络，会发起临时下载
arsi-evaluator doctor experiment.yaml --network network.yaml
```

## 查看诊断结果

`inspect` 显示网络文件路径和环境变量覆盖后的配置。修改 YAML 后没有生效时，先检查这里的实际值。

`doctor` 根据生效的实验配置选择可确定的下载源，并显示访问位置、地址、耗时和失败原因。例如，本地 SimpleAgent 跑公开 GSM8K 时只探测 Hugging Face。包源探针直接检查对应索引，宿主无需安装额外的包管理器。Ray 实验把相同的探针选择发给执行节点。

具体题目的镜像、Dockerfile 内的下载和外部 Bundle 或插件的依赖需要等任务准备时才能确认。使用下面的 `warmup` 检查这些依赖。`doctor` 不调用模型。

| 状态 | 含义 |
| --- | --- |
| `passed` | 本项检查通过 |
| `failed` | 本项检查失败，按输出的原因处理 |
| `not-checked` | 本项未完成检查，需要继续排查 |
| `not-applicable` | 当前实验不需要该项 |

只读到缓存、没有实际完成下载检查时，不算下载检查通过。检查不完整时命令退出码为 `1`。

## 根据失败原因处理

1. 查看 `network.configPath`，确认修改的是本次使用的网络文件。
2. 按失败项中的 `guidance.yamlFields` 查找配置字段，按 `guidance.action` 调整。缺少工具、认证失败和 Docker 无法连接需要分别处理，换源不能解决所有问题。
3. 使用输出中的 `retryCommand` 重新检查。若采用 `recommendedCommand` 提供的镜像源配置，先确认其中的地址适合自己的环境；程序不会自动换源。

Docker 代理和 daemon 连接问题见[部署网络配置](../deployment/network.zh-CN.md)。

## 准备实际任务

`doctor` 只检查部分下载和构建操作，不代表所有题目的镜像、依赖或模型调用都可用。进一步准备实际选中的任务：

```bash
arsi-evaluator warmup experiment.yaml --network network.yaml
```

`warmup` 准备镜像和依赖，不调用模型。参数和前置条件见[镜像预热](../usage.zh-CN.md#只预热镜像不开始测评)。已有 run 中符合条件的网络失败任务可按[网络故障补测](../network-retry.zh-CN.md)恢复。
