import { requireDrawOpen } from './draw-gate.mjs';
requireDrawOpen();
// 小墨的出图脚本：给一句话 → ComfyUI 出一张 PNG → 落到 D:\AI\out（可选再拷进桥接 outbox 好发出去）
// 用法：node draw.mjs "正向提示词" [负向提示词] [宽] [高] [步数] [种子]
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:8188';
const OUT_DIR = 'D:\\AI\\out\\待整理';
const COMFY_OUT = 'D:\\AI\\ComfyUI\\output';
const argvAll = process.argv.slice(2);
const ckptFlag = argvAll.find((a) => a.startsWith('--ckpt='));
const CKPT = ckptFlag ? ckptFlag.slice('--ckpt='.length) : (process.env.XIAOMO_CKPT || 'sd_xl_base_1.0.safetensors');

const [posArg, negArg, wArg, hArg, stepArg, seedArg] = argvAll.filter((a) => !a.startsWith('--ckpt='));
const positive = posArg || '1girl, solo, white long hair, red eyes, robot girl, white uniform, anime style, clean background, upper body';
const negative = negArg || 'lowres, bad anatomy, bad hands, extra fingers, watermark, signature, text, jpeg artifacts';
const width = Number(wArg) || 1024;
const height = Number(hArg) || 1024;
const steps = Number(stepArg) || 25;
const seed = Number(seedArg) || Math.floor(Math.random() * 1e9);
// 采样器/调度器可以用环境变量覆盖（不同采样器出来的质感差别很大）
const samplerName = process.env.XIAOMO_SAMPLER || 'euler';
const schedulerName = process.env.XIAOMO_SCHEDULER || 'normal';
const cfgScale = Number(process.env.XIAOMO_CFG || 7);

const workflow = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed, steps, cfg: cfgScale, sampler_name: samplerName, scheduler: schedulerName, denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
    }
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'xiaomo', images: ['8', 0] } }
};

const t0 = Date.now();
const submitted = await fetch(`${API}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'xiaomo-draw' })
}).then((r) => r.json());

if (!submitted?.prompt_id) {
  console.error('❌ 提交失败：' + JSON.stringify(submitted).slice(0, 600));
  process.exit(1);
}
const id = submitted.prompt_id;
console.log(`已提交 prompt_id=${id}（${width}x${height}, ${steps} 步, seed=${seed}）`);

let file = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const hist = await fetch(`${API}/history/${id}`).then((r) => r.json()).catch(() => ({}));
  const entry = hist?.[id];
  if (!entry) { process.stdout.write('.'); continue; }
  if (entry.status?.status_str === 'error' || entry.status?.completed === false && entry.status?.messages?.some?.((m) => m[0] === 'execution_error')) {
    console.error('\n❌ 执行出错：' + JSON.stringify(entry.status).slice(0, 800));
    process.exit(2);
  }
  const imgs = entry.outputs?.['9']?.images;
  if (imgs?.length) { file = imgs[0]; break; }
}
if (!file) { console.error('\n❌ 超时没出图'); process.exit(3); }

const src = path.join(COMFY_OUT, file.subfolder || '', file.filename);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dst = path.join(OUT_DIR, `xiaomo-${stamp}.png`);
fs.copyFileSync(src, dst);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✅ 出图完成，用时 ${secs}s\n   源：${src}\n   另存：${dst}\n   大小：${(fs.statSync(dst).size / 1024).toFixed(0)} KB`);
console.log('   参数：' + JSON.stringify({ positive, negative, width, height, steps, seed }));
// ── 参数留档（主人 2026-11-09 21:1x 定：参数也要留存）──
try {
  const rec = {
    time: new Date().toISOString(), out: path.basename(dst), src: path.basename(src),
    positive, negative, width, height, steps, seed,
    cfg: Number(process.env.XIAOMO_CFG || 8), ckpt: (process.argv.find((a) => a.startsWith('--ckpt=')) || '').slice(7) || '',
    tool: path.basename(process.argv[1] || 'draw.mjs'), seconds: Number(secs)
  };
  const logDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '画');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, '生成参数.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
} catch (e) { console.error('参数留档失败：' + e.message); }



