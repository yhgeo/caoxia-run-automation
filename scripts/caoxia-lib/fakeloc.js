/**
 * caoxia-lib/fakeloc.js —— FakeLoc 控制
 * ============================================================================
 *
 * 职责：启动/停止路线模拟、读取坐标、判断达标通知、清场。
 *
 * 依赖 FakeLoc 的自动化入口（原版没有）：
 *   AutomationReceiver（exported=true）
 *     com.mo.fakeloc.automation.START_ROUTE / .STOP_ROUTE
 */

importClass(android.content.Intent);
importClass(android.content.ComponentName);
importClass(android.net.Uri);

var C = require("./config.js");
var U = require("./util.js");

// ============================== 广播 ==============================

/**
 * 发广播给 FakeLoc。
 *
 * ⚠️ 必须用 Java 显式 Intent，不能 shell("am broadcast")：
 *    AutoX 的 shell 以 App uid 运行 am，Android 14 会抛
 *    SecurityException: broadcast asks to run as user -2 but is calling from uid u0a325
 */
function send(action) {
    U.log("广播 → " + action);
    if (C.CFG.dryRun) return true;
    try {
        var it = new Intent(action);
        it.setComponent(new ComponentName(C.PKG.fakeloc, C.PKG.fakelocReceiver));
        context.sendBroadcast(it);
        return true;
    } catch (e) {
        U.log("  广播异常: " + e);
        return false;
    }
}

function start() { return send(C.PKG.actionStart); }
function stop() { return send(C.PKG.actionStop); }

// ============================== 坐标读取 ==============================

/** 读 FakeLoc 当前坐标（只读 ContentProvider），返回 "lat,lon" 或 null */
function coord() {
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

// ============================== 启动 ==============================

/** 把 FakeLoc 拉到前台（ColorOS 会拦截后台启动，先拉起界面再广播才稳） */
function wake() {
    U.log("拉起 FakeLoc 界面（绕过 ColorOS 后台启动拦截）");
    if (C.CFG.dryRun) return;
    try {
        app.launchPackage(C.PKG.fakeloc);
        sleep(3000);
    } catch (e) {
        U.log("  拉起失败: " + e);
    }
}

/**
 * 启动路线模拟，并**确认真的在推进**（采样两次坐标比对）。
 * 最多重试 3 轮。
 */
function startRoute() {
    for (var attempt = 1; attempt <= 3; attempt++) {
        U.log("启动路线模拟（第 " + attempt + " 轮）");
        wake();
        start();
        sleep(3000);

        var c1 = coord();
        sleep(3000);
        var c2 = coord();

        if (c1 && c2 && c1 !== c2) {
            U.log("  ✅ 模拟已推进（" + c1 + " → " + c2 + "）");
            return true;
        }
        U.log("  ⚠️ 未确认推进（c1=" + c1 + ", c2=" + c2 + "），重试");
        sleep(2000);
    }
    U.log("❌ 路线模拟启动失败");
    return false;
}

// ============================== 达标信号 ==============================

/** 读通知栏里 FakeLoc 达标通知的条数（需 root）；-1 表示读不到 */
function notifyCount() {
    var out = U.sh("dumpsys notification --noredact 2>/dev/null | grep -c 'NotificationRecord.*fakeloc_target'");
    var n = parseInt(String(out).replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? -1 : n;
}

/** 清掉 FakeLoc 的达标通知（让下次基线从 0 起算） */
function clearNotify() {
    U.sh("cmd notification post -t 'x' fakeloc_target_clear 'x' >/dev/null 2>&1");
}

// ============================== 清场 ==============================

/**
 * 停止模拟 + 关掉 FakeLoc 进程。
 *
 * ⚠️ 这里**不碰微信** —— 杀微信会清掉小程序登录态，
 *    下次打开会弹「立即登录 / 授权登录」页（2026-09-28 踩坑）。
 *    微信的清理交给 ui.closeMiniProgram() 用温和方式处理。
 */
function shutdown() {
    U.log("停止 FakeLoc");
    stop();
    sleep(1500);
    clearNotify();

    if (U.isRoot()) {
        U.sh("am force-stop " + C.PKG.fakeloc);
        sleep(1000);
        U.log("  已关闭 FakeLoc 进程");
    }
}

module.exports = {
    send: send,
    start: start,
    stop: stop,
    coord: coord,
    wake: wake,
    startRoute: startRoute,
    notifyCount: notifyCount,
    clearNotify: clearNotify,
    shutdown: shutdown
};
