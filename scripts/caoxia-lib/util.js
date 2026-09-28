/**
 * caoxia-lib/util.js —— 基础设施：日志 / root / 单实例锁 / 环境保障
 * ============================================================================
 *
 * 本模块不包含任何业务逻辑，换界面/换 App 都不需要动它。
 */

var C = require("./config.js");

// ============================== 日志 ==============================

function log(msg) {
    console.log("[苍霞乐跑] " + msg);
    try {
        var fw = new java.io.FileWriter(C.PATH.log, true);
        fw.write("[" + new Date().toTimeString().substring(0, 8) + "] " + msg + "\n");
        fw.close();
    } catch (e) { }
}

/** 清空日志（每次运行开头调用，避免日志无限增长） */
function resetLog() {
    try { files.remove(C.PATH.log); } catch (e) { }
}

// ============================== root ==============================

var ROOT_OK = false;

function detectRoot() {
    try {
        var r = shell("id", true);
        var s = (r && r.result != null) ? String(r.result) : String(r);
        ROOT_OK = /uid=0/.test(s);
    } catch (e) {
        ROOT_OK = false;
    }
    return ROOT_OK;
}

/**
 * 以 root 执行 shell，返回 stdout 字符串。
 *
 * ⚠️ 必须用 shell(cmd, true) —— 第二参数才是 root 标志。
 *    拼 `su -c '...'` 会因引号被 AutoX 的 shell 吃掉而失败。
 * ⚠️ 返回值是 ShellResult 对象，用 .result 取 stdout。
 */
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

/** 去掉首尾空白 */
function trim(s) {
    return String(s == null ? "" : s).replace(/^\s+|\s+$/g, "");
}

// ============================== 单实例锁 ==============================
//
// AutoX 悬浮窗的 × 不保证终止脚本；两个实例同时操作会搅乱跑步状态。

function acquireLock() {
    try {
        if (files.exists(C.PATH.lock)) {
            var ts = parseInt(files.read(C.PATH.lock), 10) || 0;
            if (Date.now() - ts < 90 * 60 * 1000) {
                log("⚠️ 已有实例在运行（锁于 " +
                    new Date(ts).toTimeString().substring(0, 8) + "），本次退出");
                return false;
            }
            log("检测到过期锁，覆盖");
        }
        files.write(C.PATH.lock, String(Date.now()));
        return true;
    } catch (e) {
        log("加锁异常（忽略）: " + e);
        return true;
    }
}

function releaseLock() {
    try { if (files.exists(C.PATH.lock)) files.remove(C.PATH.lock); } catch (e) { }
}

// ============================== 环境保障 ==============================

/** 是否处于锁屏状态 */
function isKeyguardShowing() {
    var out = sh("dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=[a-z]*' | head -1");
    return String(out).indexOf("true") >= 0;
}

/**
 * 解除锁屏。
 *
 * ⚠️ 关键：`KEYCODE_WAKEUP` **只亮屏，不解锁**。
 *    ColorOS 即使没设密码也有锁屏界面（需上滑），所以唤醒后必须再
 *    `wm dismiss-keyguard`，否则后续所有点击都落在锁屏上，
 *    表现为「屏幕亮了但没进桌面 / 解锁后看到别的 App / 之后操作全乱」。
 *
 * @return true = 已解锁（或本来就没锁）；false = 无法解锁（设了密码）
 */
function dismissKeyguard() {
    if (!isKeyguardShowing()) {
        log("  锁屏: 未锁");
        return true;
    }
    log("  ⚠️ 检测到锁屏 → dismiss-keyguard");
    sh("wm dismiss-keyguard");
    sleep(2000);

    if (isKeyguardShowing()) {
        log("  ❌ 仍未解锁（手机设了密码？脚本无法自动解锁）");
        return false;
    }
    log("  ✅ 已解锁，等无障碍重新绑定");
    // 解锁会让无障碍服务重新绑定，这期间 click()/press() 会抛异常，
    // 所以留出缓冲（ui.js 里另有重试兜底）
    sleep(2500);
    return true;
}

/**
 * 唤醒屏幕 → 解锁 → 保持常亮。
 *
 * 定时任务常在息屏时触发，而 input 类操作与 UI 渲染在休眠态下不可靠。
 *
 * @return true = 屏幕可用；false = 无法解锁，调用方应中止流程
 */
function ensureScreenOn() {
    var w = sh("dumpsys power | grep -E 'mWakefulness=' | head -1");
    log("屏幕状态: " + trim(w));

    if (String(w).indexOf("Awake") < 0) {
        log("  屏幕未唤醒 → 发 WAKEUP");
        sh("input keyevent KEYCODE_WAKEUP");
        sleep(1500);
    }

    var unlocked = dismissKeyguard();

    sh("svc power stayon true");   // 插电时常亮
    sleep(500);

    return unlocked;
}

/** 确保 AutoX 的无障碍服务开着（root 可直接改 secure settings） */
function ensureAccessibility() {
    var cur = trim(sh("settings get secure enabled_accessibility_services"));
    var want = C.PKG.autox + "/" + C.PKG.autoxA11y;

    if (cur.indexOf(C.PKG.autoxA11y) >= 0) {
        log("无障碍: ✅ 已开启");
        return true;
    }
    log("无障碍未开启，尝试用 root 打开（当前: " + (cur || "null") + "）");
    var val = (cur === "null" || cur === "") ? want : (cur + ":" + want);
    sh("settings put secure enabled_accessibility_services '" + val + "'");
    sh("settings put secure accessibility_enabled 1");
    sleep(2000);

    var after = trim(sh("settings get secure enabled_accessibility_services"));
    var ok = after.indexOf(C.PKG.autoxA11y) >= 0;
    log("  结果: " + (ok ? "✅ 已开启" : "❌ 仍失败（" + after + "）"));
    return ok;
}

/** 确保 AutoX 的通知使用权开着 */
function ensureNotificationAccess() {
    var cur = trim(sh("settings get secure enabled_notification_listeners"));
    var want = C.PKG.autox + "/" + C.PKG.autoxNotif;

    if (cur.indexOf(C.PKG.autoxNotif) >= 0) {
        log("通知使用权: ✅ 已开启");
        return true;
    }
    log("通知使用权未开启，尝试打开");
    var val = (cur === "null" || cur === "") ? want : (cur + ":" + want);
    sh("settings put secure enabled_notification_listeners '" + val + "'");
    sleep(1500);

    var after = trim(sh("settings get secure enabled_notification_listeners"));
    var ok = after.indexOf(C.PKG.autoxNotif) >= 0;
    log("  结果: " + (ok ? "✅ 已开启" : "❌ 仍失败"));
    return ok;
}

/**
 * 一键完成全部前置保障。
 * @return true = 环境就绪；false = 屏幕无法解锁，调用方应中止
 */
function prepareEnvironment() {
    if (!ensureScreenOn()) {
        log("❌ 屏幕无法解锁，中止流程（避免在锁屏上乱点）");
        return false;
    }
    ensureAccessibility();
    ensureNotificationAccess();
    return true;
}

// ============================== 当前前台 App ==============================

function currentApp() {
    var p = "";
    try { p = currentPackage(); } catch (e) { }
    return p;
}

/** 等某个包名到前台，返回实际等待毫秒数；超时返回 -1 */
function waitForApp(pkg, timeoutMs) {
    var waited = 0;
    while (waited < timeoutMs) {
        if (currentApp() === pkg) return waited;
        sleep(1000);
        waited += 1000;
    }
    return -1;
}

module.exports = {
    log: log,
    resetLog: resetLog,
    sh: sh,
    trim: trim,
    detectRoot: detectRoot,
    isRoot: function () { return ROOT_OK; },
    acquireLock: acquireLock,
    releaseLock: releaseLock,
    ensureScreenOn: ensureScreenOn,
    dismissKeyguard: dismissKeyguard,
    isKeyguardShowing: isKeyguardShowing,
    ensureAccessibility: ensureAccessibility,
    ensureNotificationAccess: ensureNotificationAccess,
    prepareEnvironment: prepareEnvironment,
    currentApp: currentApp,
    waitForApp: waitForApp
};
