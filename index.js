// index.js
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// ----------------------
// 1. 환경 설정
// ----------------------

// TODO: 여기에 네 봇 토큰 넣기 (환경변수로 대체됨)
const TOKEN = process.env.TOKEN;

// TODO: 자동 출석 메시지를 보낼 채널 ID 넣기
// 디스코드 설정 > 고급 > 개발자 모드 ON 후 채널 우클릭 > ID 복사
const ATTEND_CHANNEL_ID = '1447608509209510010';

// DB 파일 경로
const dbPath = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbPath);

// ======================================================================
// 2. DB 테이블 생성
// ======================================================================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS streaks (
      user_id TEXT PRIMARY KEY,
      last_date TEXT NOT NULL,
      streak INTEGER NOT NULL
    )
  `);
});

// ======================================================================
// 3. 시간 유틸 (한국 기준)
// ======================================================================
function getKST() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
}

function getTodayString() {
  const k = getKST();
  const y = k.getUTCFullYear();
  const m = String(k.getUTCMonth() + 1).padStart(2, '0');
  const d = String(k.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterdayString() {
  const k = getKST();
  const yester = new Date(k.getTime() - 24 * 60 * 60 * 1000);
  const y = yester.getUTCFullYear();
  const m = String(yester.getUTCMonth() + 1).padStart(2, '0');
  const d = String(yester.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayLabel() {
  const k = getKST();
  const y = k.getUTCFullYear();
  const m = String(k.getUTCMonth() + 1).padStart(2, '0');
  const d = String(k.getUTCDate()).padStart(2, '0');
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][k.getUTCDay()];
  return `${y}-${m}-${d} (${weekday})`;
}

// ======================================================================
// 4. 디스코드 클라이언트
// ======================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

// ======================================================================
// 5. 슬래시 명령어 정의
// ======================================================================
const commands = [
  new SlashCommandBuilder()
    .setName('출석메시지')
    .setDescription('출석 버튼 메시지를 현재 채널에 보냅니다.'),

  new SlashCommandBuilder()
    .setName('출석랭킹')
    .setDescription('이번 달 출석 랭킹을 임베드로 보여줍니다.'),

  new SlashCommandBuilder()
    .setName('오늘출석')
    .setDescription('오늘 출석한 사람 목록을 임베드로 보여줍니다.'),
].map(cmd => cmd.toJSON());

// ======================================================================
// 6. 연속 출석 업데이트
// ======================================================================
function updateStreak(userId, today, callback) {
  const yesterday = getYesterdayString();

  db.get('SELECT * FROM streaks WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      console.error('streak 조회 오류:', err);
      return callback(null);
    }

    let newStreak = 1;

    if (row) {
      if (row.last_date === yesterday) newStreak = row.streak + 1;
      else if (row.last_date === today) newStreak = row.streak;
      else newStreak = 1;
    }

    db.run(
      `
      INSERT INTO streaks (user_id, last_date, streak)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id)
      DO UPDATE SET last_date = excluded.last_date, streak = excluded.streak
      `,
      [userId, today, newStreak],
      err2 => {
        if (err2) {
          console.error('streak 저장 오류:', err2);
          return callback(null);
        }
        callback(newStreak);
      }
    );
  });
}

// ======================================================================
// 7. 채널 토픽 변경 (오늘 출석 인원 표시)
// ======================================================================
async function updateChannelTopicWithCount(channel, count) {
  try {
    if (!channel || !channel.setTopic) return;
    const label = getTodayLabel();
    await channel.setTopic(`📊 ${label} 기준 오늘 출석 인원: ${count}명`);
  } catch (err) {
    console.error('채널 토픽 업데이트 실패:', err);
  }
}

// ======================================================================
// 8. 출석 메시지(임베드)
// ======================================================================
async function sendAttendanceMessage(channel) {
  const todayLabel = getTodayLabel();

  const embed = new EmbedBuilder()
    .setTitle(`🌙 ${todayLabel} 출석체크`)
    .setDescription(
      '📝 아래 버튼을 눌러 오늘 출석을 완료하세요!\n\n' +
      '🔥 연속 출석을 모으면 개근에 도전할 수 있어요!'
    )
    .setColor(0x5865f2)
    .setFooter({ text: '버튼은 하루 1회만 가능합니다.' })
    .setTimestamp();

  const button = new ButtonBuilder()
    .setCustomId('attendance_check')
    .setLabel('🌟 오늘 출석하기')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  await channel.send({
    embeds: [embed],
    components: [row],
  });

  // 출석 메시지 보낼 때 현재 인원으로 토픽 세팅
  const today = getTodayString();
  db.get(
    'SELECT COUNT(DISTINCT user_id) AS cnt FROM attendance WHERE date = ?',
    [today],
    async (err, row) => {
      if (err) return;
      const cnt = row?.cnt ?? 0;
      await updateChannelTopicWithCount(channel, cnt);
    }
  );
}

// ======================================================================
// 9. 매일 0시에 자동 출석 메시지 보내기
// ======================================================================
function scheduleDailyAttendance() {
  if (!ATTEND_CHANNEL_ID) {
    console.warn('⚠ ATTEND_CHANNEL_ID 미설정 → 자동 출석 비활성화');
    return;
  }

  const sendForToday = async () => {
    try {
      const channel = await client.channels.fetch(ATTEND_CHANNEL_ID);
      if (!channel) {
        console.warn('❌ 출석 채널을 찾을 수 없음');
        return;
      }
      await sendAttendanceMessage(channel);
      console.log('✅ 자동 출석 메시지 전송 완료');
    } catch (err) {
      console.error('자동 출석 오류:', err);
    }
  };

  const now = getKST();
  const nextMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  const delay = nextMidnight.getTime() - now.getTime();

  console.log('⏱ 다음 자동 출석까지 남은 ms:', delay);

  setTimeout(() => {
    sendForToday();
    setInterval(sendForToday, 24 * 60 * 60 * 1000);
  }, delay);
}

// ======================================================================
// 10. 봇 Ready 이벤트
// ======================================================================
client.once('ready', async () => {
  console.log(`🚀 로그인 성공: ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const guilds = client.guilds.cache.map(g => g.id);

  try {
    for (const guildId of guilds) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: commands }
      );
      console.log(`📌 슬래시 명령어 등록됨 (Guild: ${guildId})`);
    }
  } catch (err) {
    console.error('❌ 명령어 등록 오류:', err);
  }

  scheduleDailyAttendance();
});

// ======================================================================
// 11. 인터랙션 처리 (슬래시 명령어 + 버튼)
// ======================================================================
client.on('interactionCreate', async interaction => {
  const today = getTodayString();

  // ----------------------- 슬래시 명령어 -----------------------
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /출석메시지
    if (commandName === '출석메시지') {
      await sendAttendanceMessage(interaction.channel);

      const embed = new EmbedBuilder()
        .setTitle('🌟 출석 메시지 생성 완료')
        .setDescription('이 채널에 새로운 출석 메시지를 생성했습니다!')
        .setColor(0x2ecc71);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /출석랭킹
    if (commandName === '출석랭킹') {
      const monthPrefix = today.slice(0, 7); // YYYY-MM

      db.all(
        `
        SELECT user_id, COUNT(*) AS cnt
        FROM attendance
        WHERE date LIKE ?
        GROUP BY user_id
        ORDER BY cnt DESC
        LIMIT 10
        `,
        [`${monthPrefix}%`],
        async (err, rows) => {
          if (err) {
            console.error(err);
            const embed = new EmbedBuilder()
              .setTitle('❌ 오류')
              .setDescription('랭킹을 불러오는 중 오류가 발생했습니다.')
              .setColor(0xe74c3c);
            return interaction.reply({ embeds: [embed] });
          }

          if (rows.length === 0) {
            const embed = new EmbedBuilder()
              .setTitle(`🏆 ${monthPrefix}월 출석 랭킹`)
              .setDescription('이번 달 출석 기록이 없습니다.')
              .setColor(0xe74c3c);
            return interaction.reply({ embeds: [embed] });
          }

          let desc = '';
          rows.forEach((r, i) => {
            desc += `${i + 1}위 — <@${r.user_id}> : **${r.cnt}회**\n`;
          });

          const embed = new EmbedBuilder()
            .setTitle(`🏆 ${monthPrefix}월 출석 랭킹 TOP 10`)
            .setDescription(desc)
            .setColor(0xf1c40f);

          return interaction.reply({ embeds: [embed] });
        }
      );
    }

    // /오늘출석
    if (commandName === '오늘출석') {
      const label = getTodayLabel();

      db.all(
        `
        SELECT DISTINCT user_id
        FROM attendance
        WHERE date = ?
        `,
        [today],
        async (err, rows) => {
          if (err) {
            console.error(err);
            const embed = new EmbedBuilder()
              .setTitle('❌ 오류')
              .setDescription('오늘 출석 목록을 불러오는 중 오류가 발생했습니다.')
              .setColor(0xe74c3c);
            return interaction.reply({ embeds: [embed] });
          }

          if (rows.length === 0) {
            const embed = new EmbedBuilder()
              .setTitle(`📅 ${label} 출석`)
              .setDescription('오늘은 아직 아무도 출석하지 않았어요 😢')
              .setColor(0xe74c3c);
            return interaction.reply({ embeds: [embed] });
          }

          const list = rows.map(r => `• <@${r.user_id}>`).join('\n');

          const embed = new EmbedBuilder()
            .setTitle(`📅 ${label} 출석 (${rows.length}명)`)
            .setDescription(list)
            .setColor(0x2ecc71);

          return interaction.reply({ embeds: [embed] });
        }
      );
    }

    return; // 슬래시 명령어 처리 끝
  }

  // ----------------------- 버튼 (출석하기) -----------------------
  if (interaction.isButton()) {
    if (interaction.customId !== 'attendance_check') return;

    const userId = interaction.user.id;

    // 오늘 이미 출석했는지 확인
    db.get(
      'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
      [userId, today],
      async (err, row) => {
        if (err) {
          console.error(err);
          const embed = new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription('출석 처리 중 문제가 발생했습니다.')
            .setColor(0xe74c3c);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // 이미 출석했을 때
        if (row) {
          db.get(
            'SELECT COUNT(DISTINCT user_id) AS cnt FROM attendance WHERE date = ?',
            [today],
            async (err2, countRow) => {
              const cnt = countRow?.cnt ?? 0;

              await updateChannelTopicWithCount(interaction.channel, cnt); 

              const embed = new EmbedBuilder()
                .setTitle('🔔 이미 출석 완료!')
                .setDescription(
                  `오늘 이미 출석하셨습니다 😊\n\n` +
                  `📊 현재 출석 인원: **${cnt}명**`
                )
                .setColor(0x3498db);

              return interaction.reply({ embeds: [embed], ephemeral: true });
            }
          );
          return;
        }

        // 첫 출석: DB에 추가
        db.run(
          'INSERT INTO attendance (user_id, date) VALUES (?, ?)',
          [userId, today],
          err2 => {
            if (err2) {
              console.error(err2);
              const embed = new EmbedBuilder()
                .setTitle('❌ 저장 오류')
                .setDescription('출석 정보를 저장하는 중 문제가 발생했습니다.')
                .setColor(0xe74c3c);
              return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            // 현재 인원 수 조회
            db.get(
              'SELECT COUNT(DISTINCT user_id) AS cnt FROM attendance WHERE date = ?',
              [today],
              async (err3, countRow) => {
                const cnt = countRow?.cnt ?? 1;

                await updateChannelTopicWithCount(interaction.channel, cnt);

                updateStreak(userId, today, async streak => {
                  let streakMsg;
                  if (streak && streak > 1) {
                    streakMsg = `🔥 **${streak}일 연속 출석 중!**`;
                  } else {
                    streakMsg = '🌱 첫 출석입니다! 내일부터 연속을 시작해보세요!';
                  }

                  const embed = new EmbedBuilder()
                    .setTitle('🎉 출석 완료!')
                    .setDescription(
                      `📊 오늘 출석 인원: **${cnt}명**\n\n` + streakMsg
                    )
                    .setColor(0x2ecc71);

                  return interaction.reply({ embeds: [embed], ephemeral: true });
                });
              }
            );
          }
        );
      }
    );
  }
});

// ======================================================================
// 12. 로그인
// ======================================================================
client.login(TOKEN);
