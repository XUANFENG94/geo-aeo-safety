#!/usr/bin/env node
/**
 * geo-aeo-safety · validate.js  (v1.1 · 安全姿态增强)
 * GEO/AEO 内容资产化自校验器
 *
 * 关键修正（v1.1）：
 *  - 红线区分「论述/教育性提及」与「部署指令」：仅当敏感词出现在代码围栏内，
 *    或同句含操作性动词（植入/执行/运行/部署/使用以下/payload…）才判为硬违规。
 *  - JSON-LD 改为抽取所有 <script type="application/ld+json"> 块并逐个 parse。
 *
 * 用法: node validate.js <file.md>
 * 退出码: 0=可发布 1=命中红线/评分不足 2=参数错误
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 红线敏感词（仅部署用途违规；论述用途仅记录）
const RED_LINES = [
  '内容农场', 'prompt injection', 'prompt注入', '投毒', 'flooding',
  '水军', '刷量', '刷屏', '伪造引用', '隐藏文本', 'hidden text',
  'keyword stuffing', '关键词堆砌', '虚假放大', 'typosquat'
];

// 操作性动词：仅当敏感词与「明确部署/攻击执行标记」同现时，才判为部署指令。
// 注意：孤立的「执行/运行」过于常见（如「加载执行」属描述），不计入。
const OPERATIONAL = /(植入|部署|实施以下|使用以下|复制以下|具体步骤|步骤如下|run the following|payload|exploit|执行以下|运行以下|粘贴以下|将以下)/i;

const SIGNALS = {
  hasTLDR: /TL;?DR|定义[:：]|核心结论|一句话/i,
  hasJsonLd: /application\/ld\+json|"@context"\s*:\s*"https?:\/\/schema\.org/i,
  hasHeading: /^#{1,3}\s/m,
  hasList: /^\s*[-*]\s+/m,
  hasSource: /(https?:\/\/[^\s)]+)|(来源|出处|参考|\[\d+\])/i,
  hasAuthor: /(作者|author|@|撰文|by\s+[A-Za-z])/i,
  hasFaq: /(FAQ|常见问|问答)/i
};

function extractJsonLd(text) {
  const blocks = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1].trim());
  }
  // 也支持围栏代码块形式
  const re2 = /```json[\s\S]*?("?@context"?\s*:\s*"https?:\/\/schema\.org[\s\S]*?)```/gi;
  while ((m = re2.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks;
}

function main() {
  const f = process.argv[2];
  if (!f) { console.error('用法: node validate.js <file.md>'); process.exit(2); }
  let text;
  try { text = fs.readFileSync(f, 'utf8'); }
  catch (e) { console.error('读取失败:', e.message); process.exit(2); }

  const report = { file: path.basename(f), blocked: [], mentioned: [], score: 0, jsonLd: [] };

  // 1) 红线：按行判断是「部署」还是「论述」
  const lines = text.split(/\r?\n/);
  let inFence = false;
  lines.forEach((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    const low = line.toLowerCase();
    for (const kw of RED_LINES) {
      if (!low.includes(kw.toLowerCase())) continue;
      if (inFence || OPERATIONAL.test(line)) report.blocked.push(kw);
      else if (!report.mentioned.includes(kw)) report.mentioned.push(kw);
    }
  });

  // 2) 勾选清单统计
  const checked = (text.match(/- \[[xX]\]/g) || []).length;
  const unchecked = (text.match(/- \[ \]/g) || []).length;
  report.checklist = { checked, unchecked, total: checked + unchecked };

  // 3) 正向信号评分（满分 100）
  let s = 0; const sig = {};
  sig.tldr = SIGNALS.hasTLDR.test(text);      if (sig.tldr) s += 15;
  sig.jsonld = SIGNALS.hasJsonLd.test(text);  if (sig.jsonld) s += 20;
  sig.heading = SIGNALS.hasHeading.test(text);if (sig.heading) s += 10;
  sig.list = SIGNALS.hasList.test(text);      if (sig.list) s += 10;
  sig.source = SIGNALS.hasSource.test(text);  if (sig.source) s += 20;
  sig.author = SIGNALS.hasAuthor.test(text);  if (sig.author) s += 10;
  sig.faq = SIGNALS.hasFaq.test(text);        if (sig.faq) s += 15;
  report.signals = sig; report.score = s;

  // 4) JSON-LD 抽取与解析
  const blocks = extractJsonLd(text);
  report.jsonLd = blocks.map((b, i) => {
    try { JSON.parse(b); return { i, ok: true }; }
    catch (e) { return { i, ok: false, err: e.message }; }
  });

  // 输出
  console.log('=== GEO/AEO 安全姿态校验报告 (v1.1) ===');
  console.log('文件:', report.file);
  console.log('红线·部署违规:', report.blocked.length ? report.blocked.join(', ') + ' ❌' : '无 ✅');
  console.log('红线·教育性提及:', report.mentioned.length ? report.mentioned.join(', ') + '（仅论述，非违规）' : '无');
  console.log('清单勾选:', `${report.checklist.checked}/${report.checklist.total}`);
  console.log('正向信号:', Object.entries(sig).filter(([,v])=>v).map(([k])=>k).join(', ') || '无');
  console.log('JSON-LD 块:', report.jsonLd.length, '| 有效:', report.jsonLd.filter(j=>j.ok).length, '| 失效:', report.jsonLd.filter(j=>!j.ok).length);
  console.log('GEO/AEO 评分:', report.score + '/100');

  const blocked = report.blocked.length > 0 || report.score < 60;
  console.log(blocked ? '判定: ❌ 不得发布（修正后重试）' : '判定: ✅ 可发布');
  process.exit(blocked ? 1 : 0);
}

main();
