/**
 * 苍霞乐跑 · 全自动跑步脚本【生产入口】
 * ============================================================================
 *
 * 本文件只是入口，**流程实现全在 caoxia-lib/ 下**，各自独立：
 *
 *   caoxia-lib/config.js     ★ 全部坐标与参数 —— 换设备/调参只改这个
 *   caoxia-lib/util.js       日志 / root / 单实例锁 / 环境保障
 *   caoxia-lib/fakeloc.js    FakeLoc 控制（启停 / 坐标 / 达标通知）
 *   caoxia-lib/ui.js         小程序 UI 操作（含登录页兜底）
 *   caoxia-lib/recorder.js   调试用录屏 + 截图（生产版不生效）
 *   caoxia-lib/flow.js       ★ 主流程（生产/调试两个入口共用）
 *
 * ---------------------------------------------------------------------------
 * 部署结构（全部放到 /sdcard/脚本/ 下）：
 *
 *   /sdcard/脚本/
 *   ├── caoxia-run.js          ← 生产版，定时任务指向它
 *   ├── caoxia-run-debug.js    ← 调试版（全程录屏），手动跑
 *   └── caoxia-lib/
 *       ├── config.js
 *       ├── util.js
 *       ├── fakeloc.js
 *       ├── ui.js
 *       ├── recorder.js
 *       └── flow.js
 *
 * 一键部署（PC 侧）：
 *   adb push scripts/caoxia-run.js        /sdcard/脚本/
 *   adb push scripts/caoxia-run-debug.js  /sdcard/脚本/
 *   adb push scripts/caoxia-lib           /sdcard/脚本/
 * ---------------------------------------------------------------------------
 *
 * 调试需求请改用 caoxia-run-debug.js（同样的流程 + 全程录屏 + 每步截图）。
 *
 * ============================ 修订记录 ============================
 * 2026-09-28 V7 —— 模块化重构
 *   · 拆成 config / util / fakeloc / ui 四个独立模块
 *   · 新增登录页兜底（微信被强杀后会出现「立即登录」页）
 *   · 清场**不再强杀微信**（那会清掉登录态，导致下次要重新登录）
 * 2026-09-29 V8 —— 流程与入口解耦 + 调试版
 *   · 主流程抽到 caoxia-lib/flow.js，生产/调试两个入口共用
 *   · 新增 caoxia-run-debug.js：全程录屏（root screenrecord）+ 每步截图
 * ==================================================================
 */

var C = require("./caoxia-lib/config.js");

C.CFG.debug = false;    // ★ 生产版：不录屏、不截图，零开销

require("./caoxia-lib/flow.js").run();
