# 测试夹具

`smoke.mjs` 用的三个一次性脚本，用来验证三种 shell 的启动和输出解码。

| 文件 | shell | 验证什么 |
|---|---|---|
| `t.py` | python | UTF-8 输出直通 |
| `t.bat` | bat | **GBK 输出**（`chcp 936`），文件本身也是 GBK 编码 |
| `t.ps1` | powershell | **UTF-8 BOM**，PS 5.1 没 BOM 会把中文读成乱码 |

## 为什么 `t.bat` 里是乱码

```
echo BAT ÖÐÎÄÊä³ö²âÊÔ
```

这不是损坏。文件是 **GBK 编码**，用 UTF-8 打开就会显示成这样。它存在的意义正是
**故意让解码器走 GBK 回退分支**——如果哪天 `decodeBuffer` 的 fallback 被删了，
这个夹具会立刻暴露出来。

改这两个文件时别让编辑器把它们转成 UTF-8，否则测的就不是原来那条路径了。
`t.ps1` 必须保留 UTF-8 BOM（前三个字节 `EF BB BF`）。
