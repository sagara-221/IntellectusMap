// Run from repository root: node scripts/build-user-manuals.mjs
// Uses the checked-in icon guide's embedded implementation-derived images.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=process.cwd(), out=path.join(root,'output/pdf');
const require=createRequire(path.join(root,'frontend/package.json'));
const {chromium}=require('playwright');
const source=await fs.readFile(path.join(out,'IntellectusMap_アイコン早見一覧.html'),'utf8');
const images={};
for(const m of source.matchAll(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/g))images[m[2]]=m[1];
const img=id=>{if(!images[id])throw Error('Missing icon '+id);return `<img src="${images[id]}" alt="${id}">`;};
const p=t=>`<p>${t}</p>`;
const h=(title,text)=>`<h2>${title}</h2>${p(text)}`;
const note=t=>`<aside>${t}</aside>`;
const list=items=>`<ol>${items.map(t=>`<li>${t}</li>`).join('')}</ol>`;
const table=(heads,rows)=>`<table><thead><tr>${heads.map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(t=>`<td>${t}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const cards=rows=>`<div class="cards">${rows.map(([id,title,text])=>`<article>${img(id)}<div><h3>${title}</h3>${p(text)}</div></article>`).join('')}</div>`;
const flow=steps=>`<div class="flow">${steps.map((s,i)=>`<div><b>${String(i+1).padStart(2,'0')}</b><span>${s}</span></div>`).join('')}</div>`;
const page=(title,sub,body)=>({title,sub,body});
const quick=[
page('まずは、ひとつ地図を作る','簡易ユーザーマニュアル / 01　最初の5分',
cards([['root','IntellectusMapとは','知っていること・曖昧なことを、会話や確認問題から地図にするアプリです。'],['role-reception','入口は「探索」','テーマを決めて開始。最初の地図の生成を待ちながら、探索受付で話せます。']])+
list(['ログインし、上部の「探索」を開きます。','「探索するテーマ」に、例として「微分」を入力します。必要なら「高校数学。接線と導関数を中心に」のように範囲のメモを書きます。','「このテーマを探索する」を押します。受付が表示されたら、経験・知っていること・困っていることを送信します。','例：「接線の傾きは分かりますが、合成関数の微分でつまずきます」。返答の後も地図の整理は続き、項目が順に増えます。','気になるノードをクリックします。調査手帳が開き、その項目の確認・展開ができます。'])+
flow(['テーマを決める','受付で話す','項目を選ぶ','確かめて広げる'])+
note('最初の自動分解と、会話からの追加は併用されます。会話の返答が終わっても、地図への反映が終わったとは限りません。')),
page('項目を選んで、次へ進む','簡易ユーザーマニュアル / 02　調査手帳と地図操作',
cards([['notebook','調査手帳','ノードを選ぶと開きます。調査依頼・必要時の問題回答・調査記録を切り替えます。'],['role-reception','探索受付','手帳を閉じ、受付アイコンを押すと会話に戻れます。2つのパネルは同時に開きません。']])+
table(['調査依頼で選ぶもの','結果'],[['自信アリ','自己評価90%を保存し、下位項目の展開へ進む。'],['そこそこ','自己評価55%を保存し、下位項目の展開へ進む。'],['ちょっと','自己評価20%を保存し、下位項目の展開へ進む。'],['問題で理解度を確認する','そのノードの「問題・回答」ページへ。回答を送って結果を読む。'],['問題を飛ばして下位項目を展開','出題・採点を待たずに下へ進む。回答したことにはならない。']])+
h('地図の見方を調整する','マウスホイールで拡大縮小。ノードをドラッグすると位置を調整できます。地図の文字はドラッグ中に選択されません。「配置を整える」で再配置。「理解度」のチェックを外した段階は、薄く小さく表示されます。削除ではありません。')+
h('次に開く場所','「深堀マップ一覧」はテーマごとの地図。「繋がりMAP一覧」は系統ごとの関連テーマ。「知識ノード一覧」は項目を探す入口です。「ユーザーマニュアル」で簡易版・詳細版を切り替え、PDFも開けます。')+
note('処理中はボタンや手帳の進捗を確認してください。理解度の保存と、下位項目の展開には別々に時間がかかる場合があります。')),
page('このアイコンだけ覚えれば大丈夫','簡易ユーザーマニュアル / 03　よく見る状態',
cards([['unknown','石碑・点線リング','未確認。理解度0%と同じではありません。'],['low','テント','理解度は低。中は小屋、高は完成した拠点。'],['flagWhite','白旗','根拠の確かさが低い、または未確認。理解度の低さとは別です。'],['provisional','吹き出し＋？','会話由来の暫定推定。未検証の項目は20%で補われます。'],['question','答案の印','問題回答が理解度の根拠です。会話は吹き出し、自己評価は人物。'],['ready-missing','閉じた宝箱','下位項目は準備済み。問題の準備はまだ完了していません。'],['ready-ready','開いた宝箱','分解と問題の両方が準備済み。回答済みの意味ではありません。'],['generating-missing','動くツルハシ','下位項目を準備中。砂時計は順番待ち、警告印は失敗。']])+
h('うまく進まないとき','まず対象ノードと処理中の表示を確認します。失敗が表示されたら、その場所の再試行を使います。チャットは「マップへの反映を再試行」、初期地図は「初期マップを再試行」が表示される場合があります。')+
note('理解度は回答・発言からの推定です。親の値は子項目の集計で変わることがあります。より詳しくは「詳細ユーザーマニュアル」と既存の「アイコン早見一覧」を参照してください。'))
];
const detailed=[
page('画面の入口と、最初の探索','詳細ユーザーマニュアル / 01　ログインから地図作成まで',
cards([['root','探索テーマを地図にする','テーマを狭めるほど、見たい知識の範囲を伝えやすくなります。'],['notebook','確認はノードごと','同じ地図の中でも、理解度・問題・準備状況は項目ごとに異なります。']])+
table(['上部メニュー','用途'],[['探索','新しいテーマを始める、または現在の探索を続ける。'],['深堀マップ一覧','作成した地図を探し、開く。タイトル等の編集や削除もここから。'],['繋がりMAP一覧','系統を選び、その中の地図と未探索候補の関係を見る。'],['知識ノード一覧','地図を横断して、自分の項目を探して詳細を見る。']])+
h('開始手順','公開環境ではGoogleログインを行い、「探索」でテーマと任意のメモを入力します。「このテーマを探索する」を押すと探索受付が開き、初期地図の作成が進みます。環境によってログイン方法が異なる場合があります。')+
h('入力の例','テーマ：「CADの選び方」。メモ：「機械設計の初心者。2Dと3Dの使い分け、製図、データ互換を知りたい。価格比較は今回は対象外」。範囲や目的を書くと、会話の出発点を共有できます。')+
note('表示するのはログイン中のユーザーの地図です。別アカウントで開くと一覧が異なります。この資料は2026年10月13日、develop_v2 / 2026-10-13更新版の実装を対象としています。')),
page('探索受付で知識を増やす','詳細ユーザーマニュアル / 02　会話の使い方',
cards([['role-reception','受付係に話す','経験・説明できること・疑問を自由に入力して送信します。'],['role-recorder','記録係が整理する','発言から情報を取り出して、既存項目への対応や追加先を調べます。']])+
list(['受付の候補文を押すと、入力欄に話し始めの文が入ります。自分の内容を追記して送信します。','返答を読み、具体例・理由・迷っている点を追加します。単語の列挙より「何ができ、どこで迷うか」が評価の手がかりになります。','地図への反映状況を確認します。会話から複数の項目が生まれたり、既存項目の理解度が更新されたりします。','作られた枝は、祖先の表示も含めて自動で開きます。後から準備できた子項目も順に表示対象になります。'])+
h('送るとよい内容','「知っている」だけでなく、「この式をこう使った」「このケースでは判断できない」と説明してください。会話評価は発言内容を根拠にするため、説明が具体的なほど何を確認できたかを記録しやすくなります。')+
h('会話を切り替える','「会話履歴」で過去の会話を表示できます。「新しい会話」は同じ地図の中で会話を区切る機能で、地図・理解度・過去の会話を消しません。過去の会話を見ているときは「現在の会話に戻る」から送信へ戻ります。')+
note('チャット由来の項目に付く暫定20%は、理解を確認した得点ではありません。通常の初期分解の項目すべてに一律で付くわけではありません。')),
page('調査手帳で理解を確かめる','詳細ユーザーマニュアル / 03　自己評価・問題・展開',
cards([['notebook','ノードをクリックして開く','右上の拡大ボタンで手帳の領域を広げられます。長い内容は内部をスクロールします。'],['question','問題・回答は必要な項目だけ','問題確認を始めた対象ノードで表示します。他のノードの問題を共通表示する機能ではありません。']])+
table(['ページ','できること'],[['調査依頼','自己評価、問題での確認、下位項目の展開など、次の操作を選ぶ。'],['問題・回答','問題を解き、回答を送信してフィードバックを読む。必要な状態のときだけ表示。'],['調査記録','項目の詳細、回答や会話からの根拠、理解度の情報を確認する。']])+
h('自己評価して先へ進む','「自信アリ」90%、「そこそこ」55%、「ちょっと」20%を選ぶと、保存後に下位項目を自動展開します。根拠の確かさは自己申告として低く扱われます。開始ノードは下位項目の集計を見る場所で、同じ自己評価操作の対象ではありません。')+
h('問題で確かめる','「問題で理解度を確認する」を選び、問題が表示されたら選択肢を選んで回答を送信します。評価と説明を読み、画面に出る次の操作へ進みます。追加確認が利用できる項目では、過去の根拠を含めた再評価も行えます。')+
h('問題を飛ばす','「問題を飛ばして下位項目を展開」は、問題生成が終わる前でも使える操作です。準備済みの子があれば表示へ進み、未準備なら分解を待ちます。問題を飛ばしただけで採点したことにはなりません。')+
note('ページのタブと左右ボタンで切り替えます。受付を開くときは手帳を閉じてください。ボタンが処理中の間は、保存中・展開中などの表示を確認します。')),
page('深堀MAPを読み、操作する','詳細ユーザーマニュアル / 04　地図の視覚表現',
cards([['unknown','未確認','点線リングと石碑。未評価と0%は区別します。'],['high','理解度：高','80%以上。中は40%以上80%未満、低は40%未満。'],['flagWhite','旗は根拠の確かさ','70%未満または不明なら白旗。70%以上なら色付き。'],['ready-ready','宝箱は準備状況','開いていても理解済みとは限りません。']])+
table(['操作','効果'],[['ホイール / ＋・－','地図を拡大・縮小する。'],['ノードをドラッグ','力方向グラフの位置を動かす。離すと周囲との力関係で調整される。'],['配置を整える','配置を計算し直す。落ち着くまで操作が待機になる場合がある。'],['知識を検索','目的の項目を見つけやすくする。'],['理解度チェック','外した段階を薄く小さくする。データは削除しない。'],['理解度エリア / 動きを抑える','背景の理解度表現、アニメーション量を調整する。']])+
h('等高線と道路','等高線は開始地点からのつながりの距離を基に描きます。理解度や難易度の高さではありません。深堀MAPで両端の理解度が80%以上のエッジは、道のような線になります。')+
note('「分解候補なし」はAIの末端判定。「親の結果で出題省略」は子を直接採点していない状態です。どちらも「理解済み」と同義ではありません。')),
page('繋がりMAPで探索範囲を広げる','詳細ユーザーマニュアル / 05　地図をまたぐ関連テーマ',
cards([['root','深堀MAP','ひとつのテーマを下位の知識項目に分けて調べます。'],['normalEdge','繋がりMAP','地図や未探索の候補を結び、別のテーマへ進む入口にします。']])+
list(['上部の「繋がりMAP一覧」を開き、見たい系統を選びます。すべての系統をひとつのグラフに混ぜて表示する方式ではありません。','地図上の候補、または地図内パネルの「未探索の候補」から項目を選びます。','展開元・関係・理由を確認します。エッジの関係表現も、つながりの意味を読む手がかりです。','詳しく調べたい候補なら「このテーマで深掘りを始める」を押します。候補を起点とする深掘りへ進みます。','関連候補を増やしたい場合は「さらに広げる」を使います。処理中は進捗と調査隊の表示を確認します。'])+
h('配置と移動','繋がりMAPはRPGの海図風です。砂浜と草地の島がノードで、探索済みは桟橋付き、未探索は小さな島、開始地点は大きな島です。選択中の島は明るい縁取りで示します。繋がりMAPも力方向グラフです。ノードをドラッグして配置を変え、拡大縮小して関係を追えます。等高線はここでも接続距離を基にする背景表現で、能力を採点するものではありません。')+
h('地図や項目を後から探す','「深堀マップ一覧」や「知識ノード一覧」の検索・並べ替えを使います。地図一覧ではタイトル等を編集できます。項目名を見つけたら詳細を確認し、該当する探索へ戻ります。')+
note('未探索の候補は、まだ十分に調べていない行き先です。候補の名前が表示されたことと、その知識を確認済みであることは別です。')),
page('保存・削除と、困ったとき','詳細ユーザーマニュアル / 06　日常の確認ポイント',
cards([['count','BASE CAMPの×数字','その役割の待機人数。最大数から稼働数を引いた表示です。'],['failed-missing','警告印','生成失敗。手帳や受付に出る説明と再試行操作を確認してください。']])+
table(['症状','確認・操作'],[['開いた宝箱なのに待つ','準備済みでも、対象問題の取得・選択状態の切替・保存等が残る場合があります。手帳の進捗を確認。'],['返答は来たが地図が増えない','裏の抽出・配置・分解・評価が続いている可能性があります。反映状況を確認し、失敗時は再試行。'],['理解度が後から変わる','新しい根拠や、子の集計が反映された可能性があります。調査記録で評価元を確認。'],['問題・回答タブがない','そのノードで問題確認を始めていない場合は正常です。調査依頼から確認を開始。'],['ログインや接続に失敗','利用アカウントと通信を確認。再ログイン後も続く場合は、操作・時刻・表示エラーを管理者へ伝える。']])+
h('保存','処理結果はサーバー側に保存されます。「保存」や「診断記録を保存」は、探索データをJSONファイルとして手元にダウンロードする操作です。この画面には、そのJSONを読み戻す操作はありません。')+
h('削除','地図の削除は関連する記録にも影響します。ノード削除は同じ地図の下位項目を含み、別の親と共有されている子にも影響します。確認ダイアログの対象を必ず読みます。ノード削除では会話の原文と他の地図は残ります。')+
note('一覧や旗・建物の全パターンは「アイコン早見一覧」「アイコン詳細ガイド」を参照してください。ここでの説明は実装を調査したもので、本番環境の全操作を実行して確認した記録ではありません。'))
];
const logic=[
page('全体像：操作と処理を分けて読む','動作・ロジック解説 / 01　構成とデータの単位',
flow(['React画面','認証付きAPI','処理・AI','保存','画面へ反映'])+
cards([['role-reception','対話の入口','返答を作る処理と、地図を更新する処理は別に進みます。'],['role-miner','地図の準備','分解・出題のジョブが並行して動きます。画面の歩行は処理状況の演出です。']])+
table(['単位','意味'],[['セッション','テーマ、知識ツリー、回答根拠、自己評価、会話、処理状態を保持する探索の単位。'],['地図・系統','地図は探索結果の単位。系統は派生した地図や未探索候補をまとめる単位。'],['ノード / concept_id','知識項目を識別するID。理解度や問題の対象を結びつける。'],['エッジ','親子のpart関係など。複数の親を持つ結合も表現する。'],['ジョブ / revision','仕事の進捗と、更新の新旧を識別する情報。画面の見た目だけで完了を判断しない。']])+
h('主要な構成','frontend/src/Application.tsxが探索操作をまとめ、api.tsがBearer認証付き通信とストリームを扱います。backend/app/main.pyがAPI入口、servicesが処理、policiesが評価・集計を担当します。保存先は設定によりFirestoreまたはSQLiteです。')+
note('基準：2026-10-13 / develop_v2 / 2026-10-13更新版。設定値はソース上の既定値であり、公開環境の環境変数を検査した値ではありません。APIキー等の秘密情報は本資料に含めません。')),
page('初期分解・先読み・展開の違い','動作・ロジック解説 / 02　宝箱が開くまで',
flow(['セッション保存','初期地図を生成','次の分解を先読み','必要な枝を展開'])+
cards([['queued-missing','queued','処理の順番待ち。生成そのものは始まっていません。'],['generating-missing','generating','AIで下位項目を準備している状態。'],['ready-missing','分解ready','分解結果は準備済み。問題readyとは独立です。'],['ready-ready','分解ready＋問題ready','両方の準備済みが開いた宝箱の条件です。']])+
h('開始直後の受付を待たせない仕組み','entry_mode=map_chatではセッションを保存し、その結果を先に返します。レスポンス後のBackgroundTaskで初期生成を開始します。受付で話しながら、初期地図を作れる構成です。')+
h('先読みと公開は別','先読みは子の分解結果をキャッシュ等に準備します。展開はその結果を知識ツリーへ反映し、画面で子を表示する処理です。既に準備済み・実行中の生成は再利用し、同じ対象の生成をむやみに二重に始めない実装です。')+
h('既定の範囲と上限','初期の最大子数は5、追加分解の最大子数は4。自動先読みは先の1層まで、先読みの同時実行設定は10です。実際の数は計画、末端判定、設定、処理結果で変わります。固定の待ち時間を保証する値ではありません。')+
note('主な参照：main.py:start、services/diagnostic.py:schedule_initial_map・prepare_concept・schedule_prefetch、config.py、DecompositionIcon.tsx。')),
page('会話を地図に反映する流れ','動作・ロジック解説 / 03　受付・記録・評価の協調',
flow(['発言を保存','受付が返答','根拠を抽出','配置・追加・分解','理解を評価'])+
cards([['role-recorder','抽出と配置','発言の引用を付けた情報を取り出し、既存ノードや追加先との対応を調べます。'],['role-evaluation','会話から評価','対応する評価観点について、発言から確認できた内容を評価します。']])+
h('なぜ返答後も動くのか','会話の返答はストリームで返します。地図への反映は背景処理のキューで進むため、返答完了と地図更新完了の時刻は一致しません。会話の情報が複数の項目に対応すると、配置・分解・評価が複数回必要になります。')+
h('根拠を追跡する','発言を情報単位に整理し、メッセージIDと引用を使って対応付けます。未解決の配置先、追加予定、詳細化が必要な項目をキューに残し、地図が変わった際に再調整します。同じ発言をもう一度調べただけで根拠の確かさが増えないよう、評価で重複を扱います。')+
h('自動で表示する条件','画面はchat.created_concept_idsとopened_concept_idsを開く対象に加え、すべての祖先も開きます。後から子が到着しても表示へつながります。概念統合でIDが変わった場合はconcept_redirectsをたどります。')+
h('無制限に生成するわけではない','設定には1回の背景処理で行う分解・追加の上限があります。既定は各10件。話した単語すべてをノード化することや、すべての子孫を無限に展開することを保証する機能ではありません。')+
note('参照：services/chat.py、chat_queue.py、chat_map.py、chat_retrieval.py、frontend/src/atlas-session.ts。')),
page('理解度を算出するロジック','動作・ロジック解説 / 04　直接評価・暫定値・親の集計',
cards([['self_report','自己評価','high=.90、medium=.55、low=.20。確かさ=.25。'],['provisional','会話由来の補完','使える評価がない対象にscore=.20、confidence=.10の暫定値を補います。']])+
table(['段階','処理'],[['会話評価がある','評価観点ごとに会話と対応する問題根拠を組み合わせる。会話の自己申告は確かさを最大.25に制限。'],['会話評価がない・問題根拠がある','採点可能な回答のscoreを平均。採点不能は除く。'],['自己評価のみ','90 / 55 / 20%を使う。「問題で確認する」はそれ自体を得点にしない。'],['根拠なし','原則は未確認。チャット由来と識別できる非ルートとその自動展開枝は、条件を満たすと暫定値で補完。']])+
h('会話と問題の重み','観点内では新しい根拠から順に0.6の累乗で減衰させ、各根拠の確かさも重みに使います。主要観点は重み1、補助観点は0.5。直近の得点が大きく矛盾すると確かさを下げます。これは単純な「最新値で上書き」とは異なります。')+
h('親の理解度','直下の子がすべて評価済みなら、子側の寄与元を集めて平均します。共有ノードを二重に数えません。未評価の子が残る場合は親自身の値を使い、親にも値がなければ未確認のままになる場合があります。')+
note('例：子の寄与元が20%と80%なら親は50%。子が増えると集計条件や平均が変わり、親の表示も変わり得ます。参照：policies/conversation.py:estimates、understanding.py:summaries。')),
page('問題・自己評価・ノード別の進捗','動作・ロジック解説 / 05　操作から表示更新まで',
flow(['対象IDを確定','保存・生成を依頼','サーバー結果','対象ノードへ反映'])+
h('自己評価の処理順','Application.tsxのassessSelectedは、session_idとconcept_idの組を進捗のキーにします。self-assessmentを送信し、成功後に、unsureならselectで問題へ、その他ならexpandConceptで下位展開へ進みます。保存失敗時に次の処理へ進めません。')+
h('問題ページの対象','next_question、pending_review、reassessment等のconcept_idが選択ノードと一致するかを判定します。問題確認要求、フィードバック等の対象状態からタブ表示を決めます。APIのアクティブな問題は1つであり、各ノードで独立した問題を同時回答するUIではありません。')+
h('準備済みなのに待つ理由','出題の準備状態と、その問題を現在の回答対象にする処理は別です。認証付き通信、保存、状態取得や画面反映に時間がかかることがあります。生成前なら待ち行列とAI応答も加わります。宝箱はこれら全工程の終了通知ではありません。')+
cards([['available-ready','問題だけ準備済み','分解が未準備なら小さな答案で表現します。'],['failed-missing','失敗は対象ごと','分解失敗と問題生成失敗は別状態。右下の小印は問題側の進捗です。']])+
h('画面が更新を取り込む方法','操作の応答やSSEに加え、探索状態を定期取得します。生成中は800ms、通常は2000ms。ChatPanelの背景更新は1200msです。ネットワークやサーバー時間が加わるため、この間隔が操作全体の所要時間ではありません。')+
note('古いrevisionの応答で新しい地図を巻き戻さないようにreconcileSessionで比較します。参照：Application.tsx、api.ts、ChatPanel.tsx、atlas-session.ts。')),
page('配置・等高線・調査隊の動き','動作・ロジック解説 / 06　地図表現の規則',
cards([['root','開始地点','基本となる中心。新しい子は発生元から中心の外側へ配置します。'],['count','待機人数','役割の最大数から稼働数を引く。順番待ちは開始されるまで出動扱いになりません。'],['envelope','情報の引き継ぎ','新たに届いた引き継ぎイベントの演出。過去の全履歴を繰り返すものではありません。'],['role-reception','受付係の居場所','探索受付のアイコンで動作します。通常の地図上作業係とは配置が異なります。']])+
h('力方向グラフ','D3のリンク力、反発、衝突回避、中心への力、深さに応じた半径方向の力を組み合わせます。既存座標を引き継ぎ、新規の子は親から外側へ初期配置します。ドラッグ中は位置を固定し、離すと固定を解除します。')+
h('等高線','開始点からの最短ホップ数をBFSで計算します。この距離はエッジを両方向にたどった接続距離です。画面上では距離の重み付き補間と外側への補正で場を作り、等値線を描きます。数学的に正確な地理の標高線ではありません。')+
h('人の数と仕事の数','ジョブの役割・段階・対象を基に配置します。並列の仕事が同じノードに集まる場合があります。記録係の同じ対象・同じ段階の処理はまとめて表示する場合があり、見える人物数をAPI呼び出し回数と同一視できません。')+
note('参照：map-geometry.ts、LiveAtlasMap.tsx、MapPages.tsx、live-map-jobs.ts、map-crew.ts、MapAgents.tsx、AgentHandoffs.tsx。')),
page('保存・認証・障害の調べ方','動作・ロジック解説 / 07　運用と実装を読む入口',
table(['調べたいもの','主なコード'],[['API・所有者の確認','backend/app/main.py、auth.py、services/maps.py、repositories/*'],['初期生成・分解・問題・採点','services/diagnostic.py、agents/*、prompts/*'],['会話・項目追加・再処理','services/chat.py、chat_queue.py、chat_map.py'],['理解度・統合・削除','policies/understanding.py、conversation.py、services/concept_merge.py・concept_deletion.py'],['画面と状態整合性','Application.tsx、atlas-session.ts、api.ts、MapPages.tsx'],['モデル・並列数・保存先','backend/app/config.py、llm/adk.py、llm/vertex_auth.py']])+
h('認証と保存','フロントはBearerトークンを送信します。APIは認証ユーザーに紐づく一覧や所有権を確認します。401を受けるとフロント側の認証状態をクリアします。JSONダウンロードはサーバー保存とは別の書き出しです。')+
h('障害を切り分ける順序','①対象の地図とノードID、操作、時刻を特定 → ②分解と問題のどちらが待機・失敗か確認 → ③APIの状態コードと完了結果を確認 → ④背景ジョブと保存状態を確認 → ⑤AI呼び出しや認証・設定を確認。APIキー・トークン・個人の会話本文を不用意に共有しないでください。')+
h('既定モデルについて','ソースの既定値はgemini-3.5-flash-liteです。環境変数で上書き可能なので、この記載だけで公開サーバーが同モデルを使っているとは断定できません。利用経路・認証もデプロイ設定に依存します。')+
note('この資料はコードを読んで実装を説明したものです。エラーが起きないことや、生成内容の正しさを保証するものではありません。今回の作成ではアプリの動作を変更せず、マニュアルのレイアウトと出力を検証しています。'))
];
const css=`@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8eade;color:#203d35;font:14px/1.8 'Yu Gothic','Meiryo',sans-serif}.sheet{width:210mm;height:297mm;background:#fffdf7;margin:16px auto;padding:13mm 15mm 17mm;position:relative;break-after:page}.sheet:last-child{break-after:auto}header,footer{display:flex;justify-content:space-between;color:#6b7e70;font-size:10px}header{border-bottom:1px solid #bfc9b4;padding-bottom:8px}footer{position:absolute;bottom:9mm;left:15mm;right:15mm;border-top:1px solid #bfc9b4;padding-top:5px}h1{font-size:25px;line-height:1.45;margin:17px 0 5px}h2{font-size:16px;margin:15px 0 5px;border-left:3px solid #b29c52;padding-left:9px}h3{font-size:14px;margin:0 0 3px}p{margin:5px 0 10px}.lead{font-size:11px;color:#657969;margin-bottom:16px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.cards article{display:flex;align-items:center;padding:8px 9px 8px 0;border:1px solid #d6decb;background:#f4f6eb;border-radius:6px;min-height:105px}.cards img{width:81px;height:77px;object-fit:contain;flex-shrink:0;image-rendering:pixelated}.cards p{font-size:12px;line-height:1.65;margin:0}aside{font-size:12px;background:#ecf0e3;border-left:3px solid #648669;padding:10px 13px;margin:14px 0}table{width:100%;border-collapse:collapse;font-size:12.5px;margin:12px 0}th{text-align:left;background:#e8eedf;padding:8px}td{border-bottom:1px solid #dce2d2;padding:8px;vertical-align:top}td:first-child{width:32%;font-weight:600}ol{padding-left:25px}li{padding:3px 0 5px}.flow{display:flex;gap:7px;margin:16px 0}.flow>div{flex:1;background:#eaf0e0;border-top:3px solid #4c7462;padding:9px;font-size:12px}.flow b{display:block;color:#839971;font-size:18px}.flow span{display:block}@media print{body{background:white}.sheet{margin:0}}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const tab=await browser.newPage({viewport:{width:1100,height:1200}});
 for(const [name,pages] of [['簡易ユーザーマニュアル',quick],['詳細ユーザーマニュアル',detailed],['動作・ロジック解説',logic]]){
  const title='IntellectusMap_'+name;
  const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>${title}</title><style>${css}</style><body>${pages.map((s,i)=>`<section class="sheet"><header><span>IntellectusMap / 知図</span><span>2026.10.13</span></header><h1>${s.title}</h1><p class="lead">${s.sub}</p><main>${s.body}</main><footer><span>${name} · 実装基準 2026-10-13更新版</span><span>${i+1} / ${pages.length}</span></footer></section>`).join('')}</body></html>`;
  await fs.writeFile(path.join(out,title+'.html'),html);
  await tab.setContent(html,{waitUntil:'load'});await tab.emulateMedia({media:'print'});await tab.evaluate(()=>document.fonts.ready);
  const overflow=await tab.locator('.sheet').evaluateAll(ss=>ss.map((s,i)=>({page:i+1,bottom:s.querySelector('main').getBoundingClientRect().bottom,limit:s.querySelector('footer').getBoundingClientRect().top-15})).filter(x=>x.bottom>x.limit));
  if(overflow.length)throw Error(title+' overflow '+JSON.stringify(overflow));
  await tab.pdf({path:path.join(out,title+'.pdf'),printBackground:true,preferCSSPageSize:true});
  console.log(title+': '+pages.length+' pages; layout bounds OK');
 }
}finally{await browser.close();}
await import('./sync-user-manuals.mjs');
