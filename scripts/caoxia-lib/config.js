/**
 * caoxia-lib/config.js —— 全部可调参数与坐标
 * ============================================================================
 *
 * ★ 换设备 / 改布局 / 调参数，**只需要改这个文件**，不必碰任何逻辑代码。
 *
 * 坐标系：1080x2400 @480dpi
 * 若你的分辨率不同，按比例换算后覆盖 XY 里的对应项即可。
 * 校准工具：scripts/locate-color.py（截屏后按颜色找元素中心）
 *
 * ============================ 修改指引 ============================
 *   改跑多少公里        → RUN.targetKm
 *   改了 FakeLoc 配速   → RUN.paceMinPerKm（必须一致！）
 *   界面按钮位置变了    → XY 里对应的项
 *   换手机              → XY 全部 + 可能需要重测
 * =================================================================
 */

// ============================== 坐标表 ==============================
var XY = {
    // ---- 桌面 ----
    shortcutRun: [909, 1235],       // 「苍霞乐跑」快捷方式

    // ---- 小程序：首页 ----
    entryRun: [408, 729],           // 「校园乐跑」图标

    // ---- 小程序：跑步页 ----
    btnStart: [539, 1313],          // 「开始乐跑」

    // ---- 小程序：地图页弹窗 ----
    dlgAck: [540, 1552],            // 「成绩合格标准」→「我知道了」（时间窗内必现）
    dlgFreeRun: [711, 1315],        // 「跑步提示」→「自由跑」（仅时间窗外）

    // ---- 小程序：地图页 / 跑步中 ----
    // ★ 2026-09-29 用 Pillow 逐行扫描实测（此前凭肉眼估的 2150 贴在药丸上边缘，
    //   只有十几像素余量，稍有偏移就会点空 → 跑步结束不了 → 该次成绩作废）
    btnStartMap: [580, 2198],       // 地图页「开始乐跑」（药丸 x∈[371,790]，中心 580）
    btnPause: [539, 2198],          // 跑步中「长按暂停」（药丸 x∈[330,749]，中心 539）

    // ---- 小程序：结束流程 ----
    btnEndRun: [302, 2198],         // 暂停后左下「结束跑步」（x∈[94,511]，中心 302）
    btnResume: [776, 2198],         // 暂停后右下「继续跑步」（x∈[567,986]，中心 776）
    dlgEndConfirm: [376, 1337],     // 二次确认弹窗里的「结束跑步」

    // ---- 小程序：菜单 ----
    wxMore: [877, 182],             // 右上角「···」
    wxReenter: [716, 1900],         // 「重新进入小程序」

    // ---- ★ 登录页（登录态丢失时才会出现）----
    //   出现条件：微信被 force-stop 过 / 登录过期
    //   处理顺序：立即登录 → 勾选协议 → 授权登录
    loginBtn: [540, 1175],          // 「立即登录」
    loginAgree: [108, 680],         // 协议勾选框
    loginAuth: [540, 880]           // 「授权登录」
};

// ============== 状态判定采样点（root 截屏取色，用于校验每步是否成功）==============
//
// 实测（2026-09-29，1080x2400）：
//   跑步中： (539,2140) 被「长按暂停」深色药丸覆盖
//   暂停后： (302,2198) 深色「结束跑步」 + (776,2198) 绿色「继续跑步」
//   弹窗时： 整屏被 60% 黑色蒙层压暗，(539,2140) 变成 ~(102,102,102) 灰
var PROBE = {
    pausePill: [539, 2140],         // 跑步中该点应为深色
    endBtn: [302, 2198],            // 暂停后该点应为深色
    resumeBtn: [776, 2198],         // 暂停后该点应为绿色
    dialogScrim: [539, 2140]        // 有弹窗蒙层时该点为灰色
};

// ============================== 运行时配置 ==============================
var CFG = {
    // 按钮文字候选（原生控件可用；小程序自绘读不到 → 回退坐标）
    startTexts: ["开始乐跑", "开始跑步", "开始"],
    loginTexts: ["立即登录", "登录"],
    authTexts: ["授权登录"],

    timeout: {
        maxRun: 45 * 60 * 1000,     // 硬上限（安全阀）
        miniProgram: 25000,         // 等小程序打开（微信冷启动 + 加载较慢，实测可十几秒）
        homeReady: 8000,            // 等桌面就绪（home() 后立刻点会点空）
        cooldown: 2500              // 每次点击后的默认等待
    },

    // ---- 开关 ----
    dryRun: false,                  // true = 只打印不操作
    probeOnly: false,               // true = 只探测环境，不跑流程
    cleanWechat: false,             // true = 结束时强杀微信（⚠️ 会清掉登录态！）

    // ★ 调试开关：由 caoxia-run-debug.js 打开，生产版保持 false（零开销）
    //   true = 全程录屏 + 关键步骤截图 → /sdcard/脚本/diag/
    debug: false
};

// =============== 调试录制配置（仅 CFG.debug = true 时生效）===============
var REC = {
    dir: "/sdcard/脚本/diag",       // 录屏与截图输出目录
    segSeconds: 170,                // 每段时长（screenrecord 单次上限 180s）
    maxSegments: 8,                 // 最多录多少段（8×170s≈23min；一次完整跑约 5 段）
    bitRate: 4000000,               // 码率 4Mbps ≈ 每秒 0.5MB
    sampleSeconds: 30               // 等达标期间每 N 秒补一张截图
};

// ======================= 里程 / 时长换算 =======================
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

    debugSeconds: 0         // >0 时直接指定跑步秒数（调试用），生产保持 0
};

// ============================== 常量 ==============================
var PKG = {
    fakeloc: "com.mo.fakeloc",
    fakelocReceiver: "com.mo.fakeloc.service.AutomationReceiver",
    actionStart: "com.mo.fakeloc.automation.START_ROUTE",
    actionStop: "com.mo.fakeloc.automation.STOP_ROUTE",

    wechat: "com.tencent.mm",

    autox: "org.autojs.autoxjs.v6",
    autoxA11y: "com.stardust.autojs.core.accessibility.AccessibilityService",
    autoxNotif: "com.stardust.notification.NotificationListenerService"
};

// ============================== 路径 ==============================
var PATH = {
    log: "/sdcard/脚本/caoxia-run.log",
    lock: "/sdcard/脚本/caoxia-run.lock"
};

module.exports = {
    XY: XY,
    PROBE: PROBE,
    CFG: CFG,
    RUN: RUN,
    REC: REC,
    PKG: PKG,
    PATH: PATH
};
