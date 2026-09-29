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
var R = require("./recorder.js");   // 调试截图（CFG.debug=false 时全是空操作）

// ============================== 基础操作 ==============================

/**
 * 无障碍操作带重试。
 *
 * ⚠️ 解锁屏幕后无障碍服务会重新绑定，这期间 click()/press() 可能抛
 *    ScriptInterruptedException（表现为「脚本莫名中断」）。
 *    所以包一层重试，最多 3 次。
 */
function a11yCall(fn, desc) {
    for (var i = 1; i <= 3; i++) {
        try {
            fn();
            return true;
        } catch (e) {
            U.log("  ⚠️ " + desc + " 第 " + i + " 次失败: " + e);
            sleep(1200);      // 等无障碍重新绑定
        }
    }
    U.log("  ❌ " + desc + " 连续 3 次失败");
    return false;
}

/**
 * 点击。**优先用 root 的 `input tap`** —— 它不依赖无障碍服务。
 *
 * ⚠️ 为什么要这样：解锁屏幕（dismiss-keyguard）会让无障碍服务重新绑定，
 *    期间 click() 会抛
 *      ScriptException: 无障碍服务已启用但并未运行，这可能是安卓的BUG
 *    而 root 的 input 命令完全不受影响，更稳。
 *    无 root 时退回无障碍 click（带重试）。
 */
function tapXY(xy, label) {
    U.log("点击" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "]");
    if (!C.CFG.dryRun) {
        if (U.isRoot()) {
            U.sh("input tap " + xy[0] + " " + xy[1]);
        } else {
            a11yCall(function () { click(xy[0], xy[1]); }, "click");
        }
    }
    sleep(C.CFG.timeout.cooldown);
}

/** 长按。同样优先走 root 的 `input swipe`（起止同点 = 长按） */
function pressXY(xy, label, ms) {
    ms = ms || 300;
    U.log("长按" + (label ? "「" + label + "」" : "") + " [" + xy[0] + ", " + xy[1] + "] " + ms + "ms");
    if (!C.CFG.dryRun) {
        if (U.isRoot()) {
            U.sh("input swipe " + xy[0] + " " + xy[1] + " " + xy[0] + " " + xy[1] + " " + ms);
        } else {
            a11yCall(function () { press(xy[0], xy[1], ms); }, "press");
        }
    }
    sleep(C.CFG.timeout.cooldown);
}

/** 回桌面。优先 root 的 input keyevent（不依赖无障碍） */
function goHome() {
    if (C.CFG.dryRun) return;
    if (U.isRoot()) U.sh("input keyevent KEYCODE_HOME");
    else home();
}

/**
 * 按文字点击（原生控件有效；小程序自绘读不到 → 返回 false 由调用方回退坐标）。
 *
 * ⚠️ `text().findOnce()` 依赖无障碍；无障碍未就绪时会抛异常，
 *    所以整段包 try/catch，失败就当作"没找到"由调用方回退坐标。
 */
function tapText(texts, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (var i = 0; i < texts.length; i++) {
            var n = null;
            try {
                n = text(texts[i]).findOnce();
            } catch (e) {
                // 无障碍未就绪，直接放弃文字查找
                return false;
            }
            if (n) {
                U.log("按文字命中「" + texts[i] + "」");
                if (!C.CFG.dryRun) {
                    var b = n.bounds();
                    if (U.isRoot()) {
                        U.sh("input tap " + b.centerX() + " " + b.centerY());
                    } else {
                        a11yCall(function () { click(b.centerX(), b.centerY()); }, "click");
                    }
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

/** 深色药丸（按钮底色）。比 isDark 更严，避免把地图上的深色元素误算进来 */
function isPillDark(p) {
    return p && (p.r + p.g + p.b) < 300;
}

/** 灰色蒙层。弹窗出现时整屏被压暗，白底页会变成 ~(102,102,102) */
function isGrayish(p) {
    return p && Math.abs(p.r - p.g) < 20 && Math.abs(p.g - p.b) < 20 &&
           p.r >= 60 && p.r <= 190;
}

// ---- 跑步状态判定（坐标实测自 2026-09-29 的截图，见 config.js PROBE）----

/** 跑步中：底部中央被「长按暂停」深色药丸覆盖 */
function isRunning() {
    return isPillDark(pixel(C.PROBE.pausePill[0], C.PROBE.pausePill[1]));
}

/** 暂停后：左下「结束跑步」深色 + 右下「继续跑步」绿色 */
function isPaused() {
    return isPillDark(pixel(C.PROBE.endBtn[0], C.PROBE.endBtn[1])) &&
           isGreen(pixel(C.PROBE.resumeBtn[0], C.PROBE.resumeBtn[1]));
}

/** 停在「校园乐跑」跑步页：中部是绿色「开始乐跑」大按钮 */
function isRunPage() {
    return isGreen(pixel(C.XY.btnStart[0], C.XY.btnStart[1]));
}

/** 有弹窗（整屏被蒙层压暗） */
function hasDialog() {
    return isGrayish(pixel(C.PROBE.dialogScrim[0], C.PROBE.dialogScrim[1]));
}

// ============== 按钮定位（按颜色扫描，不依赖写死的坐标）==============
//
// ⚠️ 为什么不能写死坐标：**时间窗内外界面不一样**
//    （窗内弹「成绩合格标准」，窗外弹「跑步提示·自由跑」），
//    不同 ROM/分辨率/字号也会让按钮上下浮动几十像素。
//    所以底部按钮一律**先按颜色找**，找到就点它的真实中心，
//    找不到才回退到 config.js 里的实测坐标。

/** 用 root 截屏并读成位图 */
function shotImage() {
    if (!U.isRoot()) return null;
    try {
        U.sh("screencap -p " + SHOT);
        return images.read(SHOT);
    } catch (e) {
        return null;
    }
}

function rgbAt(img, x, y) {
    var c = images.pixel(img, x, y);
    return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
}

/**
 * 在 [y0,y1] 条带里按颜色找按钮色块。
 *
 * 做法：每隔几行/几列采样，统计每个 x 列「命中该颜色」的比例，
 *       取连续且足够宽的一段作为候选，再**挑离 hintX 最近的那个**。
 *
 * ⚠️ 为什么要 hintX：地图上本身就有大片绿色（公园/绿地），
 *    光按颜色找会认错。用 config 里的实测坐标当先验，只做小幅修正。
 *
 * @param kind      "dark"（深色药丸）| "green"（绿色药丸）
 * @param xMin,xMax 限定横向范围（用于区分并排的两个按钮）
 * @param minWidth  最小宽度（采样列数），过滤掉零碎同色块
 * @param hintX     期望的中心 x（config 实测值）
 * @return {x,y} 或 null
 */
function locateButton(kind, y0, y1, xMin, xMax, minWidth, hintX) {
    var img = shotImage();
    if (!img) return null;
    var W = img.getWidth();
    if (xMax > W) xMax = W;

    var cnt = {}, rows = 0, x, y;
    for (y = y0; y <= y1; y += 8) {
        rows++;
        for (x = xMin; x < xMax; x += 4) {
            var p = rgbAt(img, x, y);
            if (kind === "dark" ? isPillDark(p) : isGreen(p)) {
                cnt[x] = (cnt[x] || 0) + 1;
            }
        }
    }
    img.recycle();
    if (rows === 0) return null;

    // 命中率过半的列才算按钮内部
    //（药丸中间有白色文字，会把那几行「打断」，所以阈值取 0.5 而不是 0.6）
    var need = Math.ceil(rows * 0.5);
    var keys = [];
    for (var k in cnt) {
        if (cnt[k] >= need) keys.push(parseInt(k, 10));
    }
    if (keys.length === 0) return null;
    keys.sort(function (a, b) { return a - b; });

    // 切成长度 >= minWidth 的连续段（允许 24px 以内的采样空隙）
    var spans = [], s = keys[0];
    for (var i = 1; i < keys.length; i++) {
        if (keys[i] - keys[i - 1] > 24) {
            if (keys[i - 1] - s >= minWidth) spans.push([s, keys[i - 1]]);
            s = keys[i];
        }
    }
    if (keys[keys.length - 1] - s >= minWidth) spans.push([s, keys[keys.length - 1]]);
    if (spans.length === 0) return null;

    // 就近选：挑中心离 hintX 最近的那段，且偏移不能太离谱
    var best = null, bestD = 1e9;
    for (var j = 0; j < spans.length; j++) {
        var cx = (spans[j][0] + spans[j][1]) / 2;
        var d = Math.abs(cx - hintX);
        if (d < bestD) { bestD = d; best = cx; }
    }
    if (bestD > 250) return null;      // 偏太远，宁可回退配置坐标

    return { x: Math.round(best), y: Math.round((y0 + y1) / 2), off: Math.round(best - hintX) };
}

/** 底部按钮条带的纵向范围（实测药丸在 2136~2260） */
var BTN_Y0 = 2110, BTN_Y1 = 2290;

/**
 * 点底部按钮：优先按颜色定位（以配置坐标为先验做小幅修正），失败回退配置坐标。
 * @return 实际使用的坐标
 */
function tapBottomButton(fallbackXY, kind, xMin, xMax, minWidth, label, pressMs) {
    var loc = locateButton(kind, BTN_Y0, BTN_Y1, xMin, xMax, minWidth, fallbackXY[0]);
    var xy = loc ? [loc.x, loc.y] : fallbackXY;
    U.log("  定位「" + label + "」→ [" + xy[0] + ", " + xy[1] + "]" +
          (loc ? "（按颜色修正 " + (loc.off >= 0 ? "+" : "") + loc.off + "px）" : "（用配置坐标）"));
    if (pressMs) pressXY(xy, label, pressMs);
    else tapXY(xy, label);
    return xy;
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
/**
 * 当前前台是不是**小程序**。
 *
 * ⚠️ 不能用 `currentPackage() == com.tencent.mm` 判断 —— 微信进程本来
 *    就在后台，`home()` 后可能仍被判为前台，导致「假成功」。
 *    必须看 Activity 名：小程序是 `AppBrandUI00`，微信主界面是 `LauncherUI`。
 */
function currentActivity() {
    return U.sh("dumpsys activity activities | grep topResumedActivity | head -1");
}

function isMiniProgramOpen() {
    return currentActivity().indexOf("AppBrandUI") >= 0;
}

/** 把当前前台 Activity 翻译成人话，便于排查卡在哪一步 */
function describeScreen(act) {
    act = String(act || "");
    if (act.indexOf("AppBrandUI") >= 0) return "小程序";
    if (act.indexOf("LauncherUI") >= 0) return "微信主界面";
    if (act.indexOf("Splash") >= 0) return "微信启动页";
    if (act.indexOf("com.mo.fakeloc") >= 0) return "FakeLoc";
    if (act.indexOf("autojs") >= 0) return "AutoX";
    if (act.indexOf("com.android.launcher") >= 0) return "桌面";
    if (trim(act) === "") return "（无前台 Activity / 息屏）";
    var m = /topResumedActivity=ActivityRecord\{\S+ \S+ ([\w.\/]+)/.exec(act);
    return m ? m[1] : "未知";
}

function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

/**
 * 等小程序真正打开。
 *
 * ⚠️ 点击快捷方式后，微信要冷启动 + 加载小程序，实测**可能十几秒**，
 *    所以这里超时给得比较宽，并且每秒把「当前停在哪个界面」记进日志，
 *    卡住时能直接看出是「微信主界面」还是「启动页」还是别的。
 */
function waitMiniProgram(timeoutMs) {
    var w = 0;
    var lastState = "";
    while (w < timeoutMs) {
        var act = currentActivity();
        if (act.indexOf("AppBrandUI") >= 0) {
            U.log("  ✅ 小程序已打开（等待 " + w + "ms）");
            return true;
        }
        var state = describeScreen(act);
        if (state !== lastState) {
            U.log("  …等待中 " + w + "ms，当前界面: " + state);
            lastState = state;
        }
        sleep(1000);
        w += 1000;
    }
    U.log("  ⚠️ 等待小程序超时（" + timeoutMs + "ms），最后停在: " + describeScreen(currentActivity()));
    return false;
}

/**
 * 是否已经在桌面。
 *
 * ⚠️ 不能用 `indexOf("Launcher")` 判断 —— 微信主界面的 Activity 是
 *    `com.tencent.mm/.ui.LauncherUI`，也含 "Launcher"，会被误判成桌面。
 *    所以按**包名**判断，并显式排除微信/AutoX/FakeLoc。
 */
function isHomeReady() {
    var pkg = U.currentApp();
    if (pkg === C.PKG.wechat) return false;
    if (pkg.indexOf("autojs") >= 0 || pkg.indexOf("fakeloc") >= 0) return false;
    return pkg.indexOf("launcher") >= 0;
}

/** 等桌面真正到前台（home() 后立刻点击会点空） */
function waitHomeReady(timeoutMs) {
    var w = 0;
    while (w < timeoutMs) {
        if (isHomeReady()) return true;
        sleep(400);
        w += 400;
    }
    U.log("  ⚠️ 等待桌面超时（当前: " + describeScreen(currentActivity()) + "）");
    return false;
}

function openMiniProgram() {
    U.log("回桌面 → 打开乐跑小程序");
    goHome();
    // ⚠️ 桌面切换有动画，太早点快捷方式会被吞掉（实测 1.5s 不够，点了没反应）
    sleep(3000);
    waitHomeReady(C.CFG.timeout.homeReady);
    sleep(1000);   // 再稳一下

    // ---- 快路径：直接点一次（桌面通常就在第一页）----
    tapXY(C.XY.shortcutRun, "苍霞乐跑快捷方式");
    if (waitMiniProgram(C.CFG.timeout.miniProgram)) {
        afterMiniProgramOpened();
        return;
    }

    // ---- 兜底 1：只唤起了微信、没进小程序 ----
    if (describeScreen(currentActivity()) === "微信主界面") {
        U.log("  兜底：停在微信主界面 → 退回桌面重试");
        goHome();
        sleep(3000);
        waitHomeReady(C.CFG.timeout.homeReady);
        sleep(1000);
        tapXY(C.XY.shortcutRun, "苍霞乐跑快捷方式");
        if (waitMiniProgram(C.CFG.timeout.miniProgram)) {
            afterMiniProgramOpened();
            return;
        }
    }

    // ---- 兜底 2：图标可能不在当前页，逐页找 ----
    U.log("  兜底：逐页查找快捷方式");
    for (var attempt = 1; attempt <= 4; attempt++) {
        var visible = shortcutVisible();
        U.log("  第 " + attempt + " 轮：图标" + (visible ? "可见" : "不可见") + "（root 截屏判定）");
        tapXY(C.XY.shortcutRun, "苍霞乐跑快捷方式");
        if (waitMiniProgram(C.CFG.timeout.miniProgram)) {
            afterMiniProgramOpened();
            return;
        }
        backOneHomePage();
    }
    U.log("  ❌ 未打开小程序 —— 请确认快捷方式在桌面第一页");
}

/** 小程序首页「校园乐跑」图标是否可见（绿色圆底，采样图标边缘避开白色图案） */
function isHomeIconVisible() {
    var cx = C.XY.entryRun[0], cy = C.XY.entryRun[1];
    var pts = [[cx - 38, cy], [cx + 38, cy], [cx, cy - 38], [cx, cy + 38]];
    for (var i = 0; i < pts.length; i++) {
        if (isGreen(pixel(pts[i][0], pts[i][1]))) return true;
    }
    return false;
}

/**
 * 小程序已打开后的收尾：等**首页真正渲染出来** + 登录兜底。
 *
 * ⚠️ AppBrandUI 出现 ≠ 页面画好。小程序还要拉数据、渲染，实测又要几秒。
 *    所以这里用 root 截屏轮询「校园乐跑」图标是否出现，出现才继续。
 */
function afterMiniProgramOpened() {
    var ok = false;
    var where = "";
    for (var i = 1; i <= 12; i++) {
        sleep(1000);
        if (isHomeIconVisible()) { ok = true; where = "首页"; break; }
        // ⚠️ 小程序会**记住上次停留的页面** —— 上次若停在跑步页，
        //    重开就直接是跑步页（实测 2026-09-29）。这里必须一并认出来，
        //    否则会白等 12s，后面 enterRunPage 还会多点一次「校园乐跑」。
        if (isRunPage()) { ok = true; where = "跑步页（小程序记住了上次页面）"; break; }
    }
    if (ok) U.log("  ✅ 页面已渲染：" + where + "（等了 " + i + "s）");
    else U.log("  ⚠️ 12s 内既不是首页也不是跑步页（可能是登录页）");

    handleLoginIfNeeded();
    R.snap("01b-小程序首页");
}

/** 首页 → 跑步页（若小程序记住了上次页面、已停在跑步页，则跳过点击） */
function enterRunPage() {
    if (isRunPage()) {
        U.log("  已直接停在跑步页，跳过「校园乐跑」点击");
    } else {
        tapXY(C.XY.entryRun, "校园乐跑");
        sleep(4500);
    }
    R.snap("02-跑步页");
}

/** 跑步页 → 点开始乐跑（点完会弹「成绩合格标准」或「跑步提示」） */
function tapStart() {
    for (var i = 1; i <= 3; i++) {
        if (!tapText(C.CFG.startTexts, 6000)) {
            tapXY(C.XY.btnStart, "开始乐跑");
        }
        sleep(2500);
        if (hasDialog() || !isRunPage()) {
            U.log("  ✅ 已离开跑步页（第 " + i + " 次点击生效）");
            break;
        }
        U.log("  ⚠️ 第 " + i + " 次点「开始乐跑」没反应，重试");
    }
    R.snap("03-点开始乐跑后");
}

/**
 * 关掉提示弹窗（自绘，只能盲点）。
 *   a) 「成绩合格标准」→「我知道了」：时间窗内必现
 *   b) 「跑步提示」→「自由跑」：仅时间窗外
 *
 * ⚠️ 到底弹哪个由**时间窗**决定，脚本无法预知，所以两个位置都点一遍；
 *    再用 hasDialog() 校验是否真的关掉，没关掉就补点。
 */
function closeMapDialogs() {
    U.log("关闭提示弹窗（盲点）");
    pressXY(C.XY.dlgAck, "我知道了(成绩合格标准)", 200);
    sleep(1500);
    if (hasDialog()) {
        pressXY(C.XY.dlgFreeRun, "自由跑(仅时间窗外)", 200);
        sleep(1500);
    }
    if (hasDialog()) {
        U.log("  ⚠️ 弹窗仍在，再补点一次「我知道了」");
        pressXY(C.XY.dlgAck, "我知道了(成绩合格标准)", 200);
        sleep(1500);
    }
    U.log(hasDialog() ? "  ❌ 弹窗没关掉（后面很可能点空，见 step_04 截图）"
                      : "  ✅ 弹窗已关闭");
    R.snap("04-关弹窗后");
}

/**
 * 地图页 → 正式开始跑步。
 *
 * ★ 必须校验：这一步点空的话后面整段都是白跑 ——
 *   2026-09-29 早 7:30 的事故就出在「点没点中没人知道」。
 */
function startRunning() {
    for (var i = 1; i <= 3; i++) {
        if (!tapText(C.CFG.startTexts, 5000)) {
            tapBottomButton(C.XY.btnStartMap, "green", 0, 1080, 70, "开始乐跑(地图页)", 0);
        }
        sleep(3500);
        if (isRunning()) {
            U.log("  ✅ 已确认进入跑步状态（第 " + i + " 次点击生效）");
            R.snap("05-开跑后");
            return true;
        }
        U.log("  ⚠️ 第 " + i + " 次点「开始乐跑(地图页)」没进入跑步状态，重试");
    }
    U.log("  ❌ 连续 3 次都没进入跑步状态！本次不可能产生成绩");
    R.snap("05-开跑失败");
    return false;
}

/**
 * 长按暂停 → 结束跑步 → 二次确认。
 *
 * ★ 必须校验：暂停没生效的话，「结束跑步」「确认结束」全部落空，
 *   跑步一直没结束；最后小程序被重启 → 该次成绩直接作废（无记录）。
 */
function stopRunning() {
    var ended = false;
    for (var round = 1; round <= 3 && !ended; round++) {
        tapBottomButton(C.XY.btnPause, "dark", 200, 880, 70, "长按暂停", 1200);
        sleep(3500);

        if (!isPaused()) {
            U.log("  ⚠️ 第 " + round + " 轮：长按暂停未生效，重试");
            continue;
        }
        U.log("  ✅ 已确认暂停（第 " + round + " 轮）");

        tapBottomButton(C.XY.btnEndRun, "dark", 0, 540, 70, "结束跑步", 200);
        sleep(3500);
        pressXY(C.XY.dlgEndConfirm, "确认结束", 200);   // 有二次确认弹窗时才有用
        sleep(3500);

        if (!isRunning() && !isPaused()) {
            U.log("  ✅ 已确认退出跑步状态");
            ended = true;
        } else {
            U.log("  ⚠️ 第 " + round + " 轮：仍在跑步/暂停状态，整体重试");
        }
    }
    R.snap("06-长按暂停后");
    R.snap("08-确认结束后");
    return ended;
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

    goHome();
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
    closeMiniProgram: closeMiniProgram,
    // 状态判定（供流程层校验用）
    isRunning: isRunning,
    isPaused: isPaused,
    isRunPage: isRunPage,
    hasDialog: hasDialog
};
