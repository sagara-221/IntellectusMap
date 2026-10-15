import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), front=path.join(root,'frontend'), out=path.join(root,'output/pdf');
const require=createRequire(path.join(front,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')));
const React=require('react'),{renderToStaticMarkup:render}=require('react-dom/server');
const {chromium}=require('playwright');
const vite=await createServer({root:front,configFile:false,esbuild:{jsx:'automatic'},server:{middlewareMode:true},appType:'custom'});
const component=async name=>(await vite.ssrLoadModule('/src/'+name+'.tsx')).default;
const Site=await component('UnderstandingSite'),Prep=await component('DecompositionIcon'),Source=await component('AssessmentSourceIcon');
const Miner=await component('PixelAgent'),Recorder=await component('PixelRecorder'),Reception=await component('PixelReceptionist'),Notebook=await component('PixelNotebook'),Task=await component('AgentTaskIcon');
const roleTool=id=>id==='questioner'?'pen':id==='evaluation'?'lens':id==='merge'?'documents':'pick';
const draw=(C,props={})=>render(React.createElement(C,props));
const sprites={};
for(const [name,score] of [['unknown',null],['low',.2],['medium',.55],['high',.9]])sprites[name]=draw(Site,{assessment:{score,confidence:.2}});
sprites.flagWhite=draw(Site,{assessment:{score:.9,confidence:.25}});
sprites.flagColor=draw(Site,{assessment:{score:.9,confidence:.8}});
sprites.selected='<div class="assessment-node selected">'+draw(Site,{assessment:{score:.55,confidence:.25}})+'</div>';
for(const source of ['question','conversation','self_report'])sprites[source]=draw(Source,{source});
sprites.provisional=draw(Source,{source:'conversation',provisional:true});
sprites.mixed=draw(Source,{source:'question'})+draw(Source,{source:'conversation'});
const statuses=['available','queued','generating','ready','failed'], qs=['unknown','missing','queued','generating','ready','failed'];
for(const s of statuses)for(const q of qs)sprites[s+'-'+q]=draw(Prep,{status:s,question:q});
const roles=[['miner','分解係','#d79539'],['questioner','出題係','#6689b0'],['evaluation','評価係','#a77bb3'],['merge','統合係','#659780'],['recorder','記録係','#aa7655'],['reception','受付係','#416c5a']];
for(const [id,,tint] of roles)sprites['role-'+id]=id==='recorder'?draw(Recorder):id==='reception'?draw(Reception):draw(Miner,{tint,tool:roleTool(id)});
const actions=[['dig','分解する','miner'],['build','項目を追加する','miner'],['question','問題を作る','questioner'],['grade','回答を採点する','evaluation'],['inspect','理解の根拠を調べる','evaluation'],['merge','知識を照合・統合する','merge'],['write','発言から根拠を抜き出す','recorder'],['plan','配置先・配置案を調べる','recorder'],['reply','会話に返答する','reception']];
for(const [action,,id] of actions){const role=roles.find(r=>r[0]===id);sprites['action-'+action]='<span class="actor '+action+'">'+(id==='recorder'?draw(Recorder,{working:action==='write',planning:action==='plan'}):id==='reception'?draw(Reception):draw(Miner,{state:'work',tint:role[2],tool:roleTool(id)}))+draw(Task,{action})+'</span>';}
sprites.notebook=draw(Notebook);
sprites.count='<span class="count">'+draw(Miner)+'<b>×9</b></span>';
const live=await fs.readFile(path.join(front,'src/LiveAtlasMap.tsx'),'utf8');
sprites.root=live.match(/className="start-landmark"[\s\S]*?(<svg[\s\S]*?<\/svg>)/)[1];
sprites.terminal='<span class="tag">◇ 分解候補なし</span>';
sprites.covered='<span class="tag">↳ 親の結果で出題省略</span>';
sprites.aggregate='<span class="tag">下位項目の集計</span>';
sprites.shared='<span class="tag">結合 · 2親</span>';
sprites.envelope='<svg viewBox="0 0 32 32"><rect x="4" y="8" width="24" height="17" rx="1" fill="#fff2c9" stroke="#715a38" stroke-width="2"/><path d="M5 9L16 18 27 9" fill="none" stroke="#a87b48" stroke-width="2"/></svg>';
sprites.received='<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#fff8df" stroke="#63866c"/><path d="m11 16 3 4 7-8" stroke="#416c5a" stroke-width="2" fill="none"/></svg>';
sprites.normalEdge='<svg viewBox="0 0 120 32"><path d="M4 16H116" stroke="#98a588" stroke-width="2" stroke-dasharray="5 7"/></svg>';
sprites.road='<svg viewBox="0 0 120 32"><path d="M4 16H116" stroke="#568494" stroke-width="8" stroke-linecap="round"/><path d="M4 16H116" stroke="#e2eeea" stroke-width="2.4"/></svg>';
const base=await fs.readFile(path.join(front,'src/map-mock.css'),'utf8');
const connectionSource=await fs.readFile(path.join(front,'src/MapPages.tsx'),'utf8');
const island=connectionSource.match(/<svg className="connection-island"[\s\S]*?<\/svg>/)[0]
  .replaceAll('className=','class=').replaceAll('shapeRendering=','shape-rendering=')
  .replace('class="island-water"','fill="#7ccccb"')
  .replace('class="island-grass"','fill="#719f62"').replace('class="island-meadow"','fill="#94bc73"');
sprites.island=island;
sprites.islandCandidate=island.replace('#719f62','#9da879').replace('#94bc73','#bdc391').replace(/<path class="island-dock"[^>]*\/>/,'');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1000,height:900},deviceScaleFactor:2});
await page.setContent('<style>'+base+`*{animation:none!important;transition:none!important;box-sizing:border-box}body{margin:0;background:#fffdf7}.asset{width:max-content;min-width:96px;height:100px;padding:8px;display:flex;align-items:center;justify-content:center;gap:6px;position:relative}.asset>svg{width:72px;height:72px}.asset .miner,.asset .pixel-recorder{width:72px;height:72px}.asset .decomposition-icon{display:block;width:72px;height:72px}.decomposition-icon svg{width:100%;height:100%}.asset .assessment-source-icon{width:64px;height:64px}.actor{position:relative;display:block;width:86px;height:84px}.actor>svg:first-child{width:72px;height:72px}.actor>.agent-task-icon{position:absolute;right:0;bottom:0;width:38px;height:38px}.actor:not(.dig) .pick{display:none}.count{position:relative}.count b{position:absolute;right:-5px;bottom:0;background:#fff7df;border:1px solid #8a9b77;font:700 20px Arial;padding:2px 6px}.tag{font:14px 'Yu Gothic';border:1px solid #b3baa5;padding:7px;background:#fff8e6;white-space:nowrap}`+'</style>'+Object.entries(sprites).map(([id,svg])=>`<div class="asset" id="${id}">${svg}</div>`).join(''));
const images={};for(const id of Object.keys(sprites)){const buffer=await page.locator('#'+id).screenshot();images[id]='data:image/png;base64,'+buffer.toString('base64');}
const img=(id,cls='')=>`<img class="${cls}" src="${images[id]}" alt="${id}">`;
const note=text=>`<aside class="note">${text}</aside>`;
const cards=items=>'<div class="cards">'+items.map(([id,title,text])=>`<article>${img(id)}<div><h3>${title}</h3><p>${text}</p></div></article>`).join('')+'</div>';
const table=items=>'<table class="list"><thead><tr><th>画像</th><th>表示・意味</th><th>読み方・注意点</th></tr></thead><tbody>'+items.map(([id,title,text])=>`<tr><td>${img(id)}</td><td><b>${title}</b></td><td>${text}</td></tr>`).join('')+'</tbody></table>';
const pageSection=(title,sub,body)=>`<section class="sheet"><header><span>IntellectusMap / 知図</span><span>アイコンガイド · 2026.10.13</span></header><h1>${title}</h1><p class="lead">${sub}</p>${body}<footer><span>実装準拠 · develop_v2 / 2026-10-13更新版</span><span class="page-number"></span></footer></section>`;
const buildings=[['unknown','未確認 / 石碑','理解度がまだ決まっていない。外周リングは点線。'],['low','低 / テント','0%以上40%未満。例：チャット由来の暫定20%。'],['medium','中 / 建設途中の小屋','40%以上80%未満。自己評価「そこそこ」は55%。'],['high','高 / 完成した拠点','80%以上。自己評価「自信アリ」は90%。']];
const sources=[['question','答案：問題回答','問題への回答結果が理解度の根拠。'],['conversation','吹き出し：会話','チャットの発言から理解度を推定。'],['provisional','吹き出し＋？：暫定','会話由来だが理解は未検証。補完値は20%。'],['mixed','答案＋吹き出し：両方','問題と会話の両方が根拠。子項目の集計でも両方が現れる。'],['self_report','人物：自己評価','「自信アリ・そこそこ・ちょっと」の自己申告。']];
const preps=[['available-missing','木箱：分解前','下位項目の準備は未着手。理解度の低さとは別。'],['queued-missing','砂時計：分解待ち','処理の順番待ち。まだ作業開始前。'],['generating-missing','ツルハシ：分解中','バックグラウンドで下位項目を準備中。画面では動く。'],['ready-missing','閉じた宝箱：分解準備済み','下位項目は準備済み。問題はまだ準備済みではない。'],['ready-ready','開いた宝箱：両方準備済み','分解と問題の両方が準備済み。回答済み・理解済みではない。'],['failed-missing','警告印：分解失敗','下位項目の準備に失敗。再試行できる。']];
const overlays=[['ready-queued','右下の砂時計','問題生成の順番待ち。'],['ready-generating','右下の羽根ペン','問題を生成中。画面では動く。'],['available-ready','右下の答案','問題生成済み。分解が未完了なら、この小印で示す。'],['ready-failed','右下の警告印','問題準備の失敗。分解の失敗とは別。']];
const roleRows=roles.map(([id,label])=>['role-'+id,label,{miner:'下位項目の分解、新しい項目の追加。',questioner:'確認問題の作成。',evaluation:'回答の採点、会話の根拠からの理解度評価。',merge:'知識の重複や対応関係を照合・統合。',recorder:'発言から根拠を抽出し、知識項目への配置先を調べる。',reception:'探索受付でユーザーと会話する。通常の調査隊とは別配置。'}[id]]);
const extras=[['root','羅針盤：開始ノード','探索テーマの開始地点。専用の飾りで、理解度アイコンとは別。'],['selected','外側の枠：選択中','枠だけを強調。理解度の建物・色を上書きしない。'],['terminal','◇ 分解候補なし','AIによる末端判定。理解済みや絶対に分解不能という意味ではない。'],['covered','↳ 親の結果で出題省略','この子項目を直接採点したわけではない。'],['shared','結合 · 2親','複数の親からつながる項目。数字は親の数。'],['aggregate','下位項目の集計','表示理解度が子項目から集計されたもの。'],['notebook','調査手帳','調査依頼・問題回答・調査記録のパネルを開く。'],['role-reception','探索受付','チャットのパネルを開く。手帳とは同時に開かない。']];
let quick=[
pageSection('アイコン早見一覧','01 / 理解度・根拠の読み方',cards(buildings)+note('<b>建物・リング＝理解度 ／ 旗＝根拠の確かさ ／ 小バッジ＝評価の由来。</b><br>3つの情報は別々です。白旗でも理解度が高いことがあります。')+cards([['flagWhite','白旗','未確認、または確かさが70%未満。'],['flagColor','色付きの旗','確かさが70%以上。チェック付き。']])+table(sources)),
pageSection('準備状況の早見一覧','02 / 下位項目の分解と、問題の生成は別の進捗です。',table(preps)+`<h2>右下の小印は「問題」の準備状況</h2>`+cards(overlays)+note('<b>閉じた木箱と、閉じた宝箱を区別してください。</b><br>木箱＝分解前。金色の宝箱＝分解準備済み。宝箱が開くのは分解・問題の両方が準備できたときです。')),
pageSection('調査隊の早見一覧','03 / 色は役割、道具や動きは現在の作業を表します。',table(roleRows)+cards([['count','×9：待機人数','最大10体の役割で1体が作業中なら×9。出動数ではありません。'],['envelope','封筒：情報の引き継ぎ','エージェント間の依頼や結果を受け渡しています。'],['received','チェック：受け渡しの到着','引き継ぎ演出の終端。理解度の正解判定とは別です。']])+note('待機・移動・作業の3状態があります。作業の終了はサーバー状態に連動します。静止画像では動きの違いは表現していません。')),
pageSection('地図とパネルの補助表示','04 / 理解度以外のマーク',table(extras)+cards([['normalEdge','通常の点線エッジ','項目同士のつながり。'],['road','道のようなエッジ','深堀MAPで、両端の理解度がともに80%以上。']])+note('対象：知識地図・調査手帳・探索受付の状態表示。検索・拡大縮小・閉じる等の一般操作アイコンは省略しています。'))
];
const matrix='<table class="matrix"><thead><tr><th>分解 ↓ / 問題 →</th>'+['未確認','未生成','順番待ち','生成中','生成済み','失敗'].map(s=>`<th>${s}</th>`).join('')+'</tr></thead><tbody>'+statuses.map((s,i)=>'<tr><th>'+['分解前','分解待ち','分解中','準備済み','分解失敗'][i]+'</th>'+qs.map(q=>'<td>'+img(s+'-'+q)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
let detail=[
pageSection('アイコン詳細ガイド','01 / ひとつのノードに、別々の状態を重ねて表示しています。',cards(buildings)+`<h2>建物・色・リング</h2><p>理解度が未設定なら石碑と点線リングです。値がある場合、外周リングの長さが理解率を表し、建物と色は低・中・高の3段階になります。低は40%未満、中は40%以上80%未満、高は80%以上です。</p><p>自己申告では「自信アリ」90%、「そこそこ」55%、「ちょっと」20%を暫定的に使います。「問題で理解度を確認する」を選んだだけでは、問題への回答による評価は確定しません。</p>`+cards([['selected','選択中は外枠','色や建物を変更せず、対象ノードを示します。'],['root','開始地点は羅針盤','理解度は子項目の集計で変わります。開始ノードを直接自己評価する方式ではありません。']])+note('表示する理解度は、ノード単独の根拠だけでなく、子項目の集計が優先される場合があります。詳しくは6ページ。')),
pageSection('旗と評価元バッジ','02 / 「どの程度わかるか」と「何を根拠に判断したか」を区別します。',cards([['flagWhite','白旗：根拠が少ない','確かさが未設定、または70%未満。理解度0%や失敗を意味しません。'],['flagColor','色付き旗：十分な確かさ','確かさが70%以上。理解度の値とは独立しています。']])+table(sources)+`<h2>「？」が表すもの</h2><p>「？」は未検証の暫定理解度です。発言から項目が作られたことだけで、内容を理解できたとは断定しません。地図上では未確認のままにせず、低い値で仮置きしていることを明示します。</p><p>子項目を集計しているノードのバッジは、その集計に使った根拠の種類です。答案と吹き出しが並んでいても、必ずしもその親ノード自身が両方の評価を受けたとは限りません。</p>`),
pageSection('分解と問題の全組み合わせ','03 / 5種類の分解状態 × 6種類の問題状態',matrix+note('<b>この表は描画可能な組み合わせを網羅したものです。</b><br>すべての状態が通常操作で必ず発生するわけではありません。')+`<h2>読む順番</h2><ol><li>大きい図柄で分解状態を読みます。木箱・砂時計・ツルハシ・宝箱・警告印です。</li><li>右下の小印で問題の状態を読みます。砂時計・羽根ペン・答案・警告印です。</li><li>分解準備済み＋問題生成済みだけが「開いた宝箱」になります。</li></ol><p>問題の「未確認」と「未生成」は現在、同じ見た目です。カーソルを合わせた説明では区別されます。ツルハシと羽根ペンは実画面で動きます。</p><p>開いた宝箱は、正解済み・採点済み・高い理解度を保証しません。問題を開くための通信や、回答後の採点処理は別に発生します。</p>`),
pageSection('調査隊の役割と作業','04 / 同じ人物でも、処理によって道具とアニメーションが変わります。',table(actions.map(([action,title,id])=>['action-'+action,roles.find(r=>r[0]===id)[1]+' / '+title,{dig:'ツルハシ。下位項目の分解・先行準備。',build:'ハンマーとレンガ。新しい知識項目を追加。',question:'用紙と筆記具。確認問題を生成。',grade:'スタンプとチェック。問題への回答を採点。',inspect:'虫眼鏡。会話などの根拠を検討。',merge:'重なる書類。知識の重複や対応を照合。',write:'手帳とペン。発言から経験・根拠を抽出。',plan:'手帳のページ。配置先の照合、配置案の検証。',reply:'受付窓口の人物。会話への返答を準備。'}[action]]))+note('静止資料なのでアニメーションの一瞬を掲載しています。記録係は抽出・配置先照合・配置案検証で作業名も変わります。')),
pageSection('BASE CAMP と引き継ぎ','05 / 人数・居場所・作業完了を混同しないために',cards([['count','×数字は待機数','最大数から稼働中の人数を引いた残数です。'],['role-reception','受付係は探索受付にいる','地図上のノードへ歩く通常の調査隊とは別です。'],['envelope','封筒が移動する','依頼や結果の引き継ぎイベントを表示。'],['received','到着時のチェック','受け渡しの到着を示す短い演出です。']])+`<h2>人数の読み方</h2><p>最大10体の役割で1体が稼働していれば「×9」、全員稼働中なら「×0」です。最大人数はサーバーの設定から取得するため、役割ごと・環境ごとに異なる場合があります。順番待ちの処理は、開始されるまで待機側に残ります。</p><h2>同じ場所に複数の人物がいる場合</h2><p>異なる処理が並列で動いていれば、同じノードの近くに複数の作業係が表示されます。記録係は役割・対象ノード・作業段階が同じ仕事をまとめて表示する場合があります。地図全体に対する作業は拠点や開始地点の近くに表示されます。</p><h2>アニメーションと実際の処理</h2><p>移動は約1秒の演出です。移動終了は仕事の完了ではありません。作業の完了はAPIや定期取得で確認したサーバー状態に従います。動きを抑える設定では演出が省略される場合があります。</p><p>引き継ぎ演出は新しく届いたイベントが対象で、過去の履歴を地図を開くたびに再生するものではありません。</p>`),
pageSection('チャット由来の暫定値と集計','06 / 暫定20%が付く条件と、その後の更新',`<div class="hero">${img('provisional')}<div><h2>未評価のチャット由来ノード → 暫定20%</h2><p>チャットで直接作られた項目、その自動展開による子項目、保存済みの該当項目に適用します。</p></div></div><h2>暫定値を補う条件</h2><ul><li>チャット由来として識別できる項目であること。</li><li>利用可能な会話評価、採点可能な問題回答、明示的な自己評価がないこと。</li><li>開始ノードそのものではないこと。</li></ul><p>20%は理解を確認できた実測値ではありません。暫定値を付けるために、存在しない問題の回答や会話の引用を作ることはしません。通常の初期分解だけで生まれた、チャットと無関係の項目には一律で付けません。</p><h2>あとで評価が得られたとき</h2><p>問題回答や実際の会話評価が得られれば、その根拠を使います。強い根拠を暫定20%に戻すための仕組みではありません。自己申告で選んだ値と、会話・問題からの評価も区別して扱います。</p><h2>親ノードの集計</h2><p>直下の子がすべて評価済みなら、子側の値を集計した理解度が優先されます。複数の親につながる同じ項目は、集計時に重複して数えないようにします。子に未評価が残る場合は、親自身の値があればそれを使います。</p><p>したがって、子項目の展開・評価によって親の表示が変わることがあります。「下位項目の集計」という補助表示と合わせて確認してください。</p>`+note('暫定バッジの「？」は、表示に寄与する値がすべて暫定の場合に付きます。複数の実評価と暫定値が混ざる集計では、単一の「？」だけですべての内訳を表現していません。')),
pageSection('補助表示と、よくある読み違い','07 / 日常の確認ポイント',table(extras.slice(2,6))+`<h2>よくある組み合わせ</h2>`+cards([['flagWhite','完成した拠点＋白旗','理解度は高いが、確認の根拠は少ない。自己申告などで起こります。'],['ready-ready','開いた宝箱＋低い理解度','問題は準備済みでも、理解度は低い。矛盾ではありません。'],['provisional','低い理解度＋吹き出し？','チャット由来の仮置き。理解を検証済みという意味ではありません。'],['selected','選択枠＋どの建物でも','今選んでいる対象を示すだけ。理解度には影響しません。']])+`<h2>確認場所</h2><p>ノードにカーソルを合わせると、理解度・確かさ・準備状況の説明を確認できます。調査手帳の「調査記録」では、評価元や回答・会話の根拠を確認します。問題・回答ページは、そのノードで問題確認を行ったときに表示されます。</p><h2>資料の範囲と出典</h2><p class="small">2026年10月13日の develop_v2（2026-10-13更新版）を基準に、実装のSVGから画像を作成。UnderstandingSite.tsx、AssessmentSourceIcon.tsx、DecompositionIcon.tsx、map-crew.ts、AgentTaskIcon.tsx、LiveAtlasMap.tsx、AgentHandoffs.tsx、policies/conversation.py、policies/understanding.py を参照。一般操作アイコンは省略。画像は読みやすく拡大しており、画面上の縮尺とは異なります。</p>`)
];
const css=`@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#e7e9e2;color:#233c36;font-family:'Yu Gothic','Meiryo',sans-serif;font-size:14px;line-height:1.75}.sheet{width:210mm;height:297mm;background:#fffdf7;margin:18px auto;padding:13mm 15mm 15mm;position:relative;break-after:page;overflow:hidden}.sheet:last-child{break-after:auto}header,footer{display:flex;justify-content:space-between;font-size:9px;letter-spacing:.04em;color:#728074}header{border-bottom:1px solid #c5cdbb;padding-bottom:9px}footer{position:absolute;left:15mm;right:15mm;bottom:9mm;border-top:1px solid #c5cdbb;padding-top:6px}h1{font-size:25px;line-height:1.4;letter-spacing:.025em;margin:17px 0 5px}h2{font-size:16px;margin:18px 0 7px;border-left:3px solid #bda35c;padding-left:9px}h3{font-size:12px;margin:0 0 4px}.lead{color:#728074;font-size:11px;margin:0 0 15px}p{margin:6px 0 10px}ul,ol{padding-left:22px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:9px 0}.cards article{display:flex;align-items:center;min-height:97px;border:1px solid #dce0d1;background:#f7f7ee;border-radius:6px;padding:6px 10px 6px 3px;gap:5px}.cards article img{width:88px;height:72px;object-fit:contain;flex-shrink:0}.cards p{font-size:11.5px;line-height:1.6;margin:0}.note{margin:12px 0;padding:10px 14px;background:#edf1e7;border-left:3px solid #52785c;font-size:11px}.list{border-collapse:collapse;width:100%;margin:9px 0;font-size:12px}.list th{text-align:left;background:#e9eddf;font-weight:600;padding:7px 9px}.list td{padding:5px 9px;border-bottom:1px solid #e0e3d7;vertical-align:middle}.list td:first-child{width:100px}.list td:nth-child(2){width:190px}.list img{width:86px;height:64px;object-fit:contain;display:block}.matrix{border-collapse:collapse;width:100%;font-size:10px;margin:15px 0}.matrix th,.matrix td{border:1px solid #d9ddcf;text-align:center;padding:6px 1px}.matrix th{background:#edf0e5}.matrix img{width:75px;height:67px;object-fit:contain}.hero{display:flex;gap:16px;align-items:center;background:#edf1e7;padding:15px}.hero img{width:105px;height:90px}.hero h2{border:0;padding:0;margin:0;font-size:17px}.small{font-size:10px;line-height:1.9}img{image-rendering:pixelated}@media print{body{background:white}.sheet{margin:0;box-shadow:none}}`;
const islandsPage=pageSection('繋がりMAPの島と海','海図の読み方 / 深堀MAPとは異なる、関連テーマの地図です。',cards([
 ['island','探索済みの島','砂浜・草地と桟橋のある島。下の札が地図の名前です。'],
 ['islandCandidate','未探索の島','小さな島で、桟橋がありません。これから探索できる候補です。'],
 ['root','起点の島','通常より大きな島と羅針盤で示します。'],
 ['normalEdge','島を結ぶ航路','項目の関係をたどるエッジ。線の関係表示も確認します。']])+`<h2>選択と新しい候補</h2><p>選択した島は明るい縁取りで強調します。新しい候補は名前の札を淡い金色にします。ノード名は島の下の札に表示します。</p><h2>海と等高線</h2><p>背景は青い海とドット絵の波模様です。淡い等高線は開始地点からの接続距離を基に描きます。波や島の大きさで理解度を表すものではありません。</p><h2>操作</h2><p>ドラッグで島や地図を動かし、ホイールで拡大縮小できます。地図の文字は操作中に選択されないようにしています。調査手帳やチャットの文章は引き続きコピーできます。</p>`);
quick.push(islandsPage);detail.push(islandsPage);
await fs.mkdir(out,{recursive:true});
for(const [name,title,pages] of [['IntellectusMap_アイコン早見一覧','IntellectusMap アイコン早見一覧',quick],['IntellectusMap_アイコン詳細ガイド','IntellectusMap アイコン詳細ガイド',detail]]){
  let html='<!doctype html><html lang="ja"><meta charset="utf-8"><title>'+title+'</title><style>'+css+'</style><body>'+pages.map((p,i)=>p.replace('<span class="page-number"></span>',`<span>${i+1} / ${pages.length}</span>`)).join('')+'</body></html>';
  await fs.writeFile(path.join(out,name+'.html'),html);
  await page.setContent(html,{waitUntil:'load'});await page.emulateMedia({media:'print'});await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.locator('.sheet').evaluateAll(sheets=>sheets.map((s,i)=>({page:i+1,last:Math.max(...[...s.children].filter(e=>!['HEADER','FOOTER'].includes(e.tagName)).map(e=>e.getBoundingClientRect().bottom))-s.getBoundingClientRect().top,limit:s.clientHeight-65})).filter(x=>x.last>x.limit));
  if(overflow.length)throw new Error(name+' overflows '+JSON.stringify(overflow));
  await page.pdf({path:path.join(out,name+'.pdf'),printBackground:true,preferCSSPageSize:true});
  console.log(name+': '+pages.length+' pages; layout bounds OK');
}
await browser.close();await vite.close();
