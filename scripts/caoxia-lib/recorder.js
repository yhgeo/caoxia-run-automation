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
 * 开始录屏（后台分段循环，**不阻塞**脚本）。
 * @return true = 已启动
 */
function start() {
    if (!enabled()) return false;
    if (!U.isRoot()) { U.log("⚠️ 无 root，跳过录屏"); return false; }

    purge();
    U.sh("rm -f " + dir() + "/.stop");

    var d = dir();
    var loop =
        "#!/system/bin/sh\n" +
        "D='" + d + "'\n" +
        "i=0\n" +
        "while [ $i -lt " + C.REC.maxSegments + " ]; do\n" +
        "  [ -f $D/.stop ] && break\n" +
        "  n=$(printf '%02d' $i)\n" +
        "  screenrecord --time-limit " + C.REC.segSeconds +
        " --bit-rate " + C.REC.bitRate + " $D/rec_$n.mp4\n" +
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
    sleep(2000);

    var n = U.trim(U.sh("ps -A | grep screenrecord | wc -l"));
    U.log("🔴 录屏已启动（每段 " + C.REC.segSeconds + "s → " + d + "/rec_*.mp4，进程数=" + n + "）");
    return true;
}

/** 结束录屏：写标记，让循环跑完当前段后自行退出（保证文件可播放） */
function stop() {
    if (!enabled()) return;
    try {
        files.write(dir() + "/.stop", "1");
        U.log("🔴 录屏已标记结束（当前段录完自动收工，文件在 " + dir() + "）");
    } catch (e) { }
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
    enabled: enabled,
    dir: dir
};
