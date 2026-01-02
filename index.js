require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
} = require("discord.js");

const { DateTime, IANAZone } = require("luxon");
const { nanoid } = require("nanoid");
const { q, initDb } = require("./db");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env var");

const APP_ID = process.env.APP_ID || null;
// 可選：為了讓 slash commands 立刻出現，建議設 GUILD_ID（你的測試伺服器 ID）
const GUILD_ID = process.env.GUILD_ID || null;

// ===== Discord client (minimal intents) =====
// 你只需要：Guilds + DirectMessages
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// ===== Slash commands =====
const commands = [
  new SlashCommandBuilder()
    .setName("alive")
    .setDescription("ALIVE - low-intrusion check-in")
    .addSubcommand((s) =>
      s
        .setName("setup")
        .setDescription("Create/Update your settings")
        .addStringOption((o) =>
          o
            .setName("schedule")
            .setDescription("daily | weekly | random")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("time")
            .setDescription("HH:mm (for daily/weekly)")
            .setRequired(false)
        )
        .addIntegerOption((o) =>
          o
            .setName("weekday")
            .setDescription("0=Sun..6=Sat (for weekly)")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("timezone")
            .setDescription("IANA tz e.g. Asia/Taipei")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o.setName("quiet_start").setDescription("HH:mm").setRequired(false)
        )
        .addStringOption((o) =>
          o.setName("quiet_end").setDescription("HH:mm").setRequired(false)
        )
        .addIntegerOption((o) =>
          o
            .setName("retry_gap")
            .setDescription("30 or 120 or 1440 (minutes)")
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("add_contact")
        .setDescription("Add a contact (max 3)")
        .addUserOption((o) =>
          o.setName("user").setDescription("Contact user").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("remove_contact")
        .setDescription("Remove a contact")
        .addUserOption((o) =>
          o.setName("user").setDescription("Contact user").setRequired(true)
        )
    )
    .addSubcommand((s) => s.setName("start").setDescription("Start ALIVE reminders"))
    .addSubcommand((s) => s.setName("pause").setDescription("Pause ALIVE reminders"))
    .addSubcommand((s) => s.setName("status").setDescription("Show your current status"))
    .addSubcommand((s) =>
      s
        .setName("consent")
        .setDescription("Contact consents to receive alerts")
        .addStringOption((o) =>
          o.setName("code").setDescription("Consent code from DM").setRequired(true)
        )
    ),
].map((c) => c.toJSON());

// ===== Helpers =====
function parseHHmm(hhmm) {
  if (!hhmm) return null;
  const t = String(hhmm).trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? t : null;
}

function validTimezone(tz) {
  if (!tz) return false;
  return IANAZone.isValidZone(tz);
}

function inQuietHours(dt, quietStart, quietEnd) {
  const [sh, sm] = quietStart.split(":").map(Number);
  const [eh, em] = quietEnd.split(":").map(Number);
  const t = dt.hour * 60 + dt.minute;
  const s = sh * 60 + sm;
  const e = eh * 60 + em;

  // quiet window may wrap overnight
  if (s <= e) return t >= s && t < e;
  return t >= s || t < e;
}

function nextAllowedTime(dt, quietStart, quietEnd) {
  if (!quietStart || !quietEnd) return dt;
  if (!inQuietHours(dt, quietStart, quietEnd)) return dt;

  const [eh, em] = quietEnd.split(":").map(Number);
  let candidate = dt.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (candidate <= dt) candidate = candidate.plus({ days: 1 });
  return candidate;
}

function computeNextReminder(userRow) {
  const tz = userRow.tz || "Asia/Taipei";
  const now = DateTime.now().setZone(tz);

  const quietStart = userRow.quiet_start || "23:00";
  const quietEnd = userRow.quiet_end || "07:00";

  const schedule = userRow.schedule_type || "daily";
  const dailyTime = userRow.daily_time || "09:00";
  const weekday = Number.isInteger(userRow.weekly_day) ? userRow.weekly_day : 1;

  let target;

  if (schedule === "daily") {
    const [h, m] = dailyTime.split(":").map(Number);
    target = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (target <= now) target = target.plus({ days: 1 });
  } else if (schedule === "weekly") {
    const [h, m] = dailyTime.split(":").map(Number);
    // luxon weekday: 1=Mon..7=Sun ; we use 0=Sun..6=Sat
    const want = weekday === 0 ? 7 : weekday;
    const today = now.weekday; // 1..7
    let diff = (want - today + 7) % 7;
    target = now.plus({ days: diff }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (target <= now) target = target.plus({ days: 7 });
  } else {
    // random daily: 09:00-21:00
    const base = now.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    let start = base;
    if (start <= now) start = start.plus({ days: 1 });

    const randMin = Math.floor(Math.random() * (12 * 60)); // 0..719
    target = start.plus({ minutes: randMin });
    target = nextAllowedTime(target, quietStart, quietEnd);
  }

  target = nextAllowedTime(target, quietStart, quietEnd);
  return target.toUTC();
}

async function ensureUser(userId) {
  await q(
    `INSERT INTO users(user_id) VALUES($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const { rows } = await q(`SELECT * FROM users WHERE user_id=$1`, [userId]);
  return rows[0];
}

async function contactCount(ownerId) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS c FROM contacts WHERE owner_user_id=$1`,
    [ownerId]
  );
  return rows[0].c;
}

async function dm(userId, payload) {
  const user = await client.users.fetch(userId);
  return user.send(payload);
}

function reminderButtons(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`alive_ok:${ownerId}`)
      .setLabel("I’m here")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`alive_later:${ownerId}`)
      .setLabel("Later")
      .setStyle(ButtonStyle.Secondary)
  );
}

// ===== Interactions =====
client.on("interactionCreate", async (interaction) => {
  try {
    // ---- Buttons ----
    if (interaction.isButton()) {
      const [key, ownerId] = interaction.customId.split(":");

      if (key === "alive_ok") {
        await q(
          `INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'responded','button')`,
          [ownerId]
        );

        const u = await ensureUser(ownerId);
        const next = computeNextReminder(u);

        await q(
          `UPDATE jobs
           SET retry_count=0,
               last_response_at=now(),
               last_reminded_at=NULL,
               next_at=$2
           WHERE owner_user_id=$1`,
          [ownerId, next.toISO()]
        );

        await interaction.reply({ content: "✅ Check-in recorded. Thank you.", ephemeral: true });
        return;
      }

      if (key === "alive_later") {
        const next = DateTime.now().toUTC().plus({ minutes: 10 });

        await q(
          `INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'responded','later')`,
          [ownerId]
        );

        await q(
          `UPDATE jobs
           SET retry_count=0,
               last_response_at=now(),
               last_reminded_at=NULL,
               next_at=$2
           WHERE owner_user_id=$1`,
          [ownerId, next.toISO()]
        );

        await interaction.reply({ content: "⏳ OK. I will ping you again in 10 minutes.", ephemeral: true });
        return;
      }
    }

    // ---- Slash commands ----
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "alive") return;

    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    const userRow = await ensureUser(userId);

    if (sub === "setup") {
      const schedule = interaction.options.getString("schedule");
      const time = parseHHmm(interaction.options.getString("time"));
      const weekday = interaction.options.getInteger("weekday");
      const tzInput = interaction.options.getString("timezone");
      const tz = validTimezone(tzInput) ? tzInput : (userRow.tz || "Asia/Taipei");

      const quietStart =
        parseHHmm(interaction.options.getString("quiet_start")) ||
        userRow.quiet_start ||
        "23:00";
      const quietEnd =
        parseHHmm(interaction.options.getString("quiet_end")) ||
        userRow.quiet_end ||
        "07:00";

      const retryGap = interaction.options.getInteger("retry_gap") || userRow.retry_gap_minutes || 30;

      if (!["daily", "weekly", "random"].includes(schedule)) {
        await interaction.reply({ content: "schedule must be daily | weekly | random", ephemeral: true });
        return;
      }
      if ((schedule === "daily" || schedule === "weekly") && !time) {
        await interaction.reply({ content: "For daily/weekly, you must provide time=HH:mm", ephemeral: true });
        return;
      }
      if (schedule === "weekly" && (weekday === null || weekday < 0 || weekday > 6)) {
        await interaction.reply({ content: "For weekly, weekday must be 0..6", ephemeral: true });
        return;
      }
      if (![30, 120, 1440].includes(retryGap)) {
        await interaction.reply({ content: "retry_gap must be 30 or 120 or 1440 (minutes)", ephemeral: true });
        return;
      }

      await q(
        `UPDATE users
         SET schedule_type=$2,
             daily_time=$3,
             weekly_day=$4,
             tz=$5,
             quiet_start=$6,
             quiet_end=$7,
             retry_gap_minutes=$8,
             updated_at=now()
         WHERE user_id=$1`,
        [userId, schedule, time, weekday, tz, quietStart, quietEnd, retryGap]
      );

      await interaction.reply({
        content:
          "✅ Saved.\n" +
          `- schedule: ${schedule}\n` +
          (time ? `- time: ${time}\n` : "") +
          (weekday !== null ? `- weekday: ${weekday}\n` : "") +
          `- tz: ${tz}\n` +
          `- quiet: ${quietStart} ~ ${quietEnd}\n` +
          `- retry: max 2, gap ${retryGap} minutes\n`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "add_contact") {
      const contact = interaction.options.getUser("user");
      if (!contact) return;

      const count = await contactCount(userId);
      if (count >= 3) {
        await interaction.reply({
          content: "You already have 3 contacts (max). Remove one first.",
          ephemeral: true,
        });
        return;
      }

      const code = nanoid(10);
      await q(
        `INSERT INTO contacts(owner_user_id,contact_user_id,consent_code,consented)
         VALUES($1,$2,$3,false)
         ON CONFLICT (owner_user_id,contact_user_id)
         DO UPDATE SET consent_code=$3, consented=false`,
        [userId, contact.id, code]
      );

      await dm(contact.id, {
        content:
          "ALIVE consent request:\n" +
          "A user wants to add you as an emergency contact.\n\n" +
          "If you agree, run this command in ANY server where ALIVE exists:\n" +
          `**/alive consent code:${code}**\n\n` +
          "If you do not agree, ignore this message.",
      });

      await interaction.reply({
        content: `✅ Contact added (pending consent): ${contact.username}. I sent them a DM.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "remove_contact") {
      const contact = interaction.options.getUser("user");
      await q(`DELETE FROM contacts WHERE owner_user_id=$1 AND contact_user_id=$2`, [userId, contact.id]);
      await interaction.reply({ content: `✅ Removed contact: ${contact.username}`, ephemeral: true });
      return;
    }

    if (sub === "consent") {
      const code = interaction.options.getString("code");

      const { rows } = await q(
        `UPDATE contacts
         SET consented=true
         WHERE contact_user_id=$1 AND consent_code=$2
         RETURNING owner_user_id`,
        [userId, code]
      );

      if (rows.length === 0) {
        await interaction.reply({ content: "❌ Invalid code.", ephemeral: true });
        return;
      }

      const ownerId = rows[0].owner_user_id;

      // DM owner: consent accepted
      try {
        await dm(ownerId, {
          content: `✅ Consent accepted: <@${userId}> agreed to be your emergency contact.`,
        });
      } catch {}

      await interaction.reply({
        content: "✅ Consent recorded. You may receive alerts in the future.",
        ephemeral: true,
      });
      return;
    }

    if (sub === "start") {
      const { rows: contacts } = await q(
        `SELECT contact_user_id, consented FROM contacts WHERE owner_user_id=$1`,
        [userId]
      );
      const consented = contacts.filter((c) => c.consented).length;

      if (consented === 0) {
        await interaction.reply({
          content: "⚠️ You must have at least 1 contact who has consented before starting.",
          ephemeral: true,
        });
        return;
      }

      await q(`UPDATE users SET is_active=true, updated_at=now() WHERE user_id=$1`, [userId]);

      const refreshed = (await q(`SELECT * FROM users WHERE user_id=$1`, [userId])).rows[0];
      const next = computeNextReminder(refreshed);

      await q(
        `INSERT INTO jobs(owner_user_id,next_at,retry_count,retry_max,last_reminded_at)
         VALUES($1,$2,0,2,NULL)
         ON CONFLICT (owner_user_id)
         DO UPDATE SET next_at=$2, retry_count=0, retry_max=2, last_reminded_at=NULL`,
        [userId, next.toISO()]
      );

      await interaction.reply({ content: "✅ ALIVE started. Next check-in scheduled.", ephemeral: true });
      return;
    }

    if (sub === "pause") {
      await q(`UPDATE users SET is_active=false, updated_at=now() WHERE user_id=$1`, [userId]);
      await interaction.reply({ content: "⏸️ ALIVE paused.", ephemeral: true });
      return;
    }

    if (sub === "status") {
      const u = (await q(`SELECT * FROM users WHERE user_id=$1`, [userId])).rows[0];
      const job = (await q(`SELECT * FROM jobs WHERE owner_user_id=$1`, [userId])).rows[0];
      const { rows: contacts } = await q(
        `SELECT contact_user_id, consented FROM contacts WHERE owner_user_id=$1`,
        [userId]
      );

      await interaction.reply({
        content:
          "ALIVE status:\n" +
          `- active: ${u.is_active}\n` +
          `- schedule: ${u.schedule_type}\n` +
          `- tz: ${u.tz}\n` +
          `- quiet: ${u.quiet_start} ~ ${u.quiet_end}\n` +
          `- retry: max 2, gap ${u.retry_gap_minutes}m\n` +
          `- next: ${job ? job.next_at : "(not scheduled)"}\n` +
          `- contacts: ${contacts.length} (consented: ${contacts.filter((c) => c.consented).length})\n`,
        ephemeral: true,
      });
      return;
    }
  } catch (e) {
    console.error(e);
    try {
      if (interaction && !interaction.replied) {
        await interaction.reply({ content: "❌ Error. Check logs.", ephemeral: true });
      }
    } catch {}
  }
});

// ===== Worker loop (poll DB every 60s) =====
async function workerTick() {
  // 1) Scheduled reminders (only jobs not currently waiting for response)
  const { rows: due } = await q(
    `SELECT j.*, u.*
     FROM jobs j
     JOIN users u ON u.user_id = j.owner_user_id
     WHERE u.is_active=true
       AND j.next_at <= now()
       AND j.last_reminded_at IS NULL
     LIMIT 50`
  );

  for (const row of due) {
    const ownerId = row.owner_user_id;

    try {
      await dm(ownerId, {
        content:
          "Quiet check-in.\n" +
          "Silence is proof you’re still here.\n\n" +
          "How are you today?",
        components: [reminderButtons(ownerId)],
      });

      await q(`INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'reminded','scheduled')`, [ownerId]);

      const gap = row.retry_gap_minutes ?? 30;
      const nextAt = DateTime.now().toUTC().plus({ minutes: gap });

      // mark we are waiting for response window
      await q(
        `UPDATE jobs
         SET last_reminded_at=now(),
             next_at=$2
         WHERE owner_user_id=$1`,
        [ownerId, nextAt.toISO()]
      );
    } catch (e) {
      console.error("DM failed", ownerId, e.message);
      // keep job; will retry later
      await q(`UPDATE jobs SET next_at=now() + interval '5 minutes' WHERE owner_user_id=$1`, [ownerId]);
    }
  }

  // 2) Timeouts (jobs waiting for response window)
  const { rows: pending } = await q(
    `SELECT j.*, u.*
     FROM jobs j
     JOIN users u ON u.user_id = j.owner_user_id
     WHERE u.is_active=true
       AND j.next_at <= now()
       AND j.last_reminded_at IS NOT NULL
     LIMIT 50`
  );

  for (const row of pending) {
    const ownerId = row.owner_user_id;

    // did user respond after last_reminded_at?
    const { rows: responded } = await q(
      `SELECT 1 FROM checkins
       WHERE owner_user_id=$1 AND status='responded' AND created_at >= $2
       LIMIT 1`,
      [ownerId, row.last_reminded_at]
    );

    if (responded.length > 0) {
      // button handler already scheduled next
      continue;
    }

    const retryCount = row.retry_count ?? 0;
    const retryMax = row.retry_max ?? 2;
    const gap = row.retry_gap_minutes ?? 30;

    await q(`INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'timeout',$2)`, [
      ownerId,
      `retry_count=${retryCount}`,
    ]);

    if (retryCount < retryMax) {
      // retry: send another reminder now, but keep last_reminded_at for window tracking
      await q(`UPDATE jobs SET retry_count=retry_count+1, last_reminded_at=now(), next_at=now() + ($2 || ' minutes')::interval WHERE owner_user_id=$1`, [
        ownerId,
        String(gap),
      ]);

      // Actually send the retry DM now
      try {
        await dm(ownerId, {
          content: "Just checking again. Please tap a button so I know you’re OK.",
          components: [reminderButtons(ownerId)],
        });
        await q(`INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'reminded','retry')`, [ownerId]);
      } catch (e) {
        console.error("retry DM failed", ownerId, e.message);
      }
    } else {
      // escalate: notify consented contacts (simultaneous)
      const { rows: contacts } = await q(
        `SELECT contact_user_id
         FROM contacts
         WHERE owner_user_id=$1 AND consented=true
         LIMIT 3`,
        [ownerId]
      );

      for (const c of contacts) {
        try {
          await dm(c.contact_user_id, {
            content:
              "ALIVE alert (neutral):\n" +
              "A user did not respond to scheduled check-ins.\n" +
              "This is not a medical emergency judgment.\n" +
              "If you can, please check on them.",
          });
        } catch (e) {
          console.error("notify contact DM failed", c.contact_user_id, e.message);
        }
      }

      await q(`INSERT INTO checkins(owner_user_id,status,note) VALUES($1,'escalated','contacts_notified')`, [ownerId]);

      // Reset and schedule next normal reminder
      const u = await ensureUser(ownerId);
      const next = computeNextReminder(u);

      await q(
        `UPDATE jobs
         SET retry_count=0,
             last_reminded_at=NULL,
             next_at=$2
         WHERE owner_user_id=$1`,
        [ownerId, next.toISO()]
      );
    }
  }
}

async function registerCommands() {
  if (!APP_ID) {
    console.log("APP_ID not set; skip auto register commands.");
    console.log("You can register commands manually, or set APP_ID and redeploy.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("Slash commands registered (GUILD).");
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log("Slash commands registered (GLOBAL).");
  }
}

async function main() {
  await initDb();

  await registerCommands();

  client.once(Events.ClientReady, () => {
    console.log(`ALIVE bot logged in as ${client.user.tag}`);
    setInterval(() => workerTick().catch(console.error), 60 * 1000);
  });

  await client.login(BOT_TOKEN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
