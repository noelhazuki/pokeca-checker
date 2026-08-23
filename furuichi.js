/* ==========================================================================
   furuichi.js
   ふるいちトップブックス高田西店（X: @furu1_takada）の抽選投稿監視・専用処理

   前提：本体（pokeca_cyusen.html）側で先に読み込まれている共通処理を利用する。
   - extractCombinedText(el)   … テキストノード＋img altを結合して本文復元（絵文字数字対応）
   - matchesKeywordRule / INCLUDE_KEYWORDS / EXCLUDE_KEYWORDS … 全サイト共通の含む/除外判定
     （ふるいちは本ファイル内の独自ロジックで判定するため、本ファイルでは未使用）
   - PRODUCT_MASTER / matchProductsInText(text) … 全サイト共通の商品マスタ照合（本文全体走査・複数商品対応）
   - nowISO() … ISO日時取得
   - syncSiteResults(siteId, candidates) … localStorageへの共通同期（新規追加／自動取得系フィールドのみ更新）
   - findDuplicateEntryForSite(siteId, candidate, savedList) … サイトごとの重複判定の入口
     （本ファイルのcheckFuruichiDuplicateAgainstSavedを、本体側でsiteId==="furuichi"の分岐に追加して使う）

   取得経路：Yahoo!リアルタイム検索「id:furu1_takada」（@furu1_takada本人の投稿を無条件に取得。
   内容の絞り込み（抽選・ポケカ等）はYahoo側では行わず、取得後に本ファイル側で判定する）。
   Joshinと同じくYahoo!リアルタイム検索結果HTML（Tweet_系クラス構造）を解析する。

   本ファイルが持つのはふるいち固有のロジックのみ：
   - Yahoo!リアルタイム検索「id:furu1_takada」の検索結果HTML解析
   - @furu1_takada本人の投稿であることの確認
   - ポケカ案件かどうかの判定（他TCG除外）
   - 販売・応募に関係する「対象案件」かどうかの判定（Yahoo側で内容を絞り込まなくなったため必要）
   - 日程抽出（releaseDate / applyEnd）
   - 案件統合・重複判定用データ生成
   ========================================================================== */

/* ▼ ふるいち固有設定 */
const FURUICHI_CONFIG = {
  siteId: "furuichi",
  siteName: "ふるいち高田西店",
  targetAuthorId: "furu1_takada" // @は付けずに比較する（投稿者ID側の表記揺れ対策）
};

// Joshinと違い「不特定多数の投稿からふるいちという語を探す」のではなく、
// この店舗公式アカウント（@furu1_takada）の投稿だけを対象にする。
// Yahoo!リアルタイム検索側は「id:furu1_takada」で本人投稿に絞っているが、
// 引用RTやリプライ等が結果に混ざる可能性を考慮し、投稿者ID側でも本人の投稿であることを再確認する。
function isFuruichiOfficialPost(authorId) {
  if (!authorId) return false;
  return authorId.replace(/^@/, "") === FURUICHI_CONFIG.targetAuthorId;
}

// 検索結果には複数TCG（ポケモンカード／ワンピースカード等）の投稿が混在するため、
// 他TCGが明確な投稿は除外する。既存の共通EXCLUDE_KEYWORDSにも同じ語が含まれているが、
// 「ポケカ候補判定」の主目的の除外条件として、ここでも明示的に判定できるようにしておく。
const OTHER_TCG_KEYWORDS = [
  "ワンピースカード", "ワンピース", "デュエマ", "デュエル・マスターズ",
  "遊戯王", "ガンダム", "MTG", "マジック:ザ・ギャザリング",
  "ヴァイスシュヴァルツ", "ヴァイス"
];
function isOtherTcgText(text) {
  return OTHER_TCG_KEYWORDS.some(k => text.includes(k));
}

// 明確なポケカ語（商品マスタに載っていない略称等でも拾えるように、語そのものでも判定する）
const POKECA_WORDS = ["ポケモンカード", "ポケカ"];
function hasExplicitPokecaWord(text) {
  return POKECA_WORDS.some(k => text.includes(k));
}

// ポケカ案件として採用してよいかの総合判定。
// 優先順位：①商品マスタに一致 → 採用／②「ポケモンカード」「ポケカ」語がある → 採用／
// ③上記のポケカ肯定材料がなく、他TCGワードのみ存在する → 除外
// 2026-08-23修正：他TCG判定を最優先にしていたため、ポケカ商品と他TCG商品を同時告知する投稿
// （例：「#ポケモンカード #メガブレイブ ならびに #ワンピースカードゲーム 抽選販売の受付を開始いたします」）
// が丸ごと除外される偽陰性があった。ポケカ肯定条件（商品マスタ一致／明示的ポケカ語）を先に判定し、
// それが無い場合のみ他TCG語で除外する順序に変更。
function isPokecaCandidateText(text, matchedProducts) {
  if (matchedProducts.length > 0) return true;
  if (hasExplicitPokecaWord(text)) return true;
  if (isOtherTcgText(text)) return false;
  return false;
}

// Yahoo側で「id:furu1_takada」のみに絞り込み、内容（抽選等）では絞り込まなくなったため、
// ポケカ投稿の中でも「販売・応募に関係する対象案件」かどうかをここで判定する。
// 店側の文章表現が一定ではない前提のため、単一の固定表現には依存せず語のOR判定にする。
const FURUICHI_CASE_KEYWORDS = [
  "抽選", "抽選販売", "予約", "予約受付", "予約販売",
  "受付", "受付開始", "応募", "再販", "販売"
];
function isFuruichiTargetCaseText(text) {
  return FURUICHI_CASE_KEYWORDS.some(k => text.includes(k));
}
/* ▲ ふるいち固有設定 */

/* ▼ 商品未特定時の表示用フォールバックラベル
   2026-08-23④追加：商品マスタ不一致でも「ポケカ根拠＋販売機会根拠」が揃っている投稿は
   案件自体を捨てず「要確認」として残すため、一覧表示用の簡易ラベルを本文から生成する。
   商品名の高精度な推測は行わない（URL・メンション・ハッシュタグを除いた先頭30文字程度の簡易表示のみ）。 */
function buildFuruichiUnresolvedLabel(text) {
  if (!text) return "商品名未特定の投稿";
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/[@＠]\S+/g, " ").trim();
  if (!t) return "商品名未特定の投稿";
  return t.length > 30 ? t.slice(0, 30) + "…" : t;
}
/* ▲ 商品未特定時の表示用フォールバックラベル */

/* ▼ 日程抽出（明確に読み取れる形式のみ。曖昧な日付は無理に構造化しない） */
// 例：「8/22発売予定」「8月22日発売」
function extractFuruichiReleaseDate(text) {
  const m = text.match(/(\d{1,2})[\/月](\d{1,2})日?\s*(?:に)?\s*発売(?:予定)?/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// 例：「受付期間 ～8/16日 23:00迄」「〜8/16 23:59まで」「8/16締切」
function extractFuruichiApplyEnd(text) {
  let m = text.match(/[~〜～]\s*(\d{1,2})[\/月](\d{1,2})日?(?:\s*\d{1,2}[:：]\d{2})?\s*(?:迄|まで)/);
  if (m) return `${m[1]}/${m[2]}`;
  m = text.match(/(\d{1,2})[\/月](\d{1,2})日?\s*(?:締切|締め切り)/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}
/* ▲ 日程抽出 */

/* ▼ 元投稿日時（sourcePostedAt）の取得
   2026-08-23追加：detectedAt（アプリがYahoo検索から初めて発見した日時）と、
   sourcePostedAt（X等の元投稿が実際に投稿された日時）は別物。
   古い投稿を後日初めて検知すると、detectedAtだけを見ては新しい案件のように誤認される問題があったため、
   Snowflake ID（X投稿ID）から元投稿日時を復元して別フィールドとして保持する。
   ※現時点ではこのsourcePostedAtは保存するだけで、鮮度判定・終了判定には使用しない。

   X（旧Twitter）のSnowflake ID仕様：
   ID の上位ビット（>>22）が「Twitter epoch（2010-11-04T01:42:54.657Z）からのミリ秒差分」。
   Yahoo!リアルタイム検索の表示テキスト（「M月D日(曜) H:MM」「H:MM」の2パターン）との
   実データ突合（2026-08-23、@furu1_takada投稿40件）で全件一致を確認済み。
   表示テキストのパースと違い、表記ゆれ・年またぎの影響を受けない。 */
const TWITTER_SNOWFLAKE_EPOCH_MS = 1288834974657; // 2010-11-04T01:42:54.657Z

// postIdからISO 8601形式（JST基準）の投稿日時文字列を復元する。
// postIdが無い／数値として扱えない場合はnullを返す（無理に推測しない）。
function extractPostedAtFromSnowflakeId(postId) {
  if (!postId) return null;
  try {
    const idNum = BigInt(postId);
    const ms = Number(idNum >> 22n) + TWITTER_SNOWFLAKE_EPOCH_MS;
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  } catch (e) {
    return null;
  }
}
/* ▲ 元投稿日時の取得 */

/* ▼ Yahoo!リアルタイム検索結果HTMLの解析（Joshinと同じ検索結果構造） */
// Yahoo側のCSSクラス名は末尾ハッシュが変わる可能性があるため、
// [class*='Tweet_xxx__']のような部分一致セレクタで比較的安定した属性を優先して拾う。
// 投稿1件のコンテナは Tweet_Tweet__ 系クラス（本文=Tweet_body__、投稿者・時刻=Tweet_info__配下）。
// なお検索結果HTML内の<article>要素は「トレンド」欄など無関係な項目のため対象にしない。
// バッチ内dedup：同一postIdが複数回出現した場合は最初の1件のみ残す（postId未取得は対象外＝誤って弾かない）。
function extractFuruichiPostsFromDoc(doc) {
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

    // @furu1_takada本人の投稿以外は対象外（店舗公式アカウントのみ監視する仕様のため）
    if (!isFuruichiOfficialPost(authorId)) return;
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
      authorName,
      sourcePostedAt: extractPostedAtFromSnowflakeId(postId)
    });
  });

  console.log(
    `[Furuichi Parse] Tweet_body__検出=${bodyEls.length} / 本文取得=${textOkCount} / 本人投稿=${officialCount} / postId取得=${postIdOkCount} / extracted=${posts.length}`
  );

  return posts;
}

// Cloudflare Worker（/furuichi-search）から返るHTML文字列をDOMParserでパースするラッパー
function extractFuruichiPosts(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractFuruichiPostsFromDoc(doc);
}
/* ▲ Yahoo!リアルタイム検索結果HTMLの解析 */

/* ▼ 投稿→案件変換（商品マスタ照合・案件種別・日程付与） */
// 1投稿を、商品マスタ一致数ぶんの案件候補へ展開する（1投稿に複数商品名が含まれるケースに対応）。
// 商品マスタに一致しない場合は productId:null の候補を1件返す（同期対象にはしないが、デバッグ集計には使う）。
function enrichFuruichiCandidate(post) {
  const matchedProducts = matchProductsInText(post.rawText);
  const releaseDate = extractFuruichiReleaseDate(post.rawText);
  const applyEnd = extractFuruichiApplyEnd(post.rawText);

  if (matchedProducts.length === 0) {
    // 2026-08-23④：商品マスタ不一致でも案件自体は捨てない。
    // この時点でrawPostsはすでにisPokecaCandidateText（ポケカ根拠）と
    // isFuruichiTargetCaseText（販売機会根拠）の両方を通過済みのため、
    // 「商品未特定の要確認案件」として productId:null のまま保持する。
    return [{
      ...post,
      productId: null,
      productName: buildFuruichiUnresolvedLabel(post.rawText),
      productResolved: false,
      confidence: "needs_review",
      caseType: "抽選",
      releaseDate,
      applyEnd
    }];
  }

  return matchedProducts.map(master => ({
    ...post,
    productId: master.id,
    productName: master.name,
    productResolved: true,
    caseType: "抽選",
    releaseDate,
    applyEnd
  }));
}

// 同一案件判定：productId一致＋caseType一致で同一案件とみなす。
// （2026-08-23：販売イベント同一性判定（postId／applyEnd・releaseDate／sourcePostedAt+文言による分離）を
//   一旦撤回し、メガブレイブ抽選が正常に検知できていた段階の判定へ戻した。
//   「8/8と8/23で別イベントが統合されてしまう」問題は既知の制約として保留する。）
function isSameFuruichiCase(a, b) {
  if (!a.productId || !b.productId) return false;
  if (a.productId !== b.productId) return false;
  if (a.caseType && b.caseType && a.caseType !== b.caseType) return false;
  return true;
}

// 商品マスタに一致した投稿候補（enriched, productId必須）を商品案件単位にグループ化し、
// 保存済みカードと同じフィールド構成のオブジェクトへ統合する。
function groupFuruichiCandidates(enriched) {
  const groups = [];

  enriched.forEach(c => {
    const target = groups.find(g => g.some(member => isSameFuruichiCase(member, c)));
    if (target) {
      target.push(c);
    } else {
      groups.push([c]);
    }
  });

  return groups.map(group => {
    const productId = group[0].productId;
    const master = PRODUCT_MASTER.find(p => p.id === productId) || null;
    const withReleaseDate = group.find(g => g.releaseDate);
    const withApplyEnd = group.find(g => g.applyEnd);
    const withUrl = group.find(g => g.sourceUrl);
    // 同一案件へ統合された複数投稿のうち、最も古いsourcePostedAt（＝最初の告知）を採用する。
    // ISO 8601形式は文字列としてソートしても時系列順になるため、単純な文字列比較でよい。
    const postedAts = group.map(g => g.sourcePostedAt).filter(Boolean).sort();
    const sourcePostedAt = postedAts.length > 0 ? postedAts[0] : null;

    return {
      siteId: FURUICHI_CONFIG.siteId,
      siteName: FURUICHI_CONFIG.siteName,
      status: "抽選受付中（候補）",
      // 2026-08-23追加：ふるいちはcaseTypeが常に"抽選"固定（検索クエリが「抽選」のため）で「再販」を判定できない。
      // 本体側のsalePhase/entryMethod判定が原文から「再販」等を読み取れるよう、原文を結合して保持する。
      rawText: group.map(g => g.rawText).filter(Boolean).join(" "),
      productId: productId,
      productName: master ? master.name : group[0].productName,
      imageUrl: master ? master.imageUrl : null,
      // 2026-08-23④追加：商品マスタ一致の有無を明示するフラグ。未一致（要確認）の場合のみconfidenceを付与する。
      productResolved: !!productId,
      confidence: productId ? undefined : "needs_review",
      caseType: "抽選",
      approxDate: null,
      applyStart: null,
      applyEnd: withApplyEnd ? withApplyEnd.applyEnd : null,
      resultAnnounce: null,
      releaseDate: withReleaseDate ? withReleaseDate.releaseDate : null,

      sourceUrl: withUrl ? withUrl.sourceUrl : null,
      detectedAt: nowISO(),
      // アプリが初めて検知した日時（detectedAt）とは別に、元のX投稿が実際に投稿された日時を保持する。
      // 現時点では保存のみ。鮮度判定・終了判定には使用しない（2026-08-23追加）。
      sourcePostedAt: sourcePostedAt,

      sourcePosts: group.map(g => ({
        postId: g.postId,
        authorName: g.authorName,
        authorId: g.authorId,
        sourceUrl: g.sourceUrl,
        rawText: g.rawText,
        sourcePostedAt: g.sourcePostedAt
      })),

      viaYahoo: true,
      requiresOfficialCheck: true
    };
  });
}
/* ▲ 投稿→案件変換 */

/* ▼ 保存済みデータとの重複判定（本体のfindDuplicateEntryForSiteから呼ばれる想定） */
// 判定順序（2026-08-23④修正）：
// ①まず同一投稿由来（sourcePostsのpostIdが既存データと重複）かどうかを productId の有無に関わらず先に確認する。
//   これにより「商品未特定（要確認）で保存した投稿が、後日products.json更新でproductId解決した」場合でも、
//   同じ既存カード（同じid・appliedStatus等のユーザー操作状態）を正しく更新できる
//   （旧実装はproductIdの有無で判定方法を完全に分けていたため、解決後に別の新規カードとして重複してしまっていた）。
// ②postId一致が無い場合のみ、従来通りproductId・caseTypeの一致で判定する（productId不明の候補はここで終了）。
function checkFuruichiDuplicateAgainstSaved(candidate, savedList) {
  const furuichiSaved = savedList.filter(s => s.siteId === FURUICHI_CONFIG.siteId);

  // 2026-08-23④修正：postId一致だけで即決めると、1投稿から複数商品が検出されるケース
  // （例：1つの投稿にメガブレイブとストームエメラルダが両方含まれる）で、
  // 同じpostIdを持つ別商品同士が誤って同一エントリとして統合されてしまう。
  // そのため、postId一致に加えて「productIdが一致する、またはどちらか一方がnull（要確認←→解決の昇格）」
  // の場合のみ同一エントリとみなす。
  const candidatePostIds = (candidate.sourcePosts || []).map(p => p.postId).filter(Boolean);
  if (candidatePostIds.length > 0) {
    const sameSourcePost = furuichiSaved.find(s =>
      Array.isArray(s.sourcePosts) &&
      s.sourcePosts.some(p => candidatePostIds.includes(p && p.postId)) &&
      (!s.productId || !candidate.productId || s.productId === candidate.productId)
    );
    if (sameSourcePost) return { level: "exact", message: "同一投稿由来の既存データがあります", entry: sameSourcePost };
  }

  if (!candidate.productId) return null;
  // productId+caseTypeの一致で同一案件とみなす（isSameFuruichiCaseと同じ基準）。
  const exact = furuichiSaved.find(s => isSameFuruichiCase(candidate, s));
  if (exact) return { level: "exact", message: "同一商品・同一種別の既存データがあります", entry: exact };
  return null;
}
/* ▲ 保存済みデータとの重複判定 */

/* ▼ 検索→同期の本体（本体側から呼ばれる） */
// ↓デプロイ済みWorkerの実URLに差し替えること（liliana944.workers.devサブドメインを使用）
const FURUICHI_WORKER_URL = "https://pokeca-joshin-proxy.liliana944.workers.dev/furuichi-search";

// Joshinのsync JoshinData()と同じ構成：起動時自動同期・虫眼鏡の手動同期の両方からこの1つを呼ぶ。
// Yahoo側では「id:furu1_takada」のみで絞り込み、内容の絞り込みはここで行う：
// ①他TCG除外 → ②ポケカ判定 → ③販売・応募に関係する対象案件かどうかの判定 → ④商品マスタ照合 → ⑤案件統合
// 戻り値は呼び出し側（本体のstatus表示）が使えるよう { rawCount, otherTcgExcludedCount, pokecaCount,
// nonCaseExcludedCount, matchedCount, unmatchedCount, caseCount, added, updated } を返す。
async function syncFuruichiData() {
  console.log("[Furuichi Auto Sync] start");

  let data;
  try {
    const res = await fetch(FURUICHI_WORKER_URL);
    data = await res.json();
    if (!res.ok && !data.ok) {
      throw new Error("取得に失敗しました（サーバー応答エラー）");
    }
  } catch (e) {
    console.warn("[Furuichi] 同期失敗:", e);
    return { error: e.message || String(e) };
  }

  let rawPosts;
  let excludedOtherTcg = 0;
  let excludedNonCase = 0;
  let pokecaCandidates = [];
  let caseCandidates = [];
  try {
    rawPosts = extractFuruichiPosts(data.html);
    rawPosts.forEach(post => {
      const matchedProducts = matchProductsInText(post.rawText);
      if (!isPokecaCandidateText(post.rawText, matchedProducts)) {
        // ポケカ肯定材料（商品マスタ一致／明示的ポケカ語）が無く除外された投稿のうち、
        // 他TCG語が原因のものを集計する（両方無い投稿もここに含まれるが件数集計上の扱いは従来通り）
        if (isOtherTcgText(post.rawText)) excludedOtherTcg++;
        return;
      }
      pokecaCandidates.push(post);

      // Yahoo側で内容を絞り込まなくなったため、ここで「販売・応募に関係する対象案件」かどうかを判定する
      if (!isFuruichiTargetCaseText(post.rawText)) {
        excludedNonCase++;
        return;
      }
      caseCandidates.push(post);
    });
  } catch (e) {
    console.warn("[Furuichi] 抽出エラー:", e);
    return { error: e.message || String(e) };
  }

  // 商品マスタ照合はここで1回だけ行う。1投稿から複数商品を検出できるためflatMapで展開する。
  const enriched = caseCandidates.flatMap(enrichFuruichiCandidate);
  const matched = enriched.filter(e => e.productId);
  const unmatched = enriched.filter(e => !e.productId);

  // 2026-08-23④：商品マスタ不一致でも案件自体は捨てない方針への変更。
  // unmatchedはこの時点で既にisPokecaCandidateText（ポケカ根拠）とisFuruichiTargetCaseText（販売機会根拠）を
  // 通過済みのため、そのまま「商品未特定の要確認案件」としてmatchedと合わせてグループ化・保存対象にする。
  const furuichiCases = groupFuruichiCandidates(matched.concat(unmatched));

  console.log(`[Furuichi Yahoo] 投稿${rawPosts.length} / 他TCG除外${excludedOtherTcg} / ポケカ${pokecaCandidates.length} / 対象外(非案件)${excludedNonCase} / 対象案件${caseCandidates.length} / 商品一致${matched.length} / 商品未判定${unmatched.length} / 案件${furuichiCases.length}`);
  if (unmatched.length > 0) {
    console.table(unmatched.map(u => ({ rawText: u.rawText, postId: u.postId })));
  }

  // ここで初めてlocalStorageへ反映。新規は追加、既存は自動取得系フィールドのみ更新。
  // appliedStatus・見送り状態などユーザー操作系はsyncSiteResults内で一切触らない。
  const { added, updated } = syncSiteResults(FURUICHI_CONFIG.siteId, furuichiCases);

  console.log(`[Furuichi] 同期完了　新規${added}件 / 更新${updated}件`);
  console.log("[Furuichi Auto Sync] complete");

  return {
    rawCount: rawPosts.length,
    otherTcgExcludedCount: excludedOtherTcg,
    pokecaCount: pokecaCandidates.length,
    nonCaseExcludedCount: excludedNonCase,
    caseCandidateCount: caseCandidates.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    caseCount: furuichiCases.length,
    added,
    updated
  };
}
/* ▲ 検索→同期の本体 */
