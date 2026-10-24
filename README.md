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

### 浏览器

```bash
node index.mjs                 # 起服务，自动开浏览器
node index.mjs --no-open       # 不自动开
node index.mjs --port 7718     # 换端口
```

Windows 下双击 `zen-dock.ps1` 也行（支持 `-Restart` 先杀掉占用端口的旧实例）。

### 桌面窗口

不想开浏览器就双击 `zen-dock-window.bat`。

**首次使用**先双击 `shell/setup.bat`，它会创建 `.venv` 并装上 pywebview / pystray（需要系统里有 Python 3.10+）。

窗口是原生 WinForms 窗口 + 系统 WebView2 渲染，不是浏览器套壳：自己的标题栏、自己的图标、自己的大小和位置。

关掉窗口之后干什么，在**设置**里选：

- **退出程序**（默认）—— 连自己启动的服务一起停掉
- **最小化到托盘** —— 窗口隐藏，服务继续跑，点托盘图标恢复

**外壳和核心是分开的。** `index.mjs` 依然是零依赖的纯 Node 服务，不装 pywebview 也能用浏览器访问，`shell/` 只是多一层可选外壳。

端口上已经有服务在跑时（比如你先用浏览器开了），窗口会直接连过去，关窗口**不会**杀那个服务。

改图标配色或字形：`.venv/Scripts/python.exe shell/make_icon.py`。

### 静默启动

```bash
pythonw shell/desktop.py --hidden
```

不显示主窗口，直接进托盘，靠热键或托盘图标唤出。**开机自启注册的就是这个模式**，所以开机不会弹窗。

### 拓展坞

按 **Alt+X**（可在设置里改），在鼠标附近弹出一个精简面板：

- 无边框、置顶，出现在鼠标右下角；贴边时自动翻到内侧，多屏按鼠标所在屏算
- 只显示卡片，没有「添加」「设置」
- **整张卡点一下就启动**，不用找按钮
- 启动结果等探活：成功才关坞，失败原地显示错误
- 其余操作（日志 / 打开所在文件夹 / 编辑 / 删除）都在右下角三点菜单里
- 点「日志」会关掉坞、打开主窗口并直接展开那张卡的日志抽屉
- **真失焦就关**：点到任何别的地方（包括别的程序）自动消失，Esc 也能关

热键是系统级注册（`RegisterHotKey`），不是键盘钩子——所以能真做冲突检测：注册失败就说明被别的程序占了，设置页会直接告诉你。改热键时如果新的注册不上，会自动把旧的恢复回来，不会让你失去唤出能力。

## 命令行（zd）

不开浏览器也能管理。装一次：

```powershell
.\install-cli.ps1          # 写进用户 PATH，不碰系统 PATH，不需要管理员
```

装完**新开一个终端**，`zd` 就能用了。查状态 `.\install-cli.ps1 -Status`，撤销 `-Uninstall`。

脚本会把原 PATH 备份到 `shell/path-backup-<时间>.txt`，并且保持注册表类型（`REG_EXPAND_SZ`）——直接 `SetEnvironmentVariable` 会把它降级成 `REG_SZ`，`%USERPROFILE%` 这类变量就被固化了。

### 命令

```
zd                        列出所有项（= zd list）
zd status                 hub 自身：地址、项数、在跑什么
zd show <id>              单项详情
zd start <id>             启动，等端口探活通过才返回
zd stop <id>              停止，taskkill 整棵进程树
zd restart <id>
zd run <id> [--参数 值]   跑脚本，参数按脚本的 params 映射
zd logs <id> [-f] [-n 50] 看日志，-f 跟随
zd open <id>              用设置的浏览器打开
zd add                    注册新项（不带参数进向导）
zd edit <id> --port 8888
zd rm <id> [-f]
zd settings [key=value]
zd stop-all
zd up                     前台启动 hub
zd help [命令]
```

### 注册

不带参数走交互向导，逐项问、带默认值：

```
$ zd add
类型 (service / script / page) [service]:
ID（字母数字下划线连字符）: relay
名称 [relay]: Provider Relay
启动命令（如 node / python / npm）: node
参数，空格分隔（可留空）: index.mjs
工作目录（可留空 = 项目根）: D:/work/.../provider-relay
监听端口（可留空 = 不做端口探活）: 8787
```

带参数直接写，适合脚本和 AI 调用：

```bash
zd add service relay --name "Provider Relay" --cmd node --args "index.mjs" --port 8787
zd add script deploy --name "部署" --shell powershell --path "run.ps1"
zd add page notes --name "笔记" --dir "./sites/notes"
```

### hub 没在跑的时候

CLI 按命令性质走两条路，不是所有命令都要求 hub 在线：

| 命令 | hub 不在时 |
|---|---|
| `list` `show` `add` `edit` `rm` `settings` | 照常可用，直接读写 `hub.config.json` |
| `start` `stop` `run` `logs` `open` | 报错，提示先 `zd up` |

原因是**进程状态只活在 hub 的内存里**。CLI 自己去 spawn 一个服务，面板不知道、日志收不到、也停不掉，两边状态会打架。配置则是文件，hub 有热重载，改完自己就认到了。

`zd up` 是前台跑 `node index.mjs --no-open`，能看到启动日志，Ctrl+C 退出。它不会偷偷在后台起进程——要托盘和拓展坞，双击 `zen-dock-window.bat`。

### 输出

默认对齐表格 + 状态色。所有命令都支持 `--json`：

```bash
zd --json list | jq '.items[] | select(.runtime.status == "running") | .id'
```

`--no-color` 或环境变量 `NO_COLOR` 关颜色；输出被重定向时自动关。

退出码：`0` 成功，`1` 出错，`2` hub 没在跑。

## 设置

右上角「设置」：

| 项 | 说明 |
|---|---|
| 打开页面 | **新浏览器窗口**（带地址栏，能复制 URL）或**无地址栏独立窗口**（`--app` 模式，像独立应用） |
| 关闭窗口时 | 退出程序 / 最小化到托盘。只在桌面窗口里有效 |
| 打开页面用的浏览器 | 自动（优先 Chrome）或指定某个 Chromium 系浏览器。检测不到就退回系统默认，但那样只能开成标签页 |
| 唤出拓展坞 | 全局热键，默认 `alt+x`。点「应用」当场注册，失败会报冲突 |
| 开机自启 | 写进 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，不需要管理员权限。设置页会显示当前是否已注册、注册的具体命令是什么 |

「打开页面」走的是服务端 `spawn` 而不是前端 `window.open`——只有这样才能真正控制窗口形态（`--new-window` / `--app`），在 WebView2 里也不会被拦。

## 卡片操作

每张卡片两个按钮 + 一个三点菜单：

- 主按钮：启动 / 停止 / 运行
- **打开页面**：服务和静态页面都有，在独立浏览器窗口里打开
- **⋮ 菜单**：日志、打开所在文件夹、编辑、删除

「打开所在文件夹」对脚本会定位并选中文件本身，对服务和页面直接打开目录。

## 配置

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
- **桌面外壳只在 Windows 测过。** pywebview 本身跨平台，但 `desktop.py` 里的 `taskkill`、`CREATE_NO_WINDOW`、`MessageBoxW` 都是 Windows 专属分支。另外它依赖系统 WebView2 运行时（Win10/11 一般自带，Win7 要单独装）。
- **托盘图标可能被系统折叠。** Windows 默认会把新托盘图标塞进 `^` 折叠区，需要自己拖出来固定。
- **拓展坞焦点可能抢不到。** 系统有"前台锁定"，`SetForegroundWindow` 会被挡。代码用 `AttachThreadInput` 绕过并重试到焦点稳定；万一始终不稳，会跳过失焦自动关闭（坞仍然能开，按 Esc 或再按热键关），不会出现"一开就关"。
- **热键是全局独占的。** 注册成功后别的程序收不到这个组合。有些软件用 Alt+字母做菜单，撞了就在设置里换一个。
- **开机自启注册的是桌面窗口，不是服务。** 开机后窗口会自己起服务；如果你改成了「退出程序」，关窗口就等于全关。
- **`zd` 的 Ctrl+C 只在真终端里可靠。** Windows 没有 POSIX 信号，Node 的 `SIGINT` 靠控制台事件模拟。在 Windows Terminal / PowerShell / cmd 里按 Ctrl+C 正常；从 Git Bash 用 `kill -INT` 或 `timeout -s INT` 打过去可能到不了。真按不动就再按一次，第二次会强制退出。
- **`--port` 是 item 的端口，hub 端口是 `--hub-port`。** 两个不能共用一个名字，否则 `zd edit x --port 8888` 会被当成去连 8888 上的 hub。
- **`zd add` 的向导在管道输入下可能提前结束。** 把答案 `echo` 进去时，输入读完就 EOF，后面的问题拿不到值。手动在终端里跑没有这个问题。

## 目录

```
index.mjs                    入口
zen-dock.ps1                 浏览器启动（PowerShell）
zen-dock-window.bat          桌面窗口启动
zd.cmd / zd                  CLI 包装（ASCII-only，cmd.exe 按 OEM 代码页读文件）
install-cli.ps1              把项目目录写进用户 PATH（幂等 + 备份）
hub.config.example.json      配置模板（进仓库）
hub.config.json              你的实际配置（不进仓库，首次运行自动生成）
hub.state.json               运行时 pid，自动写（不进仓库）
bin/
  zd.mjs                     CLI 入口：参数解析 / 命令分发 / help
lib/
  server.js                  路由 + Origin 校验 + SSE
  config.js                  配置读写校验（原子写）+ 相对路径解析
  services.js                常驻进程：spawn / 探活 / 强杀 / 接管
  scripts.js                 三种 shell + 参数拼接
  logs.js                    环形缓冲 + GBK 回退解码
  sites.js                   静态托管 + <base> 注入
  system.js                  开浏览器窗口 / 开资源管理器 / 开机自启注册表
  panel.js                   管理页（内联 CSS/JS）
  cli/
    client.js                hub 探测 + HTTP + SSE 消费
    format.js                表格（CJK 宽度感知）/ 着色 / JSON
    commands.js              14 个命令的实现
shell/
  desktop.py                 桌面窗口外壳（pywebview + WebView2 + pystray 托盘 + 拓展坞）
  hotkey.py                  全局热键（RegisterHotKey + 消息循环）
  setup.bat                  首次建 .venv
  make_icon.py               生成 shell/icon.ico
  requirements.txt           外壳依赖（pywebview / pystray / pillow）
sites/<id>/                  静态页面
test-scripts/                冒烟测试
```

## 冒烟测试

```bash
node index.mjs --no-open &
node test-scripts/smoke.mjs
```

跑三种 shell 各一次，验证中文不乱码、退出码正确。

## 环境

- **核心**：Node 20+，零依赖
- **桌面窗口**：Python 3.10+（只用来跑 `shell/desktop.py`）+ 系统 WebView2 运行时
- Windows 是主要目标平台。Linux/macOS 上核心能跑，脚本那部分没细测，桌面外壳的 Windows 分支会退化
