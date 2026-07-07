// 眾志成城 · 全班共鬥 Boss Raid — 同步層（Upstash Redis REST）
// action: create / join / start / hit / state / mystate / mvp / warcry / log / hall / suggest / sqlist / sqjudge
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TTL = 4 * 60 * 60; // 房間內 key 4 小時過期；班級長期 key（camp/hall/hidden/warcry/sq/eq）不設 TTL
const rk = (c, s = "") => `raid:${c}${s ? ":" + s : ""}`;
const ck = (cls, s) => `raid:${s}:${cls}`;
// 每人 HP 係數：短/中/長
const HP_PER = { short: 150, mid: 250, long: 400 };
const BOSSES = ["xuemo", "shangyu", "xueshashi", "licanglan", "shinian", "xuemo2"];
// 行為牌：每場開房隨機抽一張（效果由客端套用，swift 由 state 判定）
const TRAITS = ["none", "hardult", "fastqi", "chainlust", "thickskin", "swift"];

const j = (res, code, obj) => res.status(code).json(obj);
const parseItem = (s) => (typeof s === "string" ? JSON.parse(s) : s);

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
  const cls = String(q.cls || "").trim().slice(0, 12);

  try {
    if (action === "create") {
      // 團戰需班名才能開房：遊客（無班名）不建房、不寫資料庫，改玩四個純本機模式
      if (!cls) return j(res, 400, { error: "請先輸入班名才能開闢戰場（遊客可體驗雙人對戰、闖關等本機模式）" });
      let boss = BOSSES.includes(q.boss) ? q.boss : "xuemo";
      if (boss === "xuemo2") {
        const unlocked = cls ? await redis.get(ck(cls, "hidden")) : null;
        if (!unlocked) return j(res, 403, { error: "隱藏魔尊尚未解鎖（需一場勝利且全班答對率 ≥85%）" });
      }
      const habits = Array.isArray(q.habits) && q.habits.length
        ? q.habits.filter((h) => h >= 0 && h <= 6) : [0, 1, 2, 3, 4, 5, 6];
      const len = HP_PER[q.len] ? q.len : "mid";
      const trait = TRAITS[Math.floor(Math.random() * TRAITS.length)];
      const cameo = Math.random() < 0.03; // 神秘援軍：3% 場次埋伏
      const eqRaw = await redis.lrange("raid:eq", 0, 49); // 老師核准的獻策題併入
      const eq = (eqRaw || []).map(parseItem);
      // 4 位數房號，避開已存在的
      let newCode = "";
      for (let i = 0; i < 8; i++) {
        newCode = String(Math.floor(1000 + Math.random() * 9000));
        if (!(await redis.exists(rk(newCode)))) break;
      }
      await saveRoom(newCode, {
        boss, habits, len, cls, trait, cameo, eq, status: "lobby",
        maxhp: 0, startAt: 0, endAt: 0, slayer: "", seed: Date.now() % 100000,
      });
      return j(res, 200, { code: newCode, trait });
    }

    // ===== 班級層 action（不需房間） =====
    if (action === "warcry") {
      if (!cls) return j(res, 400, { error: "缺班名" });
      if (q.set !== undefined) {
        const text = String(q.set).trim().slice(0, 40);
        if (text) await redis.set(ck(cls, "warcry"), text);
        return j(res, 200, { warcry: text });
      }
      const warcry = await redis.get(ck(cls, "warcry"));
      return j(res, 200, { warcry: warcry || "" });
    }

    if (action === "hall") {
      const [hallRaw, camp, hidden, warcry] = await Promise.all([
        redis.lrange("raid:hall", 0, 99),
        cls ? redis.get(ck(cls, "camp")) : null,
        cls ? redis.get(ck(cls, "hidden")) : null,
        cls ? redis.get(ck(cls, "warcry")) : null,
      ]);
      return j(res, 200, {
        hall: (hallRaw || []).map(parseItem),
        camp: Math.min(7, Number(camp) || 0),
        hidden: !!hidden, warcry: warcry || "",
      });
    }

    if (action === "log") {
      if (!cls) return j(res, 400, { error: "缺班名" });
      const raw = await redis.lrange(ck(cls, "log"), 0, 59);
      return j(res, 200, { log: (raw || []).map(parseItem) });
    }

    if (action === "suggest") {
      const it = q.item || {};
      const text = String(it.text || "").trim().slice(0, 120);
      const by = String(it.by || "").trim().slice(0, 8);
      const c = Array.isArray(it.c) ? it.c.slice(0, 4) : [];
      const h = Math.max(0, Math.min(6, parseInt(it.h, 10) || 0));
      if (text.length < 6 || c.length !== 4) return j(res, 400, { error: "題目不完整" });
      if (c.filter((o) => o && o.q === 0).length !== 1) return j(res, 400, { error: "須恰好一個正解" });
      const clean = c.map((o) => ({ t: String(o.t || "").trim().slice(0, 60), q: o.q === 0 ? 0 : 2 }));
      if (clean.some((o) => o.t.length < 2)) return j(res, 400, { error: "選項太短" });
      await redis.lpush("raid:sq", JSON.stringify({ h, text, c: clean, by, t: Date.now() }));
      await redis.ltrim("raid:sq", 0, 199);
      return j(res, 200, { ok: true });
    }

    if (action === "sqlist") {
      const raw = await redis.lrange("raid:sq", 0, 49);
      return j(res, 200, { items: (raw || []).map(parseItem) });
    }

    if (action === "sqjudge") {
      const idx = parseInt(q.idx, 10);
      const raw = await redis.lrange("raid:sq", 0, 199);
      if (!raw || isNaN(idx) || idx < 0 || idx >= raw.length) return j(res, 400, { error: "題目不存在" });
      const item = raw[idx];
      await redis.lrem("raid:sq", 1, item);
      if (q.approve) {
        await redis.lpush("raid:eq", typeof item === "string" ? item : JSON.stringify(item));
        await redis.ltrim("raid:eq", 0, 49);
      }
      return j(res, 200, { ok: true, approved: !!q.approve });
    }

    // ===== 房間層 action =====
    const room = await loadRoom(code);
    if (!room) return j(res, 404, { error: "房間不存在或已過期" });

    if (action === "join") {
      const name = String(q.name || "").trim().slice(0, 8);
      if (!name) return j(res, 400, { error: "請輸入名號" });
      if (room.status === "won") return j(res, 400, { error: "此役已終" });
      const ch = String(q.ch || "xiaoyi");
      const ti = String(q.ti || "").trim().slice(0, 10); // 稱號
      const existing = await redis.hget(rk(code, "players"), name);
      if (!existing) {
        await redis.hset(rk(code, "players"), {
          [name]: { ch, ti, dmg: 0, ok: 0, miss: 0, ults: 0 },
        });
        await redis.expire(rk(code, "players"), TTL);
      } else if (room.status === "lobby") {
        // 大廳期間同名重進＝戰前軍議換角，統計保留
        const p = parseItem(existing);
        await redis.hset(rk(code, "players"), { [name]: { ...p, ch, ti } });
      }
      return j(res, 200, { room, rejoined: !!existing });
    }

    if (action === "start") {
      if (room.status !== "lobby") return j(res, 200, { room });
      const n = (await redis.hlen(rk(code, "players"))) || 1;
      const hpX = room.boss === "xuemo2" ? 1.5 : 1; // 隱藏魔尊血量 ×1.5
      room.maxhp = Math.round(n * HP_PER[room.len] * hpX);
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
      const dmg = Math.max(0, Math.min(240, parseInt(q.dmg, 10) || 0)); // hardult 破綻×3 後上限 240

      // 個人統計（客端回報整包，教室信任模型）
      if (q.stats && name) {
        await redis.hset(rk(code, "players"), { [name]: q.stats });
      }

      if (kind === "miss") {
        await redis.set(rk(code, "combo"), 0, { ex: TTL });
        const hp = (await redis.get(rk(code, "hp"))) || 0;
        return j(res, 200, { hp: Number(hp), combo: 0 });
      }

      // 聚血打斷：窗內每次命中累計，達標即打斷
      const gatherRaw = await redis.get(rk(code, "gather"));
      let gather = gatherRaw ? parseItem(gatherRaw) : null;
      if (gather && !gather.result && Date.now() < gather.until) {
        gather.hits = (gather.hits || 0) + 1;
        if (gather.hits >= gather.need) {
          gather.result = "broken";
          await redis.lpush(rk(code, "feed"), JSON.stringify({
            name: "", dmg: 0, kind: "gatherbreak", fx: "", ch: "", ulname: "", t: Date.now(),
          }));
          await redis.ltrim(rk(code, "feed"), 0, 29);
        }
        await redis.set(rk(code, "gather"), gather, { ex: TTL });
      }

      // 支援型大絕副作用
      if (kind === "ult" && q.fx === "buff") {
        await redis.set(rk(code, "buff"), Date.now() + 30000, { ex: TTL });
      }
      if (kind === "ult" && q.fx === "gift" && name) {
        const allP = (await redis.hgetall(rk(code, "players"))) || {};
        const others = Object.keys(allP).filter((n) => n !== name);
        let picked;
        const target = String(q.target || "").slice(0, 8);
        if (target && target !== name && allP[target] !== undefined) {
          picked = [target]; // 渡氣指定：全力灌注一位同袍
        } else {
          for (let i = others.length - 1; i > 0; i--) {
            const k = Math.floor(Math.random() * (i + 1));
            [others[i], others[k]] = [others[k], others[i]];
          }
          picked = others.slice(0, 2);
        }
        if (picked.length) {
          const upd = {};
          picked.forEach((n) => (upd[n] = Date.now()));
          await redis.hset(rk(code, "gifts"), upd);
          await redis.expire(rk(code, "gifts"), TTL);
        }
      }

      const combo = await redis.incr(rk(code, "combo"));
      let hp = await redis.decrby(rk(code, "hp"), dmg);
      const flen = await redis.lpush(rk(code, "feed"), JSON.stringify({
        name, dmg, kind, fx: q.fx || "", ch: q.stats?.ch || "xiaoyi",
        ti: q.stats?.ti || "", ulname: q.ulname || "", t: Date.now(),
      }));
      // 省指令：只在 feed 初建時設 TTL、長度破 60 才修剪（讀取端固定只取前 30）
      if (flen === 1) await redis.expire(rk(code, "feed"), TTL);
      else if (flen > 60) await redis.ltrim(rk(code, "feed"), 0, 29);

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
          // 班級戰果落庫：戰役推進／殿堂戰報／隱藏解鎖
          if (room.cls) {
            const camp = await redis.incr(ck(room.cls, "camp"));
            if (camp > 7) await redis.set(ck(room.cls, "camp"), 7);
            const players = (await redis.hgetall(rk(code, "players"))) || {};
            let ok = 0, miss = 0;
            Object.values(players).forEach((p0) => {
              const p = parseItem(p0);
              ok += Number(p.ok) || 0; miss += Number(p.miss) || 0;
            });
            const acc = ok + miss > 0 ? ok / (ok + miss) : 0;
            if (acc >= 0.85) await redis.set(ck(room.cls, "hidden"), 1);
            await redis.lpush("raid:hall", JSON.stringify({
              cls: room.cls, boss: room.boss, len: room.len,
              secs: Math.round((room.endAt - room.startAt) / 1000),
              n: Object.keys(players).length,
              acc: Math.round(acc * 100), date: room.endAt,
            }));
            await redis.ltrim("raid:hall", 0, 99);
            // 教師後台：本場每人答題紀錄落庫（每班保留最近 60 場）
            const roster = Object.entries(players).map(([n, p0]) => {
              const p = parseItem(p0);
              return {
                name: n, ch: p.ch || "", ti: p.ti || "",
                ok: Number(p.ok) || 0, miss: Number(p.miss) || 0,
                dmg: Number(p.dmg) || 0, ults: Number(p.ults) || 0,
              };
            });
            await redis.lpush(ck(room.cls, "log"), JSON.stringify({
              boss: room.boss, len: room.len,
              secs: Math.round((room.endAt - room.startAt) / 1000),
              date: room.endAt, slayer: name, roster,
            }));
            await redis.ltrim(ck(room.cls, "log"), 0, 59);
          }
        }
      }
      return j(res, 200, { hp: Number(hp), combo, slain });
    }

    if (action === "mvp") {
      const who = String(q.for || "").trim().slice(0, 8);
      if (!who) return j(res, 400, { error: "缺投票對象" });
      await redis.hincrby(rk(code, "mvp"), who, 1);
      await redis.expire(rk(code, "mvp"), TTL);
      const votes = (await redis.hgetall(rk(code, "mvp"))) || {};
      return j(res, 200, { votes });
    }

    if (action === "state") { // Boss 投影端 poll（重）— mget 合併省指令
      const [vals, players, feedRaw, mvp] = await Promise.all([
        redis.mget(rk(code, "hp"), rk(code, "combo"), rk(code, "buff"), rk(code, "weak"),
          rk(code, "weakDone"), rk(code, "gather"), rk(code, "gnext"), rk(code, "cameoDone")),
        redis.hgetall(rk(code, "players")),
        redis.lrange(rk(code, "feed"), 0, 29),
        redis.hgetall(rk(code, "mvp")),
      ]);
      const [hp, combo, buff, weak, weakDone, gatherRaw, gnext, cameoDone] = vals || [];
      let hpN = Math.max(0, Number(hp) || 0);
      const now = Date.now();

      // 破綻時刻：狂怒期（HP≤50%）隨機乍現一次；保底線 25%（行為牌 swift → 40%）
      let weakUntil = Number(weak) || 0;
      const floorAt = room.trait === "swift" ? 0.4 : 0.25;
      if (room.status === "fight" && room.maxhp && hpN > 0 && hpN <= room.maxhp / 2
        && !weakUntil && !weakDone
        && (hpN <= room.maxhp * floorAt || Math.random() < 0.04)) {
        weakUntil = now + 60000;
        await redis.set(rk(code, "weak"), weakUntil, { ex: TTL });
        await redis.set(rk(code, "weakDone"), 1, { ex: TTL });
      }

      // 聚血預告（白帽損失規避：可被全班合力打斷）
      let gather = gatherRaw ? parseItem(gatherRaw) : null;
      if (room.status === "fight" && room.maxhp && hpN > room.maxhp / 2 && hpN < room.maxhp) {
        const active = gather && !gather.result && now < gather.until;
        if (!active && now > (Number(gnext) || 0) && Math.random() < 0.03) {
          gather = { until: now + 30000, need: 12, hits: 0, result: "" };
          await redis.set(rk(code, "gather"), gather, { ex: TTL });
          await redis.set(rk(code, "gnext"), now + 120000, { ex: TTL });
        }
      }
      // 聚血到期未打斷 → 回血 5%（上限 maxhp），只結算一次
      if (room.status === "fight" && gather && !gather.result && now >= gather.until) {
        const newHp = Math.min(room.maxhp, hpN + Math.round(room.maxhp * 0.05));
        const healed = newHp - hpN;
        await redis.set(rk(code, "hp"), newHp, { ex: TTL });
        hpN = newHp;
        gather.result = "healed";
        gather.healed = healed;
        await redis.set(rk(code, "gather"), gather, { ex: TTL });
        await redis.lpush(rk(code, "feed"), JSON.stringify({
          name: "", dmg: healed, kind: "gatherheal", fx: "", ch: "", ulname: "", t: now,
        }));
        await redis.ltrim(rk(code, "feed"), 0, 29);
      }

      // 神秘援軍：3% 場次，HP 首次跌破 60% 時路過的蕭逸砍一刀 100
      if (room.status === "fight" && room.cameo && !cameoDone && room.maxhp
        && hpN > 120 && hpN <= room.maxhp * 0.6) {
        const claimed = await redis.set(rk(code, "cameoDone"), 1, { nx: true, ex: TTL });
        if (claimed) {
          hpN = Math.max(0, await redis.decrby(rk(code, "hp"), 100));
          await redis.lpush(rk(code, "feed"), JSON.stringify({
            name: "路過的蕭逸", dmg: 100, kind: "cameo", fx: "", ch: "xiaoyi",
            ulname: "醉仙劍・天外一撩", t: now,
          }));
          await redis.ltrim(rk(code, "feed"), 0, 29);
        }
      }

      const feed = (feedRaw || []).map(parseItem);
      return j(res, 200, {
        room, hp: hpN, combo: Number(combo) || 0,
        players: players || {}, feed, buffUntil: Number(buff) || 0, weakUntil,
        gather: gather || null, mvp: mvp || {},
      });
    }

    if (action === "mystate") { // 學生端 poll（輕）— mget 合併省指令
      const name = String(q.name || "").slice(0, 8);
      const [vals, giftAt] = await Promise.all([
        redis.mget(rk(code, "hp"), rk(code, "buff"), rk(code, "weak"), rk(code, "gather")),
        name ? redis.hget(rk(code, "gifts"), name) : null,
      ]);
      const [hp, buff, weak, gatherRaw] = vals || [];
      const gather = gatherRaw ? parseItem(gatherRaw) : null;
      return j(res, 200, {
        status: room.status, maxhp: room.maxhp, hp: Math.max(0, Number(hp) || 0),
        habits: room.habits, seed: room.seed, boss: room.boss, slayer: room.slayer || "",
        trait: room.trait || "none", cls: room.cls || "", eq: room.eq || [],
        buffUntil: Number(buff) || 0, giftAt: Number(giftAt) || 0, weakUntil: Number(weak) || 0,
        gather,
      });
    }

    return j(res, 400, { error: "未知指令" });
  } catch (e) {
    return j(res, 500, { error: String(e.message || e) });
  }
}
