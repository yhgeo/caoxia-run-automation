/**
 * caoxia-lib/recorder.js —— 调试用：全程录屏 + 关键步骤截图
 * ============================================================================
 *
 * ★ 只在 CFG.debug = true 时生效（由 caoxia-run-debug.js 打开）。
 *   生产版（caoxia-run.js）里所有函数直接 return，零开销、零副作用。
 *
 * ⚠️ 本 ROM 的关键坑：`screenrecord` 以 **shell 用户**运行会 **段错误（rc=139）**，
 *    但以 **root** 运行完全正常。所以录屏必须走 root（U.sh）。
 *
 * 录屏策略：**分段循环**
 *   · screenrecord 单次上限 180s，所以用 sh 循环录成 rec_00.mp4 / rec_01.mp4 …
 *   · 脚本结束时写一个 .stop 标记，循环**跑完当前段**再退出
 *     —— 不能直接 kill：被 kill 的 mp4 没有 moov atom，根本放不出来
 *   · 循环脚本落盘成 rec_loop.sh 再 nohup 执行，避免多层引号被 shell 吃掉
 *
 * 输出（/sdcard/脚本/diag/）：
 *   rec_00.mp4 …        全程录像（分段）
 *   step_*.png          关键步骤截图（按流程顺序命名）
 *   t_*.png             等达标期间的定时采样截图
 */

var C = require("./config.js");
var U = require("./util.js");

function dir() { return C.REC.dir; }
function enabled() { return !!C.CFG.debug; }

/** 清掉上一次的录制产物，避免无限堆积 */
function purge() {
    if (!U.isRoot()) return;
    U.sh("mkdir -p " + dir());
    U.sh("rm -f " + dir() + "/rec_*.mp4 " + dir() + "/step_*.png " + dir() + "/t_*.png");
}

/**
 * 按进程名杀进程（录屏 loop / screenrecord 都是 root 进程，只能 root 杀）。
 */
function killByPattern(pat, tag) {
    if (!U.isRoot()) return;
    U.sh("mkdir -p " + dir());
    var s = "#!/system/bin/sh\n" +
            "ps -A -o PID,ARGS 2>/dev/null | grep -E '" + pat + "' | grep -v grep " +
            "| awk '{print $1}' | while read p; do kill -9 \"$p\" 2>/dev/null; done\n";
    try {
        files.write(dir() + "/kill_" + tag + ".sh", s);
        U.sh("chmod 755 " + dir() + "/kill_" + tag + ".sh");
        U.sh("sh " + dir() + "/kill_" + tag + ".sh");
        sleep(600);
    } catch (e) { }
}

/**
 * 干掉所有残留的录屏进程（loop 外壳 + screenrecord）。
 * 只在 start() 里调用 —— 保证不会有两个 loop 抢编码器。
 *
 * ⚠️ 为什么必须做：loop 是**后台常驻**的，脚本异常退出（被强停/崩溃）时它不会
 *    自己结束，会一直录到 maxSegments 为止。更糟的是下一次 start() 会
 *    `rm .stop` —— 残留 loop 就永远等不到停止标记，越积越多
 *    （2026-09-29 实测同时挂了 4 个 rec_loop.sh，导致新录屏抢不到编码器直接失败）。
 */
function killAll() {
    killByPattern("screenrecord|rec_loop", "all");
}

/**
 * 只杀 loop 外壳，**不动正在录的那段 screenrecord**。
 *
 * 这样当前这段会自然录满 --time-limit 后退出（mp4 才有 moov、能播放），
 * 但不会再开新的一段 —— 即「立刻确定地停下来」。
 */
function killLoop() {
    killByPattern("rec_loop", "loop");
}

/**
 * 开始录屏（后台分段循环，**不阻塞**脚本）。
 * @return true = 已启动
 */
function start() {
    if (!enabled()) return false;
    if (!U.isRoot()) { U.log("⚠️ 无 root，跳过录屏"); return false; }

    killAll();          // ★ 先清掉上一次的残留 loop，否则会越积越多
    purge();
    U.sh("rm -f " + dir() + "/.stop");
    U.sh("rm -f " + dir() + "/rec_loop.err");

    var d = dir();
    var loop =
        "#!/system/bin/sh\n" +
        "D='" + d + "'\n" +
        "i=0\n" +
        "while [ $i -lt " + C.REC.maxSegments + " ]; do\n" +
        "  [ -f $D/.stop ] && break\n" +
        "  n=$(printf '%02d' $i)\n" +
        "  screenrecord --time-limit " + C.REC.segSeconds +
        " --bit-rate " + C.REC.bitRate + " $D/rec_$n.mp4 2>> $D/rec_loop.err\n" +
        "  echo \"seg $n exit=$?\" >> $D/rec_loop.err\n" +
        "  i=$((i+1))\n" +
        "done\n";

    try {
        files.write(d + "/rec_loop.sh", loop);
    } catch (e) {
        U.log("⚠️ 写录屏循环脚本失败: " + e);
        return false;
    }
    U.sh("chmod 755 " + d + "/rec_loop.sh");
    U.sh("nohup sh " + d + "/rec_loop.sh >/dev/null 2>&1 &");

    // ★ 校验「真的在录」：等几秒看 rec_00.mp4 是否在写盘。
    //   只数进程数不靠谱 —— 编码器被别的 screenrecord 占用时，
    //   进程会立刻失败退出，光看 ps 看不出问题（2026-09-29 踩过）。
    var size = 0;
    for (var t = 0; t < 6; t++) {
        sleep(1000);
        size = parseInt(U.trim(U.sh("stat -c %s " + d + "/rec_00.mp4 2>/dev/null")), 10) || 0;
        if (size > 0) break;
    }
    if (size > 0) {
        U.log("🔴 录屏已启动并确认在写盘（rec_00.mp4 " + size + "B，每段 " +
              C.REC.segSeconds + "s → " + d + "）");
        return true;
    }

    var err = U.trim(U.sh("cat " + d + "/rec_loop.err 2>/dev/null"));
    U.log("❌ 录屏没能启动！screenrecord 可能被占用或失败" + (err ? "：" + err : ""));
    return false;
}

/**
 * 结束录屏。
 *
 * 两步走，缺一不可：
 *   1. 写 .stop 标记 —— 正常路径，loop 在下一轮开头看到就退出
 *   2. 直接杀掉 loop 外壳 —— 兜底，确保**一定**停下来
 *      （历史教训：只写标记的话，下一次运行的 start() 会把标记删掉，
 *        残留 loop 就永远活着，越积越多 → 新录屏抢不到编码器）
 *
 * 注意：**不杀正在录的那段 screenrecord** —— 让它自然录满，mp4 才完整可播。
 *       它最多再跑 segSeconds 秒就自己退出。
 */
function stop() {
    if (!enabled()) return;
    try { files.write(dir() + "/.stop", "1"); } catch (e) { }
    killLoop();
    U.log("🔴 录屏已停止（loop 已杀；当前那段最多再录 " + C.REC.segSeconds +
          "s 后自行收尾，文件在 " + dir() + "）");
}

/** 关键步骤截图（按流程命名，方便直接对着看） */
function snap(name) {
    if (!enabled() || !U.isRoot()) return;
    try { U.sh("screencap -p " + dir() + "/step_" + name + ".png"); } catch (e) { }
}

/** 等待期间的定时采样截图 */
function sample(seq) {
    if (!enabled() || !U.isRoot()) return;
    try { U.sh("screencap -p " + dir() + "/t_" + seq + ".png"); } catch (e) { }
}

module.exports = {
    start: start,
    stop: stop,
    snap: snap,
    sample: sample,
    purge: purge,
    killAll: killAll,
    enabled: enabled,
    dir: dir
};
