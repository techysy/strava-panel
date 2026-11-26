/* ============================================================================
 * model-catalog.js — 模型「厂商家族」识别与展示口径（设置→模型库 / 网关拉取弹层 /
 * 训练建议模型弹层 三处共用，避免各写一套截断规则）
 *
 * 口径对齐飞鸽（feige-fry-cards feige.py VENDOR_LOGO_RULES / _FAMILY_OFFICIAL）：
 *   命中厂商家族 → 厂商 logo + 官方模型名（deepseek-v4.1-flash → DeepSeek v4.1-flash）
 *   未命中       → 兜底通用图标（#i-spark）+ 原短名，绝不空着
 *
 * 为什么要单独一个文件：三处渲染原本各自 `m.short || modelShort(m.id)`，
 * 而 short 是网关/手写带进来的原始名（`cbai/deepseek-v4.1-flash` 的
 * `deepseek-v4.1-flash`），sub 行又没设成块级，于是糊成
 * `deepseek-v4.1-flashcbai · 1000k`。
 *
 * 为什么部分 logo 要垫深色底：openai / grok / kimi / moonshot / dots /
 * xiaomimimo / upstage 的官方 logo 是「白字形 + 透明底」，直接放在浅色主题的
 * var(--tertiary) 圆角块上等于隐形，渲染时给瓦片加 .is-ink（深色底）。
 * ==========================================================================*/

const ModelCatalog = (() => {
  const LOGO_BASE = '/static/vendor-logos/';

  // 白字形 logo：需深色瓦片底，否则浅色主题下看不见
  const INK_FILES = new Set([
    'openai.png', 'grok.png', 'kimi.png', 'moonshot.png',
    'dotsstudio.png', 'xiaomimimo.png', 'upstage.png',
  ]);

  // [命中词, logo 文件, 官方家族名]；顺序即优先级（gpt 先于 openai、glm 后于 zhipu…）
  const RULES = [
    ['deepseek', 'deepseek.png', 'DeepSeek'],
    ['qwen', 'qwen.png', 'Qwen'],
    ['zhipu', 'zhipu.png', 'Zhipu'],
    ['glm', 'zhipu.png', 'GLM'],
    ['zcode', 'zhipu.png', 'ZCode'],
    ['chatglm', 'zhipu.png', 'ChatGLM'],
    ['claude', 'claude.png', 'Claude'],
    ['anthropic', 'claude.png', 'Claude'],
    ['gemini', 'gemini.png', 'Gemini'],
    ['kimi', 'kimi.png', 'Kimi'],
    ['moonshot', 'moonshot.png', 'Moonshot'],
    ['minimax', 'minimax.png', 'MiniMax'],
    ['doubao', 'doubao.png', 'Doubao'],
    ['hunyuan', 'hunyuan.png', 'Hunyuan'],
    ['gpt', 'openai.png', 'GPT'],
    ['openai', 'openai.png', 'OpenAI'],
    ['step', 'stepfun.png', 'Step'],
    ['hy4', 'hunyuan.png', 'Hy4'],
    ['codebuddy', 'codebuddy.png', 'CodeBuddy'],
    ['grok', 'grok.png', 'Grok'],
    ['longcat', 'longcat.png', 'LongCat'],
    ['mimo', 'xiaomimimo.png', 'MiMo'],
    ['dots', 'dotsstudio.png', 'Dots'],
    ['muse', 'muse.png', 'Muse'],
    ['ling', 'ling.png', 'Ling'],
    ['upstage', 'upstage.png', 'Upstage'],
  ].map(([needle, file, official]) => ({ needle, file, official, ink: INK_FILES.has(file) }));

  // 网关 id 形如 provider/model；provider 段只用于分组兜底，不参与厂商识别
  function splitId(id) {
    const s = String(id || '').trim();
    const i = s.indexOf('/');
    return { provider: i > 0 ? s.slice(0, i) : '', base: i >= 0 ? s.slice(i + 1) : s };
  }

  function vendorOf(id) {
    /** 模型 id → 厂商家族规则项；未命中返回 null（调用方走兜底图标）。 */
    const lower = String(id || '').toLowerCase();
    if (!lower) return null;
    return RULES.find(r => lower.includes(r.needle)) || null;
  }

  function displayName(id, fallback) {
    /** 展示名：命中厂商 → 「官方名 + 版本尾巴」；未命中 → 原短名（绝不空着）。
     *  尾巴取自 provider 之后的部分，丢分隔符：deepseek-v4.1-flash → DeepSeek v4.1-flash。 */
    const { base } = splitId(id);
    const v = vendorOf(id);
    if (!v) return String(fallback || base || id || '');
    const idx = base.toLowerCase().indexOf(v.needle);
    if (idx < 0) return v.official;
    const tail = base.slice(idx + v.needle.length).replace(/^[-_\s]+/, '').trim();
    return (v.official + ' ' + tail).trim();
  }

  function groupLabel(id, defaultLabel) {
    /** 分组标题：命中厂商用官方名（cbai/bcn/cmc 这类网关代号不配当分组），
     *  否则退回 provider，再退回「默认」。 */
    const v = vendorOf(id);
    if (v) return v.official;
    const { provider } = splitId(id);
    return provider || String(defaultLabel || '');
  }

  function logoUrl(id) {
    const v = vendorOf(id);
    return v ? LOGO_BASE + v.file : '';
  }

  function iconHtml(id, tileClass) {
    /** 图标瓦片 HTML：命中厂商出 logo，未命中出 #i-spark 兜底（同一圆角块样式）。 */
    const v = vendorOf(id);
    // is-logo 让瓦片保持中性底（选中态也不跟着变绿）——彩色 logo 压在主色上会糊
    const cls = tileClass + (v ? ' is-logo' : '') + (v && v.ink ? ' is-ink' : '');
    const inner = v
      ? '<img class="vl-img" src="' + logoUrl(id) + '" alt="" loading="lazy">'
      : '<svg class="ic" aria-hidden="true"><use href="#i-spark"/></svg>';
    return '<span class="' + cls + '">' + inner + '</span>';
  }

  function contextText(ctx) {
    const n = Number(ctx) || 0;
    return n ? Math.round(n / 1000) + 'k' : '';
  }

  function subText(id, ctx) {
    /** 副行：网关代号 · 上下文。名字里已是官方厂商名，这里只交代「哪个网关的」——
     *  cbai/deepseek-v4.1-flash 与 bcn/deepseek-v4.1-flash 展示名相同，靠它区分。
     *  （v3.0.0 的糊法是把 provider 直接拼在名字后面成 `…flashcbai · 1000k`。） */
    const { provider } = splitId(id);
    return [provider, contextText(ctx)].filter(Boolean).join(' · ');
  }

  function providerHint(id, defaultLabel) {
    /** 弹层条目里的网关代号：分组标题已经是它时不再重复（combo 组里每行再写 combo 是噪音）。 */
    const { provider } = splitId(id);
    if (!provider) return '';
    return provider === groupLabel(id, defaultLabel) ? '' : provider;
  }

  function groupBy(list, getId, defaultLabel) {
    /** 按厂商分组：保持「厂商名首次出现」的顺序，同组内按 id 字典序，
     *  这样网关列表不会因为 provider 字母序把一家人拆散。 */
    const map = new Map();
    for (const item of (list || [])) {
      const key = groupLabel(getId(item), defaultLabel);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => String(getId(a)).localeCompare(String(getId(b))));
    }
    return [...map.entries()];
  }

  return { LOGO_BASE, RULES, INK_FILES, splitId, vendorOf, displayName, groupLabel,
           logoUrl, iconHtml, contextText, subText, providerHint, groupBy };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ModelCatalog;