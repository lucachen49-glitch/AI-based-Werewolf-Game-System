(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NightfallScenarioSamples = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create({ matchedVoice, validate }) {
    function bloodMoonSample(roomSize = 6) {
      if (![6, 12].includes(roomSize)) throw Error('房间人数无效');
      const title = '血月停战宴';
      const boundary =
        '秘密只用于人物背景、关系铺垫和 AI 核对，不作为本局阵营证据，不触发额外搜证、胜利条件或角色技能。';
      const baseBackground =
        '二十年前，暮鸦古堡的大火烧毁了银牙狼人氏族与绯夜吸血鬼家族的停战盟约。双方从此把责任推给对方，只有少数旧档案留下矛盾的线索。血月将至，伯爵分别寄出邀请，声称盟约还留有最后一页，愿意让来客在古堡当面听完。';
      const rawCharacters = [
        {
          name: '薇拉·绯夜',
          gender: 'female',
          publicIdentity: '绯夜家族继承人',
          personality: '骄傲克制，受到质疑时锋利直接，重视承诺。',
          relationships: '与2号有旧日联姻约定；信任4号的医术；对5号保管旧档一事保持警惕。',
          secret: '火灾前曾奉母亲之命带走密封信匣，后来担心自己的离开间接错过了停战机会。',
          appearance: '红棕卷发的成年女性，黑金长裙，胸前别着深红宝石，神情克制。',
        },
        {
          name: '莱恩·银牙',
          gender: 'male',
          publicIdentity: '银牙氏族议事代表',
          personality: '沉稳负责，先听依据再表态，护短但愿意认错。',
          relationships: '与1号有旧约；是3号的兄长；曾请6号修复火灾中受损的乐谱。',
          secret: '曾收到警告火灾的匿名信，却误以为是阻止联姻的恐吓并将其烧毁。',
          appearance: '棕色短发的成年男性，黑金礼服，肩上有银色披肩，目光沉着。',
        },
        {
          name: '诺克斯·银牙',
          gender: 'male',
          publicIdentity: '边境巡夜人',
          personality: '直率多疑，厌恶含糊回答，容易被激将。',
          relationships: '不满2号替自己做决定；与4号在边境共事；常与5号争论旧档的可信度。',
          secret: '当年从旧隧道救出一名绯夜家族的孩子，却向族人隐瞒此事，担心被视为背叛。',
          appearance: '黑色短发的成年男性，深蓝礼服，皮手套与旧银扣，站姿警觉。',
        },
        {
          name: '瑟琳·暮烛',
          gender: 'female',
          publicIdentity: '暮烛家族医师',
          personality: '温和敏锐，擅长追问细节，被逼迫时态度坚定。',
          relationships: '曾治疗1号的母亲；与3号在边境救助伤者；认为6号值得信任。',
          secret: '曾把两族伤者的真实名单藏进医疗账册，避免他们遭到报复。',
          appearance: '栗色长发的成年女性，暗红长裙，佩戴古金医师胸针，神情敏锐。',
        },
        {
          name: '阿德里安·灰誓',
          gender: 'male',
          publicIdentity: '灰誓氏族档案官',
          personality: '寡言谨慎，措辞严密，习惯先观察再判断。',
          relationships: '曾是2号父亲的书记官；保管古堡旧档；与1号因查阅盟约发生过争执。',
          secret: '保留着盟约最后一页的抄本，迟迟不公开是怕名单被极端派利用。',
          appearance: '银灰长发的成年男性，深棕礼服，戴细框眼镜，手边常有皮质档案夹。',
        },
        {
          name: '艾琳·月弦',
          gender: 'female',
          publicIdentity: '月弦家族乐师',
          personality: '外表轻松，善于缓和冲突，触及家人时情绪鲜明。',
          relationships: '受2号委托修复旧乐谱；与4号是好友；小时候曾在古堡暂住。',
          secret: '她正是当年被3号救出的孩子，只记得救命者衣袖上的银线。',
          appearance: '金色卷发的成年女性，米金长裙，携带深色乐谱，神情温柔而警醒。',
        },
        {
          name: '埃里克·铜钟',
          gender: 'male',
          publicIdentity: '古堡钟表师',
          personality: '沉着严谨，宁愿承认不知道，也不修改记录。',
          relationships: '受11号邀请检修古堡旧钟；曾协助5号核对档案；不认同9号凭经验判断时间。',
          secret: '保存着师父记录的旧钟偏差纸条，担心牵连师父而没有交给调查者。',
          appearance: '深栗短发的成年男性，铜棕礼服，佩戴怀表与细金链，动作精确。',
        },
        {
          name: '米蕾·青藤',
          gender: 'female',
          publicIdentity: '绯夜家族信使',
          personality: '敏锐独立，反感替别人作主，承认错误很艰难。',
          relationships: '与1号是旧识；替11号送出邀请；曾委托10号修复家书。',
          secret: '曾扣留一封寄错地址的旧回信，想先确认收信人是否安全。',
          appearance: '墨绿色长发的成年女性，青藤色礼服，腰间有信袋，目光利落。',
        },
        {
          name: '卢修斯·赤枫',
          gender: 'male',
          publicIdentity: '赤枫氏族山路向导',
          personality: '坦率务实，危险时先照顾同行者，讨厌空谈。',
          relationships: '熟悉古堡周边山路；与7号一起巡查雪线；常提醒12号不要独自行动。',
          secret: '火灾当夜曾在后山看见无灯马车，却因害怕卷入两族冲突没有作证。',
          appearance: '黑褐短发的成年男性，暗红棕色外套，穿耐雪长靴，神情务实。',
        },
        {
          name: '诺娅·白栎',
          gender: 'female',
          publicIdentity: '白栎家族修复师',
          personality: '专注耐心，面对损坏物件比面对争吵更有把握。',
          relationships: '与11号共同修复古堡壁画；曾为4号整理救护账册；熟悉古堡的旧门锁。',
          secret: '保留了一份被要求销毁的物资收据，能证明当年有人跨族运送药物。',
          appearance: '浅棕长发的成年女性，墨绿与古金修复师服装，带小画笔盒。',
        },
        {
          name: '达米安·黑栎',
          gender: 'male',
          publicIdentity: '古堡宴会管事',
          personality: '周到克制，遇到突发情况先维持秩序，再解释原因。',
          relationships: '按伯爵吩咐准备今夜宴席；与8号有旧信件往来；请7号检修停钟。',
          secret: '伯爵离开前只交给他一把旧钥匙，并要求暂时不要告诉任何人。',
          appearance: '黑色长发的成年男性，黑栎色管事礼服，佩戴古金钥匙扣，姿态端正。',
        },
        {
          name: '奥菲莉娅·霜灯',
          gender: 'female',
          publicIdentity: '霜灯家族调停使',
          personality: '冷静耐心，习惯把冲突拆成可以回答的问题。',
          relationships: '曾参与两族边境救助；与9号共同巡查雪线；希望所有人先听完再判断。',
          secret: '她曾看到一份不完整的停战名单，知道有人被遗漏，却没有找到缺失的页码。',
          appearance: '乌黑长发的成年女性，霜白与深蓝礼服，佩戴细小银灯胸针。',
        },
      ];
      const characters = rawCharacters.slice(0, roomSize).map((c, i) => {
        const seat = i + 1;
        return {
          ...c,
          seat,
          voiceId: matchedVoice({ ...c, seat }),
          portraitId: 'portrait-' + String(seat).padStart(2, '0'),
        };
      });
      const shot = (
        duration,
        cast,
        description,
        startFrame,
        endFrame,
        narration,
        dialogues = [],
        narrationSeconds = 0,
      ) => ({
        duration,
        cast,
        description,
        startFrame,
        endFrame,
        narration,
        narrationSeconds,
        dialogues: dialogues.map(([seat, text]) => ({ seat, text })),
      });
      const sixScenes = [
        shot(
          11,
          [1, 2],
          '雪夜门廊，薇拉展开邀请函，莱恩举灯照亮通往宴厅的橡木门。',
          '吊桥仍可通行，邀请函在薇拉手中。',
          '两人推门走向长廊，灯光照在前方。',
          '',
          [
            [1, '伯爵说，盟约还剩最后一页。'],
            [2, '先找到他，再问清楚。'],
          ],
        ),
        shot(
          12,
          [1, 2, 3, 4],
          '长廊尽头，诺克斯扶住被风吹开的门，瑟琳接过莱恩的灯，四人一起进入宴厅。',
          '灯光从门廊移入长廊，薇拉仍握着邀请函。',
          '空主位出现在四人前方。',
          '',
          [
            [3, '我敲过门，里面没人应声。'],
            [4, '烛火还燃着，先看看宴厅。'],
          ],
        ),
        shot(
          11,
          [1, 2, 5, 6],
          '空主位旁，阿德里安合上档案夹，艾琳停下试奏。薇拉把邀请函放在桌边。',
          '空主位和烛台位于同一桌后方。',
          '莱恩望向高窗，信函留在桌边。',
          '',
          [
            [5, '餐具摆好了，伯爵却不在。'],
            [6, '我来时只看见这封留言。'],
            [1, '先别拆，等大家都看见。'],
          ],
        ),
        shot(
          10,
          [2, 3, 4],
          '高窗旁风雪猛然加剧，诺克斯关窗，莱恩看到吊桥被雪压断，瑟琳稳住摇晃的烛台。',
          '莱恩从桌边转向右侧高窗，烛台仍在窗旁。',
          '断桥留在窗外，三人转身回到桌边。',
          '',
          [
            [3, '桥断了，今晚走不了。'],
            [4, '那就先留在暖处。'],
          ],
        ),
        shot(
          12,
          [1, 2, 5, 6],
          '桌边四人入画，阿德里安当众展开留言，薇拉与莱恩站在两侧，艾琳扶住纸角，其余人在画外。',
          '邀请函在桌边，封好的留言在空主位前。',
          '留言平摊桌心，所有人可以看到。',
          '',
          [
            [5, '伯爵请我们先听完彼此，再做判断。'],
            [1, '没有盟约最后一页？'],
            [2, '那就不要替他编答案。'],
          ],
        ),
        shot(
          11,
          [3, 4, 5, 6],
          '镜头沿桌沿移动，诺克斯拉开椅子，瑟琳看向留言，艾琳将乐谱放在自己座位旁。',
          '留言保持平摊，四人面向同一张圆桌。',
          '椅子拉开，留言与烛火仍在桌心。',
          '',
          [
            [3, '没有答案，我们拿什么信任彼此？'],
            [4, '从说清楚自己知道的事开始。'],
            [6, '也给每个人同样的机会。'],
          ],
        ),
        shot(
          12,
          [1, 2, 3, 5],
          '薇拉把邀请函推向桌心，莱恩坐到对面，阿德里安摆好背面朝上的身份牌。',
          '桌心仍是公开留言，邀请函从薇拉手边推入。',
          '六张牌未翻，主位仍空。',
          '',
          [
            [1, '我会问，也会回答。'],
            [2, '我们围桌试一试。'],
            [5, '身份由牌决定，往事不算证据。'],
          ],
        ),
        shot(
          8,
          [1, 2, 3, 4, 5, 6],
          '六人各自落座，目光从桌心移向彼此。镜头停在未翻的牌与稳定烛火上。',
          '六张牌背面朝上，邀请函和留言留在桌心。',
          '六人围桌等待发牌，空主位仍在背景。',
          '风雪关上了归路，六人决定用一场游戏试探彼此。',
          [],
          8,
        ),
      ];
      const twelveScenes = [
        shot(
          11,
          [1, 2, 8],
          '雪夜门廊，米蕾收起信袋，把最后两封邀请交给薇拉和莱恩。',
          '吊桥可通行，门廊烛火照着信封。',
          '三人推门进入同一条长廊。',
          '',
          [
            [8, '十二封邀请都送到了。'],
            [1, '信里说盟约还有一页。'],
            [2, '我们当面问伯爵。'],
          ],
        ),
        shot(
          10,
          [3, 4, 7, 8],
          '长廊里诺克斯扶门，瑟琳举灯，埃里克察看停住的钟。',
          '米蕾从门廊进入，烛光照向停钟。',
          '四人的目光转向长廊尽头。',
          '',
          [
            [7, '钟停了，不能拿它判断时间。'],
            [3, '我也没听见伯爵回应。'],
            [4, '先去宴厅看看。'],
          ],
        ),
        shot(
          11,
          [5, 6, 10, 11],
          '阿德里安和诺娅穿过焦黑壁画，达米安推开宴厅门，艾琳护住乐谱。',
          '长廊尽头的门与停钟相连，众人朝同一方向走。',
          '门内空主位和摆好的餐具同时可见。',
          '',
          [
            [11, '宴席是伯爵吩咐准备的。'],
            [10, '这幅壁画的烧痕仍在。'],
            [6, '可主人却没来迎客。'],
          ],
        ),
        shot(
          10,
          [1, 2, 5, 11],
          '薇拉与莱恩走到空主位前，阿德里安指向封好的留言。',
          '空主位居中，餐具与留言在原位。',
          '留言留在桌面，莱恩转向窗边。',
          '',
          [
            [1, '你最后见到他是什么时候？'],
            [11, '布置晚宴时，之后我没有见过。'],
            [5, '这封留言还没有拆。'],
          ],
        ),
        shot(
          10,
          [3, 9, 12],
          '窗边卢修斯看见风雪压断吊桥，诺克斯关窗，奥菲莉娅扶稳烛台。',
          '高窗可见吊桥，风雪逐渐增强。',
          '窗外断桥清晰，三人朝桌边转身。',
          '',
          [
            [9, '桥断了，山路也被雪封住。'],
            [12, '先别出去，等天亮。'],
            [3, '我去告诉其他人。'],
          ],
        ),
        shot(
          12,
          [2, 4, 7, 9],
          '莱恩听卢修斯说明道路，瑟琳把窗边的灯带回桌旁，埃里克确认停钟。',
          '承接窗边转身，断桥仍在窗外。',
          '灯放在桌边，来客围向留言。',
          '',
          [
            [9, '我熟悉山路，现在走很危险。'],
            [4, '先让所有人留在暖处。'],
            [2, '我们一起等天亮。'],
          ],
        ),
        shot(
          12,
          [1, 5, 8, 10],
          '阿德里安当众拆开留言，诺娅压住纸角，米蕾把信袋放在椅旁。',
          '封好的留言放在空主位前，所有人聚向桌边。',
          '留言平摊桌心，邀请函在旁。',
          '',
          [
            [5, '伯爵写着，先听彼此说完，再判断。'],
            [10, '这里没有最后一页。'],
            [1, '那就不要假装已经找到。'],
          ],
        ),
        shot(
          11,
          [4, 6, 8, 12],
          '艾琳把乐谱放在座位旁，奥菲莉娅替瑟琳拉开椅子，米蕾望向桌心。',
          '留言仍在桌心，烛火照亮两侧席位。',
          '椅子拉开，信袋与乐谱留在各自座位旁。',
          '',
          [
            [8, '邀请是真的，失踪的原因我们不知道。'],
            [6, '先听每个人怎么想。'],
            [12, '至少今晚没人需要独自等待。'],
          ],
        ),
        shot(
          12,
          [1, 2, 3, 7, 10],
          '薇拉把邀请函推近留言，埃里克放下怀表，诺克斯看向莱恩。',
          '留言和邀请函并排，空主位不变。',
          '莱恩把牌背朝上放到桌上。',
          '',
          [
            [3, '如果有人说谎呢？'],
            [7, '那就把事实和猜测分开。'],
            [2, '我们用一场游戏试探彼此。'],
          ],
        ),
        shot(
          11,
          [5, 6, 9, 11, 12],
          '达米安分放背面朝上的牌，卢修斯坐下，艾琳看向对面。',
          '牌背朝上，留言和邀请函仍在桌心。',
          '来客从两侧入座，主位仍空。',
          '',
          [
            [11, '十二张牌，每人一张。'],
            [9, '天亮前，我们就在这里。'],
            [5, '往事不能决定今晚的身份。'],
          ],
        ),
        shot(
          9,
          [1, 2, 3, 4, 5, 6],
          '镜头沿桌沿缓缓掠过第一侧，六人落座，烛光与留言保持原位。',
          '第一侧六席面对桌心，牌均未翻。',
          '镜头继续沿桌沿移向另一侧。',
          '风雪封住古堡，来客决定留下。',
          [],
          9,
        ),
        shot(
          9,
          [7, 8, 9, 10, 11, 12],
          '镜头接续桌沿移动到第二侧，六人落座，停在桌心未翻的牌。',
          '接上前镜运动，空主位与留言仍在背景。',
          '画面中的六人围桌等待发牌，另外六人在画外。',
          '他们把未解的问题留到天亮，先听彼此说话。',
          [],
          9,
        ),
      ];
      const background =
        roomSize === 6
          ? baseBackground +
            ' 六位来客沿门廊、焦黑壁画和宴厅一路进入，发现伯爵缺席后确认风雪封路，读完公开留言，决定围桌试探彼此。游戏中的随机身份由发牌决定，不能由血统或旧事推断。'
          : baseBackground +
            ' 十二位来客沿门廊、焦黑壁画和宴厅陆续进入，逐步确认伯爵缺席、停钟和风雪封路，再共同读完公开留言，决定围桌试探彼此。十二人的故事独立保存，公开关系不改变狼人杀发牌结果。';
      const visualGuide =
        '暮鸦古堡始终保持同一地理：山谷吊桥通向橡木门，橡木门接烛光长廊，长廊尽头是圆桌宴厅，宴厅右侧高窗能看到吊桥。红月、雪夜和暖金烛光贯穿全片，断桥只在确认风雪封路后出现。主位始终空着，留言先封好后展开，身份牌在最后保持背面朝上。镜头只展示当前列出的成年人物，每镜最多六人，人物沿同一方向移动，不瞬移、不切回往事，不出现狼耳、獠牙、武器身份道具或可读文字。' +
        characters.map((c) => c.seat + '号' + c.name + '：' + c.appearance).join('；');
      const scenes = roomSize === 6 ? sixScenes : twelveScenes;
      const source =
        '《血月停战宴》' +
        roomSize +
        '人电影剧本草稿\n\n公开背景\n' +
        background +
        '\n\n人物（均为成年人）\n' +
        characters
          .map(
            (c) =>
              c.seat +
              '号 ' +
              c.name +
              '\n公开剧情身份：' +
              c.publicIdentity +
              '\n性格：' +
              c.personality +
              '\n公开关系：' +
              c.relationships +
              '\n本人秘密：' +
              c.secret,
          )
          .join('\n\n') +
        '\n\n' +
        boundary +
        '\n\n连续镜头\n' +
        scenes
          .map(
            (s, i) =>
              i +
              1 +
              '：' +
              s.duration +
              '秒；出场' +
              s.cast.join('、') +
              '；对白' +
              s.dialogues.map((d) => d.seat + '号 ' + d.text).join(' / ') +
              '\n' +
              s.description +
              '\n起：' +
              s.startFrame +
              '\n止：' +
              s.endFrame +
              '\n旁白：' +
              s.narration,
          )
          .join('\n\n');
      return validate({
        roomSize,
        title,
        source,
        background,
        confirmed: false,
        visualGuide,
        narrativeMode: roomSize === 6 ? 'continuity-v1' : undefined,
        characters,
        scenes,
      });
    }
    function bloodMoonEnglishSample(roomSize = 6) {
      const draft = bloodMoonSample(roomSize);
      // Dialogue and translations are paired explicitly so edits cannot detach a translation from its line.
      const lines =
        roomSize === 6
          ? [
              [
                ['The Count promised us the last page.', '伯爵答应给我们盟约的最后一页。'],
                [
                  'If it names a witness, we can end this feud.',
                  '如果上面写着证人的名字，就能结束这场世仇。',
                ],
              ],
              [
                ['I knocked. No one answered.', '我敲过门，没人回应。'],
                ['The candles are lit. Try the hall.', '烛火还亮着，先去宴厅看看。'],
              ],
              [
                ['The table is set, but our host is gone.', '餐桌已经摆好，主人却不见了。'],
                ['I found this sealed note at his place.', '我在他的座位上发现了这封密信。'],
                ['Wait. Open it when everyone can see.', '等等，等大家都能看见时再拆。'],
              ],
              [
                ['The bridge is gone. We are trapped.', '桥断了，我们被困住了。'],
                [
                  'Stay inside. The storm will kill anyone outside.',
                  '留在屋内，风雪会要了外面人的命。',
                ],
              ],
              [
                ['He asks us to listen before we judge.', '他要我们先听彼此说完，再作判断。'],
                ['But where is the page he promised?', '可他答应的那一页在哪里？'],
                ['The note gives no answer.', '留言没有给出答案。'],
              ],
              [
                ['Someone here could be lying.', '在场的人可能有人说谎。'],
                ['Then let each person speak and be questioned.', '那就让每个人发言，接受提问。'],
                ['And give everyone the same chance.', '每个人都有同样的机会。'],
              ],
              [
                ['I will answer if you will.', '只要你们愿意回答，我也会回答。'],
                ['A game, then. We listen, and we choose.', '那就玩一场游戏。听完发言，再作选择。'],
                ['The cards decide our roles, not our past.', '身份由牌决定，与过去无关。'],
              ],
              [],
            ]
          : [
              [
                ['All twelve invitations were delivered.', '十二封邀请函都送到了。'],
                ['The Count promised the last page of the pact.', '伯爵答应给我们盟约的最后一页。'],
                ['A witness could end this feud.', '证人或许能结束这场世仇。'],
              ],
              [
                ['The clock has stopped. We cannot tell when.', '钟停了，我们无法知道是什么时候。'],
                ['The Count did not answer me either.', '伯爵也没有回应我。'],
                ['Let us look in the hall.', '先去宴厅看看。'],
              ],
              [
                ['The Count ordered this supper.', '这场晚宴是伯爵吩咐准备的。'],
                ['The fire scar is still here.', '火灾留下的痕迹还在。'],
                ['Yet our host never greeted us.', '可是主人始终没有来迎接。'],
              ],
              [
                ['When did you last see him?', '你最后一次见到他是什么时候？'],
                ['While I prepared supper. Not since.', '准备晚餐时，之后就没有见过。'],
                ['This note is still sealed.', '这封留言还没有拆。'],
              ],
              [
                ['The bridge is broken. The path is buried.', '桥断了，山路也被雪埋了。'],
                ['Do not go out in this storm.', '不要在这场风雪里出去。'],
                ['I will tell the others.', '我去告诉其他人。'],
              ],
              [
                ['I know the path. It is deadly now.', '我熟悉那条路，现在走很危险。'],
                ['Bring everyone to the fire.', '让所有人都到火边来。'],
                ['We stay together until dawn.', '天亮之前，我们待在一起。'],
              ],
              [
                ['He asks us to listen before judging.', '他要我们先听彼此说完，再作判断。'],
                ['The final page is not here.', '最后一页不在这里。'],
                ['Then we still do not know the truth.', '那我们仍然不知道真相。'],
              ],
              [
                [
                  'The invitations are real. His absence is unexplained.',
                  '邀请是真的，他为何缺席仍不清楚。',
                ],
                ['Let everyone speak first.', '先听每个人说。'],
                ['No one should wait alone tonight.', '今晚谁也不要独自等待。'],
              ],
              [
                ['What if someone lies?', '如果有人说谎呢？'],
                ['Separate what we know from what we guess.', '把事实和猜测分开。'],
                ['A game will test whom we trust.', '用一场游戏来试探彼此的信任。'],
              ],
              [
                ['Twelve cards. One for each of us.', '十二张牌，每人一张。'],
                ['We stay here until dawn.', '天亮之前我们留在这里。'],
                ['Our past cannot decide tonight’s roles.', '过去无法决定今晚的身份。'],
              ],
              [],
              [],
            ];
      const narrations =
        roomSize === 6
          ? [
              ...Array(7).fill(['', '']),
              [
                'Six guests. One empty chair. Who will they trust before dawn?',
                '六位来客，一个空位。天亮之前，他们会相信谁？',
              ],
            ]
          : [
              ...Array(10).fill(['', '']),
              [
                'The storm has sealed the castle. Twelve guests take their places.',
                '风雪封住古堡，十二位来客各自落座。',
              ],
              [
                'One chair remains empty. Before dawn, who will they trust?',
                '唯有主位空着。天亮之前，他们会相信谁？',
              ],
            ];
      draft.language = 'en';
      draft.confirmed = false;
      draft.scenes = draft.scenes.map((scene, i) => ({
        ...scene,
        dialogues: scene.dialogues.map((line, j) => ({
          seat: line.seat,
          text: lines[i][j][0],
          translation: lines[i][j][1],
        })),
        narration: narrations[i][0],
        narrationTranslation: narrations[i][1],
      }));
      // The sealed message sets a concrete reason for the guests to stay and listen.
      const revisedLines =
        roomSize === 6
          ? [
              [
                [1, 'The Count promised the missing page.', '伯爵答应交出失落的盟约一页。'],
                [
                  2,
                  'If we hear him together, neither family can bury it.',
                  '我们一起听他说明，两族谁也无法掩盖真相。',
                ],
              ],
              [
                [3, 'I knocked twice. No answer.', '我敲了两次门，无人应答。'],
                [
                  4,
                  'His candles are burning. Something is wrong.',
                  '他的烛火还亮着，一定出了什么事。',
                ],
              ],
              [
                [5, 'The supper is ready. The Count is missing.', '晚宴已备好，伯爵却不见了。'],
                [6, 'He left this sealed note at his chair.', '他在自己的座位留下了这封密信。'],
                [1, 'Wait for everyone before opening it.', '等所有人到齐再拆。'],
              ],
              [
                [3, 'The bridge collapsed. We cannot leave.', '桥塌了，我们出不去了。'],
                [4, 'Then we stay inside, together.', '那就待在屋里，一起行动。'],
              ],
              [
                [5, 'The note says: listen before you choose.', '信上说，做选择之前先听彼此说完。'],
                [1, 'And the page?', '那盟约呢？'],
                [2, 'He says it is safe until dawn.', '他说盟约会安全保存到天亮。'],
              ],
              [
                [3, 'Someone could use this night against us.', '有人可能趁今晚对我们不利。'],
                [
                  4,
                  'Then no whispers. Everyone speaks at the table.',
                  '那就别私下密谋，让所有人坐下来发言。',
                ],
                [6, 'And everyone gets a voice.', '每个人都要有机会开口。'],
              ],
              [
                [1, 'If we accuse blindly, the feud wins.', '如果我们盲目指责，仇恨就赢了。'],
                [
                  2,
                  'A game, then. Listen, question, and choose.',
                  '那就玩一场游戏。倾听、质问，然后选择。',
                ],
                [5, 'The cards decide our roles, not our past.', '牌决定今晚的身份，过去不会。'],
              ],
              [],
            ]
          : [
              [
                [8, 'All twelve invitations were delivered.', '十二封邀请函都已送到。'],
                [1, 'The Count promised the missing page.', '伯爵答应交出失落的盟约一页。'],
                [
                  2,
                  'If we hear him together, neither family can bury it.',
                  '我们一起听他说明，两族谁也无法掩盖真相。',
                ],
              ],
              [
                [7, 'The clock stopped before the guests arrived.', '客人抵达前钟就停了。'],
                [3, 'I knocked twice. No answer.', '我敲了两次门，无人应答。'],
                [
                  4,
                  'His candles are burning. Something is wrong.',
                  '他的烛火还亮着，一定出了什么事。',
                ],
              ],
              [
                [11, 'Supper is ready, as the Count ordered.', '晚宴已按伯爵吩咐备好。'],
                [10, 'But his chair is empty.', '可他的座位空着。'],
                [6, 'Then who left the note?', '那是谁留下了这封信？'],
              ],
              [
                [1, 'When did you last see him?', '你最后一次见他是什么时候？'],
                [11, 'Before supper. Not since.', '准备晚餐前，此后就没见过。'],
                [5, 'The seal is unbroken. Wait for everyone.', '封印完好，等所有人到齐再拆。'],
              ],
              [
                [9, 'The bridge collapsed. The path is buried.', '桥塌了，小路也被雪埋住。'],
                [12, 'Nobody can survive that storm.', '没人能在这场风雪中活下来。'],
                [3, 'Tell the others. We stay inside.', '告诉其他人，我们留在屋里。'],
              ],
              [
                [9, 'There is no safe way down.', '下山没有安全的路。'],
                [4, 'Bring everyone to the fire.', '让所有人都到火边来。'],
                [2, 'We stay together until dawn.', '天亮之前，我们待在一起。'],
              ],
              [
                [5, 'The note says: listen before you choose.', '信上说，做选择之前先听彼此说完。'],
                [10, 'He says the page is safe until dawn.', '他说盟约会安全保存到天亮。'],
                [1, 'But he leaves us here without answers.', '可他把我们留在这里，什么也没解释。'],
              ],
              [
                [8, 'Every invitation bears his seal.', '每封邀请函都有他的印章。'],
                [6, 'Then let everyone speak, in the open.', '那就让每个人当众开口。'],
                [12, 'No one should wait alone tonight.', '今晚谁也不要独自等待。'],
              ],
              [
                [3, 'Someone could use this night against us.', '有人可能趁今晚对我们不利。'],
                [7, 'Separate what we know from what we guess.', '把事实和猜测分开。'],
                [
                  2,
                  'A game, then. Listen, question, and choose.',
                  '那就玩一场游戏。倾听、质问，然后选择。',
                ],
              ],
              [
                [11, 'Twelve cards. One for each of us.', '十二张牌，每人一张。'],
                [9, 'We stay here until dawn.', '天亮之前我们留在这里。'],
                [5, 'The cards decide our roles, not our past.', '牌决定今晚的身份，过去不会。'],
              ],
              [],
              [],
            ];
      draft.scenes.forEach((scene, i) => {
        scene.dialogues = revisedLines[i].map(([seat, text, translation]) => ({
          seat,
          text,
          translation,
        }));
      });
      // Keep the same focal guests and objects visible across cuts wherever the six-person limit permits.
      const beats =
        roomSize === 6
          ? [
              [
                [1, 2],
                '门廊：薇拉握着邀请函，莱恩提灯走到橡木门前；两人商定共同见证盟约。',
                '雪中的吊桥仍可通行，薇拉手里是封好的邀请函。',
                '莱恩推开橡木门，灯光照入长廊，薇拉跟在他左侧。',
              ],
              [
                [1, 2, 3, 4],
                '长廊：诺克斯扶门，瑟琳接过莱恩的灯；四人望向宴厅方向。',
                '莱恩推门进入长廊，薇拉仍在他的左侧，邀请函未离手。',
                '瑟琳将灯举向宴厅，四人沿同一方向走去。',
              ],
              [
                [1, 2, 5, 6],
                '宴厅入口：众人看见备好的餐桌和空主位。阿德里安合上档案夹，艾琳在主位旁发现密封留言。',
                '灯光先照到空主位，桌上餐具未动，薇拉和莱恩站在入口。',
                '艾琳把密封留言留在空主位前，薇拉走近桌边。',
              ],
              [
                [1, 2, 5, 6],
                '桌边：薇拉阻止立即拆信，要求等所有人共同见证；窗外突然传来木桥断裂声。',
                '留言仍封好放在空主位前，薇拉站在桌边，莱恩在她右侧。',
                '四人朝右侧高窗看去，邀请函和密信留在桌边。',
              ],
              [
                [2, 3, 4],
                '右侧高窗：诺克斯关窗，莱恩看见桥断，瑟琳稳住手中的灯。',
                '莱恩从桌边来到右侧高窗，诺克斯与瑟琳紧随其后。',
                '断桥留在窗外，莱恩带着两人转回桌边。',
              ],
              [
                [1, 2, 5, 6],
                '桌边：阿德里安当众拆开留言，艾琳压住纸角，薇拉和莱恩追问盟约所在。',
                '薇拉在桌边等待，莱恩从窗边返回，密信仍在空主位前。',
                '留言摊在桌心，邀请函在旁，六人都能看到。',
              ],
              [
                [3, 4, 5, 6],
                '沿桌移动：诺克斯担忧有人趁机行动，瑟琳提出公开发言，艾琳拉开椅子。',
                '留言平摊桌心，瑟琳手中的灯放在桌边。',
                '椅子拉开，灯、邀请函和留言仍在原位。',
              ],
              [
                [1, 2, 3, 5],
                '桌边：薇拉拒绝盲目指责，莱恩提议用游戏互相倾听和选择，阿德里安摆下身份牌。',
                '众人面向同一桌心，邀请函与留言并排。',
                '身份牌背面朝上，莱恩坐到薇拉对面，空主位仍在。',
              ],
              [
                [1, 2, 3, 4, 5, 6],
                '六人围桌，手停在各自的牌边；目光在对面的人和空主位之间游移。',
                '六张牌背面朝上，留言、邀请函与灯仍在桌心。',
                '牌尚未翻开，烛火映着六人的目光，淡出至双语片尾。',
              ],
            ]
          : [
              [
                [1, 2, 8],
                '门廊：信使米蕾迎接薇拉和莱恩，三人确认共同见证盟约的目的。',
                '最后两封邀请函在米蕾手中，吊桥仍可通行。',
                '薇拉收好邀请函，莱恩推门，三人走入长廊。',
              ],
              [
                [1, 2, 3, 4, 7, 8],
                '长廊：莱恩举灯，诺克斯守门，瑟琳和埃里克发现停钟；薇拉与米蕾在旁。',
                '莱恩推门进入长廊，薇拉紧随其左侧，米蕾在右侧。',
                '瑟琳举灯照向宴厅，同行者沿长廊朝同一方向走。',
              ],
              [
                [1, 2, 5, 6, 10, 11],
                '宴厅入口：莱恩与薇拉到达，达米安打开门，阿德里安、诺娅和艾琳望见备好的餐桌。',
                '灯光穿过宴厅门，薇拉和莱恩站在入口两侧。',
                '空主位和封好的留言出现在桌前，六人向桌边靠近。',
              ],
              [
                [1, 2, 5, 11],
                '桌边：薇拉询问达米安伯爵的去向，阿德里安守着尚未拆封的留言。',
                '空主位居中，留言在主位前，薇拉和莱恩站在桌边。',
                '密信仍未开启，窗外传来断裂声，莱恩转向右侧高窗。',
              ],
              [
                [2, 3, 9, 12],
                '右侧高窗：卢修斯看到吊桥断裂，诺克斯关窗，奥菲莉娅拦住正要靠近窗边的莱恩。',
                '莱恩从桌边来到高窗，诺克斯跟在他身后。',
                '断桥留在窗外，四人转身返回餐桌。',
              ],
              [
                [2, 3, 4, 7, 9],
                '桌边：卢修斯说明山路已封，瑟琳举灯召集来客，莱恩决定共同等待天亮。',
                '莱恩与诺克斯从右窗回到桌边，卢修斯跟在身侧。',
                '灯放在桌边，众人面向空主位前的留言。',
              ],
              [
                [1, 2, 5, 8, 10],
                '桌边：阿德里安当众拆开留言，诺娅压住纸角，薇拉追问盟约。',
                '莱恩守在桌边，薇拉站在他的对侧，密信位于空主位前。',
                '留言平摊桌心，邀请函和灯留在两侧。',
              ],
              [
                [1, 4, 6, 8, 12],
                '镜头沿桌边移动：米蕾核对邀请印章，艾琳提议公开发言，奥菲莉娅为瑟琳拉椅。',
                '留言摊在桌心，薇拉仍在桌边，灯照着纸面。',
                '椅子拉开，信袋和乐谱放在各自主人的座位旁。',
              ],
              [
                [1, 2, 3, 7, 10],
                '另一侧桌边：诺克斯担忧有人借夜色行动，埃里克区分事实与猜测，莱恩提出游戏。',
                '留言与邀请函并排，薇拉和莱恩隔桌相对。',
                '莱恩将身份牌放在桌上，牌背朝上。',
              ],
              [
                [2, 5, 6, 9, 11, 12],
                '桌边：达米安分放身份牌，卢修斯确认众人留下，阿德里安说明身份由牌决定。',
                '莱恩手边的牌背朝上，留言和灯仍在桌心。',
                '来客沿桌两侧落座，牌未翻开，空主位仍在。',
              ],
              [
                [1, 2, 3, 4, 5, 6],
                '镜头缓缓沿桌的一侧移动，六人望向对席，手停在牌边。',
                '牌未翻，留言和灯在桌心，空主位可见。',
                '镜头沿桌边继续向另一侧移动，烛火和留言保持原位。',
              ],
              [
                [7, 8, 9, 10, 11, 12],
                '镜头接续桌沿运动掠过另一侧六人，最后停在未翻的牌与空主位。',
                '从前镜的桌沿运动接入，留言和空主位保持原位。',
                '牌仍未翻开，烛火映照十二人的位置，淡出至双语片尾。',
              ],
            ];
      if (roomSize === 6) {
        const noteBeat = {
          ...draft.scenes[2],
          duration: 6,
          dialogues: [draft.scenes[2].dialogues[2]],
          narration: '',
          narrationTranslation: '',
          narrationSeconds: 0,
        };
        draft.scenes[2].dialogues = draft.scenes[2].dialogues.slice(0, 2);
        draft.scenes.splice(3, 0, noteBeat);
      }
      draft.scenes.forEach((scene, i) => {
        [scene.cast, scene.description, scene.startFrame, scene.endFrame] = beats[i];
      });
      // The note close-up continues the established composition from the preceding shot.
      draft.scenes[3].startSource = 'previous';
      if (roomSize === 12) {
        draft.scenes[3].cast = [...draft.scenes[2].cast];
        const final = draft.scenes[11];
        final.description = '餐桌另一侧六人的连续短推镜，最后停在未翻的牌与空主位。';
        final.startFrame =
          '以相同桌沿、留言和烛台作匹配切入，机位在餐桌另一侧，空主位和光向保持一致。';
        final.endFrame = '牌仍未翻开，画面内六人停在各自座位，空主位与烛火可见，淡出至双语片尾。';
      }
      draft.source =
        '《血月停战宴》' +
        roomSize +
        '人双语电影草稿\n目标：赴宴寻找盟约最后一页和证人，结束两族世仇。伯爵失踪，风雪封路，公开留言只要求众人先听彼此。来客决定以身份随机的游戏检验信任，留待天亮追寻真相。\n\n' +
        draft.scenes
          .map(
            (scene, i) =>
              '镜头' +
              (i + 1) +
              '：' +
              scene.description +
              '\n起：' +
              scene.startFrame +
              '\n止：' +
              scene.endFrame +
              '\n' +
              scene.dialogues
                .map((d) => d.seat + '号 ' + d.text + ' / ' + d.translation)
                .join('\n') +
              (scene.narration
                ? '\n旁白 ' + scene.narration + ' / ' + scene.narrationTranslation
                : ''),
          )
          .join('\n\n');
      return validate(draft);
    }

    return { bloodMoonSample, bloodMoonEnglishSample };
  }
  return { create };
});
