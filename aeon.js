/**
 * aeon.js
 *
 * イオン西日本 公式X（@AEONnishinihon）のポケモンカード関連投稿を監視する。
 * 取得経路はJoshin・ふるいち・トレカピットと同じ「Cloudflare Worker経由のYahoo!リアルタイム検索」方式。
 * このファイルはDOMに一切触れない（ステータス表示・件数サマリー・一覧再描画はpokeca_cyusen.html側の
 * syncAeonUI()が担当する＝furuichi.js/tcgpit.jsと同じ役割分担）。
 *
 * 前提：以下は本体（pokeca_cyusen.html）のグローバル関数・変数をそのまま参照する。
 * このファイルでは再定義しない。
 * - extractCombinedText(el)         … テキストノード＋img alt結合
 * - matchProductsInText(text)       … 本文全体をPRODUCT_MASTERと照合（複数商品対応）
 * - syncSiteResults(siteId, cases)  … localStorageへの反映（新規追加／自動取得系フィールドのみ更新）
 * - nowISO()
 */

// ↓デプロイ済みWorkerの実URLに差し替えること（Joshin・ふるいちと同じサブドメイン liliana944 を使用）
const AEON_WORKER_URL = "https://pokeca-joshin-proxy.liliana944.workers.dev/aeon-search";

// id:検索のため基本的に本人のみだが、引用RT等の混入に備えた保険として維持（ふるいち・トレカピットと同じ考え方）
const AEON_ACCOUNT_ID = "AEONnishinihon";

/* ▼ 判定用キーワード辞書（識別子衝突防止のためAEON_接頭辞で統一） */

// 他TCGが明確な投稿は除外（全サイト共通の考え方を踏襲）
const AEON_OTHER_TCG_KEYWORDS = [
  'ワンピースカード', 'ワンピース', 'ワンピ',
  'デュエルマスターズ', 'デュエマ',
  '遊戯王',
  'ガンダム',
  'MTG', 'マジックザギャザリング',
  'ヴァイスシュヴァルツ', 'ヴァイス'
];

// ポケカ判定の明確語（Yahoo側で既に「ポケモンカード」を検索条件にしているため基本は通るが、念のための再確認用）
const AEON_POKECA_WORDS = ['ポケモンカード', 'ポケカ', 'Pokémon Card', 'Pokemon Card'];

// 案件候補判定：応募・予約・購入行動に直接つながる語を含む投稿のみを案件候補とする
const AEON_CASE_KEYWORDS = [
  '抽選', '抽選販売', '予約', '予約受付', '予約販売',
  '受付', '受付開始', '応募', '再販', '販売'
];

// 単なる紹介・キャンペーン・大会・発売済み商品の一般的な宣伝など、案件候補から明確に除外したい語
// （AEON_CASE_KEYWORDSに一つでも一致していても、これらが強く示す「過去の報告」「通常営業案内」は除外する）
const AEON_EXCLUDE_KEYWORDS = [
  '買取', '値下げ', '値引き', 'セール', '休業', '営業時間',
  'くじ', 'オリパ',
  'ジムバトル', 'ピットナイト', '優勝',
  '抽選結果', '結果を発表', '当選者発表', '抽選会を実施しました',
  '好評発売中', '発売中です', '入荷しました', '入荷情報',
];

/* ▲ 判定用キーワード辞書 */

/* ▼ Yahoo!リアルタイム検索HTML解析（Joshin・ふるいち・トレカピットと同じDOM構造：.Tweet_Tweet__系） */
// 投稿コンテナ：class名に"Tweet_Tweet__"を含む要素（本文=.Tweet_body__系、投稿者=.Tweet_authorName__/.Tweet_authorID__系、
// 時刻・permalink=.Tweet_time__内 a[href*='/status/']）。X.com直接構造（article[data-testid='tweet']）は対象にしない。
function extractAeonPostsFromDoc(doc) {
  const posts = [];
  const containers = doc.querySelectorAll('[class*="Tweet_Tweet__"]');

  containers.forEach(container => {
    const bodyEl = container.querySelector('[class*="Tweet_body__"]');
    if (!bodyEl) return;

    const authorIdEl = container.querySelector('[class*="Tweet_authorID__"]');
    const authorNameEl = container.querySelector('[class*="Tweet_authorName__"]');
    const timeLinkEl = container.querySelector('[class*="Tweet_time__"] a[href*="/status/"]');

    const authorIdRaw = authorIdEl ? authorIdEl.textContent.trim() : '';
    const authorId = authorIdRaw.replace(/^@/, '');

    // id:検索の保険：本人（AEONnishinihon）以外の投稿（引用RT等）が混入していたら除外
    if (authorId !== AEON_ACCOUNT_ID) return;

    const sourceUrl = timeLinkEl ? timeLinkEl.getAttribute('href') : null;
    const postIdMatch = sourceUrl ? sourceUrl.match(/status\/(\d+)/) : null;
    const postId = postIdMatch ? postIdMatch[1] : null;
    if (!postId) return;

    const text = extractCombinedText(bodyEl);
    if (!text) return;

    posts.push({
      postId,
      rawText: text,
      sourceUrl: sourceUrl ? (sourceUrl.startsWith('http') ? sourceUrl : 'https://twitter.com' + sourceUrl) : null,
      authorId,
      authorName: authorNameEl ? authorNameEl.textContent.trim() : 'イオン西日本',
    });
  });

  // 同一postIdは検索結果内で重複排除
  const seen = new Set();
  const deduped = [];
  posts.forEach(p => {
    if (seen.has(p.postId)) return;
    seen.add(p.postId);
    deduped.push(p);
  });

  return deduped;
}
/* ▲ Yahoo!リアルタイム検索HTML解析 */

/* ▼ 内容判定（3段階：他TCG除外 → ポケカ判定 → 案件候補判定） */
function isAeonOtherTcgPost(text) {
  return AEON_OTHER_TCG_KEYWORDS.some(k => text.includes(k));
}

function isAeonPokecaPost(text) {
  if (matchProductsInText(text).length > 0) return true;
  return AEON_POKECA_WORDS.some(k => text.includes(k));
}

function isAeonCaseCandidate(text) {
  const hasCaseWord = AEON_CASE_KEYWORDS.some(k => text.includes(k));
  if (!hasCaseWord) return false;
  const hasExcludeWord = AEON_EXCLUDE_KEYWORDS.some(k => text.includes(k));
  return !hasExcludeWord;
}
/* ▲ 内容判定 */

/* ▼ 案件種別（caseType）判定：抽選 > 予約 > 再販 > 販売 の優先順位で1つに決める */
function detectAeonCaseType(text) {
  if (text.includes('抽選')) return '抽選';
  if (text.includes('予約')) return '予約';
  if (text.includes('再販')) return '再販';
  return '販売';
}
/* ▲ 案件種別判定 */

/* ▼ 商品未特定時の表示用フォールバックラベル（2026-08-23④追加。furuichi.jsと同じ考え方） */
function buildAeonUnresolvedLabel(text) {
  if (!text) return "商品名未特定の投稿";
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/[@＠]\S+/g, " ").trim();
  if (!t) return "商品名未特定の投稿";
  return t.length > 30 ? t.slice(0, 30) + "…" : t;
}
/* ▲ 商品未特定時の表示用フォールバックラベル */

/* ▼ 日程抽出（本文から明確に読み取れる場合のみ。曖昧な日時は無理に構造化せずnullのまま） */
function extractAeonDates(text) {
  const dates = {
    applyStart: null,
    applyEnd: null,
    resultAnnounce: null,
    releaseDate: null,
  };

  // 応募期間・抽選受付期間の開始（例：「応募期間 8/22〜」「受付期間8/22から」）
  const startMatch = text.match(/(?:応募期間|受付期間|抽選受付期間)[^\d]{0,10}(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (startMatch) {
    dates.applyStart = `${startMatch[1]}/${startMatch[2]}`;
  }

  // 締切・応募期限（例：「〜8/24まで」「8/24締切」「8/24(日)23:59まで」）
  const endMatch = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*(?:日)?[^\d]{0,10}(?:まで|締切|締め切り)/);
  if (endMatch) {
    dates.applyEnd = `${endMatch[1]}/${endMatch[2]}`;
  } else {
    // 「まで」等の明言がなくても、「開始日〜終了日」の範囲表記（例：「8月19日〜8月20日」）は
    // 〜/～の直後の日付を終了日として扱う（イオンの投稿で頻出するパターン）
    const rangeEndMatch = text.match(/[〜～~]\s*(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
    if (rangeEndMatch) {
      dates.applyEnd = `${rangeEndMatch[1]}/${rangeEndMatch[2]}`;
    }
  }

  // 当選発表（例：「当選発表は8/26」「抽選結果は8/26頃発表」）
  const resultMatch = text.match(/(?:当選発表|抽選結果)[^\d]{0,10}(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (resultMatch) {
    dates.resultAnnounce = `${resultMatch[1]}/${resultMatch[2]}`;
  }

  // 発売日（例：「8/29発売」「8/29(金)発売予定」）
  const releaseMatch = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*(?:日)?[^\d]{0,6}発売/);
  if (releaseMatch) {
    dates.releaseDate = `${releaseMatch[1]}/${releaseMatch[2]}`;
  }

  return dates;
}
/* ▲ 日程抽出 */

/* ▼ 案件統合（同一productId・caseTypeの候補を1件へまとめる） */
// 2026-08-23④：productIdがnull（商品未特定の要確認案件）の場合、素朴に"null__caseType"で
// キー化すると別商品の未特定投稿同士まで誤って1件に統合されてしまう。
// そのためproductId不明の場合はpostId単位でキーを分け、投稿ごとに個別の要確認案件として扱う。
function groupAeonCandidates(enrichedList) {
  const groups = new Map();

  enrichedList.forEach(item => {
    const key = item.productId ? (item.productId + '__' + item.caseType) : ('unresolved__' + item.postId);
    if (!groups.has(key)) {
      groups.set(key, {
        siteId: 'aeon',
        siteName: 'イオン西日本',
        productId: item.productId,
        productName: item.productName,
        imageUrl: item.imageUrl,
        // 2026-08-23④追加：商品マスタ一致の有無を明示するフラグ。未一致（要確認）の場合のみconfidenceを付与する。
        productResolved: !!item.productId,
        confidence: item.productId ? undefined : "needs_review",
        caseType: item.caseType,
        // 2026-08-23追加：detectAeonCaseTypeは「抽選」優先で判定するため「再販抽選」で「再販」の情報が失われる。
        // 本体側のsalePhase/entryMethod判定が原文から再判定できるよう保持する。
        rawText: item.rawText || "",
        sourceUrl: item.sourceUrl,
        sourcePosts: [item.postId],
        applyStart: item.applyStart,
        applyEnd: item.applyEnd,
        resultAnnounce: item.resultAnnounce,
        releaseDate: item.releaseDate,
        viaYahoo: true,
        requiresOfficialCheck: true,
        detectedAt: nowISO(),
      });
      return;
    }

    const g = groups.get(key);
    if (!g.sourcePosts.includes(item.postId)) g.sourcePosts.push(item.postId);
    if (item.rawText && !g.rawText.includes(item.rawText)) {
      g.rawText = (g.rawText ? g.rawText + " " : "") + item.rawText;
    }
    // 日程は「まだ空いているフィールドがあれば埋める」方式（既存値は上書きしない）
    ['applyStart', 'applyEnd', 'resultAnnounce', 'releaseDate'].forEach(f => {
      if (!g[f] && item[f]) g[f] = item[f];
    });
  });

  return Array.from(groups.values());
}
/* ▲ 案件統合 */

/* ▼ 重複判定（保存済みデータとの突き合わせ：siteId="aeon" かつ productId・caseType一致） */
// 判定順序（2026-08-23④修正、furuichi.js/tcgpit.jsと同じ考え方）：
// ①まず同一投稿由来（sourcePostsのpostIdが既存データと重複）かどうかをproductIdの有無に関わらず先に確認する。
//   「商品未特定（要確認）で保存 → 後日products.json更新でproductId解決」のケースでも、
//   既存カード（同じid・appliedStatus等）を正しく更新できるようにするため。
//   ※aeonのsourcePostsはpostId文字列の配列（オブジェクト配列ではない）。
// ②postId一致が無い場合のみ、従来通りproductId・caseTypeの一致で判定する。
function checkAeonDuplicateAgainstSaved(candidate, savedList) {
  const aeonSaved = savedList.filter(item => item.siteId === 'aeon');

  // 2026-08-23④修正：postId一致だけで即決めると、1投稿から複数商品が検出されるケースで
  // 同じpostIdを持つ別商品同士が誤って同一エントリとして統合されてしまう（furuichi.js等と同じ問題）。
  // postId一致に加えて「productIdが一致する、またはどちらか一方がnull（要確認←→解決の昇格）」の場合のみ同一とみなす。
  const candidatePostIds = Array.isArray(candidate.sourcePosts) ? candidate.sourcePosts.filter(Boolean) : [];
  if (candidatePostIds.length > 0) {
    const sameSourcePost = aeonSaved.find(item =>
      Array.isArray(item.sourcePosts) &&
      item.sourcePosts.some(id => candidatePostIds.includes(id)) &&
      (!item.productId || !candidate.productId || item.productId === candidate.productId)
    );
    if (sameSourcePost) return { entry: sameSourcePost };
  }

  if (!candidate.productId) return null;
  const entry = aeonSaved.find(item =>
    item.productId === candidate.productId &&
    item.caseType === candidate.caseType
  );
  return entry ? { entry } : null;
}
/* ▲ 重複判定 */

/* ▼ 同期本体（DOMには触れない。呼び出し側=syncAeonUI()がステータス表示・一覧再描画を担当） */
async function syncAeonData() {
  console.log('[Aeon Yahoo Sync] start');

  let data;
  try {
    const res = await fetch(AEON_WORKER_URL);
    data = await res.json();
    if (!res.ok && !data.ok) {
      throw new Error('取得に失敗しました（サーバー応答エラー）');
    }
  } catch (e) {
    console.warn('[Aeon] 同期失敗:', e);
    return { error: e.message || String(e) };
  }

  let posts;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.html || '', 'text/html');
    posts = extractAeonPostsFromDoc(doc);
  } catch (e) {
    console.warn('[Aeon] 抽出エラー:', e);
    return { error: e.message || String(e) };
  }

  console.log(`[Aeon Parse] 本人投稿抽出=${posts.length}件`);

  // ① 他TCG除外
  const afterTcgFilter = [];
  let otherTcgExcludedCount = 0;
  posts.forEach(p => {
    if (isAeonOtherTcgPost(p.rawText)) {
      otherTcgExcludedCount++;
    } else {
      afterTcgFilter.push(p);
    }
  });

  // ② ポケカ判定
  const pokecaPosts = afterTcgFilter.filter(p => isAeonPokecaPost(p.rawText));
  const pokecaCount = pokecaPosts.length;

  // ③ 案件候補判定（抽選・予約・再販・販売等の行動につながる投稿のみ）
  const caseCandidates = [];
  let nonCaseExcludedCount = 0;
  pokecaPosts.forEach(p => {
    if (isAeonCaseCandidate(p.rawText)) {
      caseCandidates.push(p);
    } else {
      nonCaseExcludedCount++;
    }
  });

  // 商品マスタ照合（1投稿から複数商品を検出できるためflatMapで展開）＋日程抽出＋caseType判定
  // 2026-08-23④：商品マスタ不一致でも案件自体は捨てない。caseCandidatesはこの時点で既に
  // isAeonPokecaPost（ポケカ根拠）とisAeonCaseCandidate（販売機会根拠）を通過済みのため、
  // 「商品未特定の要確認案件」として productId:null のまま enriched に含める。
  const enriched = [];
  let unmatchedCount = 0;
  caseCandidates.forEach(p => {
    const products = matchProductsInText(p.rawText);
    const dates = extractAeonDates(p.rawText);
    const caseType = detectAeonCaseType(p.rawText);
    if (products.length === 0) {
      unmatchedCount++;
      enriched.push({
        postId: p.postId,
        sourceUrl: p.sourceUrl,
        rawText: p.rawText,
        productId: null,
        productName: buildAeonUnresolvedLabel(p.rawText),
        imageUrl: null,
        caseType,
        ...dates,
      });
      return;
    }
    products.forEach(prod => {
      enriched.push({
        postId: p.postId,
        sourceUrl: p.sourceUrl,
        rawText: p.rawText, // 2026-08-23追加：本体側のsalePhase/entryMethod判定用に原文を保持
        productId: prod.id,
        productName: prod.name,
        imageUrl: prod.imageUrl || null,
        caseType,
        ...dates,
      });
    });
  });

  const matchedCount = enriched.filter(e => e.productId).length;
  const aeonCases = groupAeonCandidates(enriched);

  console.log(
    `[Aeon Yahoo] 投稿${posts.length} / 他TCG除外${otherTcgExcludedCount} / ポケカ${pokecaCount} / ` +
    `対象外(非案件)${nonCaseExcludedCount} / 対象案件候補${caseCandidates.length} / ` +
    `商品一致${matchedCount} / 商品未判定${unmatchedCount} / 案件${aeonCases.length}`
  );

  // ここで初めてlocalStorageへ反映。新規は追加、既存は自動取得系フィールドのみ更新。
  const { added, updated } = syncSiteResults('aeon', aeonCases);

  console.log('[Aeon Yahoo Sync] complete');

  return {
    rawCount: posts.length,
    otherTcgExcludedCount,
    pokecaCount,
    nonCaseExcludedCount,
    caseCandidateCount: caseCandidates.length,
    matchedCount,
    unmatchedCount,
    caseCount: aeonCases.length,
    added,
    updated,
    error: null,
  };
}
/* ▲ 同期本体 */
