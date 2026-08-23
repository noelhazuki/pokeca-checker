/**
 * pokemoncenter.js
 *
 * ポケモンセンター公式X（@pokemoncenterPR）のポケモンカード関連投稿を監視する。
 * 取得経路はJoshin・ふるいち・トレカピット・イオンと同じ「Cloudflare Worker経由のYahoo!リアルタイム検索」方式。
 * このファイルはDOMに一切触れない（ステータス表示・件数サマリー・一覧再描画はpokeca_cyusen.html側の
 * syncPokemonCenterUI()が担当する＝他サイトと同じ役割分担）。
 *
 * 固有仕様（このサイトだけ）：
 * ポケモンセンターオンライン公式サイトは通常fetchでの安定取得が難しいため、公式Xを検知元として使う。
 * このサイトは「詳細な応募期間・当選発表日などの完全自動取得」を目的にしない＝検知型案件。
 * 日程が本文から明確に読み取れる場合のみフィールドへ入れ、推測での補完は行わない。
 * statusは固定文言「抽選情報あり・詳細は公式で確認」とし、詳細確認は依頼者側の手動作業（公式サイト参照）に委ねる。
 *
 * 前提：以下は本体（pokeca_cyusen.html）のグローバル関数・変数をそのまま参照する。
 * このファイルでは再定義しない。
 * - extractCombinedText(el)         … テキストノード＋img alt結合
 * - matchProductsInText(text)       … 本文全体をPRODUCT_MASTERと照合（複数商品対応）
 * - syncSiteResults(siteId, cases)  … localStorageへの反映（新規追加／自動取得系フィールドのみ更新）
 * - nowISO()
 */

// ↓デプロイ済みWorkerの実URLに差し替えること（他サイトと同じサブドメイン liliana944 を使用）
const POKEMONCENTER_WORKER_URL = "https://pokeca-joshin-proxy.liliana944.workers.dev/pokemoncenter-search";

// id:検索のため基本的に本人のみだが、引用RT等の混入に備えた保険として維持（他サイトと同じ考え方）
const POKEMONCENTER_ACCOUNT_ID = "pokemoncenterPR";

// 案件検知時に固定で使うstatus文言（このサイトは日程完全取得を目的にしないため）
const POKEMONCENTER_STATUS_TEXT = "抽選情報あり・詳細は公式で確認";

/* ▼ 判定用キーワード辞書（識別子衝突防止のためPOKEMONCENTER_接頭辞で統一） */

// ポケカ判定の明確語（Yahoo側で既に「ポケモンカード」を検索条件にしているため基本は通るが、念のための再確認用）
const POKEMONCENTER_POKECA_WORDS = ['ポケモンカード', 'ポケカ', 'Pokémon Card', 'Pokemon Card'];

// 案件候補判定：抽選・予約など、商品購入に必要な公式告知に直結する語を含む投稿のみを案件候補とする
const POKEMONCENTER_CASE_KEYWORDS = [
  '抽選', '抽選販売', '抽選応募', '事前抽選',
  '予約', '予約受付', '予約販売', '応募'
];

// 単なる商品紹介・新商品画像公開・キャンペーン・イベント告知・店舗イベント・グッズ紹介など、
// 案件候補から明確に除外したい語（POKEMONCENTER_CASE_KEYWORDSに一致していても、これらが
// 強く示す「ただのお知らせ」は除外する）
const POKEMONCENTER_EXCLUDE_KEYWORDS = [
  'キャンペーン', 'イベント', '店舗イベント', 'グッズ', '周辺グッズ',
  '新商品', 'コラボ', 'ラインナップ',
  '好評発売中', '発売中です', '入荷しました', '入荷情報',
  '抽選結果', '結果を発表', '当選者発表',
];

/* ▲ 判定用キーワード辞書 */

/* ▼ Yahoo!リアルタイム検索HTML解析（他サイトと同じDOM構造：.Tweet_Tweet__系） */
// 投稿コンテナ：class名に"Tweet_Tweet__"を含む要素（本文=.Tweet_body__系、投稿者=.Tweet_authorName__/.Tweet_authorID__系、
// 時刻・permalink=.Tweet_time__内 a[href*='/status/']）。X.com直接構造（article[data-testid='tweet']）は対象にしない。
function extractPokemonCenterPostsFromDoc(doc) {
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

    // id:検索の保険：本人（pokemoncenterPR）以外の投稿（引用RT等）が混入していたら除外
    if (authorId !== POKEMONCENTER_ACCOUNT_ID) return;

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
      authorName: authorNameEl ? authorNameEl.textContent.trim() : 'ポケモンセンター公式',
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

/* ▼ 内容判定（2段階：ポケカ判定 → 案件候補判定。公式アカウントのため他TCG除外は行わない） */
function isPokemonCenterPokecaPost(text) {
  if (matchProductsInText(text).length > 0) return true;
  return POKEMONCENTER_POKECA_WORDS.some(k => text.includes(k));
}

function isPokemonCenterCaseCandidate(text) {
  const hasCaseWord = POKEMONCENTER_CASE_KEYWORDS.some(k => text.includes(k));
  if (!hasCaseWord) return false;
  const hasExcludeWord = POKEMONCENTER_EXCLUDE_KEYWORDS.some(k => text.includes(k));
  return !hasExcludeWord;
}
/* ▲ 内容判定 */

/* ▼ 案件種別（caseType）判定：抽選 > 予約 の優先順位で1つに決める */
function detectPokemonCenterCaseType(text) {
  if (text.includes('抽選')) return '抽選';
  if (text.includes('予約')) return '予約';
  return '抽選';
}
/* ▲ 案件種別判定 */

/* ▼ 商品未特定時の表示用フォールバックラベル（2026-08-23④追加。furuichi.jsと同じ考え方） */
function buildPokemonCenterUnresolvedLabel(text) {
  if (!text) return "商品名未特定の投稿";
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/[@＠]\S+/g, " ").trim();
  if (!t) return "商品名未特定の投稿";
  return t.length > 30 ? t.slice(0, 30) + "…" : t;
}
/* ▲ 商品未特定時の表示用フォールバックラベル */

/* ▼ 公式ニュースURL抽出（本文に完全な形で含まれている場合のみ採用。省略表記「…」で切れている場合は採用しない） */
// Yahoo!リアルタイム検索の表示上、本文中のURLは「pokemoncenter-online.com/news/?id=20260803」のように
// 完全表示されることもあれば、「pokemoncenter-online.com/news/?id=20260…」のように末尾が省略されることもある。
// 省略された不完全なURLをsourceUrlに採用すると壊れたリンクになるため、8桁の日付ID（YYYYMMDD）が
// 完全に取得できた場合のみ公式ニュースURLとして採用し、それ以外はX投稿URLへフォールバックする。
function extractPokemonCenterOfficialUrl(text) {
  const m = text.match(/pokemoncenter-online\.com\/news\/\?id=(\d{8})(?!\d)/);
  if (!m) return null;
  return `https://www.pokemoncenter-online.com/news/?id=${m[1]}`;
}
/* ▲ 公式ニュースURL抽出 */

/* ▼ 日程抽出（本文から明確に読み取れる場合のみ。推測での補完は行わない＝取れなければnullのまま） */
function extractPokemonCenterDates(text) {
  const dates = {
    applyStart: null,
    applyEnd: null,
    resultAnnounce: null,
  };

  const startMatch = text.match(/(?:応募期間|受付期間|抽選受付期間)[^\d]{0,10}(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (startMatch) {
    dates.applyStart = `${startMatch[1]}/${startMatch[2]}`;
  }

  const endMatch = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*(?:日)?[^\d]{0,10}(?:まで|締切|締め切り)/);
  if (endMatch) {
    dates.applyEnd = `${endMatch[1]}/${endMatch[2]}`;
  } else {
    const rangeEndMatch = text.match(/[〜～~]\s*(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
    if (rangeEndMatch) {
      dates.applyEnd = `${rangeEndMatch[1]}/${rangeEndMatch[2]}`;
    }
  }

  const resultMatch = text.match(/(?:当選発表|抽選結果)[^\d]{0,10}(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (resultMatch) {
    dates.resultAnnounce = `${resultMatch[1]}/${resultMatch[2]}`;
  }

  return dates;
}
/* ▲ 日程抽出 */

/* ▼ 案件統合（同一productId・caseTypeの候補を1件へまとめる） */
// 2026-08-23④：productIdがnull（商品未特定の要確認案件）の場合、素朴に"null__caseType"で
// キー化すると別商品の未特定投稿同士まで誤って1件に統合されてしまう。
// そのためproductId不明の場合はpostId単位でキーを分け、投稿ごとに個別の要確認案件として扱う。
function groupPokemonCenterCandidates(enrichedList) {
  const groups = new Map();

  enrichedList.forEach(item => {
    const key = item.productId ? (item.productId + '__' + item.caseType) : ('unresolved__' + item.postId);
    if (!groups.has(key)) {
      groups.set(key, {
        siteId: 'pokemoncenter',
        siteName: 'ポケモンセンターオンライン',
        productId: item.productId,
        productName: item.productName,
        imageUrl: item.imageUrl,
        caseType: item.caseType,
        // 2026-08-23④追加：商品マスタ一致の有無を明示するフラグ。未一致（要確認）の場合のみconfidenceを付与する。
        productResolved: !!item.productId,
        confidence: item.productId ? undefined : "needs_review",
        status: POKEMONCENTER_STATUS_TEXT,
        // 2026-08-23追加：本体側のsalePhase/entryMethod判定が原文から「再販」等を読み取れるよう保持する
        // （detectPokemonCenterCaseTypeは抽選/予約以外は"抽選"にフォールバックするため、原文が無いと再販を見逃す）。
        rawText: item.rawText || "",
        sourceUrl: item.sourceUrl,
        sourcePosts: [item.postId],
        applyStart: item.applyStart,
        applyEnd: item.applyEnd,
        resultAnnounce: item.resultAnnounce,
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
    // 公式ニュースURLが取れている投稿があれば、X投稿URLより優先して差し替える
    if (item.hasOfficialUrl && !g.hasOfficialUrl) {
      g.sourceUrl = item.sourceUrl;
      g.hasOfficialUrl = true;
    }
    ['applyStart', 'applyEnd', 'resultAnnounce'].forEach(f => {
      if (!g[f] && item[f]) g[f] = item[f];
    });
  });

  // 内部フラグは保存データに含めない
  return Array.from(groups.values()).map(({ hasOfficialUrl, ...rest }) => rest);
}
/* ▲ 案件統合 */

/* ▼ 重複判定（保存済みデータとの突き合わせ：siteId="pokemoncenter" かつ productId・caseType一致） */
// 判定順序（2026-08-23④修正、furuichi.js/tcgpit.js/aeon.jsと同じ考え方）：
// ①まず同一投稿由来（sourcePostsのpostIdが既存データと重複）かどうかをproductIdの有無に関わらず先に確認する。
//   ※pokemoncenterのsourcePostsもaeonと同じくpostId文字列の配列。
// ②postId一致が無い場合のみ、従来通りproductId・caseTypeの一致で判定する。
function checkPokemonCenterDuplicateAgainstSaved(candidate, savedList) {
  const pcSaved = savedList.filter(item => item.siteId === 'pokemoncenter');

  // 2026-08-23④修正：postId一致だけで即決めると、1投稿から複数商品が検出されるケースで
  // 同じpostIdを持つ別商品同士が誤って同一エントリとして統合されてしまう（他サイトと同じ問題）。
  // postId一致に加えて「productIdが一致する、またはどちらか一方がnull（要確認←→解決の昇格）」の場合のみ同一とみなす。
  const candidatePostIds = Array.isArray(candidate.sourcePosts) ? candidate.sourcePosts.filter(Boolean) : [];
  if (candidatePostIds.length > 0) {
    const sameSourcePost = pcSaved.find(item =>
      Array.isArray(item.sourcePosts) &&
      item.sourcePosts.some(id => candidatePostIds.includes(id)) &&
      (!item.productId || !candidate.productId || item.productId === candidate.productId)
    );
    if (sameSourcePost) return { entry: sameSourcePost };
  }

  if (!candidate.productId) return null;
  const entry = pcSaved.find(item =>
    item.productId === candidate.productId &&
    item.caseType === candidate.caseType
  );
  return entry ? { entry } : null;
}
/* ▲ 重複判定 */

/* ▼ 同期本体（DOMには触れない。呼び出し側=syncPokemonCenterUI()がステータス表示・一覧再描画を担当） */
async function syncPokemonCenterData() {
  console.log('[PokemonCenter Yahoo Sync] start');

  let data;
  try {
    const res = await fetch(POKEMONCENTER_WORKER_URL);
    data = await res.json();
    if (!res.ok && !data.ok) {
      throw new Error('取得に失敗しました（サーバー応答エラー）');
    }
  } catch (e) {
    console.warn('[PokemonCenter] 同期失敗:', e);
    return { error: e.message || String(e) };
  }

  let posts;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.html || '', 'text/html');
    posts = extractPokemonCenterPostsFromDoc(doc);
  } catch (e) {
    console.warn('[PokemonCenter] 抽出エラー:', e);
    return { error: e.message || String(e) };
  }

  console.log(`[PokemonCenter Parse] 本人投稿抽出=${posts.length}件`);

  // ① ポケカ判定
  const pokecaPosts = posts.filter(p => isPokemonCenterPokecaPost(p.rawText));
  const pokecaCount = pokecaPosts.length;

  // ② 案件候補判定（抽選・予約等の行動につながる投稿のみ。商品紹介・キャンペーン・イベント等は除外）
  const caseCandidates = [];
  let nonCaseExcludedCount = 0;
  pokecaPosts.forEach(p => {
    if (isPokemonCenterCaseCandidate(p.rawText)) {
      caseCandidates.push(p);
    } else {
      nonCaseExcludedCount++;
    }
  });

  // 商品マスタ照合＋公式ニュースURL抽出＋日程抽出＋caseType判定
  // 2026-08-23④：商品マスタ不一致でも案件自体は捨てない。caseCandidatesはこの時点で既に
  // isPokemonCenterPokecaPost（ポケカ根拠）とisPokemonCenterCaseCandidate（販売機会根拠）を通過済みのため、
  // 「商品未特定の要確認案件」として productId:null のまま enriched に含める。
  const enriched = [];
  let unmatchedCount = 0;
  let officialUrlCount = 0;
  caseCandidates.forEach(p => {
    const products = matchProductsInText(p.rawText);
    const officialUrl = extractPokemonCenterOfficialUrl(p.rawText);
    if (officialUrl) officialUrlCount++;
    const dates = extractPokemonCenterDates(p.rawText);
    const caseType = detectPokemonCenterCaseType(p.rawText);
    if (products.length === 0) {
      unmatchedCount++;
      enriched.push({
        postId: p.postId,
        sourceUrl: officialUrl || p.sourceUrl,
        hasOfficialUrl: !!officialUrl,
        rawText: p.rawText,
        productId: null,
        productName: buildPokemonCenterUnresolvedLabel(p.rawText),
        imageUrl: null,
        caseType,
        ...dates,
      });
      return;
    }
    products.forEach(prod => {
      enriched.push({
        postId: p.postId,
        sourceUrl: officialUrl || p.sourceUrl,
        hasOfficialUrl: !!officialUrl,
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
  const pokemonCenterCases = groupPokemonCenterCandidates(enriched);

  console.log(
    `[PokemonCenter Yahoo] 投稿${posts.length} / ポケカ${pokecaCount} / 対象外${nonCaseExcludedCount} / ` +
    `案件候補${caseCandidates.length} / 商品一致${matchedCount} / 商品未判定${unmatchedCount} / ` +
    `公式URL取得${officialUrlCount} / 案件${pokemonCenterCases.length}`
  );

  // ここで初めてlocalStorageへ反映。新規は追加、既存は自動取得系フィールドのみ更新。
  const { added, updated } = syncSiteResults('pokemoncenter', pokemonCenterCases);

  console.log('[PokemonCenter Yahoo Sync] complete');

  return {
    rawCount: posts.length,
    pokecaCount,
    nonCaseExcludedCount,
    caseCandidateCount: caseCandidates.length,
    matchedCount,
    unmatchedCount,
    officialUrlCount,
    caseCount: pokemonCenterCases.length,
    added,
    updated,
    error: null,
  };
}
/* ▲ 同期本体 */
