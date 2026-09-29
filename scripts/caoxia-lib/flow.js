/**
 * caoxia-lib/flow.js —— 主流程编排
 * ============================================================================
 *
 * 生产入口 caoxia-run.js 与调试入口 caoxia-run-debug.js **共用这一份流程**，
 * 差别只在入口里设置的开关（见 config.js 的 CFG.debug / RUN.debugSeconds）。
 *
 * 流程：
 *   ⓪ 环境保障：唤醒屏幕 → 解锁 → 保常亮 → 确保无障碍 + 通知使用权
 *   ① 启动 FakeLoc 路线模拟（拉起界面 → 广播 → 采样坐标确认推进）
 *   ② 打开小程序（含登录页兜底）
 *   ③ 首页 → 校园乐跑 → 开始乐跑 → 关弹窗 → 地图页开始
 *   ④ 等达标（通知栏轮询为主 + 定时器兜底）
 *   ⑤ 长按暂停 → 结束跑步 → 二次确认
 *   ⑥ 清场（停 FakeLoc / 温和关小程序）
 */

var C = require("./config.js");
var U = require("./util.js");
var F = require("./fakeloc.js");
var UI = require("./ui.js");
var R = require("./recorder.js");

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
    var nextSample = start;

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
        // 调试：等达标期间定时补截图（录像万一丢了还能靠这个复盘）
        if (Date.now() >= nextSample) {
            R.sample(Math.round((Date.now() - start) / 1000));
            nextSample = Date.now() + C.REC.sampleSeconds * 1000;
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
    if (C.CFG.debug) U.log("🐞 调试模式：全程录屏 + 每步截图");

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

    // ⓪ 环境保障（唤醒屏幕 → 解锁 → 无障碍/通知权限）
    //    解锁失败（手机设了密码）必须中止，否则会在锁屏上乱点
    if (!U.prepareEnvironment()) return;

    // ★ 屏幕已亮，开始录屏（调试版才真正录）
    R.start();
    R.snap("00-已解锁");

    // ① 启动路线模拟
    if (!F.startRoute()) {
        U.log("❌ 路线模拟启动失败，中止");
        return;
    }
    R.snap("01-FakeLoc已启动");

    // ② 打开小程序（含登录页兜底）
    UI.openMiniProgram();

    // ③ 进跑步页 → 开始 → 关弹窗 → 正式开跑
    UI.enterRunPage();
    UI.tapStart();
    UI.closeMapDialogs();

    // ★ 校验是否真的跑起来了 —— 没跑起来就别白等 10 分钟
    if (!UI.startRunning()) {
        U.log("❌ 没能进入跑步状态 → 本次不可能产生成绩，直接清场");
        U.log("清理后台");
        F.shutdown();
        UI.closeMiniProgram();
        if (!C.CFG.dryRun) home();
        R.snap("99-流程结束");
        U.log("=== 流程结束 ===");
        return;
    }
    U.log("🏃 已开始跑步，等待达标…");

    // ④ 等达标
    if (waitTargetDistance()) U.log("🎯 里程已达标");

    // ⑤ 结束跑步（必须校验，否则跑步没结束 → 小程序重启后成绩作废）
    if (UI.stopRunning()) {
        U.log("✅ 跑步已正常结束");
    } else {
        U.log("❌ 跑步未能正常结束！该次成绩很可能作废（看 diag 里的 step_06/08 截图）");
    }

    // ⑥ 清场
    U.log("清理后台");
    F.shutdown();
    UI.closeMiniProgram();
    if (!C.CFG.dryRun) home();
    sleep(1000);

    R.snap("99-流程结束");
    U.log("=== 流程结束 ===");
}

// ======================= 入口（含单实例锁）=======================

function run() {
    try {
        if (U.acquireLock()) main();
    } catch (e) {
        U.log("💥 异常: " + e);
        try { F.stop(); } catch (e2) { }
    } finally {
        R.stop();
        U.releaseLock();
    }
}

module.exports = {
    run: run,
    computeRunMs: computeRunMs
};
