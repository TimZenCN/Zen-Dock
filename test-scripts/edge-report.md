# 圆环坞「奇怪底边」现场诊断报告

## 1. 那条边在哪

窗口坐标中心 (200,200)，**8 块扇区全周 0°–360° 都有**，两处：

| 位置 | 半径 | 对应像素行 |
|---|---|---|
| 内弧带 | r = 64.5 ~ 66（SVG 内径 66 的外侧 1.5px） | r=65、66 |
| 外弧带 | r = 184 ~ 185.5（SVG 外径 184 的外侧 1.5px） | r=185 |
| 径向边 | 扇区边界 ±20° 处 | 1px 亮线 |

宽度：内弧 2px、外弧 1px（个别角度 0–2px，随 18 段多边形离散抖动），径向边 1px。

## 2. 颜色（4 背景实测，BitBlt 屏幕 DC）

| 背景 | 内弧 r=65 | 内弧 r=66 | 外弧 r=185 | 45° r=184 AA | 225° r=184 AA | 间隙 22.5° r=125 |
|---|---|---|---|---|---|---|
| #ffffff | #f0f0f0 | #f0f0f0 | #f0f0f0 | #686b72 | #83858b | #ffffff |
| #000000 | #f0f0f0 | #f0f0f0 | #f0f0f0 | #686b72 | #83858b | #000000 |
| #ff0000 | #f0f0f0 | #f0f0f0 | #f0f0f0 | #686b72 | #83858b | #ff0000 |
| #808080 | #f0f0f0 | #f0f0f0 | #f0f0f0 | #686b72 | #83858b | #808080 |

**边和抗锯齿像素的颜色 4 种背景完全一致 → 不是 alpha/抗锯齿问题，是"画上去的东西"。**

## 3. 根因

窗口的"透明"100% 来自 `SetWindowRgn` 硬裁，**窗口本身底色是不透明的 #F0F0F0**（WinForms Form 默认 `SystemColors.Control`）。

证据链：

1. 把活动窗口的区域临时改成整窗 400×400 → **整个窗口（四角、扇区间隙、圆心）全部变 #f0f0f0**；改成 r=120 的圆 → 圆内扇区间隙立刻变 #f0f0f0。说明页面的透明处下面垫着一块不透明 #f0f0f0。
2. `.venv/.../webview/platforms/winforms.py:286-292`：`transparent=True` 分支**只**设 `browser.DefaultBackgroundColor = Color.Transparent`，**不设 `self.BackColor`**（只有 else 分支设），Form 底色保持默认 #F0F0F0。
3. `shell/desktop.py:366-367` 把区域**外扩 1.5px**（`R = r_out + 1.5`、`r = r_in - 1.5`），这 1.5px 内没有任何 SVG 覆盖 → 露出的就是那块 #F0F0F0。
4. 同理 SVG 的抗锯齿是跟 #F0F0F0 混的，不是跟桌面混，所以 AA 像素恒为 #686b72 / #83858b。
5. `background_color="#000000"` 在该分支被忽略 → 用户"换背景色也一样"。

`#f0f0f0` 像素总量 1708 个，全部落在 r=64~67 与 r=183~186。

## 4. 修法（实测有效）

**主方案**：`shell/desktop.py` 的 `_apply_ring_region`，在第 385 行 `user32.SetWindowRgn(hwnd, total, True)` 之前插入颜色键：

```python
ex = user32.GetWindowLongW(hwnd, -20)
user32.SetWindowLongW(hwnd, -20, ex | 0x80000)          # WS_EX_LAYERED
user32.SetLayeredWindowAttributes(hwnd, 0x00F0F0F0, 0, 0x1)  # LWA_COLORKEY
```

实测：4 种背景下 #f0f0f0 像素 1708 → 0；白/灰/红底扇形外侧 3px 内异常像素 0 个；黑底外弧最亮值 240 → 40（等于扇区本色）。

**备选**（不推荐）：把 `desktop.py:366-367` 改成内缩 `R = r_out - 2`、`r = r_in + 2`，配合角度再收 1°（`half - 1.0`）。实测 #f0f0f0 归零，但边缘变成硬锯齿、环径缩水 2px。

## 5. 过程说明

未改动 `shell/desktop.py` / `lib/panel.js` 任何一行，所有验证都是运行期用外部 `SetWindowRgn` / `SetLayeredWindowAttributes` 完成，无需还原。测试期间最小化了 Magpie 与 TTVPWindowForm，结束后已恢复。

脚本：`test-scripts/diag_edge.py`（4 背景扫描）、`diag_edge4.py`（整窗区域）、`diag_edge5.py`（方案 A/B/C/D 对比）、`diag_edge6.py`（浅色底复验）。
