/* ==========================================================================
   tcgpit.js
   トレカピット上越（X: @tcgpit_joetsu）の抽選・BOX案件監視・専用処理

   前提：本体（pokeca_cyusen.html）側で先に読み込まれている共通処理を利用する。
   - extractCombinedText(el)   … テキストノード＋img altを結合して本文復元（絵文字数字対応）
   - PRODUCT_MASTER / matchProductsInText(text) … 全サイト共通の商品マスタ照合（本文全体走査・複数商品対応）
   - nowISO() … ISO日時取得
   - syncSiteResults(siteId, candidates) … localStorageへの共通同期（新規追加／自動取得系フィールドのみ更新）
   - findDuplicateEntryForSite(siteId, candidate, savedList) … サイトごとの重複判定の入口
     （本ファイルのcheckTcgpitDuplicateAgainstSavedを、本体側でsiteId==="tcgpit"の分岐に追加して使う）

   取得経路：Yahoo!リアルタイム検索
   「id:tcgpit_joetsu ポケモン ポケカ -大会 -バトル -高額 -ピットナイト -オリパ -優勝」
   検索式自体はWorker側（/tcgpit-search）に持たせ、ここでは変更しない（依頼書の指示どおり）。
   Joshin・ふるいちと同じくYahoo!リアルタイム検索結果HTML（Tweet_系クラス構造）を解析する。

   本ファイルが持つのはトレカピット固有のロジックのみ：
   - Yahoo!リアルタイム検索結果HTMLの解析（@tcgpit_joetsu投稿の抽出）
   - ポケカ案件判定（他TCG除外）
   - 通常の少量パック販売の除外（最重要。BOX単位の情報は対象に残す）
   - 販売・応募に関係する「対象案件」かどうかの判定
   - 案件種別判定（抽選／予約／再販／BOX販売 等）
   - 日程抽出（applyStart / applyEnd / releaseDate / resultAnnounce）
   - 案件統合・重複判定用データ生成
   ========================================================================== */

/* ▼ トレカピット固有設定 */
const TCGPIT_CONFIG = {
  siteId: "tcgpit",
  siteName: "トレカピット上越",
  targetAuthorId: "tcgpit_joetsu" // @は付けずに比較する（投稿者ID側の表記揺れ対策）
};

// id:検索のため基本的に本人のみだが、引用RT等の混入に備えた保険として著者ID再確認する。
function isTcgpitOfficialPost(authorId) {
  if (!authorId) return false;
  return authorId.replace(/^@/, "") === TCGPIT_CONFIG.targetAuthorId;
}
/* ▲ トレカピット固有設定 */

/* ▼ 内容判定（他TCG除外・ポケカ判定） */
// 検索式側で大会・バトル等はある程度除外済みだが、ここでも安全側の二重チェックとして持っておく。
const TCGPIT_OTHER_TCG_KEYWORDS = [
  "ワンピースカード", "ワンピース", "デュエマ", "デュエル・マスターズ",
  "遊戯王", "ガンダム", "MTG", "マジック:ザ・ギャザリング",
  "ヴァイスシュヴァルツ", "ヴァイス"
];
function isTcgpitOtherTcgText(text) {
  return TCGPIT_OTHER_TCG_KEYWORDS.some(k => text.includes(k));
}

// Yahoo検索式の「-大会 -バトル -高額 -ピットナイト -オリパ -優勝」を取りこぼした場合の保険。
// 検索式自体は変更せず、抽出後の安全側フィルタとしてのみ機能させる。
const TCGPIT_NEGATIVE_SAFETY_KEYWORDS = ["大会", "バトル", "高額", "ピットナイト", "オリパ", "優勝"];
function tcgpitHasNegativeSafetyWord(text) {
  return TCGPIT_NEGATIVE_SAFETY_KEYWORDS.some(k => text.includes(k));
}

const TCGPIT_POKECA_WORDS = ["ポケモンカード", "ポケカ"];
function tcgpitHasExplicitPokecaWord(text) {
  return TCGPIT_POKECA_WORDS.some(k => text.includes(k));
}

// 優先順位：①他TCGが明確 → 除外／②商品マスタに一致 → 採用／③「ポケモンカード」「ポケカ」語がある → 採用
function isTcgpitPokecaCandidateText(text, matchedProducts) {
  if (isTcgpitOtherTcgText(text)) return false;
  if (matchedProducts.length > 0) return true;
  if (tcgpitHasExplicitPokecaWord(text)) return true;
  return false;
}
/* ▲ 内容判定（他TCG除外・ポケカ判定） */

/* ▼ 通常パック販売の除外（最重要） */
// 「お一人様5パックまで」「1人10パックまで」「パック販売開始」「バラ売り」等は
// BOXをバラした通常店頭販売であり、案件化しない。
// ただしBOX単位の情報（BOX抽選／BOX予約／BOX販売／BOX再販／1BOXまで／シュリンク付きBOX販売）は対象に残す。
const TCGPIT_PACK_LIMIT_PATTERN =
  /(お一人|おひとり|１人|1人|一人)[^。\n]{0,14}?[0-9０-９一二三四五六七八九十]+\s*パック|[0-9０-９]+\s*パック\s*(まで|限り)|パック販売開始|バラ売り|バラ販売/;

function tcgpitHasBoxCaseSignal(text) {
  return (
    /BOX\s*(抽選|予約|販売|再販)/i.test(text) ||
    /[0-9０-９]*\s*1?\s*BOX\s*(まで|限り)/i.test(text) ||
    /シュリンク付きBOX/.test(text) ||
    /BOX\s*入荷/i.test(text)
  );
}

// 通常パック販売として除外すべきテキストかどうか（BOX関連の言及があれば除外しない＝案件候補として残す）
function isNormalPackSaleOnlyText(text) {
  if (!TCGPIT_PACK_LIMIT_PATTERN.test(text)) return false;
  return !tcgpitHasBoxCaseSignal(text);
}
/* ▲ 通常パック販売の除外 */

/* ▼ 対象案件判定・案件種別判定 */
// 抽選結果の告知（過去形の報告）は「これから行動が必要な案件」ではないため対象外にする
// （既存Joshinの「抽選結果」「結果を発表」除外方針を踏襲）。
const TCGPIT_RESULT_ANNOUNCE_KEYWORDS = ["抽選結果", "結果を発表", "当選発表", "落選"];
function isTcgpitResultAnnouncementText(text) {
  return TCGPIT_RESULT_ANNOUNCE_KEYWORDS.some(k => text.includes(k));
}

// 単に「販売」「入荷」とだけ書いてある投稿は対象外。事前行動が必要な語のみ対象案件候補とする。
const TCGPIT_CASE_KEYWORDS = [
  "抽選", "抽選販売", "予約", "予約販売", "受付開始",
  "応募", "再販", "BOX販売"
];
function isTcgpitTargetCaseText(text) {
  if (isTcgpitResultAnnouncementText(text)) return false;
  if (tcgpitHasBoxCaseSignal(text)) return true; // BOX単位の情報は対象（BOX入荷後の販売告知等）
  return TCGPIT_CASE_KEYWORDS.some(k => text.includes(k));
}

// 案件種別（caseType）：BOX関連を優先判定し、それ以外は語のヒット順で決める。
function detectTcgpitCaseType(text) {
  if (tcgpitHasBoxCaseSignal(text)) {
    if (/再販/.test(text)) return "BOX再販";
    if (/予約/.test(text)) return "BOX予約";
    if (/抽選/.test(text)) return "BOX抽選";
    return "BOX販売";
  }
  if (/抽選/.test(text)) return "抽選";
  if (/予約/.test(text)) return "予約";
  if (/再販/.test(text)) return "再販";
  return "販売";
}
/* ▲ 対象案件判定・案件種別判定 */

/* ▼ 商品未特定時の表示用フォールバックラベル（2026-08-23④追加。furuichi.jsと同じ考え方） */
function buildTcgpitUnresolvedLabel(text) {
  if (!text) return "商品名未特定の投稿";
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/[@＠]\S+/g, " ").trim();
  if (!t) return "商品名未特定の投稿";
  return t.length > 30 ? t.slice(0, 30) + "…" : t;
}
/* ▲ 商品未特定時の表示用フォールバックラベル */

/* ▼ 日程抽出（明確に読み取れる形式のみ。曖昧な日付は無理に構造化しない） */
// 例：「8/22発売」「8月22日発売予定」
function extractTcgpitReleaseDate(text) {
  const m = text.match(/(\d{1,2})[\/月](\d{1,2})日?\s*(?:に)?\s*発売(?:予定)?/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// 例：「予約受付開始 8/16」「受付開始は8月16日から」
function extractTcgpitApplyStart(text) {
  const m = text.match(/受付開始[はが]?\s*(?:は)?\s*(\d{1,2})[\/月](\d{1,2})日?/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// 例：「受付期間 ～8/16日 23:00迄」「〜8/16 23:59まで」「8/16締切」
function extractTcgpitApplyEnd(text) {
  let m = text.match(/[~〜～]\s*(\d{1,2})[\/月](\d{1,2})日?(?:\s*\d{1,2}[:：]\d{2})?\s*(?:迄|まで)/);
  if (m) return `${m[1]}/${m[2]}`;
  m = text.match(/(\d{1,2})[\/月](\d{1,2})日?\s*(?:締切|締め切り)/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// 例：「抽選結果は8/16に発表」「当選発表 8月16日」
function extractTcgpitResultAnnounce(text) {
  const m = text.match(/(?:結果|当選)(?:発表|をご連絡)[はが]?\s*(\d{1,2})[\/月](\d{1,2})日?/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}
/* ▲ 日程抽出 */

/* ▼ Yahoo!リアルタイム検索結果HTMLの解析（Joshin・ふるいちと同じ検索結果構造） */
// Yahoo側のCSSクラス名は末尾ハッシュが変わる可能性があるため、
// [class*='Tweet_xxx__']のような部分一致セレクタで比較的安定した属性を優先して拾う。
// 投稿1件のコンテナは Tweet_Tweet__ 系クラス（本文=Tweet_body__、投稿者・時刻=Tweet_info__配下）。
// バッチ内dedup：同一postIdが複数回出現した場合は最初の1件のみ残す（postId未取得は対象外＝誤って弾かない）。
function extractTcgpitPostsFromDoc(doc) {
  const posts = [];
  const seenPostIds = new Set();

  const bodyEls = doc.querySelectorAll("[class*='Tweet_body__']");
  let textOkCount = 0;
  let officialCount = 0;
  let postIdOkCount = 0;

  bodyEls.forEach(bodyEl => {
    const pEl = bodyEl.querySelector("p") || bodyEl;
    const rawText = extractCombinedText(pEl);
    if (!rawText) return;
    textOkCount++;

    // Tweet_body__の祖先をたどり、同じ投稿ブロック内のTweet_time__（投稿者・投稿日時・パーマリンク元）を探す
    let container = bodyEl.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      if (container.querySelector("[class*='Tweet_time__']")) break;
      container = container.parentElement;
    }
    if (!container) container = bodyEl.parentElement || bodyEl;

    const authorNameEl = container.querySelector("[class*='Tweet_authorName__']");
    const authorIdEl = container.querySelector("[class*='Tweet_authorID__']");
    const authorName = authorNameEl ? authorNameEl.textContent.trim() : null;
    const authorId = authorIdEl ? authorIdEl.textContent.trim().replace(/^@/, "") : null;

    // @tcgpit_joetsu本人の投稿以外は対象外（店舗公式アカウントのみ監視する仕様のため）
    if (!isTcgpitOfficialPost(authorId)) return;
    officialCount++;

    const timeContainer = container.querySelector("[class*='Tweet_time__']");
    const permalinkA = timeContainer ? timeContainer.querySelector("a[href*='/status/']") : null;
    let sourceUrl = null;
    let postId = null;
    if (permalinkA) {
      const href = permalinkA.getAttribute("href");
      sourceUrl = href.startsWith("http") ? href : "https://x.com" + href;
      const m = sourceUrl.match(/status\/(\d+)/);
      if (m) postId = m[1];
    }
    if (!postId) {
      const twidMatch = (container.innerHTML || "").match(/twid[:="']+(\d+)/);
      if (twidMatch) postId = twidMatch[1];
    }

    // バッチ内dedup（postId基準）
    if (postId) {
      if (seenPostIds.has(postId)) return;
      seenPostIds.add(postId);
      postIdOkCount++;
    }

    posts.push({
      rawText,
      postId,
      sourceUrl,
      authorId,
      authorName
    });
  });

  console.log(
    `[Tcgpit Parse] Tweet_body__検出=${bodyEls.length} / 本文取得=${textOkCount} / 本人投稿=${officialCount} / postId取得=${postIdOkCount} / extracted=${posts.length}`
  );

  return posts;
}

// Cloudflare Worker（/tcgpit-search）から返るHTML文字列をDOMParserでパースするラッパー
function extractTcgpitPosts(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractTcgpitPostsFromDoc(doc);
}
/* ▲ Yahoo!リアルタイム検索結果HTMLの解析 */

/* ▼ 投稿→案件変換（商品マスタ照合・案件種別・日程付与） */
// 1投稿を、商品マスタ一致数ぶんの案件候補へ展開する（1投稿に複数商品名が含まれるケースに対応）。
// 商品マスタに一致しない場合は productId:null の候補を1件返す（同期対象にはしないが、デバッグ集計には使う）。
function enrichTcgpitCandidate(post) {
  const matchedProducts = matchProductsInText(post.rawText);
  const caseType = detectTcgpitCaseType(post.rawText);
  const releaseDate = extractTcgpitReleaseDate(post.rawText);
  const applyStart = extractTcgpitApplyStart(post.rawText);
  const applyEnd = extractTcgpitApplyEnd(post.rawText);
  const resultAnnounce = extractTcgpitResultAnnounce(post.rawText);

  if (matchedProducts.length === 0) {
    // 2026-08-23④：商品マスタ不一致でも案件自体は捨てない。
    // この時点でrawPostsはisTcgpitPokecaCandidateText（ポケカ根拠）とisTcgpitTargetCaseText（販売機会根拠）を
    // 通過済みのため、「商品未特定の要確認案件」として productId:null のまま保持する。
    return [{
      ...post,
      productId: null,
      productName: buildTcgpitUnresolvedLabel(post.rawText),
      productResolved: false,
      confidence: "needs_review",
      caseType,
      releaseDate,
      applyStart,
      applyEnd,
      resultAnnounce
    }];
  }

  return matchedProducts.map(master => ({
    ...post,
    productId: master.id,
    productName: master.name,
    productResolved: true,
    caseType,
    releaseDate,
    applyStart,
    applyEnd,
    resultAnnounce
  }));
}

// 同一案件判定：productId・caseTypeの両方一致で判定する
function isSameTcgpitCase(a, b) {
  if (!a.productId || !b.productId) return false;
  if (a.productId !== b.productId) return false;
  if (a.caseType !== b.caseType) return false;
  return true;
}

// 商品マスタに一致した投稿候補（enriched, productId必須）を商品案件単位にグループ化し、
// 保存済みカードと同じフィールド構成のオブジェクトへ統合する。
function groupTcgpitCandidates(enriched) {
  const groups = [];

  enriched.forEach(c => {
    const target = groups.find(g => g.some(member => isSameTcgpitCase(member, c)));
    if (target) {
      target.push(c);
    } else {
      groups.push([c]);
    }
  });

  return groups.map(group => {
    const productId = group[0].productId;
    const caseType = group[0].caseType;
    const master = PRODUCT_MASTER.find(p => p.id === productId) || null;
    const withReleaseDate = group.find(g => g.releaseDate);
    const withApplyStart = group.find(g => g.applyStart);
    const withApplyEnd = group.find(g => g.applyEnd);
    const withResultAnnounce = group.find(g => g.resultAnnounce);
    const withUrl = group.find(g => g.sourceUrl);

    return {
      siteId: TCGPIT_CONFIG.siteId,
      siteName: TCGPIT_CONFIG.siteName,
      status: `${caseType}受付中（候補）`,
      // 2026-08-23追加：detectTcgpitCaseTypeは「抽選」優先で判定するため「再販抽選」で「再販」の情報が失われる。
      // 本体側のsalePhase/entryMethod判定が原文から再判定できるよう、原文を結合して保持する。
      rawText: group.map(g => g.rawText).filter(Boolean).join(" "),
      productId: productId,
      productName: master ? master.name : group[0].productName,
      imageUrl: master ? master.imageUrl : null,
      // 2026-08-23④追加：商品マスタ一致の有無を明示するフラグ。未一致（要確認）の場合のみconfidenceを付与する。
      productResolved: !!productId,
      confidence: productId ? undefined : "needs_review",
      caseType: caseType,
      approxDate: null,
      applyStart: withApplyStart ? withApplyStart.applyStart : null,
      applyEnd: withApplyEnd ? withApplyEnd.applyEnd : null,
      resultAnnounce: withResultAnnounce ? withResultAnnounce.resultAnnounce : null,
      releaseDate: withReleaseDate ? withReleaseDate.releaseDate : null,

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
/* ▲ 投稿→案件変換 */

/* ▼ 保存済みデータとの重複判定（本体のfindDuplicateEntryForSiteから呼ばれる想定） */
// 判定順序（2026-08-23④修正、furuichi.jsと同じ考え方）：
// ①まず同一投稿由来（sourcePostsのpostIdが既存データと重複）かどうかをproductIdの有無に関わらず先に確認する。
//   「商品未特定（要確認）で保存 → 後日products.json更新でproductId解決」のケースでも、
//   既存カード（同じid・appliedStatus等）を正しく更新できるようにするため。
// ②postId一致が無い場合のみ、従来通りproductId・caseTypeの一致で判定する。
// 応募済み・見送り状態（appliedStatus）は絶対に上書きしない（syncSiteResults側の設計に準拠）。
function checkTcgpitDuplicateAgainstSaved(candidate, savedList) {
  const tcgpitSaved = savedList.filter(s => s.siteId === TCGPIT_CONFIG.siteId);

  // 2026-08-23④修正：postId一致だけで即決めると、1投稿から複数商品が検出されるケースで
  // 同じpostIdを持つ別商品同士が誤って同一エントリとして統合されてしまう（furuichi.jsと同じ問題）。
  // postId一致に加えて「productIdが一致する、またはどちらか一方がnull（要確認←→解決の昇格）」の場合のみ同一とみなす。
  const candidatePostIds = (candidate.sourcePosts || []).map(p => p.postId).filter(Boolean);
  if (candidatePostIds.length > 0) {
    const sameSourcePost = tcgpitSaved.find(s =>
      Array.isArray(s.sourcePosts) &&
      s.sourcePosts.some(p => candidatePostIds.includes(p && p.postId)) &&
      (!s.productId || !candidate.productId || s.productId === candidate.productId)
    );
    if (sameSourcePost) return { level: "exact", message: "同一投稿由来の既存データがあります", entry: sameSourcePost };
  }

  if (!candidate.productId) return null;
  const exact = tcgpitSaved.find(s => s.productId === candidate.productId && s.caseType === candidate.caseType);
  if (exact) return { level: "exact", message: "同一商品・同一種別の既存データがあります", entry: exact };
  return null;
}
/* ▲ 保存済みデータとの重複判定 */

/* ▼ 検索→同期の本体（本体側から呼ばれる） */
// ↓デプロイ済みWorkerの実URLに差し替えること（liliana944.workers.devサブドメインを使用）
const TCGPIT_WORKER_URL = "https://pokeca-joshin-proxy.liliana944.workers.dev/tcgpit-search";

// Joshin・ふるいちのsync関数と同じ構成：起動時自動同期・虫眼鏡の手動同期の両方からこの1つを呼ぶ。
// パイプライン：①投稿抽出 → ②マイナス検索の取りこぼし安全フィルタ → ③他TCG除外 → ④ポケカ判定
// → ⑤通常パック販売除外（最重要） → ⑥対象案件判定 → ⑦商品マスタ照合 → ⑧案件統合
// 戻り値は呼び出し側（本体のstatus表示）が使えるよう各段階の件数と{ added, updated }を返す。
async function syncTcgpitData() {
  console.log("[Tcgpit Auto Sync] start");

  let data;
  try {
    const res = await fetch(TCGPIT_WORKER_URL);
    data = await res.json();
    if (!res.ok && !data.ok) {
      throw new Error("取得に失敗しました（サーバー応答エラー）");
    }
  } catch (e) {
    console.warn("[Tcgpit] 同期失敗:", e);
    return { error: e.message || String(e) };
  }

  const rawPosts = extractTcgpitPosts(data.html);
  const rawCount = rawPosts.length;

  // ②マイナス検索の取りこぼし安全フィルタ（Yahoo側の-大会 -バトル等が効いているはずの保険）
  const afterNegative = rawPosts.filter(p => !tcgpitHasNegativeSafetyWord(p.rawText));
  const negativeExcludedCount = rawCount - afterNegative.length;

  // ③他TCG除外
  const afterOtherTcg = afterNegative.filter(p => !isTcgpitOtherTcgText(p.rawText));
  const otherTcgExcludedCount = afterNegative.length - afterOtherTcg.length;

  // ④ポケカ判定
  const pokecaCandidates = afterOtherTcg.filter(p =>
    isTcgpitPokecaCandidateText(p.rawText, matchProductsInText(p.rawText))
  );
  const pokecaCount = pokecaCandidates.length;

  // ⑤通常パック販売除外（最重要。BOX単位の情報は残す）
  const afterPackExclusion = pokecaCandidates.filter(p => !isNormalPackSaleOnlyText(p.rawText));
  const normalPackExcludedCount = pokecaCandidates.length - afterPackExclusion.length;

  // ⑥対象案件判定（抽選・予約・再販・BOX関連等。単なる「販売」「入荷」だけの投稿は除外）
  const caseEligible = afterPackExclusion.filter(p => isTcgpitTargetCaseText(p.rawText));
  const nonCaseExcludedCount = afterPackExclusion.length - caseEligible.length;

  // ⑦商品マスタ照合（1投稿から複数商品を検出できるためflatMapで展開）
  const enriched = caseEligible.flatMap(enrichTcgpitCandidate);
  const matched = enriched.filter(e => e.productId);
  const unmatched = enriched.filter(e => !e.productId);

  // ⑧案件統合（2026-08-23④：unmatchedも「商品未特定の要確認案件」として統合対象に含める）
  const tcgpitCases = groupTcgpitCandidates(matched.concat(unmatched));

  console.log(
    `[Tcgpit Yahoo] 投稿${rawCount}件 / マイナス検索除外${negativeExcludedCount}件 / 他TCG除外${otherTcgExcludedCount}件 / ポケカ候補${pokecaCount}件 / 通常パック販売除外${normalPackExcludedCount}件 / 対象外(非案件)${nonCaseExcludedCount}件 / 商品一致${matched.length}件 / 商品未判定${unmatched.length}件 / 案件数${tcgpitCases.length}件`
  );
  if (unmatched.length > 0) {
    console.table(unmatched.map(u => ({ rawText: u.rawText, caseType: u.caseType })));
  }

  // ここで初めてlocalStorageへ反映。新規は追加、既存は自動取得系フィールドのみ更新。
  // appliedStatus・見送り状態などユーザー操作系は syncSiteResults 内で一切触らない。
  const { added, updated } = syncSiteResults(TCGPIT_CONFIG.siteId, tcgpitCases);

  console.log("[Tcgpit Auto Sync] complete");

  return {
    rawCount,
    negativeExcludedCount,
    otherTcgExcludedCount,
    pokecaCount,
    normalPackExcludedCount,
    nonCaseExcludedCount,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    caseCount: tcgpitCases.length,
    added,
    updated
  };
}
/* ▲ 検索→同期の本体 */
