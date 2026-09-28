/**
 * caoxia-lib/ui.js —— 小程序 UI 操作
 * ============================================================================
 *
 * 职责：点击 / 长按 / 页面识别 / 登录兜底 / 关闭小程序。
 *
 * 小程序是 WebView 自绘（uiautomator dump 仅 765 字节，零控件可读），
 * 所以：
 *   · 点击靠**实测坐标盲点**
 *   · 页面识别靠 **root 截屏 + 像素采样**（captureScreen() 无 MediaProjection
 *     授权，但 root 的 screencap 命令可以）
 */

var C = require("./config.js");
var U = require("./util.js");

// ============================== 基础操作 ==============================

function tapXY(xy, label) {
    U.log("点击" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "]");
    if (!C.CFG.dryRun) click(xy[0], xy[1]);
    sleep(C.CFG.timeout.cooldown);
}

function pressXY(xy, label, ms) {
    ms = ms || 300;
    U.log("长按" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "] " + ms + "ms");
    if (!C.CFG.dryRun) press(xy[0], xy[1], ms);
    sleep(C.CFG.timeout.cooldown);
}

/** 按文字点击（原生控件有效；小程序自绘读不到 → 返回 false 由调用方回退坐标） */
function tapText(texts, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (var i = 0; i < texts.length; i++) {
            var n = text(texts[i]).findOnce();
            if (n) {
                U.log("按文字命中「" + texts[i] + "」");
                if (!C.CFG.dryRun) {
                    var b = n.bounds();
                    click(b.centerX(), b.centerY());
                }
                sleep(C.CFG.timeout.cooldown);
                return true;
            }
        }
        sleep(400);
    }
    return false;
}

// ============================== 页面识别（root 截屏）==============================

var SHOT = "/sdcard/脚本/_cx_shot.png";

/**
 * 截屏并取某点的 RGB。
 *
 * 用 root 的 `screencap` 命令，绕过 captureScreen() 需要的
 * MediaProjection 授权（AutoX 没有该授权，会抛
 * "No screen capture permission"）。
 */
function pixel(x, y) {
    if (!U.isRoot()) return null;
    try {
        U.sh("screencap -p " + SHOT);
        var img = images.read(SHOT);
        if (!img) return null;
        var c = images.pixel(img, x, y);
        var out = { r: colors.red(c), g: colors.green(c), b: colors.blue(c) };
        img.recycle();
        return out;
    } catch (e) {
        U.log("截屏取色异常: " + e);
        return null;
    }
}

function isGreen(p) {
    return p && p.g > 120 && (p.g - p.r) > 35 && (p.g - p.b) > 35;
}

/** 深色（用于识别首页顶部的用户信息卡片） */
function isDark(p) {
    return p && (p.r + p.g + p.b) < 400;
}

/** 是否停在「立即登录」页（该位置有绿色按钮） */
function isLoginPage() {
    return isGreen(pixel(C.XY.loginBtn[0], C.XY.loginBtn[1]));
}

/** 是否已登录进首页（顶部有深色的用户信息卡片） */
function isHomePage() {
    return isDark(pixel(540, 850));
}

// ============================== 登录兜底 ==============================

/**
 * 如果落在登录页，自动走完登录流程。
 *
 * 什么时候会出现登录页：
 *   · 微信被 force-stop 过（登录态被清）
 *   · 登录过期
 * 正常清理不该触发它 —— 所以 cleanup 里不杀微信。
 * 但万一出现，这里兜住。
 *
 * 流程：立即登录 → 勾选协议 → 授权登录
 */
function handleLoginIfNeeded() {
    if (!isLoginPage()) {
        U.log("非登录页，跳过登录兜底");
        return true;
    }
    U.log("⚠️ 检测到登录页 → 自动登录");
    tapXY(C.XY.loginBtn, "立即登录");
    sleep(2500);
    tapXY(C.XY.loginAgree, "勾选用户协议");
    sleep(1500);
    tapXY(C.XY.loginAuth, "授权登录");
    sleep(4500);

    if (isHomePage()) {
        U.log("  ✅ 登录成功，已进首页");
        return true;
    }
    U.log("  ⚠️ 登录后仍未识别到首页（可能页面还在加载）");
    return false;
}

// ============================== 业务动作 ==============================

/**
 * 判断桌面「苍霞乐跑」图标是否出现在预期位置。
 *
 * 桌面可能有多个页面，用户手动操作会翻页。图标是彩色的（绿/红/黄小人），
 * 采样图标区域内几个点，只要有饱和色就认为图标在。
 */
function shortcutVisible() {
    var cx = C.XY.shortcutRun[0], cy = C.XY.shortcutRun[1];
    var pts = [[cx, cy], [cx - 45, cy - 35], [cx + 45, cy + 35]];
    for (var i = 0; i < pts.length; i++) {
        var p = pixel(pts[i][0], pts[i][1]);
        if (!p) continue;
        var mx = Math.max(p.r, Math.max(p.g, p.b));
        var mn = Math.min(p.r, Math.min(p.g, p.b));
        if (mx - mn > 40) return true;      // 有饱和色 → 图标在
    }
    return false;
}

/** 尝试回到桌面的上一页（多种方式都试一遍，不保证一定有效） */
function backOneHomePage() {
    U.log("  尝试回退桌面页面");
    U.sh("input keyevent KEYCODE_DPAD_LEFT");
    sleep(700);
    U.sh("input swipe 200 1300 1000 1300 600");
    sleep(900);
}

/**
 * 打开小程序并确保到达首页。
 *
 * ⚠️ 桌面可能停在非第一页 → 点坐标会点空。所以：
 *     检测图标是否可见 → 不可见就尝试翻页 → 最多 4 轮
 *    （建议把「苍霞乐跑」快捷方式固定在桌面第一页，最省事）
 */
function openMiniProgram() {
    U.log("回桌面 → 打开乐跑小程序");
    if (!C.CFG.dryRun) home();
    sleep(2000);

    var opened = false;
    for (var attempt = 1; attempt <= 4; attempt++) {
        var visible = shortcutVisible();
        U.log("  第 " + attempt + " 轮：图标" + (visible ? "可见" : "不可见") + "（root 截屏判定）");

        tapXY(C.XY.shortcutRun, "苍霞乐跑快捷方式");
        sleep(4000);
        if (U.currentApp() === C.PKG.wechat) {
            opened = true;
            break;
        }
        if (attempt < 4) backOneHomePage();
    }

    if (!opened) {
        U.log("  ⚠️ 4 轮均未打开小程序 —— 桌面可能不在第一页，请把快捷方式固定在首页");
    } else {
        var waited = U.waitForApp(C.PKG.wechat, 25000);
        U.log("微信已前台（等待 " + waited + "ms），再等页面渲染");
        sleep(4000);
        handleLoginIfNeeded();
    }
}

/** 首页 → 跑步页 */
function enterRunPage() {
    tapXY(C.XY.entryRun, "校园乐跑");
    sleep(4500);
}

/** 跑步页 → 点开始乐跑 */
function tapStart() {
    if (!tapText(C.CFG.startTexts, 6000)) {
        tapXY(C.XY.btnStart, "开始乐跑");
    }
    sleep(3000);
}

/**
 * 关闭地图页弹窗（自绘，只能盲点）。
 *   a) 「成绩合格标准」→「我知道了」：时间窗内必现，不点掉后面会被吞
 *   b) 「跑步提示」→「自由跑」：仅时间窗外
 */
function closeMapDialogs() {
    U.log("关闭地图页弹窗（盲点）");
    pressXY(C.XY.dlgAck, "我知道了(成绩合格标准)", 200);
    sleep(1500);
    pressXY(C.XY.dlgFreeRun, "自由跑(仅时间窗外)", 200);
    sleep(1500);
}

/** 地图页 → 正式开始跑步 */
function startRunning() {
    if (!tapText(C.CFG.startTexts, 5000)) {
        tapXY(C.XY.btnStartMap, "开始乐跑(地图页)");
    }
    sleep(3000);
}

/** 长按暂停 → 结束跑步 → 二次确认 */
function stopRunning() {
    pressXY(C.XY.btnPause, "长按暂停", 1200);
    sleep(4000);                                    // 等按钮切换动画
    pressXY(C.XY.btnEndRun, "结束跑步", 200);
    sleep(3500);                                    // 等二次确认弹窗
    pressXY(C.XY.dlgEndConfirm, "确认结束", 200);    // 弹窗里的「结束跑步」
    sleep(3500);
}

/**
 * 温和关闭小程序（**不杀微信**）。
 *
 * ⚠️ 不要用 am force-stop com.tencent.mm —— 那会清掉小程序的登录态，
 *    下次打开会弹「立即登录 / 授权登录」页（2026-09-28 踩坑）。
 */
function closeMiniProgram() {
    if (U.currentApp() !== C.PKG.wechat) {
        U.log("当前不在微信，跳过小程序清理");
        return;
    }
    U.log("关闭小程序（温和方式，保留登录态）");
    tapXY(C.XY.wxMore, "小程序菜单···");
    sleep(2000);
    tapXY(C.XY.wxReenter, "重新进入小程序");
    sleep(4500);

    if (!C.CFG.dryRun) home();
    sleep(1200);
}

module.exports = {
    tapXY: tapXY,
    pressXY: pressXY,
    tapText: tapText,
    pixel: pixel,
    isLoginPage: isLoginPage,
    isHomePage: isHomePage,
    handleLoginIfNeeded: handleLoginIfNeeded,
    openMiniProgram: openMiniProgram,
    enterRunPage: enterRunPage,
    tapStart: tapStart,
    closeMapDialogs: closeMapDialogs,
    startRunning: startRunning,
    stopRunning: stopRunning,
    closeMiniProgram: closeMiniProgram
};
