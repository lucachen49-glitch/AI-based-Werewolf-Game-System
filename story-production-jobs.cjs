"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const {
  atomic,
  readAtomic,
  validId,
  StoryError,
} = require("./scenario-store.cjs");
const Schema = require("./scenario.js");
const AgentRequest = require("./agent-request.js");
const Preview = require("./workshop-preview.js");
const fingerprint = (s) =>
  createHash("sha256").update(Schema.productionSignature(s)).digest("hex");
const delay = () => new Promise((resolve) => setTimeout(resolve, 1000));
const now = () => new Date().toISOString();
const fail = (code, message) => {
  throw new StoryError(409, code, message);
};
function createProductionJobs({
  root,
  store,
  artJobs,
  jobs,
  subtitles,
  reviewer,
  poll = delay,
}) {
  const active = new Map(),
    agents = new Map(),
    writes = new Map();
  let serial = Promise.resolve(),
    closed = false;
  const locked = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  const file = (id) => path.join(root, id, "job.json");
  async function get(id) {
    if (!validId(id)) fail("PRODUCTION_NOT_FOUND", "找不到自动制作任务");
    try {
      return await readAtomic(file(id));
    } catch (e) {
      if (e.code === "ENOENT")
        fail("PRODUCTION_NOT_FOUND", "找不到自动制作任务");
      throw e;
    }
  }
  function patch(id, changes) {
    const next = (writes.get(id) || Promise.resolve()).then(async () => {
      const j = await get(id);
      Object.assign(j, typeof changes === "function" ? changes(j) : changes, {
        updatedAt: now(),
      });
      await atomic(file(id), j);
      return j;
    });
    writes.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }
  async function materialStamp(art, kind) {
    const items =
      kind === "character"
        ? art.characters
        : kind === "visual"
          ? art.visualAssets || []
          : kind === "characters"
            ? [...art.characters, ...(art.visualAssets || [])]
            : [...art.characters, ...(art.visualAssets || []), ...art.frames];
    const content = await Promise.all(
      items.map(async (item) => ({
        status: item.status,
        file: item.file || null,
        description: item.description || "",
        appearance: item.appearance || "",
        prompt: item.prompt || "",
        cast: item.cast || [],
        scenes: item.scenes || [],
        hash: item.file
          ? await assetHash(await artJobs.mediaFile(art.id, item.file))
          : null,
      })),
    );
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
  }
  function materialReference(source) {
    return source && {
      material: source.material || null,
      characterMaterial: source.characterMaterial || null,
      visualMaterial: source.visualMaterial || null,
      frameMaterial: source.frameMaterial || null,
    };
  }
  async function refreshMaterials(j) {
    if (!j.artId) return j;
    const art = await artJobs.get(j.artId);
    const charactersReference =
      j.checkpoint?.stage === "characters"
        ? j.checkpoint
        : j.approvals.characters;
    const framesReference =
      j.checkpoint?.stage === "frames" ? j.checkpoint : j.approvals.frames;
    const characterMaterial = await materialStamp(art, "character");
    const visualMaterial = await materialStamp(art, "visual");
    const frameMaterial = await materialStamp(art, "frames");
    const legacyCharactersMaterial = await materialStamp(art, "characters");
    const characterReference = materialReference(charactersReference);
    const frameReference = materialReference(framesReference);
    const characterHasComponents = Boolean(
      characterReference?.characterMaterial || characterReference?.visualMaterial,
    );
    const frameHasComponents = Boolean(
      frameReference?.characterMaterial ||
      frameReference?.visualMaterial ||
      frameReference?.frameMaterial,
    );
    const charactersChanged = characterReference
      ? characterHasComponents
        ? characterReference.characterMaterial !== characterMaterial ||
          characterReference.visualMaterial !== visualMaterial
        : characterReference.material !== legacyCharactersMaterial
      : false;
    const framesChanged = frameReference
      ? frameHasComponents
        ? frameReference.frameMaterial !== frameMaterial ||
          frameReference.characterMaterial !== characterMaterial ||
          frameReference.visualMaterial !== visualMaterial
        : frameReference.material !== frameMaterial
      : false;
    const checkpointChanged =
      ["characters", "frames"].includes(j.checkpoint?.stage) &&
      j.checkpoint.artRevision !== art.revision;
    if (!charactersChanged && !framesChanged && !checkpointChanged) return j;
    if (j.videoId) await jobs.pause(j.videoId);
    const approvals = { ...j.approvals };
    if (charactersChanged) delete approvals.characters;
    delete approvals.frames;
    delete approvals.final;
    return patch(j.id, {
      stage: charactersChanged
        ? "characters"
        : framesChanged
          ? "frames"
          : j.checkpoint.stage,
      status: "running",
      approvals,
      checkpoint: null,
      resumeStatus: null,
      videoId: null,
      subtitleId: null,
      message: "素材已修改，正在重新检查受影响的步骤。旧视频及素材已保留。",
    });
  }
  async function setAgent(id, agent) {
    const reasoningEffort = AgentRequest.normalizeReasoningEffort(agent?.reasoningEffort);
    const normalizedAgent = { ...agent, reasoningEffort };
    const identity = createHash("sha256")
      .update(JSON.stringify([AgentRequest.responsesEndpoint(agent.endpoint), agent.model.trim(), reasoningEffort, AgentRequest.PROTOCOL, AgentRequest.OUTPUT_MAX_TOKENS]))
      .digest("hex");
    const j = await get(id);
    agents.set(id, normalizedAgent);
    if (j.agentIdentity !== identity) {
      await patch(id, {
        agentIdentity: identity,
        agentReasoningEffort: reasoningEffort,
        agentProtocol: AgentRequest.PROTOCOL,
        agentMaxOutputTokens: AgentRequest.OUTPUT_MAX_TOKENS,
        capabilities: null,
        reportHistory: [...(j.reportHistory || []), ...Object.entries(j.reports || {}).map(([key, report]) => ({key, report, agentIdentity: j.agentIdentity || null, archivedAt: now()}))],
        reports: {},
        ...(j.agentIdentity &&
        j.status === "awaiting_confirmation" &&
        j.stage !== "final"
          ? {
              status: "paused",
              checkpoint: null,
              resumeStatus: null,
              message: "检查模型已更换，请点击继续以重新检查当前步骤。",
            }
          : {}),
      });
    }
  }
  async function records(storyId) {
    let ids;
    try {
      ids = await fs.readdir(root);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return (await Promise.all(ids.filter(validId).map((id) => get(id))))
      .filter((j) => !storyId || j.storyId === storyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function view(j) {
    const art = j.artId ? artJobs.summary(await artJobs.get(j.artId)) : null,
      video = j.videoId ? jobs.summary(await jobs.get(j.videoId)) : null,
      final = j.subtitleId ? await subtitles.getSummary(j.subtitleId) : null;
    return {
      id: j.id,
      storyId: j.storyId,
      version: j.version,
      roomSize: j.roomSize,
      title: j.snapshot.title,
      status: j.status,
      stage: j.stage,
      artId: j.artId || null,
      message: j.message,
      errorCode: j.errorCode || null,
      approvals: j.approvals,
      authorization: j.authorization || null,
      capabilities: j.capabilities || null,
      agentReasoningEffort: AgentRequest.normalizeReasoningEffort(j.agentReasoningEffort),
      agentProtocol: j.agentProtocol || null,
      agentMaxOutputTokens: j.agentMaxOutputTokens || null,
      reportHistory: j.reportHistory || [],
      reports: Object.fromEntries(Object.entries(j.reports).map(([key, report]) => [key, {...report, id: report.id || reportId(key, report)}])),
      skippedChecks: j.skippedChecks || {},
      candidates: j.candidates || [],
      reuse: j.reuse || {},
      visualAssetsSource: j.visualAssetsSource || null,
      redos: j.redos,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      art,
      video,
      final,
      plan: {
        characters: j.snapshot.characters.length,
        shots: j.snapshot.scenes.length,
        duration: j.snapshot.scenes.reduce((n, s) => n + s.duration, 0),
        imageRequests: j.snapshot.characters.length + (j.visualAssets || []).length + j.snapshot.scenes.length,
        visualAssets: j.visualAssets || [],
        visualAssetsReady: j.visualAssets !== null && j.visualAssets !== undefined,
        videoRequests: j.snapshot.scenes.length,
        maxRedo: 0,
        relationships: j.snapshot.scenes.map((s, i) => ({
          index: i,
          cast: s.cast,
          startSource: s.startSource || "frame",
          referenceFrames: s.referenceFrames || [],
          references: [
            ...(s.cast || []).map((seat) => ({
              label:
                seat +
                "号 " +
                j.snapshot.characters[seat - 1].name +
                " · 人物定妆",
              url: art?.characters[seat - 1]?.url || null,
            })),
            ...(s.referenceFrames || []).map((index) => ({
              label:
                "分镜 " +
                (index + 1) +
                " · " +
                {
                  scene: "场景",
                  costume: "服装",
                  prop: "道具",
                  general: "场景、服装与道具",
                }[s.referencePurposes?.[index] || "general"],
              url: art?.frames[index]?.url || null,
            })),
            ...(s.extraReferences || []).map((ref) => ({
              label:
                "附加素材 · " +
                {
                  character: "人物",
                  scene: "场景",
                  costume: "服装",
                  prop: "道具",
                }[ref.purpose],
            })),
          ],
          startFrame: s.startFrame,
          endFrame: s.endFrame,
        })),
      },
    };
  }
  async function running(id) {
    const j = await get(id);
    if (closed || j.status !== "running") return null;
    const current = await store.get(j.storyId);
    if (
      current.version !== j.version ||
      fingerprint(current) !== j.fingerprint
    ) {
      await patch(id, {
        status: "stale",
        message: "剧本已更新，旧任务与素材已保留。请为新版本开始制作。",
      });
      return null;
    }
    return refreshMaterials(j);
  }
  async function checkpoint(id, stage, message) {
    const j = await running(id);
    if (!j || (j.stage !== stage && stage !== "final")) return;
    const art = j.artId ? await artJobs.get(j.artId) : null;
    const checkpoint = {
      stage,
      artRevision: art?.revision || null,
      material:
        art && ["characters", "frames"].includes(stage)
          ? await materialStamp(art, stage)
          : null,
      characterMaterial:
        art && ["characters", "frames"].includes(stage)
          ? await materialStamp(art, "character")
          : null,
      visualMaterial:
        art && ["characters", "frames"].includes(stage)
          ? await materialStamp(art, "visual")
          : null,
      frameMaterial:
        art && stage === "frames" ? await materialStamp(art, "frames") : null,
    };
    await patch(id, (current) =>
      current.status === "running"
        ? {
            status: "awaiting_confirmation",
            stage,
            message,
            errorCode: null,
            checkpoint,
          }
        : {},
    );
  }
  async function blocked(id, message, code = "MATERIAL_REVIEW_REQUIRED") {
    if (await running(id))
      await patch(id, (current) =>
        current.status === "running"
          ? { status: "blocked", message, errorCode: code }
          : {},
      );
  }
  async function assetHash(file) {
    return createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  }
  async function audit(id, key, input, hash) {
    let j = await running(id);
    if (!j) return null;
    if(j.skippedChecks?.[key]?.version===j.version){const skip=j.skippedChecks[key],kind=input.kind,index=input.index;let valid=kind==='script'&&skip.fingerprint===j.fingerprint||kind==='video'&&skip.fingerprint===hash;if(['character','visual','frame'].includes(kind)&&Number.isInteger(index)){const art=await artJobs.get(j.artId),items=kind==='character'?art.characters:kind==='visual'?(art.visualAssets||[]):art.frames,item=items[index];valid=!!item&&skip.artRevision===art.revision&&skip.file===item.file&&skip.fingerprint===await assetHash(await artJobs.mediaFile(art.id,item.file))}if(valid){const skipped={verdict:'inspect',summary:'用户记录为手动跳过 AI 检查；自动规则仍已运行。',findings:[],fingerprint:hash,checkedAt:skip.at,method:'手动跳过',manualSkip:{type:skip.type,version:skip.version,operator:skip.operator,at:skip.at}};await patch(id,latest=>({reports:{...latest.reports,[key]:skipped}}));return skipped}}
    if (j.reports[key]?.fingerprint === hash) return j.reports[key];
    const sourceTask=(await records(j.storyId)).find(row=>row.id!==j.id&&row.roomSize===j.roomSize&&row.agentIdentity===j.agentIdentity&&row.reports?.[key]?.fingerprint===hash&&JSON.stringify([row.capabilities?.image,row.capabilities?.video,row.capabilities?.audio])===JSON.stringify([j.capabilities?.image,j.capabilities?.video,j.capabilities?.audio]));
    if(sourceTask){const reused={...sourceTask.reports[key],reuse:{sourceTaskId:sourceTask.id,sourceVersion:sourceTask.version,fingerprint:hash,reusedAt:now()}};await patch(id,latest=>({reports:{...latest.reports,[key]:reused},reuse:{...(latest.reuse||{}),[key]:reused.reuse}}));return reused;}
    await patch(id, {
      message:
        "正在检查 " +
        (key === "script"
          ? "故事因果、人物动机和结尾"
          : key
              .replace("character:", "人物 ")
              .replace("frame:", "分镜 ")
              .replace("video:", "视频镜头 ")) +
        "，已有素材已保存。",
    });
    const identity = j.agentIdentity;
    const result = {
      ...(await reviewer.check({
        agent: agents.get(id),
        story: j.snapshot,
        ...input,
      })),
      fingerprint: hash,
    };
    j = await get(id);
    if (j.agentIdentity !== identity) return null;
    await patch(id, (current) => ({
      reports: { ...current.reports, [key]: result },
    }));
    return result;
  }
  async function submit(id, operation) {
    return locked(async () => {
      const current = await running(id);
      if (!current || !current.authorization) return null;
      return operation(current);
    });
  }
  async function attachArt(j) {
    return submit(j.id, async () => {
      let art = (await artJobs.list(j.storyId)).find(
        (a) =>
          a.version === j.version &&
          (!a.productionId || a.productionId === j.id),
      );
      if (art) art = await artJobs.claim(art.id, j.id);
      else
        art = await artJobs.create({
          storyId: j.storyId,
          version: j.version,
          productionId: j.id,
          visualAssets: j.visualAssets || [],
          confirmCharge: true,
        });
      await patch(j.id, { artId: art.id });
      return art;
    });
  }
  async function waitArt(j, kind) {
    const art = await artJobs.get(j.artId),
      items =
        kind === "character"
          ? [...art.characters, ...(art.visualAssets || [])]
          : kind === "visual"
            ? art.visualAssets || []
            : art.frames;
    if (
      items.some((x) => ["unknown", "submitting"].includes(x.status)) &&
      art.status !== "running"
    ) {
      await blocked(
        j.id,
        art.message ||
          "图片提交结果不明，请在高级编辑中关联原任务或核对供应商。",
        "SUBMISSION_UNCERTAIN",
      );
      return null;
    }
    if(items.some(x=>x.needsRegeneration||x.status==='held')){
      await blocked(j.id,'当前有图片因依赖素材变化而待重新制作。请在高级图片卡片中逐张确认重做及费用；不会自动提交。','ART_REVISION_REQUIRED');return null;
    }
    if (items.some((x) => ["failed", "saved_raw"].includes(x.status))) {
      await blocked(
        j.id,
        art.message || "图片未完成，可在高级编辑中处理已保存素材后继续。",
      );
      return null;
    }
    if (art.status === "running") {
      await poll();
      return null;
    }
    if (items.some((x) => x.status !== "done")) {
      await submit(j.id, async () => {
        await artJobs.unpause(art.id);
        await artJobs.action(art.id, {
          action: kind === "frame" ? "generateFrames" : "resume",
          revision: art.revision,
          confirmCharge: true,
        });
      });
      await poll();
      return null;
    }
    return art;
  }
  const reportId=(key,r)=>createHash('sha256').update(JSON.stringify([key,r.fingerprint,r.checkedAt,r.verdict,r.findings])).digest('hex');
  function candidateFor(j,key,r,changes,affected,findingIndex=null,sourceFinding=null){return {id:randomUUID(),key,reportId:r.id||reportId(key,r),reportVersion:r.checkedAt||null,originalFingerprint:j.fingerprint,assetFingerprint:r.fingerprint,artRevision:j.artRevision||null,videoId:j.videoId||null,findingIndex,sourceFinding,changes,affected,createdAt:now(),status:'pending'}}
  function affectedFrames(art,kind,index){const visited=new Set([kind+':'+index]);for(const f of art.frames)if((f.dependencyIds||[]).some(x=>visited.has(x)))visited.add('frame:'+f.index);return [...visited]}
  async function suggestArt(j,key,result,art,kind,i){
    if(result.verdict!=='redo'||j.candidates?.some(c=>c.key===key&&c.assetFingerprint===result.fingerprint&&c.status!=='withdrawn'))return;
    const items=kind==='character'?art.characters:kind==='visual'?(art.visualAssets||[]):art.frames,item=items[i],base=item[kind==='character'?'appearance':kind==='visual'?'prompt':'description'];
    const notes=(result.findings||[]).map(f=>f.suggestion).filter(Boolean).join('；');
    const handFixes=[
      '镜头1：中近景完整显示薇拉右前臂、手腕、整只手和邀请函。只用右手在信封侧边作明确指尖夹持，拇指垫压正面，食指尖从背面正对支撑，中指托住背面边缘；信封底边悬空，不接触掌心。掌心绝不能托在信封下方。手与纸张轮廓分离，接触点清楚，恰好五指且自然连接。禁止信封贴手、穿手、悬浮、额外手或畸形指。',
      '镜头2结尾：薇拉继续由同一只右手在腰前竖直夹持同一封邀请函，完整露出前臂、手腕和手，背景为深色裙身。拇指在纸张正面，食指在纸边背面相抵，中指支撑背面，其余两指自然弯曲。只有薇拉右手参与握信，其他人物的手按本镜起始状态自然放置，每只可见手均为自然连接的五指。纸张不贴掌、不穿模、不浮空。起始静帧只呈现本镜开始姿势，递灯和行走留给后续动画。',
      '镜头3开始：严格复制镜头2结尾参考中的薇拉、画面侧、右臂角度、手腕、手势、邀请函大小方向、封蜡和光线。同一封邀请函仍由薇拉右手在侧边用拇指与食指相对夹持，中指支撑背面，另两指自然弯曲。完整展示自然连接的五指、手腕和纸张，禁止六指、重复指、掌心托信、信封贴手或穿模。只有薇拉拿邀请函。空主位前的封口留言是另一件道具，按本镜起始状态留在桌上或由艾琳取阅，不提前执行结尾动作。'
    ];
    const fixed=kind==='frame'&&j.roomSize===6&&i<3&&/薇拉|Vera/i.test(j.snapshot.characters[0]?.name)?handFixes[i]:'';
    if(!notes&&!fixed)return;
    const candidate=candidateFor({...j,artRevision:art.revision},key,result,{text:[fixed,base,notes].filter(Boolean).join('\n').slice(0,kind==='character'?800:kind==='visual'?4000:1000)},affectedFrames(art,kind,i));
    await patch(j.id,latest=>({candidates:[...(latest.candidates||[]),candidate]}));
  }
  async function checkArt(j, kind, art, selectedIndexes = null) {
    const items = kind === "character" ? art.characters : kind === "visual" ? (art.visualAssets || []) : art.frames;
    const indexes = selectedIndexes
      ? [...new Set(selectedIndexes)].filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < items.length,
        )
      : items.map((_, index) => index);
    for (const i of indexes) {
      if (!(await running(j.id))) return false;
      const item = items[i],
        key = kind + ":" + i,
        asset = await artJobs.mediaFile(art.id, item.file),
        hash = await assetHash(asset);
      const refs =
        kind === "frame"
          ? (item.cast || []).map((seat) => ({
              file: path.join(
                artJobs.root,
                art.id,
                art.characters[seat - 1].file,
              ),
              label: "人物 " + seat + " 已确认定妆参考",
            }))
          : [];
      if(kind==='frame'){for(const dependency of new Set([...(i>0?[i-1]:[]),...(j.snapshot.scenes[i]?.referenceFrames||[])]))if(art.frames[dependency]?.file)refs.push({file:await artJobs.mediaFile(art.id,art.frames[dependency].file),label:'镜头 '+(dependency+1)+' 分镜起始图，仅供空间或道具对照；它不是实际尾帧'});for(const asset of art.visualAssets||[])if(asset.file&&(asset.scenes||[]).includes(i))refs.push({file:await artJobs.mediaFile(art.id,asset.file),label:asset.label+' 已确认视觉参考'});}
      if(kind==='frame')for(const ref of item.referenceManifest||[])if(ref.snapshotFile)refs.push({file:await artJobs.mediaFile(art.id,ref.snapshotFile),label:'生成时使用的'+ref.purpose+'参考图 '+(ref.label||'')+'，用于核对物品和场景一致性'});
      const referenceHashes = await Promise.all(
        refs.map((ref) => assetHash(ref.file)),
      );
      const checkVersion = kind === "frame" && j.roomSize === 6 && i < 3
        ? "media-check-v4-hand-detail" : "media-check-v3";
      const reviewHash = createHash("sha256")
        .update(JSON.stringify([checkVersion,j.storyId,j.roomSize,hash,referenceHashes,item.contentFingerprint||null,kind==="character"?j.snapshot.characters[i]:kind==="visual"?j.visualAssets?.[i]:j.snapshot.scenes[i],j.snapshot.visualGuide]))
        .digest("hex");
      const result = await audit(
        j.id,
        key,
        {
          kind,
          index: i,
          images: [
            {
              file: asset,
              label: kind === "character" ? "实际人物定妆照" : kind === "visual" ? "实际关键视觉素材图" : "实际分镜图",
            },
            ...refs,
          ],
        },
        reviewHash,
      );
      if (!result) return false;
      const stored={...result,id:result.id||reportId(key,result)};
      await artJobs.recordReview?.(art.id,art.revision,kind,i,{id:stored.id,fingerprint:reviewHash,verdict:stored.verdict,checkedAt:stored.checkedAt});
      await suggestArt(await get(j.id),key,stored,art,kind,i);
    }
    return true;
  }
  async function videoStep(j) {
    if (!j.videoId) {
      await submit(j.id, async () => {
        const art = await artJobs.get(j.artId);
        let video = (await jobs.list(j.storyId)).find(
          (v) =>
            v.version === j.version &&
            v.artId === art.id &&
            v.artRevision === art.revision &&
            (!v.productionId || v.productionId === j.id),
        );
        if (video) video = await jobs.claim(video.id, j.id);
        else
          video = await jobs.create({
            storyId: j.storyId,
            version: j.version,
            profile: "cinema-refs-v1",
            artId: art.id,
            artRevision: art.revision,
            productionId: j.id,
            confirmCharge: true,
          });
        await patch(j.id, { videoId: video.id });
      });
      return;
    }
    const video = await jobs.get(j.videoId);
    if (["ready", "accepted"].includes(video.status)) {
      if (!j.subtitleId) {
        const suggested = await subtitles.suggestions(video.id);
        const cues = alignCues(suggested.cues, j.transcripts || {}, j.snapshot);
        const final = await subtitles.create({
          productionId: j.id,
          sourceJobId: video.id,
          cues,
          titleZh: "血月停战宴",
          titleEn: "The Blood Moon Truce",
          hookZh: "席位已定。你会相信谁？",
          hookEn: "The seats are set. Who will you trust?",
        });
        await patch(j.id, {
          subtitleId: final.id,
          message: "镜头检查完成，正在本地合成双语字幕与主题片尾。",
        });
        return;
      }
      const final = await subtitles.getSummary(j.subtitleId);
      if (final.status === "ready") {
        await checkpoint(
          j.id,
          "final",
          "成片已完成，请完整观看并核对故事、画面、声音和双语字幕。",
        );
        return;
      }
      if (final.status === "failed") {
        await blocked(
          j.id,
          final.message || "本地合成中断，继续时复用视频重新合成。",
          "LOCAL_COMPOSE_FAILED",
        );
        return;
      }
      await poll();
      return;
    }
    if (video.status === "running") {
      await poll();
      return;
    }
    if (video.status === "quality_review") {
      const index = video.scenes.findIndex(
        (s) => s.status === "done" && s.quality !== "passed",
      );
      if (index < 0) fail("QUALITY_STATE", "镜头检查状态不一致，请继续查询");
      const asset = await jobs.mediaFile(video.id, "scene-" + index + ".mp4"),
        hash = await assetHash(asset),
        key = "video:" + index;
      let report = j.reports[key];
      if (report?.fingerprint !== hash) {
        await patch(j.id, {
          message:
            "正在检查镜头 " +
            (index + 1) +
            " 的实际画面、接点与英文语音，首次转写可能需要下载本地语音模型。",
        });
        const previous = index
            ? await jobs.mediaFile(video.id, "scene-" + (index - 1) + ".mp4")
            : null,
          input = await reviewer.videoInput(asset, previous, j.snapshot, index);
        const art = await artJobs.get(j.artId);
        for (const seat of j.snapshot.scenes[index].cast || [])
          input.images.push({
            file: path.join(
              artJobs.root,
              art.id,
              art.characters[seat - 1].file,
            ),
            label: seat + "号定妆参考",
          });
        const frame = art.frames[index];
        if (frame?.file) input.images.push({
          file: await artJobs.mediaFile(art.id, frame.file),
          label: "本镜分镜起始图，仅用于对照，非实际视频画面",
        });
        for (const ref of frame?.referenceManifest || []) {
          if (ref.snapshotFile && ["scene", "prop", "costume"].includes(ref.purpose)) {
            input.images.push({
              file: await artJobs.mediaFile(art.id, ref.snapshotFile),
              label: "生成分镜时使用的" + ref.purpose + "参考图 " + (ref.label || ""),
            });
          }
        }
        report = await audit(
          j.id,
          key,
          { kind: "video", index, ...input },
          hash,
        );
        if (!report) return;
        const latest = await get(j.id);
        await patch(j.id, {
          transcripts: { ...latest.transcripts, [index]: input.transcript },
        });
      }
      if (!(await running(j.id))) return;
      if (report.verdict !== "pass" && j.acceptedIssues?.[key] !== hash) {
        await blocked(
          j.id,
          "镜头 " +
            (index + 1) +
            " 需要人工确认。请查看检查依据及实际片段，再选择接受此镜头继续。",
          "SHOT_INSPECTION_REQUIRED",
        );
        return;
      }
      await submit(j.id, async () => {
        await jobs.unpause(video.id);
        await jobs.action(video.id, {
          action: "approveScene",
          index,
          productionId: j.id,
        });
      });
      return;
    }
    if (
      video.scenes.some((s) =>
        ["unknown", "submitting", "stale", "failed"].includes(s.status),
      )
    ) {
      await blocked(
        j.id,
        video.message || "视频提交或素材状态需要处理，原任务编号已保留。",
        "VIDEO_REVIEW_REQUIRED",
      );
      return;
    }
    await submit(j.id, async () => {
      await jobs.unpause(video.id);
      await jobs.action(video.id, { action: "resume" });
    });
    await poll();
  }
  async function work(id) {
    try {
      while (!closed) {
        let j = await running(id);
        if (!j) return;
        if (!agents.has(id)) {
          await patch(id, {
            status: "paused",
            message: "请点击继续，以当前选定的整理 Agent 恢复检查。",
          });
          return;
        }
        if (!j.capabilities) {
          const identity = j.agentIdentity;
          const capabilities = await reviewer.probe(agents.get(id));
          const current = await patch(id, (latest) =>
            latest.agentIdentity === identity ? { capabilities } : {},
          );
          if (!(await running(id))) return;
          if (current.agentIdentity !== identity) continue;
        }
        if (j.stage === "plan") {
          if (!(await audit(id, "script", { kind: "script" }, j.fingerprint)))
            continue;
          let latest = await get(id);
          if (latest.visualAssets === null || latest.visualAssets === undefined) {
            const visualAssets =
              typeof reviewer.visualAssets === "function"
                ? await reviewer.visualAssets(agents.get(id), latest.snapshot)
                : [];
            const visualAssetsSource = typeof reviewer.visualAssets === "function"
              ? {type:"agent",agentIdentity:latest.agentIdentity||null,protocol:AgentRequest.PROTOCOL,model:agents.get(id)?.model||null,reasoningEffort:AgentRequest.normalizeReasoningEffort(agents.get(id)?.reasoningEffort),generatedAt:now(),fingerprint:createHash("sha256").update(JSON.stringify(visualAssets)).digest("hex")}
              : null;
            await patch(id, { visualAssets, visualAssetsSource });
            latest = await get(id);
          }          await checkpoint(
            id,
            "plan",
            "请核对故事、制作范围、关键场景与道具清单和检查报告，并确认授权后开始图片及视频生成。",
          );
          return;
        }
        if (j.stage === "characters" || j.stage === "frames") {
          const kind = j.stage === "characters" ? "character" : "frame";
          if (!j.artId) {
            await attachArt(j);
            continue;
          }
          const art = await waitArt(j, kind);
          if (!art) continue;
          if (!(await checkArt(j, kind, art))) continue;
          if (kind === "character" && !(await checkArt(j, "visual", art))) continue;
          await checkpoint(
            id,
            j.stage,
            j.stage === "characters"
              ? "人物定妆与关键视觉素材检查结果已就绪，请逐项核对后确认。"
              : "分镜及相邻画面对照已就绪，请核对空间、道具和级联关系后确认。",
          );
          return;
        }
        if (j.stage === "video") {
          await videoStep(j);
          continue;
        }
        return;
      }
    } catch (e) {
      const j = await get(id);
      if (j.status === "running")
        await patch(id, {
          status: "blocked",
          errorCode: e.code || "PRODUCTION_INTERRUPTED",
          message:
            e instanceof StoryError || e instanceof AgentRequest.ResponseError
              ? e.message
              : "制作暂时中断，已有素材及任务编号已保存。请继续查询。",
        });
    }
  }
  function launch(id) {
    if (active.has(id) || closed) return;
    const task = work(id).finally(async () => {
      active.delete(id);
      const j = await get(id);
      if (j.status === "running" && !closed) launch(id);
    });
    active.set(id, task);
  }
  const service = {
    get,
    view,
    async list(storyId) {
      return Promise.all((await records(storyId)).map(view));
    },
    create(body) {
      return locked(async () => {
        const story = await store.get(body.storyId);
        if (story.version !== body.version || !story.confirmed)
          fail("CONFIRMED_STORY_REQUIRED", "请先保存并确认当前剧本");
        if (!story.cinematic || story.language !== "en")
          fail(
            "ENGLISH_CINEMA_REQUIRED",
            "自动制作需要新版英文电影剧本，请先载入对应人数的新版剧本。",
          );
        const issues = [
          ...Preview.preflight(story, {}, { requireReviews: false }),
          ...Schema.voiceIssues(story),
        ];
        if (issues.length) fail("PRODUCTION_CHECK_FAILED", issues.join("；"));
        const agent = reviewer.credential(body.agent),
          hash = fingerprint(story);
        let j = (await records(story.id)).find(
          (j) =>
            j.version === story.version &&
            j.fingerprint === hash &&
            j.status !== "cancelled",
        );
        if (!j) {
          j = {
            id: randomUUID(),
            storyId: story.id,
            version: story.version,
            roomSize: story.roomSize,
            snapshot: Schema.automaticReferences(story),
            visualAssets: null,
            fingerprint: hash,
            stage: "plan",
            status: "running",
            message: "正在检测整理 Agent 的图片理解能力并检查剧本。",
            approvals: {},
            reports: {},
            reportHistory: [],
            agentProtocol: AgentRequest.PROTOCOL,
            agentMaxOutputTokens: AgentRequest.OUTPUT_MAX_TOKENS,
            redos: {},
            transcripts: {},
            createdAt: now(),
            agentReasoningEffort: AgentRequest.normalizeReasoningEffort(agent.reasoningEffort),
            updatedAt: now(),
          };
          await atomic(file(j.id), j);
        }
        await setAgent(j.id, agent);
        j = await get(j.id);
        if (j.status === "running") launch(j.id);
        return view(j);
      });
    },
    action(id, body) {
      return locked(async () => {
        let j = await get(id);
        if (["cancelled"].includes(j.status))
          return view(j);
        if (body.action === "pause" || body.action === "cancel") {
          j = await patch(id, {
            status: body.action === "pause" ? "paused" : "cancelled",
            ...(body.checkOnly === true ? { checkOnly: true } : {}),
            resumeStatus:
              j.status === "awaiting_confirmation"
                ? "awaiting_confirmation"
                : "running",
            message:
              body.action === "pause"
                ? "已请求暂停，在途素材处理完成后保留进度。"
                : "已取消后续制作，已生成素材与任务编号保留。",
          });
          if (j.artId) await artJobs.pause(j.artId);
          if (j.videoId) await jobs.pause(j.videoId);
          if (body.action === "cancel") agents.delete(id);
          return view(j);
        }
        const current = await store.get(j.storyId);
        if (
          body.action !== "revertRevisionCandidate" &&
          (current.version !== j.version || fingerprint(current) !== j.fingerprint)
        )
          fail("STALE_PRODUCTION", "剧本或制作资料已更新，请为新版本开始制作");
        if(body.action==='backfillVisualAssets'){
          if(!j.artId)fail('ART_NOT_READY','当前制作任务尚未关联图片任务');
          const input=body.agent||agents.get(id);
          if(!input)fail('AGENT_REQUIRED','请先提供当前制作任务使用的整理 Agent 配置');
          const agent=reviewer.credential(input);
          const art=await artJobs.get(j.artId);
          const existingArtAssets=Array.isArray(art.visualAssets)&&art.visualAssets.length
            ? art.visualAssets.map(({file,status,review,confirmedAt,needsReview,needsRegeneration,...asset})=>asset)
            : null;
          let visualAssets=existingArtAssets || (Array.isArray(j.visualAssets)&&j.visualAssets.length ? j.visualAssets : null);
          let source=j.visualAssetsSource || (existingArtAssets ? {type:'existing-art',generatedAt:now()} : null);
          if(!visualAssets){
            if(typeof reviewer.visualAssets!=='function')fail('VISUAL_ASSET_UNAVAILABLE','当前整理 Agent 不支持关键视觉素材识别');
            visualAssets=await reviewer.visualAssets(agent,j.snapshot);
            source={type:'agent',agentIdentity:j.agentIdentity||null,protocol:AgentRequest.PROTOCOL,model:agent.model,reasoningEffort:AgentRequest.normalizeReasoningEffort(agent.reasoningEffort),generatedAt:now(),fingerprint:createHash('sha256').update(JSON.stringify(visualAssets)).digest('hex')};
          }
          await setAgent(id,agent);
          j=await get(id);
          const latestArt=await artJobs.get(j.artId);
          const alreadyHasAssets=Array.isArray(latestArt.visualAssets)&&latestArt.visualAssets.length;
          if(!alreadyHasAssets){
            await artJobs.action(j.artId,{action:'addVisualAssets',visualAssets,revision:latestArt.revision,productionId:j.id});
          }
          await patch(id,latest=>({visualAssets:visualAssets,visualAssetsSource:source,status:'paused',stage:'characters',checkpoint:null,resumeStatus:null,approvals:{...latest.approvals,characters:null,frames:null,video:null,final:null},message:'关键视觉素材清单已补齐，图片尚未生成。请在制作范围和费用确认后继续。'}));
          return view(await get(id));
        }        if(body.action==='skipChecks'){
          if(!['blocked','paused'].includes(j.status))fail('CHECKPOINT_CHANGED','只有当前节点检查失败时才能手动跳过');
          const keys=j.stage==='plan'?['script']:j.stage==='characters'?[...j.snapshot.characters.map((_,i)=>'character:'+i),...(j.visualAssets||[]).map((_,i)=>'visual:'+i)]:j.stage==='frames'?j.snapshot.scenes.map((_,i)=>'frame:'+i):j.stage==='video'?j.snapshot.scenes.map((_,i)=>'video:'+i):[];
          const skipped={...(j.skippedChecks||{})};
          for(const key of keys){const [kind,indexText]=key.split(':'),index=Number(indexText);let fingerprint=null,artRevision=null,file=null;
            if(kind==='script')fingerprint=j.fingerprint;
            else if(kind==='character'||kind==='visual'||kind==='frame'){const art=await artJobs.get(j.artId),items=kind==='character'?art.characters:kind==='visual'?(art.visualAssets||[]):art.frames,item=items[index];if(!item)fail('INVALID_ART_ITEM','图片编号无效');fingerprint=await assetHash(await artJobs.mediaFile(art.id,item.file));artRevision=art.revision;file=item.file;}
            else if(kind==='video'){const video=await jobs.get(j.videoId);fingerprint=await assetHash(await jobs.mediaFile(video.id,'scene-'+index+'.mp4'));file='scene-'+index+'.mp4';}
            skipped[key]={type:kind,version:j.version,fingerprint,artRevision,file,operator:'local-user',at:now()};
          }
          return view(await patch(id,{status:'paused',skippedChecks:skipped,errorCode:null,message:'已记录当前节点 AI 检查手动跳过。自动人数、时长、音色等规则仍执行；可继续查询或制作。'}));
        }
        await setAgent(id, reviewer.credential(body.agent));
        j = await get(id);
        if(body.action==='confirmAsset'){
          if(j.status!=='awaiting_confirmation'||!['characters','frames'].includes(j.stage)||body.stage!==j.stage)fail('CHECKPOINT_CHANGED','当前确认节点已变化');
          const art=await artJobs.get(j.artId);if(body.artRevision!==art.revision||j.checkpoint?.material!==(await materialStamp(art,j.stage)))fail('ART_CONFLICT','素材已修改，请刷新并重新检查');
          const kind=j.stage==='characters'&&body.kind==='visual'?'visual':j.stage==='characters'?'character':'frame',items=kind==='character'?art.characters:kind==='visual'?(art.visualAssets||[]):art.frames,index=body.index;
          if(!Number.isInteger(index)||!items[index])fail('INVALID_ART_ITEM','图片编号无效');
          await artJobs.action(art.id,{action:kind==='character'?'confirmCharacter':kind==='visual'?'confirmVisualAsset':'confirmFrame',kind,index,revision:art.revision});
          return view(await get(id));
        }
        if(['retryCharacter','retryVisualAsset','retryFrame','restoreAssetRevision'].includes(body.action)){
          if(!['awaiting_confirmation','blocked','paused'].includes(j.status))fail('CHECKPOINT_CHANGED','请在当前确认节点或暂停状态下处理单项图片');
          if(!j.artId)fail('ART_NOT_READY','当前制作还没有图片任务');
          const kind=body.action==='restoreAssetRevision'?body.kind:body.action==='retryCharacter'?'character':body.action==='retryVisualAsset'?'visual':'frame';
                     if(!['character','visual','frame'].includes(kind))fail('INVALID_ART_KIND','图片类型无效，只能处理人物、关键视觉素材或分镜',400);
           const expectedStage=kind==='frame'?'frames':'characters';
          if(j.stage!==expectedStage)fail('CHECKPOINT_CHANGED','当前确认节点与图片类型不一致');
          const index=body.index;
          if(!Number.isInteger(index)||index<0)fail('INVALID_ART_ITEM','图片编号无效',400);
          const art=await artJobs.get(j.artId),items=kind==='character'?art.characters:kind==='visual'?(art.visualAssets||[]):art.frames;
          if(!items[index])fail('INVALID_ART_ITEM','图片编号无效',400);
          if(body.artRevision!==undefined&&body.artRevision!==art.revision)fail('ART_CONFLICT','素材已修改，请刷新后重试');
          if(body.action==='restoreAssetRevision'){
            if(typeof body.file!=='string'||!body.file)fail('ART_HISTORY_NOT_FOUND','请选择要恢复的历史版本',400);
            await artJobs.action(j.artId,{action:'restoreAssetRevision',kind,index,file:body.file,revision:art.revision});
            await patch(id,{status:'running',checkpoint:null,errorCode:null,message:'已恢复历史图片，正在重新检查当前图片及受影响镜头。'});
          }else{
            if(body.confirmCharge!==true)fail('CHARGE_CONFIRM_REQUIRED','单项重做会新增一次图片生成，请先确认费用',400);
            await artJobs.action(j.artId,{action:body.action,kind,index,revision:art.revision,confirmCharge:true,reconciled:body.reconciled===true,description:body.description});
            await patch(id,{status:'running',checkpoint:null,errorCode:null,message:'已提交单项图片重做，原图和历史版本已保留。'});
          }
          launch(id);
          return view(await get(id));
        }
        if(body.action==='createRevisionCandidate'){
          if(!['awaiting_confirmation','blocked','paused','stale','complete'].includes(j.status))fail('PRODUCTION_BUSY','请在检查报告可用或制作已暂停时生成候选');
          const key=String(body.key||''),source=j.reports?.[key];if(!source)fail('REPORT_NOT_FOUND','找不到对应检查报告');
          const sourceReportId=source.id||reportId(key,source);
          if(body.reportId!==undefined&&body.reportId!==sourceReportId)fail('STALE_REPORT','检查报告已更新，请刷新后选择对应意见');
          const findingIndex=body.findingIndex===null||body.findingIndex===undefined?null:body.findingIndex;
          if(findingIndex!==null&&(!Number.isInteger(findingIndex)||findingIndex<0||findingIndex>=(source.findings||[]).length))fail('FINDING_NOT_FOUND','找不到对应的检查意见');
          const selectedFinding=findingIndex===null?null:source.findings[findingIndex];
          const duplicate=j.candidates?.find(c=>c.key===key&&c.findingIndex===findingIndex&&c.reportId===sourceReportId&&c.status==='pending');if(duplicate)return view(j);
          const changes=await reviewer.revise({agent:reviewer.credential(body.agent),story:j.snapshot,key,report:selectedFinding?{...source,findings:[selectedFinding]}:source,findingIndex,finding:selectedFinding});
          const art=j.artId?await artJobs.get(j.artId):null,parts=key.split(':'),kind=parts[0],index=Number(parts[1]);
          let affected=[];if((kind==='character'||kind==='visual'||kind==='frame')&&Number.isInteger(index)&&art)affected=affectedFrames(art,kind,index);
          const c=candidateFor({...j,artRevision:art?.revision},key,source,changes,affected,findingIndex,selectedFinding);await patch(id,latest=>({candidates:[...(latest.candidates||[]),c],message:'整改候选已保存，可以预览并单独采用。'}));return view(await get(id));
        }
        if(body.action==='previewRevisionCandidate'){
          const c=j.candidates?.find(x=>x.id===body.candidateId&&x.status==='pending');if(!c)fail('CANDIDATE_NOT_FOUND','找不到待预览候选');c.previewedAt=now();await patch(id,{candidates:j.candidates});return view(await get(id));
        }
        if(body.action==='revertRevisionCandidate'){
          const c=j.candidates?.find(x=>x.id===body.candidateId&&x.status==='adopted');if(!c)fail('CANDIDATE_NOT_FOUND','找不到已采用候选');
          if(['character','visual','frame'].includes(c.key.split(':')[0])){const [kind,index]=c.key.split(':');const art=await artJobs.revertCandidate(j.artId,(await artJobs.get(j.artId)).revision,kind,Number(index),c.previousText,c.adoptedFile);c.status='reverted';c.revertedAt=now();c.revertArtRevision=art.revision;await patch(id,{candidates:j.candidates,status:'paused',message:'已撤销候选修改；图片保留，并需重新确认。'});return view(await get(id));}
          if(c.newVersion){const latest=await store.get(j.storyId);if(latest.version!==c.newVersion)fail('CANDIDATE_CHANGED','剧本已有更新，不能直接回退；请基于当前版本继续编辑');const saved=await store.save({...j.snapshot,id:j.storyId,version:latest.version,confirmed:false});c.status='reverted';c.revertedAt=now();c.revertVersion=saved.version;await patch(id,{candidates:j.candidates,status:'stale',message:'候选已撤销，并以新版本 r'+saved.version+'恢复原稿；历史版本仍保留。'});return view(await get(id));}
          if(c.parentSubtitleId){j.subtitleId=c.parentSubtitleId;c.status='reverted';c.revertedAt=now();await patch(id,{subtitleId:j.subtitleId,candidates:j.candidates,status:'paused',message:'已切回候选前的字幕成片；新旧版本均保留。'});return view(await get(id));}
          fail('CANDIDATE_NOT_REVERSIBLE','候选对应内容已有后续修改，请使用历史版本恢复');
        }
        if(body.action==='adoptRevisionCandidate'){
          const c=j.candidates?.find(x=>x.id===body.candidateId);if(!c||c.status!=='pending')fail('CANDIDATE_NOT_FOUND','找不到待采用的整改候选');if(!c.previewedAt)fail('CANDIDATE_PREVIEW_REQUIRED','请先打开并预览候选内容');
          const currentStory=await store.get(j.storyId);if(currentStory.version!==j.version||fingerprint(currentStory)!==j.fingerprint)fail('STALE_CANDIDATE','剧本已更新，此候选不能用于新版');
          const [kind,indexText]=c.key.split(':'),index=Number(indexText),changes=c.changes;
          if(kind==='character'||kind==='visual'||kind==='frame'){
            if(!j.artId||c.artRevision!==(await artJobs.get(j.artId)).revision)fail('STALE_CANDIDATE','图片已变化，请重新检查后生成候选');
            const oldArt=await artJobs.get(j.artId),oldItems=kind==='character'?oldArt.characters:kind==='visual'?(oldArt.visualAssets||[]):oldArt.frames,oldItem=oldItems[index];const oldText=oldItem[kind==='character'?'appearance':kind==='visual'?'prompt':'description'],oldFile=oldItem.file;const art=await artJobs.applyCandidate(j.artId,oldArt.revision,kind,index,changes.text);
            c.previousText=oldText;c.adoptedFile=oldFile;c.status='adopted';c.adoptedAt=now();c.newArtRevision=art.revision;await patch(id,{candidates:j.candidates,message:'候选提示词已采用，原图仍保留。点击对应图片重做并确认费用后才会生成新图。',status:'paused'});return view(await get(id));
          }
          let next={...j.snapshot};
          if(kind==='script'){
            if(changes.title)next.title=changes.title;if(changes.background)next.background=changes.background;if(changes.visualGuide)next.visualGuide=changes.visualGuide;
            for(const scene of changes.scenes||[]){if(!Number.isInteger(scene.index)||!next.scenes[scene.index])continue;const target=next.scenes[scene.index];for(const key of ['description','startFrame','endFrame','narration','narrationZh'])if(typeof scene[key]==='string')target[key]=scene[key];if(Array.isArray(scene.dialogues))target.dialogues=scene.dialogues;}
          }else if(kind==='video'&&typeof changes.text==='string'){
            const scene=next.scenes[index];if(!scene||typeof changes.text!=='string')fail('INVALID_CANDIDATE','视频整改候选没有有效镜头文本');scene.description=changes.text;
          }else if(kind==='final'||kind==='video'&&(Array.isArray(changes.subtitleCues)||['titleZh','titleEn','hookZh','hookEn'].some(key=>typeof changes[key]==='string'))){
            if(!j.subtitleId||typeof subtitles.applyCandidate!=='function')fail('SUBTITLE_NOT_READY','字幕副本不可编辑，请重新运行本地合成');
            const parentSubtitleId=j.subtitleId;const updated=await subtitles.applyCandidate(j.subtitleId,changes);c.parentSubtitleId=parentSubtitleId;c.status='adopted';c.adoptedAt=now();c.newSubtitleId=updated.id;await patch(id,{subtitleId:updated.id,candidates:j.candidates,status:'paused',message:'字幕或片尾候选已采用，正在复用现有视频本地重新合成。'});return view(await get(id));
          }else fail('INVALID_CANDIDATE','候选类型无效');
          const saved=await store.save({...next,id:j.storyId,version:j.version,confirmed:false});c.status='adopted';c.adoptedAt=now();c.newVersion=saved.version;await patch(id,{candidates:j.candidates,status:'stale',message:'候选已采用并保存为剧本新版本 r'+saved.version+'。旧图片和视频仍可查看，新版受影响步骤需要重新确认。'});return view(await get(id));
        }
        if(body.action==='withdrawRevisionCandidate'){
          const c=j.candidates?.find(x=>x.id===body.candidateId);if(!c||c.status!=='pending')fail('CANDIDATE_NOT_FOUND','找不到待撤回的整改候选');c.status='withdrawn';c.withdrawnAt=now();await patch(id,{candidates:j.candidates});return view(await get(id));
        }
        if (body.action === "reviewFrames") {
          const indexes = Array.isArray(body.frames)
            ? [...new Set(body.frames)]
            : [0, 1];
          if (
            indexes.length === 0 ||
            indexes.some(
              (index) =>
                !Number.isInteger(index) ||
                index < 0 ||
                index >= j.snapshot.scenes.length,
            )
          )
            fail("INVALID_FRAME_REVIEW", "指定的分镜编号无效");
          if (!j.artId)
            fail("ART_NOT_READY", "分镜素材尚未关联，无法复核");
          const art = await artJobs.get(j.artId);
          if (art.revision !== body.artRevision)
            fail("ART_CONFLICT", "分镜素材版本已变化，请刷新后重新复核");
          if (j.status === "running")
            fail("PRODUCTION_BUSY", "制作任务正在运行，请稍后再复核");
          if (
            art.status !== "review" ||
            art.frames.some(
              (item, index) => indexes.includes(index) && item.status !== "done",
            )
          )
            fail("ART_NOT_READY", "指定分镜尚未完成，无法复核");
          j = await patch(id, {
            status: "running",
            stage: "frames",
            checkOnly: true,
            checkpoint: null,
            resumeStatus: null,
            errorCode: null,
            message:
              "正在重新检查镜头 " +
              indexes.map((index) => index + 1).join("、") +
              "，不会重新生成图片或视频。",
          });
          const checked = await checkArt(j, "frame", art, indexes);
          if (!checked) return view(await get(id));
          await checkpoint(
            id,
            "frames",
            "镜头 1 新图片及镜头 2 的相邻画面对照已更新，请核对后确认分镜。",
          );
          return view(await get(id));
        }
        if (body.action === "confirm") {
          if (j.status !== "awaiting_confirmation" || body.stage !== j.stage)
            fail("CHECKPOINT_CHANGED", "当前确认节点已变化，请刷新");
          if (j.stage === "plan" && body.authorize !== true)
            fail(
              "CHARGE_CONFIRM_REQUIRED",
              "请确认制作范围及检查发现的问题仅生成整改候选，不会自动提交生成请求",
            );
          if (j.stage === "final" && body.watched !== true)
            fail("FINAL_PREVIEW_REQUIRED", "请完整观看成片后确认");
          if (j.stage === "characters" || j.stage === "frames") {
            const art = await artJobs.get(j.artId);
            if (
              body.artRevision !== art.revision ||
              j.checkpoint?.artRevision !== art.revision ||
              j.checkpoint?.material !== (await materialStamp(art, j.stage))
            ) {
              await patch(id, {
                status: "paused",
                checkpoint: null,
                resumeStatus: null,
                message: "素材已修改，请点击继续重新检查当前图片。",
              });
              fail(
                "ART_CONFLICT",
                "素材已修改，请继续制作以重新检查，再确认当前图片",
              );
            }
            await artJobs.action(art.id, {
              action:
                j.stage === "characters"
                  ? "confirmCharacters"
                  : "confirmFrames",
              revision: art.revision,
            });
          }
          const stages = {
            plan: "characters",
            characters: "frames",
            frames: "video",
            final: "final",
          };
          const changes = {
            status: j.stage === "final" ? "complete" : "running",
            stage: stages[j.stage],
            checkpoint: null,
            approvals: {
              ...j.approvals,
              [j.stage]: {
                at: now(),
                version: j.version,
                artRevision: body.artRevision || null,
                material: j.checkpoint?.material || null,
              },
            },
            message:
              j.stage === "final"
                ? "成片已确认，可独立播放和下载。"
                : "已确认，正在自动进入下一阶段。",
            errorCode: null,
            checkOnly: false,
          };
          if (j.stage === "plan")
            changes.authorization = {
              at: now(),
              version: j.version,
              characters: j.snapshot.characters.length,
              frames: j.snapshot.scenes.length,
              shots: j.snapshot.scenes.length,
              maxAutomaticRedo: 0,
            };
          j = await patch(id, changes);
        } else if (body.action === "resume" || body.action === "acceptShot") {
          if (j.status === "awaiting_confirmation") {
            j = await refreshMaterials(j);
            if (j.status === "awaiting_confirmation") return view(j);
          }
          if (body.action === "acceptShot") {
            if (j.errorCode !== "SHOT_INSPECTION_REQUIRED")
              fail("SHOT_REVIEW_CHANGED", "待检查镜头已变化");
            const video = await jobs.get(j.videoId),
              index = video.scenes.findIndex(
                (s) => s.status === "done" && s.quality !== "passed",
              ),
              key = "video:" + index,
              hash = await assetHash(
                await jobs.mediaFile(video.id, "scene-" + index + ".mp4"),
              );
            if (j.reports[key]?.fingerprint !== hash)
              fail("SHOT_REVIEW_CHANGED", "片段已变化，请重新检查");
            j = await patch(id, {
              acceptedIssues: { ...j.acceptedIssues, [key]: hash },
            });
          }
          j = await refreshMaterials(j);
          if (j.errorCode === "LOCAL_COMPOSE_FAILED" && j.subtitleId)
            await subtitles.retry(j.subtitleId);
          j = await patch(id, {
            status:
              j.resumeStatus === "awaiting_confirmation" &&
              j.checkpoint?.stage === j.stage
                ? "awaiting_confirmation"
                : "running",
            resumeStatus: null,
            errorCode: null,
            message: "正在继续，已有素材与已受理任务会复用。",
          });
        } else fail("INVALID_PRODUCTION_ACTION", "不支持此制作操作");
        if (j.status === "running") launch(id);
        else if (j.status === "complete") agents.delete(id);
        return view(j);
      });
    },
    async recover() {
      for (const j of await records()) {
        if (j.status === "running")
          await patch(j.id, {
            status: "paused",
            message:
              "服务已重启，任务与素材已恢复。点击继续以恢复检查及后续制作。",
          });
        if (j.artId) await artJobs.pause(j.artId);
        if (j.videoId) await jobs.pause(j.videoId);
      }
    },
    async close() {
      closed = true;
      for (const j of await records()) {
        if (j.status === "running")
          await patch(j.id, {
            status: "paused",
            message: "服务关闭前已保存进度，请继续制作。",
          });
        if (j.artId) await artJobs.pause(j.artId);
        if (j.videoId) await jobs.pause(j.videoId);
      }
      await Promise.allSettled([...active.values()]);
      agents.clear();
    },
  };
  return service;
}
function alignCues(cues, transcripts, story) {
  let offset = 0;
  const offsets = story.scenes.map((s) => {
    const n = offset;
    offset += s.duration;
    return n;
  });
  const words = (s) => s.toLowerCase().match(/[a-z]+(?:'[a-z]+)*/g) || [];
  return cues.map((cue) => {
    const segments = transcripts[cue.scene]?.segments || [],
      expected = words(cue.en),
      matches = segments.filter((s) => {
        const actual = words(s.text);
        return (
          expected.length &&
          actual.filter((w) => expected.includes(w)).length /
            Math.max(expected.length, actual.length) >
            0.65
        );
      });
    if (!matches.length) return cue;
    const start = Math.max(
        offsets[cue.scene],
        offsets[cue.scene] + matches[0].start,
      ),
      end = Math.min(
        offsets[cue.scene] + story.scenes[cue.scene].duration,
        offsets[cue.scene] + matches.at(-1).end,
      );
    return end > start ? { ...cue, start, end } : cue;
  });
}
module.exports = { createProductionJobs, fingerprint, alignCues };

