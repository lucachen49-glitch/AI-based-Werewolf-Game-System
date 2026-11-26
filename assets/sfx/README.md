# 本地音效与授权

当前游戏使用 `*-bell-v1.wav`，共 14 个单次短铃音，由 `scripts/generate-effects.py` 合成，每个 0.4 秒、44,100 Hz、单声道、16-bit PCM WAV。不同事件使用不同音高；重新制作可运行 `python scripts/generate-effects.py`。下方原素材和授权信息作为历史记录保留。

## 历史音效

其中 13 个短音效由项目此前的生成脚本使用振荡器、滤波噪声、包络和确定性随机数原创合成，22,050 Hz、单声道、16-bit PCM WAV。狼人行动 `wolf-attack-v4.wav` 为短狼嚎、刀锋和低沉冲击，2.8 秒、44,100 Hz、单声道、16-bit PCM WAV。全部随项目保存，播放无需密钥、服务或网络。

包含洗牌、飞牌、翻牌、夜间低鸣、狼人袭击、守护、查验、解药、毒药、投票、放逐、猎人枪声和两种胜利提示。只在对应实际事件触发；普通观战夜间不播放私有角色的专属音效。背景音乐由独立模块管理。

历史狼人音效可由 `python scripts/generate-wolf.py` 使用本地源录音和视频工具单独制作。游戏直接使用已保存 WAV，不在启动时生成。

## 当前狼嚎录音来源

- Wolf howls，美国鱼类及野生动物管理局（U.S. Fish and Wildlife Service）。
- 来源及授权：https://commons.wikimedia.org/wiki/File:Wolf_howls.ogg
- 历史来源：http://www.fws.gov/video/sound.htm （Commons 文件页记录）。
- 授权：美国联邦政府作品，公有领域（PD-USGov-FWS）。
- 修改：截取短段、滤波降噪、保留音高压缩狼嚎至约 1.42 秒；1.08—1.45 秒叠加原创滤波噪声刀锋，1.44 秒加入短刀鸣及低频冲击，最后为短室内反射和淡出。拟音由固定随机种子、包络和衰减振荡器合成；狼嚎仍来自实录。未提取商业游戏原音。
- 本地录音：`sources/wolf-howls.ogg`；元数据：`sources/wolf-howls-license.json`。

## 上一版扑袭录音留档（当前音效不使用）

录音为大型犬低吼，并非野生狼的实录。来源为论文的补充音频 S7：

- Faragó T, Pongrácz P, Miklósi Á, Huber L, Virányi Z, Range F (2010). *Dogs' Expectation about Signalers' Body Size by Virtue of Their Growls*. PLoS ONE 5(12): e15175. DOI: https://doi.org/10.1371/journal.pone.0015175
- 原文件与授权页：https://commons.wikimedia.org/wiki/File:Dogs%27-Expectation-about-Signalers%27-Body-Size-by-Virtue-of-Their-Growls-pone.0015175.s007.ogg
- 授权：Creative Commons Attribution 2.5 Generic（CC BY 2.5），https://creativecommons.org/licenses/by/2.5/ ，允许在保留署名、授权链接和修改说明的条件下改编及分发。
- 修改说明：选取片段、轻微降速、音量归一化及短室内反射，加入原创呼吸、衣物掠动与撞击拟音，合成为游戏用野兽扑袭。原作者未为本游戏背书。
- 本地原录音：`sources/large-dog-growl.ogg`；来源元数据：`sources/growl-license.json`。

历史版本使用独立文件名 `wolf-attack-v4.wav`，`wolf.wav` 同步保留兼容；旧 `wolf-howl-v3.wav` 保留用于对比。
