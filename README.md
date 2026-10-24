# Zen-Dock

一个本地服务面板。把静态页面挂上去、把常驻服务管起来、把一次性脚本点着跑，全部在一个浏览器标签页里。

**零依赖，无构建步骤。** 不需要 `npm install`，没有打包器，源码直交付。`node index.mjs` 就能跑。

```
┌─────────────────────────────────────────────┐
│  Zen-Dock                        [+ 添加] [全停] │
├─────────────────────────────────────────────┤
│  ● Provider Relay   服务                     │
│    127.0.0.1:8787 · 2h14m                    │
│    [停止] [日志] [打开]                       │
└─────────────────────────────────────────────┘
```

## 快速开始

```bash
node index.mjs                 # 起服务，自动开浏览器
node index.mjs --no-open       # 不自动开
node index.mjs --port 7718     # 换端口
```

Windows 下双击 `zen-dock.ps1` 也行（支持 `-Restart` 先杀掉占用端口的旧实例）。

配置在 `hub.config.json`，可以直接手改，改完自动热重载；也可以在页面上点「+ 添加」改，两边同步。

首次运行时如果 `hub.config.json` 不存在，会自动从 `hub.config.example.json` 复制一份。**`hub.config.json` 不进仓库**——它含本机绝对路径，属于个人配置。模板里的路径写成 `./` 开头就按项目根解析，所以示例页面跨机器也能直接打开。

## 三种 item

| kind | 干什么 | 关键字段 |
|---|---|---|
| `service` | 常驻进程，有端口、能探活、能启停 | `cmd` `args` `cwd` `port` `url` |
| `script` | 一次性脚本，点一下跑完 | `shell` `path` `params` |
| `page` | 静态页面/目录，挂在 `/s/<id>/` | `dir` `entry` |

`script` 的 `shell` 支持 `powershell` / `python` / `bat`。`params` 会在详情页渲染成输入框：

```json
{
  "id": "relay-ps",
  "kind": "script",
  "name": "Relay 启动脚本",
  "shell": "powershell",
  "path": "M:/path/to/run-relay.ps1",
  "cwd": "M:/path/to",
  "params": [
    { "name": "port", "flag": "--port", "type": "number", "default": 8787 },
    { "name": "logCalls", "flag": "--log-calls", "type": "boolean", "default": false }
  ]
}
```

## 状态机

```
stopped → starting → running → stopping → stopped
              ↓ 超时/退出
           failed / crashed
```

`starting` 由 **TCP 探活**结束，不是「进程起来了就算」。所以卡片变绿的含义是「端口真的能连上了」。

没有配 `port` 的 service 只检查进程存活。

## 三个 Windows 坑，已经处理了

**1. 孙进程杀不掉。** `spawn` 一个 `npm run dev`，杀父进程孙子还在跑、端口还占着。所以停止一律走 `taskkill /PID x /T /F`，杀整棵树。

**2. 没有优雅停止。** Node 的 `SIGTERM` 在 Windows 上就是 `TerminateProcess`；`taskkill` 不带 `/F` 发的是 `WM_CLOSE`，只对 GUI 窗口有效，对控制台程序完全没用。所以「停止」的真实语义是强杀。需要收尾的服务请自己处理信号，别指望这里。

**3. 编码。** 子进程输出是 Buffer，可能被多字节字符切断，所以按字节找 `\n` 再解码。UTF-8 严格解码失败自动回退 GBK——这样 GBK 编码的 `.bat` 和 PowerShell 5.1 的中文输出都不会乱码，比强设 `chcp 65001` 可靠（强设反而会让 GBK 编码的 bat 文件本身解析乱码）。

Python 单独设 `PYTHONUTF8=1` + `-u`，保证直接吐 UTF-8 且日志实时可见（不加 `-u` 输出被缓冲，日志面板会一片空白）。

## 接管

hub 重启后，之前跑着的服务不会丢：

1. `hub.state.json` 记了 pid，用 `process.kill(pid, 0)` 验证还活着 → 直接接管
2. pid 对不上（比如你手动起的）→ 按端口反查 `netstat -ano`，标 `external: true` 接管

接管来的进程停止时一样是强杀整棵树。

## 安全

只绑 `127.0.0.1`，另外校验 `Origin` 和 `Sec-Fetch-Site`。

这层不是多余的：你开着的任何网页都能 `fetch('http://127.0.0.1:7717/api/items/x/run')`，没有校验等于给所有网站开了个能执行脚本的后门。

不做 token，因为只本机用。要开局域网访问的话得自己加。

## 已知限制

- **静态页面的绝对路径会 404。** 页面里写 `/css/a.css` 这种以 `/` 开头的路径找不到，因为站点根是 `/s/<id>/` 不是域名根。注入 `<base>` 只能修好相对路径。要彻底解决得给每个站点独立端口或子域，P0 不做。
- **日志只在内存。** 每项默认保留 500 行，重启即丢。要历史得落盘，没做。
- **不做反向代理。** 各服务保留自己的端口，hub 只负责发现、启停、跳转。relay 的 `/__relay/` 面板是它自己的，hub 不重造。
- **崩溃不自动重启。** 自己用的工具，崩了就崩了，看日志改代码。自动重启只会掩盖 bug。

## 目录

```
index.mjs                    入口
zen-dock.ps1                 双击启动
hub.config.example.json      配置模板（进仓库）
hub.config.json              你的实际配置（不进仓库，首次运行自动生成）
hub.state.json               运行时 pid，自动写（不进仓库）
lib/
  server.js        路由 + Origin 校验 + SSE
  config.js        配置读写校验（原子写）
  services.js      常驻进程：spawn / 探活 / 强杀 / 接管
  scripts.js       三种 shell + 参数拼接
  logs.js          环形缓冲 + GBK 回退解码
  sites.js         静态托管 + <base> 注入
  panel.js         管理页（内联 CSS/JS）
sites/<id>/        静态页面
test-scripts/      冒烟测试
```

## 冒烟测试

```bash
node index.mjs --no-open &
node test-scripts/smoke.mjs
```

跑三种 shell 各一次，验证中文不乱码、退出码正确。

## 环境

Node 20+。Windows 是主要目标平台，Linux/macOS 上脚本那部分能跑但没细测。
