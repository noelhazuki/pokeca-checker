/* ============================================================
   joshin.js — Joshin専用処理（pokeca_cyusen.html より分離）

   このファイルは pokeca_cyusen.html の <script>...</script>（本体共通コード）より
   後に読み込むこと。以下の本体側の関数・変数を前提として参照する。
     PRODUCT_MASTER, matchProductsInText(), normalizeProductKey(),
     INCLUDE_KEYWORDS, EXCLUDE_KEYWORDS, matchesKeywordRule(),
     extractCombinedText(), nowISO(),
     loadSavedItems(), saveSavedItems(), savedItems,
     escapeHtml(), buildProductThumbHtml(),
     renderEntries(), renderUpcoming(), showToast()

   ロジック自体は分離前と無改変（コードの移動のみ）。
   ============================================================ */

/* ▼ Joshin候補抽出（Yahoo!リアルタイム検索経由）※pokeca-extractor.htmlより移植 */
const JOSHIN_CONFIG = {
  id: 'joshin',
  name: 'Joshin',
  storeKeywords: ['Joshin', 'ジョーシン'],
  requiredKeywords: []
};

function classifyReleaseType(text) {
  if (text.includes('再販') || text.includes('再販売')) return '再販';
  if (text.includes('新弾') || text.includes('新商品') || text.includes('発売')) return '新弾/新商品(推定)';
  return null;
}

/* ▼ アフィリエイト／SEOキーワード羅列投稿の除外判定（Joshin専用ノイズ対策） */
// Yahoo!リアルタイム検索経由の投稿には、店舗名・商品名・「抽選」「再販」等の語を
// 羅列しただけのアフィリエイト誘導投稿が混入することがある。これらはJoshinの実際の
// 抽選・予約・再販情報ではないため、Joshin候補として採用する前にここで除外する。
// 単語1つだけでは除外せず、複数の特徴が同時に成立した場合のみ除外する。
const AFFILIATE_OTHER_STORE_NAMES = [
  'Amazon', '楽天ブックス', 'ノジマ', 'イオン', 'ヨドバシ', 'ビックカメラ', 'ヤマダ', 'セブンネット'
];
const AFFILIATE_SEO_WORDS = [
  '定価', '再販', 'ポケカ', 'プロモ', '抽選', '予約', '30周年', '招待', '在庫', '入荷'
];

// 投稿冒頭または本文中に「PR」表記（広告表記）があるか。英数字に挟まれた"PR"は誤検知しやすいため
// 前後が英字でない場合のみPR表記とみなす。
function hasAffiliatePrMarker(text){
  return /(?:^|[^A-Za-z])PR(?:[^A-Za-z]|$)/.test(text || '');
}

// Amazonの商品リンク・短縮URLへの誘導があるか（プレーンな「Amazon」という単語だけでは該当しない）
function hasAffiliateProductLink(text){
  return /amazon\.co\.jp\/(?:dp|gp)\/|amzn\.to\/|amzn\.asia\/|a\.co\//i.test(text || '');
}

// Joshin以外の販売店名が何店舗分含まれているか（羅列されているほど疑わしい）
function countAffiliateOtherStoreNames(text){
  if(!text) return 0;
  return AFFILIATE_OTHER_STORE_NAMES.filter(name => text.includes(name)).length;
}

// SEOキーワード（定価・再販・ポケカ・プロモ・抽選・予約・30周年・招待・在庫・入荷）の出現回数
function countAffiliateSeoWords(text){
  if(!text) return 0;
  let count = 0;
  AFFILIATE_SEO_WORDS.forEach(w => {
    const m = text.match(new RegExp(w, 'g'));
    if(m) count += m.length;
  });
  return count;
}

// アフィリエイト／SEOキーワード羅列投稿かどうかを複合条件で判定する。
// 「PR」だけ、「Amazon」だけ、「再販」だけ、のような単一要素では除外しない。
// 強い特徴（PR表記／Amazon商品リンク／他店舗名3店舗以上）が2つ以上重なるか、
// 強い特徴が1つ以上あり、かつSEO語が3語以上出現する場合のみ除外する。
function isAffiliateSeoSpam(text){
  if(!text) return false;

  const hasPr = hasAffiliatePrMarker(text);
  const hasLink = hasAffiliateProductLink(text);
  const otherStoreCount = countAffiliateOtherStoreNames(text);
  const seoWordCount = countAffiliateSeoWords(text);

  let strongFeatureCount = 0;
  if(hasPr) strongFeatureCount++;
  if(hasLink) strongFeatureCount++;
  if(otherStoreCount >= 3) strongFeatureCount++;

  const seoSpamLevel = seoWordCount >= 3;

  return strongFeatureCount >= 2 || (strongFeatureCount >= 1 && seoSpamLevel);
}

// 除外件数・除外投稿本文（デバッグ確認用。console.log/console.tableから参照する。UI表示はしない）
let joshinAffiliateSpamCount = 0;
let joshinAffiliateSpamSamples = [];
/* ▲ アフィリエイト／SEOキーワード羅列投稿の除外判定 */

// yahoo-realtime（Joshin）: Yahoo!リアルタイム検索の検索結果HTML内のX投稿を検知
// Yahoo側のCSSクラス名は末尾ハッシュが変わる可能性があるため部分一致セレクタで拾う
// バッチ内dedup：postId取得済みの投稿は最初の1件のみ残す（postId未取得は誤って弾かないため対象外）
function extractYahooRealtime(doc, config) {
  const results = [];
  const seenPostIds = new Set();

  doc.querySelectorAll("[class*='Tweet_body__']").forEach(bodyEl => {
    const pEl = bodyEl.querySelector('p') || bodyEl;
    const rawText = extractCombinedText(pEl);
    if (!rawText) return;

    const storeKeywords = config.storeKeywords || [];
    const hasStore = storeKeywords.length === 0 || storeKeywords.some(k => rawText.includes(k));
    if (!hasStore) return;
    if (!matchesKeywordRule(rawText, config.requiredKeywords)) return;

    // アフィリエイト／SEOキーワード羅列投稿はここで除外し、商品マスタ照合・案件統合・
    // 未判定候補表示まで流さない。件数・本文はデバッグ用に保持するのみ。
    if (isAffiliateSeoSpam(rawText)) {
      joshinAffiliateSpamCount++;
      joshinAffiliateSpamSamples.push(rawText);
      return;
    }

    let container = bodyEl.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      if (container.querySelector("[class*='Tweet_time__']")) break;
      container = container.parentElement;
    }
    if (!container) container = bodyEl.parentElement || bodyEl;

    const authorNameEl = container.querySelector("[class*='Tweet_authorName__']");
    const authorIdEl = container.querySelector("[class*='Tweet_authorID__']");
    const authorName = authorNameEl ? authorNameEl.textContent.trim() : null;
    const authorId = authorIdEl ? authorIdEl.textContent.trim() : null;

    const timeContainer = container.querySelector("[class*='Tweet_time__']");
    const permalinkA = timeContainer ? timeContainer.querySelector("a[href*='/status/']") : null;
    let sourceUrl = null;
    let postId = null;
    if (permalinkA) {
      const href = permalinkA.getAttribute('href');
      sourceUrl = href.startsWith('http') ? href : 'https://x.com' + href;
      const m = sourceUrl.match(/status\/(\d+)/);
      if (m) postId = m[1];
    }
    if (!postId) {
      const twidMatch = (container.innerHTML || '').match(/twid[:="']+(\d+)/);
      if (twidMatch) postId = twidMatch[1];
    }

    // バッチ内dedup（postId基準）
    if (postId) {
      if (seenPostIds.has(postId)) return;
      seenPostIds.add(postId);
    }

    const postedAt = timeContainer ? timeContainer.textContent.trim() : null;

    results.push({
      siteId: config.id,
      siteName: config.name,
      status: '抽選候補（要公式確認）',
      productName: null,
      rawText: rawText,
      detectedAt: nowISO(),
      applyStart: null,
      applyEnd: null,
      resultAnnounce: null,
      releaseDate: null,
      releaseType: classifyReleaseType(rawText),
      sourceUrl: sourceUrl,
      postedAt: postedAt,
      postId: postId,
      authorName: authorName,
      authorId: authorId,
      viaYahoo: true
    });
  });

  return results;
}

// 2クエリ（英語表記/カタカナ表記）分の抽出結果をマージし、postId基準でバッチ間dedupする
function extractJoshinFromTwoQueries(htmlA, htmlB) {
  // 検索1回分ごとに、アフィリエイト／SEO除外のデバッグ集計をリセットする
  joshinAffiliateSpamCount = 0;
  joshinAffiliateSpamSamples = [];

  let merged = [];
  if (htmlA && htmlA.trim()) {
    const docA = new DOMParser().parseFromString(htmlA, 'text/html');
    merged = merged.concat(extractYahooRealtime(docA, JOSHIN_CONFIG));
  }
  if (htmlB && htmlB.trim()) {
    const docB = new DOMParser().parseFromString(htmlB, 'text/html');
    merged = merged.concat(extractYahooRealtime(docB, JOSHIN_CONFIG));
  }
  const seen = new Set();
  const deduped = [];
  merged.forEach(c => {
    if (c.postId) {
      if (seen.has(c.postId)) return;
      seen.add(c.postId);
    }
    deduped.push(c);
  });
  return deduped;
}

// 保存済みデータとの重複判定（pokeca-extractor.htmlより移植）
// Joshinは投稿ID優先、それ以外はsourceUrl+productName完全一致→siteId+productName近似の順
function checkDuplicateAgainstSaved(candidate, savedList) {
  if (candidate.siteId === 'joshin' && candidate.postId) {
    const exactById = savedList.find(s => s.siteId === 'joshin' && s.postId === candidate.postId);
    if (exactById) return { level: 'exact', message: '同一投稿（投稿ID一致）の既存データがあります' };
  }
  const exact = savedList.find(s =>
    s.sourceUrl && candidate.sourceUrl &&
    s.sourceUrl === candidate.sourceUrl &&
    s.productName === candidate.productName
  );
  if (exact) return { level: 'exact', message: '同一URL・商品名の既存データがあります' };

  const near = savedList.find(s =>
    s.siteId === candidate.siteId &&
    s.productName && candidate.productName &&
    s.productName === candidate.productName
  );
  if (near) return { level: 'warn', message: '同一サイト・同一商品名の既存データがあります（要確認）' };

  return null;
}
/* ▼ Joshin投稿→抽選案件 統合（同一案件のグループ化）※ここから新規追加。上記の投稿抽出・postIdバッチ内dedupは無改変 */

// ノイズ語（店舗名・キーワード・受付関連語）を除いて、商品名らしい部分を残すための除去リスト
const PRODUCT_NAME_NOISE_WORDS = [
  'Joshin', 'ジョーシン', 'ポケモンカードゲーム', 'ポケモンカード', 'ポケカ',
  'Pokémon Card', 'Pokemon Card',
  '抽選販売', '抽選', '予約販売', '予約', '再入荷', '再販',
  '受付開始', '受付中', '受付', 'Webショップ', 'web', 'ネット抽選', 'オンライン', '通販',
  '店舗', '店頭', 'あります', '入荷', '販売開始', '販売中', '販売', '実施中', '実施',
  '情報', '詳細', '公式', 'アプリ', '応募', '開始', '終了', '締切', '締め切り',
  '発表', '当選', '結果', 'ください', 'こちら', 'RT', 'いいね'
];

// 商品名候補①：投稿本文中の「」『』で囲まれた文字列（最も信頼度が高い）
function extractQuotedProductName(text){
  if(!text) return null;
  const m = text.match(/[「『]([^」』]{2,40})[」』]/);
  return m ? m[1].trim() : null;
}

// 商品名候補②：URL・メンション・ハッシュタグ・ノイズ語・記号を取り除き、
// 残った断片のうち最も長いものを商品名として採用する（囲み表記が無い投稿向けのフォールバック）
// ※「ー」（音引き）は「ストーム」等の商品名に必須の文字のため、記号除去の対象から外している
function looksLikeProductNameToken(token){
  if(!token || token.length < 2) return false;
  const katakanaCount = (token.match(/[ァ-ヶー]/g) || []).length;
  const hasAlnum = /[A-Za-z0-9]/.test(token);
  return katakanaCount >= 2 || hasAlnum;
}

function extractProductNameFallback(text){
  if(!text) return null;
  let t = text;
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[@＠]\S+/g, ' ');
  t = t.replace(/#\S+/g, ' ');
  PRODUCT_NAME_NOISE_WORDS.forEach(w => { t = t.split(w).join(' '); });
  // 記号除去（「ー」は音引きのため対象外）
  t = t.replace(/[【】\[\]「」『』!！?？,、。・…\-~〜:：;；／\/]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if(!t) return null;

  const tokens = t.split(' ')
    .map(tok => tok.replace(/^(で|にて|には|では|は|が|を|の|と|より|から)+/, ''))
    .map(tok => tok.replace(/(で|にて|には|では|は|が|を|の|と|より|から)+$/, ''))
    .filter(looksLikeProductNameToken);
  if(tokens.length === 0) return null;
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0];
}

function extractProductName(text){
  return extractQuotedProductName(text) || extractProductNameFallback(text);
}

// 種別：再販／抽選／予約。複数該当する場合は再販→抽選→予約の優先度で1つ採用する
// （再入荷・再販は「今すぐ動くべき情報」として最優先。抽選は締切のある応募系。予約はそれに次ぐ扱い）
function extractCaseType(text){
  if(!text) return null;
  if(/再販|再入荷/.test(text)) return '再販';
  if(/抽選/.test(text)) return '抽選';
  if(/予約/.test(text)) return '予約';
  return null;
}

// およその日付ラベル（構造化はせず、画面表示用の簡易な1行のみ）
// 優先度：本文中の絶対日付（M/D, M月D日）＞本文中の相対語（本日/今日/明日/昨日）＞Yahoo!側の投稿日時表記
function extractApproxDateLabel(text, postedAt){
  const t = text || '';
  const m = t.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if(m){
    const tail = t.slice(m.index, m.index + m[0].length + 4);
    const approx = /ごろ|頃/.test(tail);
    return `${m[1]}/${m[2]}${approx ? 'ごろ' : ''}`;
  }
  const relWords = ['本日', '今日', '明日', '明後日', '昨日'];
  for(const w of relWords){
    if(t.includes(w)) return w;
  }
  return postedAt || null;
}

// 商品マスタ未一致（productId===null）の投稿を「商品候補（商品名特定不能）」と
// 「ノイズ（雑談・体験談・当落報告など）」に分類する。
// 目的は、商品マスタで商品名までは特定できなくても「何らかの商品の抽選・予約・再販を
// 告知している投稿」だけを人間の確認対象として残すこと。商品名そのものの推測は行わない
// （AIによる商品名判定・fallback精度向上は今回のスコープ外）。
function classifyUnmatchedJoshinPost(candidate){
  const text = candidate.rawText || '';

  // 返信投稿（他ユーザーへのリプライ）は会話・雑談になりやすいためノイズ扱い
  if(/^返信先[:：]/.test(text.trim())) return 'noise';

  // 当落報告・体験談・感想・比較などの会話的表現は明確にノイズ
  const noisePatterns = [
    /当(たった|選(しました)?)/,
    /(落ちた|外れました|外れた)/,
    /当たり(やすい|にくい)/,
    /\d+年前/,
    /(笑|泣|涙)(\s*)$/,
    /ですよね/,
    /気がする/
  ];
  if(noisePatterns.some(re => re.test(text))) return 'noise';

  // 抽選・予約・再販の「告知」らしい定型表現が含まれていれば商品候補とする
  // （商品名は特定できないが、何かの商品について告知していると判断できる投稿）
  const announcePatterns = [
    /(抽選|予約)(の)?(受付|申込)?(が)?(開始|受付中|スタート)/,
    /再販(開始|中|情報)/,
    /「[^」]{1,30}」(にて|で).{0,10}「[^」]{1,30}」/ // 「店舗名」にて「商品名」のような定型告知パターン
  ];
  if(announcePatterns.some(re => re.test(text))) return 'product_candidate';

  return 'noise';
}

// 投稿1件に、案件統合用の商品ID・種別・およその日付を付与する。
// 重要：商品判定は本文全体マッチ（matchProductsInText）を優先する。
// guessedProductName（fallback推測の1候補）はデバッグ用としてのみ残し、商品判定には使わない。
// 1投稿に複数商品名が含まれる場合は、同じpostIdを持つ候補を商品数分に展開して返す（戻り値は配列）。
// 本文全体で一致する商品が0件の場合は、productId:null の候補を1件だけ返す（＝未判定は投稿単位で1件）。
function enrichCandidateForGrouping(c){
  const guessedProductName = extractProductName(c.rawText);
  const matchedProducts = matchProductsInText(c.rawText);
  const caseType = extractCaseType(c.rawText);
  const approxDate = extractApproxDateLabel(c.rawText, c.postedAt);

  if(matchedProducts.length === 0){
    return [{
      ...c,
      productId: null,
      productName: null,
      guessedProductName,
      caseType,
      approxDate
    }];
  }

  return matchedProducts.map(master => ({
    ...c,
    productId: master.id,
    productName: master.name,
    guessedProductName,
    caseType,
    approxDate
  }));
}

// 2投稿が同一の商品案件と判定できるか。
// 商品マスタ一致が前提（productIdが必須）。未一致の投稿はこの関数に渡さない運用のため、
// 文字列includes()によるフォールバック判定は行わない。
// 種別（抽選/予約/再販）が両方取得できていて食い違う場合は別案件として扱う。
function isSameJoshinCase(a, b){
  if(!a.productId || !b.productId) return false;
  if(a.productId !== b.productId) return false;
  if(a.caseType && b.caseType && a.caseType !== b.caseType) return false;
  return true;
}

// 種別に応じたステータスラベル
function statusLabelForCaseType(caseType){
  if(caseType === '再販') return '再販情報（候補）';
  if(caseType === '抽選') return '抽選受付中（候補）';
  if(caseType === '予約') return '予約受付中（候補）';
  return '販売情報（候補）';
}

// 投稿候補リスト（postId基準dedup済み）を商品案件単位にグループ化し、
// 通常の保存済みカードと同じフィールド構成のオブジェクトへ統合する。
// X投稿本文・投稿者・postId等は内部データ sourcePosts にのみ保持し、通常表示には出さない。
// enrichCandidateForGrouping済みの投稿リストを商品案件単位にグループ化する（グルーピング本体）
function groupEnrichedJoshinCandidates(enriched){
  const groups = [];

  enriched.forEach(c => {
    const target = groups.find(g => g.some(member => isSameJoshinCase(member, c)));
    if(target){
      target.push(c);
    } else {
      groups.push([c]);
    }
  });

  return groups.map(group => {
    const withType = group.find(g => g.caseType);
    const withDate = group.find(g => g.approxDate);
    const withUrl = group.find(g => g.sourceUrl);
    const caseType = withType ? withType.caseType : null;
    const productId = group[0].productId;
    // グループの全員がproductId一致前提なので、表示名・画像はマスタ側から確実に取得する
    const master = PRODUCT_MASTER.find(p => p.id === productId) || null;

    return {
      siteId: "joshin",
      siteName: "Joshin",
      status: statusLabelForCaseType(caseType),
      // 2026-08-23追加：caseTypeは「再販」優先で判定するため「再販抽選」等で「抽選」の情報が失われる。
      // 本体（pokeca_cyusen.html）側のsalePhase/entryMethod判定が原文から再判定できるよう、
      // グループ内投稿の原文をそのまま結合して保持する（caseType・statusの既存ロジックは変更しない）。
      rawText: group.map(g => g.rawText).filter(Boolean).join(" "),
      productId: productId,
      productName: master ? master.name : group[0].productName,
      imageUrl: master ? master.imageUrl : null,
      // 2026-08-23④追加：商品マスタ一致の有無を明示するフラグ。未一致（要確認）の場合のみconfidenceを付与する。
      productResolved: !!productId,
      confidence: productId ? undefined : "needs_review",
      caseType: caseType,
      approxDate: withDate ? withDate.approxDate : null,
      applyStart: null,
      applyEnd: null,
      resultAnnounce: null,
      releaseDate: null,

      sourceUrl: withUrl ? withUrl.sourceUrl : null,
      detectedAt: nowISO(),

      sourcePosts: group.map(g => ({
        postId: g.postId,
        authorName: g.authorName,
        authorId: g.authorId,
        sourceUrl: g.sourceUrl,
        rawText: g.rawText
      })),

      viaYahoo: true,
      requiresOfficialCheck: true
    };
  });
}

// rawCandidates（enrich前）を直接グループ化したい場合の従来互換ラッパー。
// 商品マスタに一致した投稿（productIdあり）だけを案件化する。未一致は含めない。
// rawCandidates（enrich前）を直接グループ化したい場合の従来互換ラッパー。
// 商品マスタに一致した投稿（productIdあり）に加え、2026-08-23④からは商品マスタ不一致でも
// classifyUnmatchedJoshinPostが'product_candidate'（＝ポケカの告知らしい投稿）と判定したものも
// 「商品未特定の要確認案件」として案件化対象に含める（'noise'判定のものは従来通り除外）。
function groupJoshinCandidates(rawCandidates){
  const enriched = rawCandidates.flatMap(enrichCandidateForGrouping);
  const matched = enriched.filter(e => e.productId);
  const unmatchedQualified = enriched
    .filter(e => !e.productId && classifyUnmatchedJoshinPost(e) === 'product_candidate')
    .map(e => ({
      ...e,
      // 商品名が特定できないため、fallback推測（guessedProductName）を表示用に採用する
      productName: e.guessedProductName || null
    }));
  return groupEnrichedJoshinCandidates(matched.concat(unmatchedQualified));
}

// 統合後（商品案件単位）の重複判定。
// 判定順序（2026-08-23④修正、furuichi.js等と同じ考え方）：
// ①まず同一投稿由来（sourcePostsのpostIdが既存データと重複）かどうかをproductIdの有無に関わらず先に確認する。
//   「商品未特定（要確認）で保存 → 後日products.json更新でproductId解決」のケースでも、
//   既存カード（同じid・appliedStatus等）を正しく更新できるようにするため
//   （旧実装はproductId有無で判定方法を完全に分けていたため、解決後に別の新規カードとして重複していた）。
// ②postId一致が無い場合のみ、従来通りproductId（またはproductName）＋caseTypeでの近似判定に進む。
// 戻り値の entry は「一致したsavedItems内のオブジェクト参照そのもの」。
function checkCaseDuplicateAgainstSaved(candidate, savedList){
  const joshinSaved = savedList.filter(s => s.siteId === "joshin");

  const candidatePostIds = (candidate.sourcePosts || []).map(p => (p && typeof p === "object") ? p.postId : p).filter(Boolean);
  if(candidatePostIds.length > 0){
    const sameSourcePost = joshinSaved.find(s =>
      Array.isArray(s.sourcePosts) &&
      s.sourcePosts.some(p => candidatePostIds.includes((p && typeof p === "object") ? p.postId : p)) &&
      (!s.productId || !candidate.productId || s.productId === candidate.productId)
    );
    if(sameSourcePost) return { level: "exact", message: "同一投稿由来の既存データがあります", entry: sameSourcePost };
  }

  if(!candidate.productId && !candidate.productName) return null;

  if(candidate.productId){
    const exact = joshinSaved.find(s => s.productId === candidate.productId && s.caseType === candidate.caseType);
    if(exact) return { level: "exact", message: "同一商品・同一種別の既存データがあります", entry: exact };
    const near = joshinSaved.find(s => s.productId === candidate.productId);
    if(near) return { level: "warn", message: "同一商品の既存データがあります（要確認）", entry: near };
    return null;
  }

  // 商品マスタ未一致の場合は、従来通り商品名の文字列一致で判定する
  const exact = joshinSaved.find(s =>
    s.productName === candidate.productName && s.caseType === candidate.caseType
  );
  if(exact) return { level: "exact", message: "同一商品・同一種別の既存データがあります", entry: exact };

  const near = joshinSaved.find(s => s.productName === candidate.productName);
  if(near) return { level: "warn", message: "同一商品名の既存データがあります（要確認）", entry: near };

  return null;
}
/* ▲ Joshin投稿→抽選案件 統合 */

/* ▲ Joshin候補抽出 */
