/**
 * 苍霞乐跑 · 全自动跑步脚本（入口）
 * ============================================================================
 *
 * 本文件只做**流程编排**，具体实现都在 caoxia-lib/ 下，各自独立：
 *
 *   caoxia-lib/config.js    ★ 全部坐标与参数 —— 换设备/调参只改这个
 *   caoxia-lib/util.js      日志 / root / 单实例锁 / 环境保障
 *   caoxia-lib/fakeloc.js   FakeLoc 控制（启停 / 坐标 / 达标通知）
 *   caoxia-lib/ui.js        小程序 UI 操作（含登录页兜底）
 *
 * ---------------------------------------------------------------------------
 * 部署结构（两个都要放到 /sdcard/脚本/ 下）：
 *
 *   /sdcard/脚本/
 *   ├── caoxia-run.js          ← 定时任务指向它
 *   └── caoxia-lib/
 *       ├── config.js
 *       ├── util.js
 *       ├── fakeloc.js
 *       └── ui.js
 *
 * 一键部署（PC 侧）：
 *   adb push scripts/caoxia-run.js        /sdcard/脚本/
 *   adb push scripts/caoxia-lib           /sdcard/脚本/
 * ---------------------------------------------------------------------------
 *
 * 流程：
 *   ⓪ 环境保障：唤醒屏幕 / 保常亮 / 确保无障碍 + 通知使用权
 *   ① 启动 FakeLoc 路线模拟（拉起界面 → 广播 → 采样坐标确认推进）
 *   ② 打开小程序（含登录页兜底）
 *   ③ 首页 → 校园乐跑 → 开始乐跑 → 关弹窗 → 地图页开始
 *   ④ 等达标（通知栏轮询为主 + 定时器兜底）
 *   ⑤ 长按暂停 → 结束跑步 → 二次确认
 *   ⑥ 清场（停 FakeLoc / 关小程序 / 关 FakeLoc 进程）
 *
 * ============================ 修订记录 ============================
 * 2026-09-28 V7 —— 模块化重构
 *   · 拆成 config / util / fakeloc / ui 四个独立模块
 *   · 新增登录页兜底（微信被强杀后会出现「立即登录」页）
 *   · 清场**不再强杀微信**（那会清掉登录态，导致下次要重新登录）
 * ==================================================================
 */

var C = require("./caoxia-lib/config.js");
var U = require("./caoxia-lib/util.js");
var F = require("./caoxia-lib/fakeloc.js");
var UI = require("./caoxia-lib/ui.js");

// ======================= 达标判定 =======================

/** 推算兜底时长（毫秒） */
function computeRunMs() {
    if (C.RUN.debugSeconds > 0) return C.RUN.debugSeconds * 1000;
    var fakeLocKm = C.RUN.targetKm / C.RUN.cxRatio;
    var speedMs = 1000 / (C.RUN.paceMinPerKm * 60);
    return Math.round(fakeLocKm * 1000 / speedMs * 1000 * C.RUN.margin);
}

/**
 * 等达标。两条路并行：
 *   主：通知栏出现**新的** fakeloc_target 通知（比基线多）—— 真实里程信号
 *   兜底：按配速推算的定时器
 */
function waitTargetDistance() {
    U.log("等待里程达标…");

    var baseline = F.notifyCount();
    U.log("  通知栏基线: " + (baseline < 0 ? "读不到（root 不可用？）" : baseline + " 条"));
    U.log("  兜底时长: " + Math.round(computeRunMs() / 1000) + "s");

    var start = Date.now();
    var deadline = start + C.CFG.timeout.maxRun;
    var fallbackAt = start + computeRunMs();
    var hit = null;

    while (Date.now() < deadline) {
        if (baseline >= 0) {
            var now = F.notifyCount();
            if (now > baseline) {
                U.log("✅ 达标通知已出现（" + baseline + " → " + now + "）");
                hit = "notify";
                break;
            }
        }
        if (Date.now() >= fallbackAt) {
            U.log("⏱ 兜底定时器到点（已跑 " + Math.round((Date.now() - start) / 1000) + "s）");
            hit = "timer";
            break;
        }
        sleep(2000);
    }

    if (!hit) U.log("⚠️ 超时未达标");
    else U.log("达标判定方式: " + hit);
    return hit;
}

// ======================= 主流程 =======================

function main() {
    U.log("=== 苍霞乐跑自动化启动（V7 模块化）===");

    var rootOk = U.detectRoot();
    U.log("root: " + (rootOk ? "✅ 可用" : "❌ 不可用（降级为定时器模式）"));

    if (C.CFG.probeOnly) {
        U.log("[probe] 屏幕: " + U.trim(U.sh("dumpsys power | grep mWakefulness= | head -1")));
        U.log("[probe] 无障碍: " + U.trim(U.sh("settings get secure enabled_accessibility_services")));
        U.log("[probe] 通知栏达标数: " + F.notifyCount());
        U.log("[probe] 当前前台: " + U.currentApp());
        U.log("probeOnly=true，探测结束");
        return;
    }

    // ⓪ 环境保障
    U.prepareEnvironment();

    // ① 启动路线模拟
    if (!F.startRoute()) {
        U.log("❌ 路线模拟启动失败，中止");
        return;
    }

    // ② 打开小程序（含登录页兜底）
    UI.openMiniProgram();

    // ③ 进跑步页 → 开始 → 关弹窗 → 正式开跑
    UI.enterRunPage();
    UI.tapStart();
    UI.closeMapDialogs();
    UI.startRunning();
    U.log("🏃 已开始跑步，等待达标…");

    // ④ 等达标
    if (waitTargetDistance()) U.log("🎯 里程已达标");

    // ⑤ 结束跑步
    UI.stopRunning();

    // ⑥ 清场
    U.log("清理后台");
    F.shutdown();
    UI.closeMiniProgram();
    if (!C.CFG.dryRun) home();
    sleep(1000);

    U.log("=== 流程结束 ===");
}

// ======================= 入口 =======================

try {
    if (U.acquireLock()) main();
} catch (e) {
    U.log("💥 异常: " + e);
    try { F.stop(); } catch (e2) { }
} finally {
    U.releaseLock();
}
