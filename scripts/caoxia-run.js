/**
 * 苍霞乐跑 · 全自动跑步脚本（AutoX.js）
 * ============================================================================
 *
 * 链路：
 *   ⓪ root 前置保障：唤醒屏幕 / 保常亮 / 确保无障碍 + 通知监听
 *   ① 启动 FakeLoc 路线模拟（拉起界面 → 广播 → 采样坐标确认推进 → 重试）
 *   ② 回桌面 → 点「苍霞乐跑」快捷方式 → 小程序
 *   ③ 首页点「校园乐跑」→ 跑步页
 *   ④ 跑步页点「开始乐跑」→ 关「成绩合格标准」弹窗
 *   ⑤ 地图页点「开始乐跑」→ 正式开跑
 *   ⑥ 等达标：轮询通知栏（root）+ 定时器兜底
 *   ⑦ 长按暂停 → 结束跑步 → 二次确认
 *   ⑧ 清场：停模拟 / 关小程序 / 关 FakeLoc
 *
 * 前置条件：
 *   1. FakeLoc ≥ 1.8.0-automation（含 com.mo.fakeloc.automation.START_ROUTE）
 *   2. AutoX.js 已授 root（用于读通知栏 / 开无障碍 / 强杀进程）
 *   3. 「苍霞乐跑」快捷方式在桌面
 *   4. FakeLoc 路线已配好，配速与 RUN.paceMinPerKm 一致
 *   5. FakeLoc 的 route_notify_km 设为目标里程（脚本用它的通知做达标信号）
 *
 * ⚠️ 坐标基于 1080x2400 @480dpi 实测。换设备/换布局需重新校准
 *    （校准工具：scripts/locate-color.py）
 *
 * ============================ 修订记录 ============================
 * 2026-09-28 V6
 *   [1] 广播改用 Java 显式 Intent。AutoX 的 shell 以 App uid 跑 am 会被拒：
 *       SecurityException: broadcast asks to run as user -2 but is calling
 *       from uid u0a325
 *   [2] 全文 ES5。Rhino 引擎不支持 for...of / 模板字符串，
 *       原脚本报 "syntax error (...caoxia-run.js#140)"，从未真正跑通
 *   [3] 地图页「成绩合格标准」弹窗必须点掉，否则「假开跑」（用时 00:00:00）
 *   [4] FakeLoc 后台启动被 ColorOS 拦截（OplusAppStartupManager: prevent start）
 *       → 先拉起界面再广播，并采样两次坐标确认推进
 *   [5] 「结束跑步」有二次确认弹窗，必须处理，否则卡住结束不了
 *   [6] 单实例锁。AutoX 悬浮窗的 × 不保证终止脚本，双实例会搅乱跑步状态
 *   [7] ★ 利用 root：轮询通知栏做精确达标信号 / 自动开无障碍 / 强杀进程清理
 * ==================================================================
 */

importClass(android.content.Intent);
importClass(android.content.ComponentName);
importClass(android.net.Uri);

// ============================== 坐标表（1080x2400 @480dpi 实测）============
var XY = {
    shortcutRun: [909, 1235],   // 桌面「苍霞乐跑」快捷方式
    entryRun: [408, 729],       // 小程序首页「校园乐跑」图标
    btnStart: [539, 1313],      // 跑步页「开始乐跑」
    dlgAck: [540, 1552],        // 「成绩合格标准」弹窗 →「我知道了」
    dlgFreeRun: [711, 1315],    // 「跑步提示」弹窗 →「自由跑」(仅时间窗外)
    btnStartMap: [540, 2150],   // 地图页底部「开始乐跑」
    btnPause: [540, 2150],      // 跑步中「长按暂停」(同一位置)
    btnEndRun: [302, 2144],     // 暂停后左下「结束跑步」
    dlgEndConfirm: [376, 1337], // 二次确认弹窗里的「结束跑步」
    wxMore: [877, 182],         // 小程序右上角菜单
    wxReenter: [716, 1900]      // 「重新进入小程序」
};

// ============================== 配置 ==============================
var CFG = {
    startTexts: ["开始乐跑", "开始跑步", "开始"],
    notifyKeywords: ["达标", "已完成", "目标里程", "路线完成"],
    timeout: {
        maxRun: 45 * 60 * 1000,   // 硬上限（安全阀）
        cooldown: 2500
    },
    dryRun: false,
    probeOnly: false              // true = 只探测环境，不跑流程
};

// ======================= 里程 / 时长换算（决定何时收工）=======================
//
// 达标判定两条路并行：
//   主信号：通知栏里出现**新的** FakeLoc 达标通知（channel=fakeloc_target）— 需 root
//   兜底  ：按「配速 × 时长」推算
//
// ⚠️ paceMinPerKm 必须与 FakeLoc App 里当前设置的配速一致，否则兜底时长会偏。
var RUN = {
    targetKm: 2.0,          // 乐跑需要达到的里程（官方男生下限 2.0）
    paceMinPerKm: 4.5,      // ★ 与 FakeLoc 当前配速一致（4'30"/km）
    cxRatio: 0.93,          // 乐跑读数 / FakeLoc 理论里程（实测 0.94，取 0.93 保守）
    margin: 1.08,           // 兜底余量系数

    debugSeconds: 150         // >0 时直接指定跑步秒数（调试用），生产保持 0
};

/** 推算「需要跑多久」（毫秒）—— 仅兜底用 */
function computeRunMs() {
    if (RUN.debugSeconds > 0) return RUN.debugSeconds * 1000;
    var fakeLocKm = RUN.targetKm / RUN.cxRatio;
    var speedMs = 1000 / (RUN.paceMinPerKm * 60);
    return Math.round(fakeLocKm * 1000 / speedMs * 1000 * RUN.margin);
}

var FAKELOC = {
    pkg: "com.mo.fakeloc",
    receiverClass: "com.mo.fakeloc.service.AutomationReceiver",
    actionStart: "com.mo.fakeloc.automation.START_ROUTE",
    actionStop: "com.mo.fakeloc.automation.STOP_ROUTE"
};

var WECHAT = "com.tencent.mm";
var AUTOX_PKG = "org.autojs.autoxjs.v6";
var A11Y_CLASS = "com.stardust.autojs.core.accessibility.AccessibilityService";
var NOTIF_LISTENER_CLASS = "com.stardust.notification.NotificationListenerService";

// ============================== 日志 ==============================
var LOGFILE = "/sdcard/脚本/caoxia-run.log";

function log(msg) {
    console.log("[苍霞乐跑] " + msg);
    try {
        var fw = new java.io.FileWriter(LOGFILE, true);
        fw.write("[" + new Date().toTimeString().substring(0, 8) + "] " + msg + "\n");
        fw.close();
    } catch (e) { }
}

// ============================== root 工具 ==============================
var ROOT_OK = false;

/** 以 root 执行 shell，返回 stdout 字符串 */
function sh(cmd) {
    if (!ROOT_OK) return "";
    try {
        var r = shell(cmd, true);
        if (r == null) return "";
        if (typeof r === "string") return r;
        return (r.result != null) ? String(r.result) : String(r);
    } catch (e) {
        return "";
    }
}

/** 单实例锁（AutoX 悬浮窗 × 不保证终止脚本） */
var LOCKFILE = "/sdcard/脚本/caoxia-run.lock";

function acquireLock() {
    try {
        if (files.exists(LOCKFILE)) {
            var ts = parseInt(files.read(LOCKFILE), 10) || 0;
            if (Date.now() - ts < 90 * 60 * 1000) {
                log("⚠️ 已有实例在运行（锁于 " +
                    new Date(ts).toTimeString().substring(0, 8) + "），本次退出");
                return false;
            }
            log("检测到过期锁，覆盖");
        }
        files.write(LOCKFILE, String(Date.now()));
        return true;
    } catch (e) {
        log("加锁异常（忽略）: " + e);
        return true;
    }
}

function releaseLock() {
    try { if (files.exists(LOCKFILE)) files.remove(LOCKFILE); } catch (e) { }
}

// ======================= ⓪ root 前置保障 =======================

/**
 * 唤醒屏幕并保持常亮。
 *
 * 定时任务常在息屏时触发，而 `input` 类操作与 UI 渲染在休眠态下不可靠
 * （AutoX 的 click 也依赖窗口可交互）。
 */
function ensureScreenOn() {
    var w = sh("dumpsys power | grep -E 'mWakefulness=' | head -1");
    log("屏幕状态: " + String(w).replace(/\n/g, " ").trim());

    if (String(w).indexOf("Awake") < 0) {
        log("  屏幕未唤醒 → 发 WAKEUP");
        sh("input keyevent KEYCODE_WAKEUP");
        sleep(1500);
    }
    sh("svc power stayon true");   // 插电时常亮
    sleep(500);
}

/** 确保 AutoX 的无障碍服务开着（root 可直接改 secure settings） */
function ensureAccessibility() {
    var cur = String(sh("settings get secure enabled_accessibility_services")).trim();
    var want = AUTOX_PKG + "/" + A11Y_CLASS;

    if (cur.indexOf(A11Y_CLASS) >= 0) {
        log("无障碍: ✅ 已开启");
        return true;
    }
    log("无障碍未开启，尝试用 root 打开（当前: " + (cur || "null") + "）");
    var val = (cur === "null" || cur === "") ? want : (cur + ":" + want);
    sh("settings put secure enabled_accessibility_services '" + val + "'");
    sh("settings put secure accessibility_enabled 1");
    sleep(2000);

    var after = String(sh("settings get secure enabled_accessibility_services")).trim();
    var ok = after.indexOf(A11Y_CLASS) >= 0;
    log("  结果: " + (ok ? "✅ 已开启" : "❌ 仍失败（" + after + "）"));
    return ok;
}

/** 确保 AutoX 的通知使用权开着 */
function ensureNotificationAccess() {
    var cur = String(sh("settings get secure enabled_notification_listeners")).trim();
    var want = AUTOX_PKG + "/" + NOTIF_LISTENER_CLASS;

    if (cur.indexOf(NOTIF_LISTENER_CLASS) >= 0) {
        log("通知使用权: ✅ 已开启");
        return true;
    }
    log("通知使用权未开启，尝试打开");
    var val = (cur === "null" || cur === "") ? want : (cur + ":" + want);
    sh("settings put secure enabled_notification_listeners '" + val + "'");
    sleep(1500);

    var after = String(sh("settings get secure enabled_notification_listeners")).trim();
    var ok = after.indexOf(NOTIF_LISTENER_CLASS) >= 0;
    log("  结果: " + (ok ? "✅ 已开启" : "❌ 仍失败"));
    return ok;
}

// ======================= ① FakeLoc 启动 =======================

/** 发广播给 FakeLoc（Java 显式 Intent，免权限） */
function broadcast(action) {
    log("广播 → " + action);
    if (CFG.dryRun) return true;
    try {
        var it = new Intent(action);
        it.setComponent(new ComponentName(FAKELOC.pkg, FAKELOC.receiverClass));
        context.sendBroadcast(it);
        return true;
    } catch (e) {
        log("  广播异常: " + e);
        return false;
    }
}

/** 读 FakeLoc 当前坐标（只读 ContentProvider），返回 "lat,lon" 或 null */
function fakeLocCoord() {
    try {
        var uri = Uri.parse("content://com.mo.fakeloc.config");
        var b = context.getContentResolver().call(uri, "config", null, null);
        if (!b) return null;
        var json = b.getString("json");
        var m = /"lat":([0-9.]+),"lon":([0-9.]+)/.exec(json || "");
        return m ? (m[1] + "," + m[2]) : null;
    } catch (e) {
        return null;
    }
}

/** 把 FakeLoc 拉到前台（ColorOS 拦截后台启动，先拉起界面再广播才稳） */
function wakeFakeLoc() {
    log("拉起 FakeLoc 界面（绕过 ColorOS 后台启动拦截）");
    if (CFG.dryRun) return;
    try {
        app.launchPackage(FAKELOC.pkg);
        sleep(3000);
    } catch (e) {
        log("  拉起失败: " + e);
    }
}

/** 启动路线模拟并确认真的在跑（采样两次坐标比对），最多 3 轮 */
function startFakeLocRoute() {
    for (var attempt = 1; attempt <= 3; attempt++) {
        log("启动路线模拟（第 " + attempt + " 轮）");
        wakeFakeLoc();
        broadcast(FAKELOC.actionStart);
        sleep(3000);

        var c1 = fakeLocCoord();
        sleep(3000);
        var c2 = fakeLocCoord();

        if (c1 && c2 && c1 !== c2) {
            log("  ✅ 模拟已推进（" + c1 + " → " + c2 + "）");
            return true;
        }
        log("  ⚠️ 未确认推进（c1=" + c1 + ", c2=" + c2 + "），重试");
        sleep(2000);
    }
    log("❌ 路线模拟启动失败");
    return false;
}

// ======================= UI 操作 =======================

function tapXY(xy, label) {
    log("点击" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "]");
    if (!CFG.dryRun) click(xy[0], xy[1]);
    sleep(CFG.timeout.cooldown);
}

function pressXY(xy, label, ms) {
    ms = ms || 300;
    log("长按" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "] " + ms + "ms");
    if (!CFG.dryRun) press(xy[0], xy[1], ms);
    sleep(CFG.timeout.cooldown);
}

/** 按文字点击（小程序自绘读不到文字时返回 false，由调用方回退坐标） */
function tapText(texts, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (var i = 0; i < texts.length; i++) {
            var n = text(texts[i]).findOnce();
            if (n) {
                log("按文字命中「" + texts[i] + "」");
                if (!CFG.dryRun) {
                    var b = n.bounds();
                    click(b.centerX(), b.centerY());
                }
                sleep(CFG.timeout.cooldown);
                return true;
            }
        }
        sleep(400);
    }
    return false;
}

// ======================= ⑥ 达标判定 =======================

/** 读通知栏里 FakeLoc 达标通知的条数（需 root）；-1 表示读不到 */
function targetNotifyCount() {
    var out = sh("dumpsys notification --noredact 2>/dev/null | grep -c 'NotificationRecord.*fakeloc_target'");
    var n = parseInt(String(out).replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? -1 : n;
}

/**
 * 等达标。两条路并行：
 *   主：通知栏出现**新的** fakeloc_target 通知（比基线多）—— 真实里程信号
 *   兜底：按配速推算的定时器
 */
function waitTargetDistance() {
    log("等待里程达标…");

    var baseline = targetNotifyCount();
    log("  通知栏基线: " + (baseline < 0 ? "读不到（root 不可用？）" : baseline + " 条"));
    log("  兜底时长: " + Math.round(computeRunMs() / 1000) + "s");

    var start = Date.now();
    var deadline = start + CFG.timeout.maxRun;
    var fallbackAt = start + computeRunMs();
    var hit = null;

    while (Date.now() < deadline) {
        if (baseline >= 0) {
            var now = targetNotifyCount();
            if (now > baseline) {
                log("✅ 达标通知已出现（" + baseline + " → " + now + "）");
                hit = "notify";
                break;
            }
        }
        if (Date.now() >= fallbackAt) {
            log("⏱ 兜底定时器到点（已跑 " + Math.round((Date.now() - start) / 1000) + "s）");
            hit = "timer";
            break;
        }
        sleep(2000);
    }

    if (!hit) log("⚠️ 超时未达标");
    else log("达标判定方式: " + hit);
    return hit;
}

// ======================= ⑧ 清场 =======================

/**
 * 流程结束后清场：
 *   · 停 FakeLoc 路线模拟 + 强杀 FakeLoc 进程
 *   · 关掉微信（连带小程序）
 *   · 清掉 FakeLoc 的达标通知（保证下次基线从 0 起算）
 *
 * ⚠️ 不杀 AutoX 自身 —— 那会连带关掉无障碍，且脚本还没退出。
 */
function cleanupAll() {
    log("清理后台");

    // 1) 停路线模拟
    broadcast(FAKELOC.actionStop);
    sleep(1500);

    // 2) 清掉达标通知（下次基线从 0 起算）
    if (ROOT_OK) {
        sh("cmd notification post -t 'x' fakeloc_target_clear 'x' >/dev/null 2>&1");
    }

    // 3) 强杀微信（连带小程序）
    if (ROOT_OK) {
        sh("am force-stop " + WECHAT);
        sleep(1500);
        log("  已关闭微信（含小程序）");
    } else {
        log("  无 root，跳过强杀微信");
    }

    // 4) 强杀 FakeLoc
    if (ROOT_OK) {
        sh("am force-stop " + FAKELOC.pkg);
        sleep(1000);
        log("  已关闭 FakeLoc");
    }

    // 5) 回桌面
    if (!CFG.dryRun) home();
    sleep(1000);
}

// ============================== 主流程 ==============================

function main() {
    log("=== 苍霞乐跑自动化启动 ===");

    // ⓪ root 探测
    try {
        var r = shell("id", true);
        var idStr = (r && r.result != null) ? String(r.result) : String(r);
        ROOT_OK = /uid=0/.test(idStr);
    } catch (e) {
        ROOT_OK = false;
    }
    log("root: " + (ROOT_OK ? "✅ 可用" : "❌ 不可用（降级为定时器模式）"));

    if (CFG.probeOnly) {
        log("[probe] 屏幕: " + String(sh("dumpsys power | grep mWakefulness= | head -1")).trim());
        log("[probe] 无障碍: " + String(sh("settings get secure enabled_accessibility_services")).trim());
        log("[probe] 通知栏达标数: " + targetNotifyCount());
        log("probeOnly=true，探测结束");
        return;
    }

    ensureScreenOn();
    ensureAccessibility();
    ensureNotificationAccess();

    // ① 启动 FakeLoc 路线模拟
    if (!startFakeLocRoute()) {
        log("❌ 路线模拟启动失败，中止");
        return;
    }

    // ② 回桌面 → 打开乐跑
    log("回桌面 → 打开乐跑小程序");
    if (!CFG.dryRun) home();
    sleep(2000);
    tapXY(XY.shortcutRun, "苍霞乐跑快捷方式");

    var waited = 0;
    while (waited < 25000) {
        var p = "";
        try { p = currentPackage(); } catch (e) { }
        if (p === WECHAT) break;
        sleep(1000);
        waited += 1000;
    }
    log("微信已前台（等待 " + waited + "ms），再等页面渲染");
    sleep(4000);

    // ③ 首页 → 校园乐跑
    tapXY(XY.entryRun, "校园乐跑");
    sleep(4500);

    // ④ 跑步页 → 开始乐跑
    if (!tapText(CFG.startTexts, 6000)) {
        tapXY(XY.btnStart, "开始乐跑");
    }
    sleep(3000);

    // ⑤ 关闭地图页弹窗（小程序自绘，只能按实测坐标盲点）
    //    a) 「成绩合格标准」—— 时间窗内必现，不点掉后面会被吞
    //    b) 「跑步提示」→「自由跑」—— 仅时间窗外
    log("关闭地图页弹窗（盲点）");
    pressXY(XY.dlgAck, "我知道了(成绩合格标准)", 200);
    sleep(1500);
    pressXY(XY.dlgFreeRun, "自由跑(仅时间窗外)", 200);
    sleep(1500);

    // ⑥ 地图页 → 开始乐跑
    if (!tapText(CFG.startTexts, 5000)) {
        tapXY(XY.btnStartMap, "开始乐跑(地图页)");
    }
    sleep(3000);
    log("🏃 已开始跑步，等待达标…");

    // ⑦ 等达标
    var hit = waitTargetDistance();
    if (hit) log("🎯 里程已达标");

    // ⑧ 长按暂停 → 结束跑步 → 二次确认
    pressXY(XY.btnPause, "长按暂停", 1200);
    sleep(4000);
    pressXY(XY.btnEndRun, "结束跑步", 200);
    sleep(3500);
    pressXY(XY.dlgEndConfirm, "确认结束", 200);
    sleep(3500);

    // ⑨ 清场
    cleanupAll();

    log("=== 流程结束 ===");
}

// ============================== 入口 ==============================

try {
    if (acquireLock()) main();
} catch (e) {
    log("💥 异常: " + e);
    try { broadcast(FAKELOC.actionStop); } catch (e2) { }
} finally {
    releaseLock();
}
