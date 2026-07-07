// 眾志成城 · 全班共鬥 Boss Raid — 同步層（Upstash Redis REST）
// action: create / join / start / hit / state / mystate
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TTL = 4 * 60 * 60; // 所有 key 4 小時過期
const rk = (c, s = "") => `raid:${c}${s ? ":" + s : ""}`;
// 每人 HP 係數：短/中/長
const HP_PER = { short: 150, mid: 250, long: 400 };
const BOSSES = ["xuemo", "shangyu", "xueshashi", "licanglan", "shinian"];

const j = (res, code, obj) => res.status(code).json(obj);

async function loadRoom(code) {
  return code ? await redis.get(rk(code)) : null;
}
async function saveRoom(code, room) {
  await redis.set(rk(code), room, { ex: TTL });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.method === "POST" ? req.body || {} : req.query || {};
  const action = q.action;
  const code = String(q.code || "").trim();

  try {
    if (action === "create") {
      const boss = BOSSES.includes(q.boss) ? q.boss : "xuemo";
      const habits = Array.isArray(q.habits) && q.habits.length
        ? q.habits.filter((h) => h >= 0 && h <= 6) : [0, 1, 2, 3, 4, 5, 6];
      const len = HP_PER[q.len] ? q.len : "mid";
      // 4 位數房號，避開已存在的
      let newCode = "";
      for (let i = 0; i < 8; i++) {
        newCode = String(Math.floor(1000 + Math.random() * 9000));
        if (!(await redis.exists(rk(newCode)))) break;
      }
      await saveRoom(newCode, {
        boss, habits, len, status: "lobby",
        maxhp: 0, startAt: 0, endAt: 0, slayer: "", seed: Date.now() % 100000,
      });
      return j(res, 200, { code: newCode });
    }

    const room = await loadRoom(code);
    if (!room) return j(res, 404, { error: "房間不存在或已過期" });

    if (action === "join") {
      const name = String(q.name || "").trim().slice(0, 8);
      if (!name) return j(res, 400, { error: "請輸入名號" });
      if (room.status === "won") return j(res, 400, { error: "此役已終" });
      const ch = String(q.ch || "xiaoyi");
      const existing = await redis.hget(rk(code, "players"), name);
      if (!existing) {
        await redis.hset(rk(code, "players"), {
          [name]: { ch, dmg: 0, ok: 0, miss: 0, ults: 0 },
        });
        await redis.expire(rk(code, "players"), TTL);
      }
      return j(res, 200, { room, rejoined: !!existing });
    }

    if (action === "start") {
      if (room.status !== "lobby") return j(res, 200, { room });
      const n = (await redis.hlen(rk(code, "players"))) || 1;
      room.maxhp = n * HP_PER[room.len];
      room.status = "fight";
      room.startAt = Date.now();
      await saveRoom(code, room);
      await redis.set(rk(code, "hp"), room.maxhp, { ex: TTL });
      await redis.set(rk(code, "combo"), 0, { ex: TTL });
      return j(res, 200, { room });
    }

    if (action === "hit") {
      if (room.status !== "fight") return j(res, 200, { room, hp: 0 });
      const name = String(q.name || "").slice(0, 8);
      const kind = q.kind === "ult" ? "ult" : q.kind === "miss" ? "miss" : "atk";
      const dmg = Math.max(0, Math.min(160, parseInt(q.dmg, 10) || 0)); // 破綻×2 後上限 160

      // 個人統計（客端回報整包，教室信任模型）
      if (q.stats && name) {
        await redis.hset(rk(code, "players"), { [name]: q.stats });
      }

      if (kind === "miss") {
        await redis.set(rk(code, "combo"), 0, { ex: TTL });
        const hp = (await redis.get(rk(code, "hp"))) || 0;
        return j(res, 200, { hp: Number(hp), combo: 0 });
      }

      // 支援型大絕副作用
      if (kind === "ult" && q.fx === "buff") {
        await redis.set(rk(code, "buff"), Date.now() + 30000, { ex: TTL });
      }
      if (kind === "ult" && q.fx === "gift" && name) {
        const all = Object.keys((await redis.hgetall(rk(code, "players"))) || {})
          .filter((n) => n !== name);
        for (let i = all.length - 1; i > 0; i--) {
          const k = Math.floor(Math.random() * (i + 1));
          [all[i], all[k]] = [all[k], all[i]];
        }
        const picked = all.slice(0, 2);
        if (picked.length) {
          const upd = {};
          picked.forEach((n) => (upd[n] = Date.now()));
          await redis.hset(rk(code, "gifts"), upd);
          await redis.expire(rk(code, "gifts"), TTL);
        }
      }

      const combo = await redis.incr(rk(code, "combo"));
      let hp = await redis.decrby(rk(code, "hp"), dmg);
      await redis.lpush(rk(code, "feed"), JSON.stringify({
        name, dmg, kind, fx: q.fx || "", ch: q.stats?.ch || "xiaoyi", ulname: q.ulname || "", t: Date.now(),
      }));
      await redis.ltrim(rk(code, "feed"), 0, 29);
      await redis.expire(rk(code, "feed"), TTL);

      let slain = false;
      if (hp <= 0) {
        hp = 0;
        // 搶最後一擊：NX 鎖，第一個到的成為斬魔者
        const claimed = await redis.set(rk(code, "slain"), name, { nx: true, ex: TTL });
        if (claimed) {
          room.status = "won";
          room.endAt = Date.now();
          room.slayer = name;
          await saveRoom(code, room);
          slain = true;
        }
      }
      return j(res, 200, { hp: Number(hp), combo, slain });
    }

    if (action === "state") { // Boss 投影端 poll（重）
      const [hp, players, feedRaw, combo, buff, weak, weakDone] = await Promise.all([
        redis.get(rk(code, "hp")),
        redis.hgetall(rk(code, "players")),
        redis.lrange(rk(code, "feed"), 0, 29),
        redis.get(rk(code, "combo")),
        redis.get(rk(code, "buff")),
        redis.get(rk(code, "weak")),
        redis.get(rk(code, "weakDone")),
      ]);
      // 破綻時刻：狂怒期（HP≤50%）隨機乍現一次，60 秒全班傷害×2；HP≤25% 保底觸發
      let weakUntil = Number(weak) || 0;
      const hpN = Math.max(0, Number(hp) || 0);
      if (room.status === "fight" && room.maxhp && hpN > 0 && hpN <= room.maxhp / 2
        && !weakUntil && !weakDone
        && (hpN <= room.maxhp / 4 || Math.random() < 0.04)) {
        weakUntil = Date.now() + 60000;
        await redis.set(rk(code, "weak"), weakUntil, { ex: TTL });
        await redis.set(rk(code, "weakDone"), 1, { ex: TTL });
      }
      const feed = (feedRaw || []).map((s) => (typeof s === "string" ? JSON.parse(s) : s));
      return j(res, 200, {
        room, hp: hpN, combo: Number(combo) || 0,
        players: players || {}, feed, buffUntil: Number(buff) || 0, weakUntil,
      });
    }

    if (action === "mystate") { // 學生端 poll（輕）
      const name = String(q.name || "").slice(0, 8);
      const [hp, buff, giftAt, weak] = await Promise.all([
        redis.get(rk(code, "hp")),
        redis.get(rk(code, "buff")),
        name ? redis.hget(rk(code, "gifts"), name) : null,
        redis.get(rk(code, "weak")),
      ]);
      return j(res, 200, {
        status: room.status, maxhp: room.maxhp, hp: Math.max(0, Number(hp) || 0),
        habits: room.habits, seed: room.seed, boss: room.boss, slayer: room.slayer || "",
        buffUntil: Number(buff) || 0, giftAt: Number(giftAt) || 0, weakUntil: Number(weak) || 0,
      });
    }

    return j(res, 400, { error: "未知指令" });
  } catch (e) {
    return j(res, 500, { error: String(e.message || e) });
  }
}
