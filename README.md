# 苍霞乐跑 · 全自动打卡（AutoX.js + FakeLoc）

福建理工大学「苍霞乐跑」微信小程序的**定时全自动**方案：

> 定时触发 → 虚拟定位路线模拟 → 自动打开小程序开跑 → 里程达标自动结束 → 清理后台

全程无需人工干预，**息屏也能跑**。

---

## 一、原理

```
[定时触发 AutoX 定时任务]
        │
        ├─ ⓪ root 前置保障：唤醒屏幕 / 保常亮 / 确保无障碍 + 通知使用权
        │
        ├─ ① 拉起 FakeLoc 界面 → 广播 START_ROUTE → 采样坐标确认推进
        │      （ColorOS 会拦截后台启动，必须先拉起界面）
        │
        ├─ ② 回桌面 → 点「苍霞乐跑」快捷方式 → 微信小程序
        │
        ├─ ③ 首页点「校园乐跑」→ 跑步页
        │
        ├─ ④ 点「开始乐跑」→ 关掉「成绩合格标准」弹窗
        │
        ├─ ⑤ 地图页点「开始乐跑」→ 正式开跑
        │
        ├─ ⑥ 等达标：轮询通知栏里的 FakeLoc 达标通知（root）
        │      └ 兜底：按「配速 × 时长」推算的定时器
        │
        ├─ ⑦ 长按暂停 → 结束跑步 → 二次确认
        │
        └─ ⑧ 清场：停模拟 / 强杀微信 / 强杀 FakeLoc
```

**核心思路**：把"打开路线模拟"变成一条广播，把"里程监控"变成通知栏信号，
从而让整个流程只剩「点开始」「点结束」两个环节依赖 UI 自动化。

---

## 二、依赖与前置条件

| 组件 | 要求 |
| --- | --- |
| 手机 | Android 12+（实测 realme RMX3366 / Android 14 / realmeUI） |
| Root | Magisk（AutoX.js 需授权 root，用于读通知栏 / 开无障碍 / 强杀进程） |
| FakeLoc | 自编译的 LSPosed 模块，**必须含自动化入口**（见下） |
| AutoX.js | v6.6.8（Rhino 引擎，脚本需 ES5 语法） |
| 屏幕分辨率 | 坐标按 **1080x2400 @480dpi** 实测，其他分辨率需重新校准 |

### FakeLoc 需要含自动化入口

原版 FakeLoc 没有对外启停路线模拟的接口。本方案用的版本新增了：

- `AutomationReceiver`（exported=true）
  - action：`com.mo.fakeloc.automation.START_ROUTE` / `.STOP_ROUTE`
- `FakeLocationService` 新增 `ACTION_START_ROUTE` / `ACTION_STOP_ROUTE` 分支

改造见 [FakeLoc 仓库的 `feat/automation-entry` 分支](https://github.com/yhgeo/FakeLoc)。

### AutoX.js 需要的三个权限

| 权限 | 用途 | 脚本能否自愈 |
| --- | --- | --- |
| **root** | 读通知栏 / 改 secure settings / 强杀进程 | ❌ 需手动在 Magisk 授权 |
| **无障碍** | 点击、长按、读取控件 | ✅ 脚本用 root 自动打开 |
| **通知使用权** | 辅助判断 | ✅ 脚本用 root 自动打开 |

> ⚠️ **`am force-stop` AutoX.js 会连带关掉它的无障碍服务**（Android 既定行为），
> 之后需要重新开启。脚本已内置自愈逻辑，但尽量别手动 force-stop AutoX。

---

## 三、快速开始

### 1. 配置 FakeLoc

打开 FakeLoc，设置好：

| 项 | 建议值 | 说明 |
| --- | --- | --- |
| 路线 | 覆盖操场的闭环 | 必须经过小程序的 2 个打卡点 |
| 配速 | `4.5 min/km`（13.3 km/h） | **必须与脚本里 `RUN.paceMinPerKm` 一致** |
| 里程提醒 | `2.2 ~ 2.5 km` | 见下文「里程口径」说明 |
| 循环 | 开启 | 路线总长通常只有 0.5km，需要多圈 |

### 2. 授权 AutoX.js

- Magisk → 超级用户 → 给 AutoX.js 授权
- 打开 AutoX.js 的无障碍服务
- 打开 AutoX.js 的通知使用权

（后两项脚本能自动开，但首次建议手动确认一次）

### 3. 推送脚本

```bash
adb push scripts/caoxia-run.js /sdcard/脚本/caoxia-run.js
```

### 4. 配置定时任务

AutoX.js → 管理 → 定时任务 → 新建

- 脚本：`caoxia-run.js`
- 时间：**6:30** 与 **17:30**（落在学校规定的两个锻炼时段内）

### 5. 校准坐标（换设备必做）

```bash
# 截屏后按颜色找元素中心
python scripts/locate-color.py screenshot.png green --min-pixels 2000
```

---

## 四、脚本参数

### `RUN` —— 里程与时长（决定什么时候收工）

```js
var RUN = {
    targetKm: 2.0,          // 乐跑需要达到的里程（男生下限 2.0）
    paceMinPerKm: 4.5,      // ★ 必须与 FakeLoc 里的配速一致
    cxRatio: 0.93,          // 乐跑读数 / FakeLoc 理论里程（实测值）
    margin: 1.08,           // 兜底余量
    debugSeconds: 0         // >0 时直接指定跑步秒数（调试用）
};
```

兜底时长算法：

```
fakeLocKm = targetKm / cxRatio          // FakeLoc 需要跑的里程
speedMs   = 1000 / (paceMinPerKm × 60)  // 速度（m/s）
duration  = fakeLocKm × 1000 / speedMs × margin
```

以默认值计算：`2.0 / 0.93 = 2.15km → 3.70m/s → 580s × 1.08 = 627s ≈ 10.5 分钟`

### `XY` —— 坐标表

全部基于 1080x2400 实测，见下表。

---

## 五、实测坐标（1080x2400 @480dpi）

| 步骤 | 目标 | 坐标 |
| --- | --- | --- |
| ② | 桌面「苍霞乐跑」快捷方式 | `(909, 1235)` |
| ③ | 首页「校园乐跑」图标 | `(408, 729)` |
| ④ | 跑步页「开始乐跑」 | `(539, 1313)` |
| ⑤a | 「成绩合格标准」弹窗 →「我知道了」 | `(540, 1552)` |
| ⑤b | 「跑步提示」弹窗 →「自由跑」（仅时间窗外） | `(711, 1315)` |
| ⑥ | 地图页「开始乐跑」 | `(540, 2150)` |
| ⑦ | 跑步中「长按暂停」（长按 1200ms） | `(540, 2150)` |
| ⑧ | 暂停后「结束跑步」 | `(302, 2144)` |
| ⑨ | 二次确认弹窗「结束跑步」 | `(376, 1337)` |
| ⑩ | 小程序菜单「···」 | `(877, 182)` |
| ⑪ | 「重新进入小程序」 | `(716, 1900)` |

---

## 六、工作原理详解

### 6.1 为什么广播必须用 Java Intent

AutoX.js 的 `shell()` 以 **App uid** 运行命令，Android 14 下执行 `am broadcast` 会被拒：

```
java.lang.SecurityException: Permission Denial: broadcast asks to run as user -2
but is calling from uid u0a325
```

改用 Java 显式 Intent（带 ComponentName），普通 App 即可发送，无需任何权限：

```js
var it = new Intent(action);
it.setComponent(new ComponentName("com.mo.fakeloc",
                                  "com.mo.fakeloc.service.AutomationReceiver"));
context.sendBroadcast(it);
```

### 6.2 达标判定：为什么用通知栏而不是通知监听

AutoX.js 的 `events.observeNotification()` 在本机**收不到任何通知**
（`dumpsys` 里监听器明明是 Live 状态，连 adb 发的测试通知也触发不了回调）。

所以改用 **root + `dumpsys notification` 轮询**：

```js
dumpsys notification --noredact | grep -c 'NotificationRecord.*fakeloc_target'
```

记录开始时的基线条数，出现**新的**即判定达标。同时保留按配速推算的定时器兜底。

### 6.3 里程口径（重要）

**乐跑读数低于 FakeLoc 的理论里程**（实测偏差 5%~11%）：

| 时点 | 用时 | 乐跑显示 | FakeLoc 理论 | 偏差 |
| --- | --- | --- | --- | --- |
| 18:22 | 249s | 0.82 km | 0.92 km | -11% |
| 18:26 | 504s | 1.74 km | 1.87 km | -7% |
| 18:28 | 624s | 2.19 km | 2.31 km | -5% |
| 18:30 | 748s | 2.64 km | 2.77 km | -4.7% |

→ 所以 `route_notify_km` **不能设成 2.0**（那样乐跑只有 1.86km，不达标），
建议设 **2.2 ~ 2.5**。

> ⚠️ 不要设 3.0 —— 乐跑单次上限就是 3km，FakeLoc 跑 3km 时乐跑可能到 2.8~3.0km，有超上限风险。

### 6.4 清场

流程结束后（root）：

```js
am force-stop com.tencent.mm   // 关微信（连带小程序）
am force-stop com.mo.fakeloc   // 关 FakeLoc
```

不杀 AutoX 自身 —— 那会连带关掉无障碍，且脚本还没退出。

---

## 七、踩坑记录

按发现顺序，每一条都是实测踩出来的。

### 1. `shell("am broadcast")` 不可用

见 §6.1。改用 Java 显式 Intent。

### 2. Rhino 引擎不支持 `for...of`

AutoX.js v6.6.8 用 Rhino，脚本报：

```
syntax error (/storage/emulated/0/脚本/caoxia-run.js#140)
```

**全文必须用 ES5**：`for...of` → 传统 `for`；模板字符串 → 字符串拼接；`const/let` → `var`。

### 3. 「成绩合格标准」弹窗必须点掉

时间窗内进入地图页**必现**：

```
成绩合格标准
同时满足以下条件才会计为有效成绩
  里程: ≥2.00公里 / 打卡: 2次 / 配速: 4'0"~12'0"分钟/公里
[我知道了]
```

不点掉的话，后续点「开始乐跑」会被弹窗吞掉 → **假开跑**（用时卡在 `00:00:00`）。

### 4. ColorOS 拦截后台启动

光发广播唤不起 FakeLoc：

```
W OplusAppStartupManager: prevent start com.mo.fakeloc ... scenePriority = 0
E ActivityThread: Failed to find provider info for com.mo.fakeloc.config
```

**解法**：先 `app.launchPackage("com.mo.fakeloc")` 拉起界面，再广播。
脚本还会**采样两次坐标比对**确认真的在推进，不通过就重试（最多 3 轮）。

### 5. 「结束跑步」有二次确认弹窗

点「结束跑步」后必弹：

```
跑步提示
本次跑步距离不达标，将不会关联成绩，确定结束吗？
[结束跑步]  [继续跑步]
```

不处理就卡在这里，**跑步永远结束不了**。

### 6. AutoX 悬浮窗的 × 不保证终止脚本

点了 × 只关悬浮窗，脚本进程可能还在跑。**两个实例同时操作会搅乱跑步状态**
（旧实例先暂停了跑步 → 乐跑不计时 → 新实例算的里程与实际不符）。

→ 脚本内置**单实例锁**（`caoxia-run.lock`，90 分钟过期）。

### 7. 小程序自绘，无障碍读不到控件

`uiautomator dump` 整个页面只有 **765 字节** —— 全部自绘，零控件可读。

→ 只能**截屏 + 颜色定位**（`scripts/locate-color.py`），或者按实测坐标盲点。

### 8. 截屏权限缺失

`captureScreen()` 需要 MediaProjection 授权，未授权时抛：

```
java.lang.IllegalStateException: SecurityException: No screen capture permission
```

→ 脚本不依赖截屏，改用坐标盲点。

### 9. 小程序会恢复到上次的页面

按返回键**退不出**小程序（微信保留状态），下次打开仍停在「乐跑详情」页，
导致脚本第③步在首页找「校园乐跑」必然失败。

→ 正确做法：点右上角菜单 →「重新进入小程序」，或直接 `am force-stop com.tencent.mm`。

### 10. FakeLoc 的路线配置不在 `fakeloc.xml`

`/data/data/com.mo.fakeloc/shared_prefs/fakeloc.xml` 内容陈旧（只有 `engine_mode` /
`config_json` / `route_json`），**没有 `route_travelled_m` 等键**。
所以**无法直接读文件拿到实时里程**，达标判定只能靠通知栏或时间推算。

### 11. ★ 强杀微信会清掉小程序登录态

`am force-stop com.tencent.mm` 之后再打开小程序，会依次弹出：

```
「苍霞乐跑」启动页 → [立即登录] → 登录页(勾选协议) → [授权登录] → 首页
```

**必须全部点完才能进首页** —— 脚本原来的固定流程会全部点空，卡在登录页。

**修法两条（都已实现）**：

1. **清场不杀微信** —— `ui.closeMiniProgram()` 改用「···」→「重新进入小程序」
   温和退出，登录态保留
2. **脚本开头加登录兜底** —— `ui.handleLoginIfNeeded()` 检测到登录页就自动走
   「立即登录 → 勾选协议 → 授权登录」

> 页面识别靠 **root 截屏 + 像素采样**（`captureScreen()` 无 MediaProjection
> 授权，但 root 的 `screencap` 命令可以）。

### 12. ★ 桌面可能停在非第一页

脚本按固定坐标点桌面图标，但**用户手动翻页后图标就不在预期位置了**，点击点空。

**修法**：用 root 截屏采样图标位置的颜色，判断图标是否可见；不可见就尝试翻页，
最多 4 轮。日志里会打印 `第 N 轮：图标可见/不可见（root 截屏判定）`。

> **最省事的做法：把「苍霞乐跑」快捷方式固定在桌面第一页。**

### 13. `shell(cmd, true)` 的第二参数才是 root 标志

AutoX.js 的 `shell(cmd, root)` 里，**第二个参数**才表示用 root 执行。
拼 `su -c '...'` 会因引号被 AutoX 的 shell 吃掉而失败（实测读不到文件）。

另外返回值是 `ShellResult` 对象，要用 `.result` 取 stdout
（直接 `toString()` 得到的是 `ShellResult{code=0, error='', result='...'}` 这种格式）。

---

## 八、常见问题

### Q1：脚本运行时，步骤之间是固定等待还是靠识别元素？

**两者都有，以固定等待为主。**

- **点击前**：优先尝试 `text("开始乐跑").findOnce()` 按文字查找（原生控件有效）；
  小程序是自绘的，读不到文字，于是**回退到固定坐标点击**。
- **点击后**：用固定 `sleep` 等待页面渲染（各步骤 2.5~4.5 秒不等）。
- **唯一"条件驱动"的环节**：
  - 等微信到前台 —— 轮询 `currentPackage()`，最多 25 秒
  - 等达标 —— 轮询通知栏 + 定时器兜底
  - 启动模拟 —— 采样两次坐标比对确认推进

所以整体是**「固定节奏 + 关键节点条件判断」**，不是全条件驱动。

### Q2：脚本运行时我能用手机做别的操作吗？

**不能。**

脚本通过无障碍点击**当前屏幕的固定坐标**，还会主动 `home()`、`back()`、
`force-stop` 微信等。你的任何操作都会打断它：

- 切到别的 App → 后续点击落到错误的界面
- 手动返回/滑动 → 页面错位，坐标全部失效
- 息屏 → 脚本已内置 `WAKEUP` + 常亮，但仍建议别锁屏

**跑的时候把手机放着别动。**

### Q3：黑屏（息屏）时能自动跑完吗？

**能，脚本已处理：**

```js
// 唤醒屏幕
if (屏幕状态不含 "Awake") input keyevent KEYCODE_WAKEUP;
// 插电时常亮
svc power stayon true;
```

但有前提：

- **需要 root**（否则无法执行上述命令）
- 手机最好**插着电**（`stayon true` 只在插电时生效；纯电池下要另设息屏超时）
- 部分 ROM 在深度休眠下会限制后台启动 Activity，建议把 **AutoX.js 和 FakeLoc
  都加入「自启动白名单」+「电池不优化」**

---

## 九、合规声明

> ⚠️ **请先阅读**

- 「苍霞乐跑」是福建理工大学的**体育课程考核内容**，占体育课成绩的 20%，
  属毕业审核项。
- 学校通知明确将「**交通工具代跑、找人代跑、代他人跑步**」列为**违规**行为。
- 本项目仅为 **Android 自动化技术研究**（LSPosed hook / 无障碍自动化 /
  虚拟定位）的实践记录，**不构成任何使用建议**。
- 使用本项目产生的任何后果（成绩作废、纪律处分等）由使用者自行承担。
- 虚拟定位类工具的《使用条例》通常明确禁止用于校园跑、打卡场景，请自行查阅。

---

## 十、目录结构与模块划分

**代码按职责拆分，改一处不影响其他部分：**

```
.
├── README.md                     # 本文档
├── scripts/
│   ├── caoxia-run.js             # ★ 入口：只做流程编排（定时任务指向它）
│   ├── caoxia-lib/               # ★ 实现模块
│   │   ├── config.js             #   全部坐标与参数 ← 换设备/调参只改这个
│   │   ├── util.js               #   日志 / root / 单实例锁 / 环境保障
│   │   ├── fakeloc.js            #   FakeLoc 控制（启停/坐标/达标通知）
│   │   └── ui.js                 #   小程序 UI 操作（含登录页兜底）
│   ├── locate-color.py           # 按颜色定位元素（WebView/小程序场景）
│   └── recon-ui.py               # 控件树侦察（原生界面场景）
└── docs/
    └── 技术方案.md                # 完整技术方案与源码分析
```

**设备上的部署结构**（两个都要推）：

```
/sdcard/脚本/
├── caoxia-run.js                 ← 定时任务指向它
└── caoxia-lib/
    ├── config.js
    ├── util.js
    ├── fakeloc.js
    └── ui.js
```

```bash
# 一键部署
adb push scripts/caoxia-run.js  /sdcard/脚本/
adb push scripts/caoxia-lib     /sdcard/脚本/
```

### 改动时的影响范围

| 你要改什么 | 只动哪个文件 |
| --- | --- |
| 跑多少公里 / 配速 / 坐标 | `caoxia-lib/config.js` |
| FakeLoc 启停逻辑 | `caoxia-lib/fakeloc.js` |
| 小程序点击流程 | `caoxia-lib/ui.js` |
| 日志 / 权限 / 锁 | `caoxia-lib/util.js` |
| 整体流程顺序 | `caoxia-run.js` |

> `config.js` 与逻辑完全解耦 —— 升级脚本时**直接覆盖 lib 里的其他文件即可，
> 你的坐标和参数不会丢**。

---

## 十一、实测环境

| 项 | 值 |
| --- | --- |
| 设备 | realme RMX3366（GT 大师探索版） |
| 系统 | Android 14 / realmeUI `RMX3366_14.0.0.1310(CN01)` |
| Root | Magisk 27001 (Kitsune) |
| 屏幕 | 1080x2400 @480dpi |
| FakeLoc | v1.8.1 + 自动化入口 |
| AutoX.js | v6.6.8 (arm64-v8a) |

**验证结果**（2026-09-28 实测）：

| 项 | 值 |
| --- | --- |
| 里程 | 2.74 km（要求 ≥2.0） |
| 平均配速 | 04'44"（要求 4'00"~12'00"） |
| 打卡 | 2/2 |
| 轨迹 | 完整闭环，全程在绿色有效区域内 |
