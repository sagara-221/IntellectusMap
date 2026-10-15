import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
import type {Diagnosis,KnowledgeNode} from '../src/types';

const requestPage=(page:Page)=>page.locator('#page-request');

test('manual menu switches editions and returns to the exploration screen',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'ユーザーマニュアル',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'ユーザーマニュアル'});
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('iframe')).toHaveAttribute('src','/manuals/quick.html');
  await expect(page.frameLocator('iframe[title="簡易ユーザーマニュアル"]').getByRole('heading',{name:'まずは、ひとつ地図を作る'})).toBeVisible();
  await dialog.getByRole('button',{name:'詳細版',exact:true}).click();
  await expect(page.frameLocator('iframe[title="詳細ユーザーマニュアル"]').getByRole('heading',{name:'画面の入口と、最初の探索'})).toBeVisible();
  await expect(dialog.getByRole('link',{name:'PDFを開く'})).toHaveAttribute('href','/manuals/detailed.pdf');
  const pdf=await page.request.get('/manuals/detailed.pdf');
  expect(pdf.ok()).toBeTruthy();
  expect((await pdf.body()).subarray(0,5).toString()).toBe('%PDF-');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.app-shell.live-atlas')).toBeVisible();
});

test('the homepage opens the atlas and the legacy URL remains available',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.app-shell.live-atlas')).toBeVisible();
  await expect(page.getByRole('link',{name:'元の画面へ'})).toHaveCount(0);
  await page.goto('/legacy.html');
  await expect(page.locator('.app-shell.live-atlas')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'地図の画面へ'})).toHaveAttribute('href','/');
});

test('stream displays server errors containing JSON instead of a missing-result error',async({page})=>{
  const detail='Invalid JSON payload received: unsupported schema field';
  await page.route('**/api/sessions',route=>route.request().method()==='POST'
    ?route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify({type:'error',detail})}\n\n`})
    :route.fallback());
  await page.goto('/atlas.html');
  await page.getByRole('button',{name:'このテーマを探索する'}).click();
  await expect(page.getByText(detail,{exact:true})).toBeVisible();
  await expect(page.getByText('サーバーからの完了レスポンスを受信できませんでした。')).toHaveCount(0);
});

test('stream reads the final result even without a trailing newline',async({page})=>{
  await page.route('**/api/stream-check',route=>route.fulfill({contentType:'text/event-stream',body:'data:{"type":"result","data":{"ok":true}}'}));
  await page.goto('/atlas.html');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/api.ts';
    const {apiStream}=await import(modulePath);
    return apiStream('/stream-check');
  });
  expect(result).toEqual({ok:true});
});

test('stream resolves when the result arrives even if the connection stays open',async({page})=>{
  await page.goto('/atlas.html');
  const outcome=await page.evaluate(async()=>{
    const originalFetch=window.fetch;
    let cancelled=false;
    window.fetch=((input,init)=>String(input).endsWith('/stream-holds-open')
      ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller){controller.enqueue(new TextEncoder().encode('data:{"type":"result","data":{"ok":true}}\n\n'));},
        cancel(){cancelled=true;},
      }),{headers:{'Content-Type':'text/event-stream'}}))
      : originalFetch(input,init)) as typeof fetch;
    try{
      const {apiStream}=await import('/src/api.ts');
      const result=await Promise.race([
        apiStream<{ok:boolean}>('/stream-holds-open'),
        new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('完了イベントの後も通信を待ち続けました')),1000)),
      ]);
      return {result,cancelled};
    }finally{window.fetch=originalFetch;}
  });
  expect(outcome).toEqual({result:{ok:true},cancelled:true});
});

async function start(page:Page,generationTimeout=15000){
  await page.goto('/atlas.html');
  await page.getByRole('button',{name:'このテーマを探索する'}).click();
  await expect(page.locator('[data-node="power"]')).toBeVisible();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async()=> (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete,{timeout:generationTimeout}).toBe(true);
  await page.getByLabel('チャットを閉じる',{exact:true}).click();
  return sid;
}
async function select(page:Page,id='power'){
  // Keyboard activation works even if an open notebook overlaps this node.
  await page.locator(`[data-node="${id}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(requestPage(page)).toBeVisible();
}
async function openConnectionMap(page:Page){
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await expect(page.locator('.connection-lineage-card').first()).toBeVisible();
  await page.locator('.connection-lineage-card').first().getByRole('button',{name:'地図を開く'}).click();
  await expect(page.locator('.map-connections')).toBeVisible();
}

test('selecting a map node opens the notebook even while chat is open',async({page})=>{
  await page.goto('/atlas.html');
  await page.getByRole('button',{name:'このテーマを探索する'}).click();
  await expect(page.locator('[data-node="power"]')).toBeVisible({timeout:45000});
  await expect(page.locator('#atlas-chat')).toBeVisible();
  await page.locator('[data-node="power"]').focus();
  await page.keyboard.press('Enter');
  await expect(requestPage(page)).toBeVisible();
  await expect(page.locator('#atlas-chat')).toBeHidden();
});

test('map width stays fixed; notebook pages preserve choice and original screen remains available',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const sid=await start(page);await select(page);
  const map=page.locator('.map-surface');const openWidth=(await map.boundingBox())!.width;
  await page.getByLabel('調査手帳を閉じる',{exact:true}).click();
  await expect(page.getByLabel('調査手帳を開く',{exact:true})).toBeVisible();
  expect((await map.boundingBox())!.width).toBe(openWidth);
  await page.getByLabel('調査手帳を開く',{exact:true}).click();
  await expect(page.getByLabel('調査手帳を開く',{exact:true})).toBeHidden();
  await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
  await expect(page.locator('#page-question')).toHaveCount(0);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  const question=page.locator('#page-question');await expect(question.locator('.choices')).toBeVisible();
  await expect(page.getByRole('tab',{name:/問題・回答/})).toBeVisible();
  await expect(question.locator('.survey-options')).toHaveCount(0);
  await question.locator('.choice').first().click();
  await page.getByRole('tab',{name:/調査記録/}).click();
  await page.getByRole('tab',{name:'02 問題・回答'}).click();
  await expect(question.locator('.choice').first()).toHaveAttribute('aria-pressed','true');
  await page.getByLabel('調査手帳を広げる').click();
  expect((await map.boundingBox())!.width).toBe(openWidth);
  const notebook=(await page.locator('#atlas-notebook').boundingBox())!;
  const camp=(await page.locator('.crew-camp').boundingBox())!;
  expect(camp.x+camp.width).toBeLessThan(notebook.x);
  expect(notebook.x+notebook.width).toBeLessThanOrEqual(1440);
  await expect(question.locator('.choice').first()).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:'test-results/atlas-notebook.png'});
  await question.getByRole('button',{name:'回答して次へ'}).click();
  await expect(question.locator('.feedback')).toBeVisible();
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(saved.questions_answered).toBe(1);
  expect(saved.evidence[0].concept_id).toBe('power');
  await page.getByRole('tab',{name:/調査記録/}).click();
  await expect(page.locator('#page-record .evidence-detail')).toContainText('回答の記録');
  await page.goto('/legacy.html');
  await expect(page.locator('.react-flow')).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'))).toBe(sid);
  expect(errors).toEqual([]);
});

test('questions and answer feedback belong only to their selected node',async({page})=>{
  await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  const question=page.locator('#page-question');
  await expect(question.locator('.choices')).toBeVisible();
  const text=await question.locator('.question-markdown').textContent();
  await question.locator('.choice').first().click();
  await select(page,'meaning');
  await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
  await expect(question).toHaveCount(0);
  await select(page,'power');
  await page.getByRole('tab',{name:/問題・回答/}).click();
  await expect(question.locator('.question-markdown')).toHaveText(text!);
  await expect(question.locator('.choice').first()).toHaveAttribute('aria-pressed','true');
  await question.getByRole('button',{name:'回答して次へ'}).click();
  await expect(question.locator('.feedback')).toBeVisible();
  await select(page,'meaning');
  await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
  await select(page,'power');
  await page.getByRole('tab',{name:/問題・回答/}).click();
  await expect(question.locator('.feedback')).toBeVisible();
});

test('questions opened on two nodes can be resumed without borrowing the other question',async({page})=>{
  await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  await expect(page.locator('#page-question .choices')).toBeVisible();
  const firstText=await page.locator('#page-question .question-markdown').textContent();
  await select(page,'meaning');
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  await expect(page.locator('#page-question .choices')).toBeVisible();
  const secondText=await page.locator('#page-question .question-markdown').textContent();
  expect(firstText).not.toBe(secondText);
  await select(page,'power');
  await page.getByRole('tab',{name:/問題・回答/}).click();
  await expect(page.locator('#page-question .question-markdown')).toHaveCount(0);
  await page.getByRole('button',{name:'この項目の問題を再開する'}).click();
  await expect(page.locator('#page-question .question-markdown')).toHaveText(firstText!);
  await select(page,'meaning');
  await page.getByRole('tab',{name:/問題・回答/}).click();
  await page.getByRole('button',{name:'この項目の問題を再開する'}).click();
  await expect(page.locator('#page-question .question-markdown')).toHaveText(secondText!);
});

test('pending question creation stays on its node after selection changes',async({page})=>{
  const sid=await start(page);await select(page);
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/sessions/${sid}/select`,async route=>{await held;await route.continue();});
  try{
    const request=page.waitForRequest(r=>r.url().endsWith(`/sessions/${sid}/select`));
    await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
    await request;
    await expect(page.getByRole('tab',{name:/問題・回答/})).toBeVisible();
    await select(page,'meaning');
    await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
    await expect(requestPage(page).getByText('処理しています…',{exact:true})).toHaveCount(0);
  }finally{release();}
  await expect.poll(async()=> (await (await page.request.get(`/api/sessions/${sid}`)).json()).next_question?.concept_id).toBe('power');
  await expect(page.locator('[data-node="meaning"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
  await select(page,'power');
  await page.getByRole('tab',{name:/問題・回答/}).click();
  await expect(page.locator('#page-question .choices')).toBeVisible();
});

for(const fail of [false,true])test(`expansion shows node-specific loading and clears after ${fail?'failure':'success'}`,async({page})=>{
  const sid=await start(page);
  const original=await (await page.request.get(`/api/sessions/${sid}`)).json() as Diagnosis;
  let snapshot=structuredClone(original);snapshot.revision+=100;
  snapshot.knowledge_tree.child_nodes.find(n=>n.concept_id==='power')!.child_nodes=[];
  snapshot.concept_edges=snapshot.concept_edges.filter(edge=>edge.source!=='power'||edge.relation!=='part');
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:snapshot}));
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  let requests=0;
  await page.route(`**/api/sessions/${sid}/decompose`,async route=>{
    requests++;await held;
    if(fail)return route.fulfill({status:500,json:{detail:'展開テストのエラー'}});
    snapshot={...original,revision:snapshot.revision+1};
    await route.fulfill({json:snapshot});
  });
  try{
    await page.reload();await select(page);
    await requestPage(page).getByRole('button',{name:'問題を飛ばして下位項目を展開'}).click();
    const loading=requestPage(page).getByRole('button',{name:'下位項目を展開しています…'});
    await expect(loading).toHaveAttribute('aria-busy','true');
    await expect(loading).toBeDisabled();
    await expect(loading.locator('.spin')).toBeVisible();
    await select(page,'meaning');
    await expect(loading).toHaveCount(0);
    await expect(requestPage(page).getByRole('button',{name:'問題を飛ばして下位項目を展開'})).toBeEnabled();
    await select(page,'power');
    await expect(loading).toBeVisible();
    expect(requests).toBe(1);
  }finally{release();}
  await expect(requestPage(page).getByRole('button',{name:'下位項目を展開しています…'})).toHaveCount(0);
  if(fail)await expect(requestPage(page).getByRole('button',{name:'問題を飛ばして下位項目を展開'})).toBeEnabled();
  else await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
});

test('map badges distinguish answers, conversation estimates and provisional chat nodes',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json() as Diagnosis;
  const ids=saved.knowledge_tree.child_nodes.slice(0,3).map(node=>node.concept_id);
  for(const [index,id] of ids.entries())saved.understanding_summaries[id]={
    ...saved.understanding_summaries[id],level:index===1?'medium':'low',score:index===1?.5:.2,confidence_level:'low',confidence_score:.1,
    source:index===0?'question':index===1?'conversation':'mixed',
    evidence_sources:index===0?['question']:index===1?['conversation']:['question','conversation'],
    provisional:index===1,
  };
  saved.revision+=100;
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await page.reload();
  await expect(page.locator(`[data-node="${ids[0]}"] [data-assessment-source="question"]`)).toBeVisible();
  await expect(page.locator(`[data-node="${ids[0]}"] [data-assessment-source="conversation"]`)).toHaveCount(0);
  const provisional=page.locator(`[data-node="${ids[1]}"]`);
  await expect(provisional.locator('[data-assessment-source="conversation"]')).toHaveAttribute('data-provisional','true');
  await expect(provisional.locator('[data-level]')).toHaveAttribute('data-level','medium');
  await expect(provisional.locator('.certainty-flag')).toHaveAttribute('data-certainty','limited');
  await expect(provisional).toHaveAttribute('title',/暫定・未検証/);
  await expect(page.locator(`[data-node="${ids[2]}"] .assessment-source-icon`)).toHaveCount(2);
  await page.screenshot({path:'test-results/atlas-assessment-sources.png'});
});

test('self report saves server summary and automatically reveals lower nodes without a question',async({page})=>{
  const sid=await start(page);await select(page);
  await expect(page.locator('[data-node="power_identify"]')).toHaveCount(0);
  await requestPage(page).getByRole('button',{name:'理解できている',exact:true}).click();
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
  await expect(page.locator('[data-node="power"]')).toHaveAttribute('aria-pressed','true');
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(saved.self_assessments.power.level).toBe('high');
  expect(saved.question_history).toEqual([]);
  expect(saved.understanding_summaries.power.source).toBe('self_report');
  expect(saved.understanding_summaries.power.score).toBeGreaterThan(.7);
  await page.reload();
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
});

test('the request page explains what is pending while a self assessment is being saved',async({page})=>{
  const sid=await start(page);await select(page);
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/sessions/${sid}/self-assessment`,async route=>{
    await held;
    await route.continue();
  });
  try{
    await requestPage(page).getByRole('button',{name:'理解できている',exact:true}).click();
    await expect(requestPage(page).locator('.request-progress')).toContainText('理解度を保存しています');
    await expect(page.getByRole('tab',{name:/問題・回答/})).toHaveCount(0);
  }finally{release();}
  await expect(requestPage(page).locator('.request-progress')).toHaveCount(0);
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
});

test('chat-created descendants reveal folded ancestors and each new layer automatically',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json() as Diagnosis;
  const parent=saved.knowledge_tree.child_nodes.find(node=>node.concept_id==='power')!;
  const child=parent.child_nodes[0];
  expect(child).toBeDefined();
  const grandchild={...child,concept_id:'chat_generated_grandchild',concept_name:'会話で作られた下位項目',
    depth:child.depth+1,parent_concept_id:child.concept_id,parent_ids:[child.concept_id],
    child_nodes:[],child_candidates:[],assessment_targets:[]};
  child.child_nodes.push(grandchild);
  saved.revision+=100;
  saved.chat!.background_status='running';
  saved.chat!.opened_concept_ids=[];
  saved.chat!.created_concept_ids=[];
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await page.route(`**/api/sessions/${sid}/chat`,route=>route.request().method()==='GET'
    ?route.fulfill({json:saved}):route.fallback());
  await page.reload();
  await expect(page.locator(`[data-node="${child.concept_id}"]`)).toHaveCount(0);
  const surface=await page.locator('.map-surface').boundingBox();
  expect(surface).not.toBeNull();
  await page.mouse.move(surface!.x+50,surface!.y+surface!.height-40);
  await page.mouse.down();
  await page.mouse.move(surface!.x+330,surface!.y+surface!.height-210,{steps:5});
  await page.mouse.up();
  saved.chat!.created_concept_ids=[grandchild.concept_id];saved.revision++;
  await expect(page.locator(`[data-node="${child.concept_id}"]`)).toBeVisible();
  await expect(page.locator('[data-node="chat_generated_grandchild"]')).toBeVisible();
  await expect.poll(async()=>{
    const map=await page.locator('.map-surface').boundingBox();
    const node=await page.locator('[data-node="chat_generated_grandchild"]').boundingBox();
    return !!map&&!!node&&node.x>=map.x&&node.y>=map.y&&node.x+node.width<=map.x+map.width&&node.y+node.height<=map.y+map.height;
  }).toBe(true);
  const greatGrandchild={...grandchild,concept_id:'chat_generated_great_grandchild',concept_name:'会話で作られたさらに下位の項目',
    depth:grandchild.depth+1,parent_concept_id:grandchild.concept_id,parent_ids:[grandchild.concept_id],child_nodes:[]};
  grandchild.child_nodes.push(greatGrandchild);
  saved.chat!.created_concept_ids.push(greatGrandchild.concept_id);saved.revision++;
  await expect(page.locator('[data-node="chat_generated_great_grandchild"]')).toBeVisible();
});

test('prepared self assessment keeps ready icon and reveals children before a delayed publish response',async({page})=>{
  const sid=await start(page);
  const original=await (await page.request.get(`/api/sessions/${sid}`)).json() as Diagnosis;
  let snapshot=structuredClone(original);
  const originalPower=original.knowledge_tree.child_nodes.find(n=>n.concept_id==='power')!;
  snapshot.knowledge_tree.child_nodes.find(n=>n.concept_id==='power')!.child_nodes=[];
  snapshot.decomposition_statuses={...snapshot.decomposition_statuses,power:'ready'};
  snapshot.revision+=100;
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:snapshot}));
  await page.route(`**/api/sessions/${sid}/self-assessment`,async route=>{
    snapshot={...snapshot,revision:snapshot.revision+1,self_assessments:{...snapshot.self_assessments,power:{level:'high',answered_at:new Date().toISOString()}}};
    await route.fulfill({json:snapshot});
  });
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/sessions/${sid}/decompose`,async route=>{await held;await route.fulfill({json:snapshot});});
  try {
    await page.reload();await select(page);
    const publish=page.waitForRequest(r=>r.url().endsWith(`/sessions/${sid}/decompose`));
    await requestPage(page).getByRole('button',{name:'理解できている',exact:true}).click();await publish;
    await expect(page.locator('[data-node="power"] [data-decomposition]')).toHaveAttribute('data-decomposition','ready');
    await expect(page.getByText('下位項目を地図に反映しています…')).toBeVisible();
    snapshot=structuredClone(snapshot);snapshot.revision++;
    snapshot.knowledge_tree.child_nodes.find(n=>n.concept_id==='power')!.child_nodes=originalPower.child_nodes;
    await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
    await expect(page.locator('[data-node="power"]')).toHaveAttribute('aria-pressed','true');
  } finally {release();}
});

test('self assessment uses children in the latest save response without requesting decomposition',async({page})=>{
  const sid=await start(page);
  const original=await (await page.request.get(`/api/sessions/${sid}`)).json() as Diagnosis;
  let snapshot=structuredClone(original);snapshot.revision+=100;
  snapshot.knowledge_tree.child_nodes.find(n=>n.concept_id==='power')!.child_nodes=[];
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:snapshot}));
  await page.route(`**/api/sessions/${sid}/self-assessment`,async route=>{
    snapshot={...original,revision:snapshot.revision+1,self_assessments:{...original.self_assessments,power:{level:'high',answered_at:new Date().toISOString()}}};
    await route.fulfill({json:snapshot});
  });
  let decompositions=0;
  await page.route(`**/api/sessions/${sid}/decompose`,async route=>{decompositions++;await route.fulfill({json:snapshot});});
  await page.reload();await select(page);
  await requestPage(page).getByRole('button',{name:'理解できている',exact:true}).click();
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
  expect(decompositions).toBe(0);
});

test('lower items expand before question generation and understanding stays unchanged',async({page})=>{
  const sid=await start(page);await select(page);
  const before=await (await page.request.get(`/api/sessions/${sid}`)).json();
  await requestPage(page).getByRole('button',{name:'問題を飛ばして下位項目を展開'}).click();
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
  const after=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(after.self_assessments).toEqual(before.self_assessments);
  expect(after.question_history).toEqual([]);
  expect(after.understanding_summaries).toEqual(before.understanding_summaries);
});

test('conversation uses bearer authentication and persists across notebook pages and reload',async({page})=>{
  const sid=await start(page);await select(page);
  await openChat(page);
  await page.getByLabel('話したいこと').fill('デモ: 係数と指数を分けて、式の計算手順を説明します。');
  const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith(`/sessions/${sid}/chat`));
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  expect((await request).headers().authorization).toMatch(/^Bearer test_/);
  await expect(page.locator('.chat-message.assistant')).toContainText('経験と迷っている部分');
  await page.getByLabel('チャットを閉じる',{exact:true}).click();
  await openChat(page);
  await expect(page.locator('.chat-message.user')).toHaveCount(1);
  await page.reload();await expect(page.getByLabel('調査手帳を閉じる',{exact:true})).toBeVisible();await openChat(page);
  await expect(page.locator('.chat-message.user')).toHaveCount(1);
  const saved=await (await page.request.get(`/api/sessions/${sid}/chat`)).json();
  expect(saved.self_assessments.power).toBeUndefined();
  expect(saved.chat.messages.length).toBe(2);
  await page.getByLabel('チャットを閉じる',{exact:true}).click();
  await page.getByLabel('調査手帳を開く',{exact:true}).click();
  await page.getByRole('tab',{name:/調査記録/}).click();
  await expect(page.locator('#page-record .conversation-evidence')).toContainText('係数と指数');
});

test('map management, connection map and node list retain the current application functions',async({page})=>{
  await start(page);
  await expect(page.locator('.root-site .start-landmark')).toBeVisible();
  await page.screenshot({path:'test-results/atlas-start-node.png'});
  for(const name of ['深堀マップ一覧','繋がりMAP一覧','知識ノード一覧']){
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.locator('main')).toContainText('微分');
    if(name==='繋がりMAP一覧'){
      await expect(page.locator('.connection-page h1')).toHaveText('繋がりMAP一覧');
      await page.locator('.connection-lineage-card').first().getByRole('button',{name:'地図を開く'}).click();
      await expect(page.locator('.connection-page h1')).toHaveText('微分の繋がりMAP');
      await expect(page.locator('.connection-legend')).toContainText('未探索');
      await page.screenshot({path:'test-results/atlas-connection-map.png'});
    }
  }
  await page.getByRole('button',{name:'探索',exact:true}).click();
  await expect(page.locator('.live-map')).toBeVisible();
});

test('compact screen keeps question scrollable inside the notebook',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  await expect(page.locator('#page-question .choices')).toBeVisible();
  await page.locator('#page-question .choice').last().click();
  await expect(page.locator('#page-question .choice').last()).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/atlas-mobile.png'});
});

test('a late response keeps the newer selection and stale polling cannot undo understanding',async({page})=>{
  const sid=await start(page);await select(page);
  const before=await (await page.request.get(`/api/sessions/${sid}`)).json();
  await page.route(`**/api/sessions/${sid}`,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    await route.fulfill({json:before});
  });
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/sessions/${sid}/self-assessment`,async route=>{
    await held;await route.continue();
  });
  await requestPage(page).getByRole('button',{name:'理解できている',exact:true}).click();
  await select(page,'meaning');release();
  await expect(page.locator('[data-node="power_identify"]')).toBeVisible();
  await expect(page.locator('[data-node="meaning"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('[data-node="power"]')).toHaveAttribute('title',/90%/);
  // Observe another GET after the new result; the older snapshot must be ignored.
  await page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith(`/sessions/${sid}`));
  await expect(page.locator('[data-node="power"]')).toHaveAttribute('title',/90%/);
  await expect(page.locator('[data-node="meaning"]')).toHaveAttribute('aria-pressed','true');
});

test('queued workers stay in camp; simultaneous miners stay next to nodes after zoom',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.decomposition_statuses={...saved.decomposition_statuses,power:'generating',meaning:'generating',product:'queued'};
  saved.agent_runtime.revision+=100;
  saved.agent_runtime.jobs=['power','meaning','product'].map(id=>({job_id:id,session_id:sid,role:'miner',concept_id:id,source:'prefetch',status:id==='product'?'queued':'running',error:null,retryable:false,updated_at:1}));
  saved.agent_runtime.counts.miner={capacity:5,running:2,queued:1,idle:3};
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(page.locator('[data-agent="miner-power"]')).toBeVisible();
  await expect(page.locator('[data-agent="miner-meaning"]')).toBeVisible();
  await expect(page.locator('[data-agent="miner-product"]')).toHaveCount(0);
  await expect(page.locator('[data-node="product"] [data-decomposition]')).toHaveAttribute('data-decomposition','queued');
  await expect(page.locator('[data-crew="miner"] .crew-count')).toHaveText('×3');
  await expect(page.locator('[data-agent="miner-power"]')).toHaveClass(/work/);
  await expect(page.locator('.atlas-map')).toHaveAttribute('data-layout','settled');
  const relative=()=>page.evaluate(()=>{
    const agent=document.querySelector<HTMLElement>('[data-agent="miner-power"]')!;
    const node=document.querySelector<HTMLElement>('[data-node="power"]')!;
    return [parseFloat(agent.style.left)-parseFloat(node.style.left),parseFloat(agent.style.top)-parseFloat(node.style.top)];
  });
  expect(await relative()).toEqual([22,-32]);
  const zoomBefore=await page.locator('.map-controls span').innerText();
  await page.mouse.move(180,450);await page.mouse.wheel(0,-100);
  await expect(page.locator('.map-controls span')).not.toHaveText(zoomBefore);
  expect(await relative()).toEqual([22,-32]);
});

for(const capacity of [10,20])for(const width of [1440,390])test(`${capacity} workers update camp counts and occupy separate positions at width ${width}`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  const sid=await start(page);
  const saved:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(saved.agent_capacities).toMatchObject({miner:20,evaluation:20,recorder:20});
  saved.agent_capacities={...saved.agent_capacities,miner:capacity};
  saved.revision+=100;
  saved.agent_runtime.revision+=100;
  saved.agent_runtime.jobs=Array.from({length:capacity},(_,index)=>({
    job_id:`workers-${index}`,session_id:sid,role:'miner' as const,concept_id:'power',
    source:'prefetch',status:'running' as const,error:null,retryable:false,updated_at:Date.now()/1000,
  }));
  saved.agent_runtime.counts.miner={capacity,running:capacity,queued:2,idle:0};
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  const workers=page.locator('[data-agent^="miner-workers-"]');
  await expect(workers).toHaveCount(capacity);
  await expect(page.locator('[data-crew="miner"]')).toHaveAttribute('aria-label',new RegExp(`最大 ${capacity}体（作業中 ${capacity}体`));
  await expect(page.locator('[data-crew="miner"] .crew-count')).toHaveText('×0');
  await expect(page.locator('.crew-camp strong small')).toHaveText(`${capacity} 稼働中`);
  await expect(workers.last()).toHaveClass(/work/);
  const positions=await workers.evaluateAll(elements=>elements.map(element=>{
    const style=(element as HTMLElement).style;
    return {x:parseFloat(style.left),y:parseFloat(style.top)};
  }));
  for(let index=0;index<positions.length;index++)for(const other of positions.slice(index+1)){
    expect(Math.abs(positions[index].x-other.x)>=36||Math.abs(positions[index].y-other.y)>=36).toBe(true);
  }
  await page.screenshot({path:`test-results/${capacity}-workers-${width}.png`});
  saved.revision++;
  saved.agent_runtime.revision++;
  saved.agent_runtime.jobs=[];
  saved.agent_runtime.counts.miner={capacity,running:0,queued:0,idle:capacity};
  await expect(workers).toHaveCount(0);
  await expect(page.locator('[data-crew="miner"] .crew-count')).toHaveText(`×${capacity}`);
  await expect(page.locator('.crew-camp strong small')).toHaveText('0 稼働中');
});

test('connection map presents newly discovered routes on the wide-area chart',async({page})=>{
  await start(page);await select(page);
  await page.getByRole('tab',{name:/調査記録/}).click();
  await page.locator('#page-record').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(page.locator('.map-connections')).toHaveAttribute('data-layout','settled');
  await expect(page.locator('.connection-page h1')).toHaveText('微分の繋がりMAP');
  await expect(page.locator('.connection-page > .connection-generation')).toHaveCount(0);
  await expect(page.locator('.connection-detail .connection-generation')).toContainText('新しい候補 5件');
  await expect(page.locator('.connection-detail-heading button[aria-pressed="true"]')).toContainText('未探索の候補');
  await expect(page.locator('.connection-detail')).toBeVisible();
  const chart=await page.locator('.map-connections').boundingBox();
  const notes=await page.locator('.connection-detail').boundingBox();
  expect(notes!.x).toBeGreaterThanOrEqual(chart!.x);
  expect(notes!.x+notes!.width).toBeLessThanOrEqual(chart!.x+chart!.width);
  await page.screenshot({path:'test-results/atlas-connection-routes.png'});
});

test('connection scout travels to the source and the in-map notes can be folded',async({page})=>{
  await start(page);
  await openConnectionMap(page);
  await expect(page.getByRole('button',{name:'繋がりMAPの調査手帳を開く'})).toBeVisible();
  const chart=page.locator('.map-connections');
  const width=(await chart.boundingBox())!.width;
  await page.getByRole('button',{name:'繋がりMAPの調査手帳を開く'}).click();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve});
  await page.route('**/api/maps/*/concepts/*/divergence',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    await held;
    await route.continue();
  });
  await page.getByRole('button',{name:'このMAPから繋がりを探す'}).click();
  const scout=page.locator('[data-connection-agent="survey"]');
  await expect(scout).toBeVisible();
  await expect(page.locator('.connection-camp-away')).toHaveText('出動中');
  await expect(scout.locator('.task-moving')).toHaveCSS('animation-name','inspect-work');
  await page.screenshot({path:'test-results/atlas-connection-agent.png'});
  release();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(scout).toHaveCount(0);
  await expect(page.locator('.connection-camp .miner')).toBeVisible();
  await page.getByRole('button',{name:'調査手帳を閉じる'}).click();
  await expect(page.getByRole('button',{name:'繋がりMAPの調査手帳を開く'})).toBeVisible();
  expect((await chart.boundingBox())!.width).toBe(width);
  await page.locator('.connection-new-candidate').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.connection-detail')).toContainText('未探索の候補');
});

test('connection nodes can grow another branch without leaving the connection map',async({page})=>{
  await start(page);
  await openConnectionMap(page);
  await expect(page.locator('.connection-root .icon-root').first()).toBeVisible();
  await page.getByRole('button',{name:'繋がりMAPの調査手帳を開く'}).click();
  await page.getByRole('button',{name:'このMAPから繋がりを探す'}).click();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(page.locator('.connection-new-candidate .icon-candidate').first()).toBeVisible();
  await expect.poll(()=>page.locator('.map-connections .react-flow__edge-text').count()).toBeGreaterThanOrEqual(5);
  await page.locator('.connection-candidate-list>button').first().click();
  const selectedCandidateId=await page.locator('.connection-candidate.connection-map-selected').getAttribute('data-id');
  const candidateRelation=await page.locator('.connection-origin p').nth(1).innerText();
  const candidateEdge=page.locator(`.react-flow__edge[data-id="candidate-edge-${selectedCandidateId}"]`);
  await expect(candidateEdge).toHaveAttribute('aria-label',candidateRelation);
  await expect(candidateEdge.locator('.react-flow__edge-text')).not.toBeEmpty();
  let releaseCreation!:()=>void;
  const heldCreation=new Promise<void>(resolve=>{releaseCreation=resolve});
  await page.route('**/api/maps/*/concepts/*/divergence/*/create',async route=>{
    await heldCreation;
    await route.continue();
  });
  await page.getByRole('button',{name:'さらに広げる',exact:true}).click();
  const builder=page.locator('[data-connection-agent="build"]');
  await expect(builder).toBeVisible();
  await expect(builder.locator('.task-moving')).toHaveCSS('animation-name','hammer-work');
  await page.screenshot({path:'test-results/atlas-connection-builder.png'});
  releaseCreation();
  await expect(page.locator('.map-connections .react-flow__node:not(.connection-candidate)')).toHaveCount(2,{timeout:30000});
  await expect(page.locator('.map-connections .react-flow__edge:not([data-id^="candidate-edge-"]) .react-flow__edge-text').first()).not.toBeEmpty();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(page.locator('.map-connections')).toHaveAttribute('data-layout','settled');
  await expect.poll(async()=>{
    const chart=await page.locator('.map-connections').boundingBox();
    const map=await page.locator('.map-connections .react-flow__node:not(.connection-root):not(.connection-candidate)').first().boundingBox();
    if(!chart||!map)return Infinity;
    return Math.hypot(map.x+map.width/2-chart.x-chart.width/2,map.y+map.height/2-chart.y-chart.height/2);
  }).toBeLessThan(150);
  await expect(page.locator('.connection-page')).toBeVisible();
  await page.screenshot({path:'test-results/atlas-connection-second-branch.png'});
  const derived=page.locator('.map-connections .react-flow__node:not(.connection-root):not(.connection-candidate)').first();
  await derived.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.connection-detail .connection-concept-expand').first()).toBeVisible();
  await page.locator('.connection-detail .connection-concept-expand').first().click();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  expect(await page.locator('.map-connections .connection-candidate').count()).toBeGreaterThanOrEqual(14);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  expect(await page.locator('.react-flow__minimap-node').count()).toBeGreaterThan(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/atlas-connection-mobile-branches.png'});
});

test('hidden targets and map-wide recording remain visible with task-specific motions',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  const parent=saved.knowledge_tree.child_nodes.find((node:KnowledgeNode)=>node.concept_id==='power')!;
  const hidden:KnowledgeNode={...parent,concept_id:'hidden_worker_node',concept_name:'隠れた枝',depth:2,
    parent_concept_id:'power',parent_ids:['power'],child_nodes:[],assessment_targets:[],child_candidates:[]};
  parent.child_nodes.push(hidden);
  const running=(job_id:string,role:string,concept_id:string|null,source:string)=>({job_id,session_id:sid,role,concept_id,source,status:'running',error:null,retryable:false,updated_at:Date.now()/1000});
  saved.agent_runtime.revision+=1000;
  saved.agent_runtime.jobs=[
    running('hidden-split','miner','hidden_worker_node','prefetch'),
    running('hidden-build','miner','hidden_worker_node','chat_addition'),
    running('question','question','power','question_generation'),
    running('grading','evaluation','power','answer'),
    running('unassigned','evaluation',null,'chat_assessment'),
    running('record','recorder',null,'chat_extract'),
    running('planning','recorder','power','chat_structure'),
  ];
  saved.agent_runtime.counts.miner={capacity:5,running:2,queued:0,idle:3};
  saved.agent_runtime.counts.question={capacity:1,running:1,queued:0,idle:0};
  saved.agent_runtime.counts.evaluation={capacity:5,running:2,queued:0,idle:3};
  saved.agent_runtime.counts.recorder={capacity:5,running:2,queued:0,idle:3};
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(page.locator('[data-node="hidden_worker_node"]')).toHaveCount(0);
  await expect(page.locator('[data-agent="miner-hidden-split"]')).toHaveAttribute('data-display-target','power');
  await expect(page.locator('[data-agent="miner-hidden-build"]')).toHaveAttribute('data-display-target','power');
  await expect(page.locator('[data-agent="miner-hidden-build"]')).toHaveClass(/work/);
  await expect(page.locator('[data-agent="miner-hidden-build"]')).toHaveAttribute('data-action','build');
  await expect(page.locator('[data-agent="miner-hidden-build"] .task-moving')).toHaveCSS('animation-name','hammer-work');
  await expect(page.locator('[data-agent="question-question"] .task-moving')).toHaveCSS('animation-name','quill-work');
  await expect(page.locator('[data-agent="evaluation-grading"] .task-moving')).toHaveCSS('animation-name','stamp-work');
  await expect(page.locator('[data-agent="recorder-planning"] .recorder-pages')).toHaveCSS('animation-name','sort-notes');
  await expect(page.locator('[data-agent="evaluation-unassigned"]')).toHaveCount(0);
  await expect(page.locator('[data-crew="evaluation"]')).toHaveAttribute('data-camp-working','1');
  await expect(page.locator('[data-crew="evaluation"] .task-moving')).toHaveCSS('animation-name','inspect-work');
  await expect(page.locator('[data-agent="recorder-record"]')).toHaveAttribute('data-display-target',saved.knowledge_tree.concept_id);
  await expect(page.locator('[data-agent="recorder-record"] .pixel-recorder')).toHaveClass(/writing/);
  await expect(page.locator('[data-crew="recorder"]')).toHaveAttribute('data-camp-working','0');
  await expect(page.locator('[data-crew="recorder"] .crew-count')).toHaveText('×3');
  await page.screenshot({path:'test-results/task-agents.png'});
});

test('connection lineages keep edges visible while nodes and the map are dragged',async({page})=>{
  const stats={explored_concepts:3,diagnosed_concepts:0,question_answers:0,survey_answers:0,weak_concepts:0};
  const updated_at='2026-10-12T00:00:00Z';
  await page.route('**/api/maps',route=>route.request().method()==='GET'?route.fulfill({json:{
    maps:[
      {map_id:'root-a',lineage_id:'lineage-a',title:'微分',scope:null,updated_at,origin:null,stats},
      {map_id:'root-b',lineage_id:'lineage-b',title:'統計学',scope:null,updated_at,origin:null,stats},
    ],
    lineages:[
      {lineage_id:'lineage-a',root_map_id:'root-a',title:'微分',map_ids:['root-a']},
      {lineage_id:'lineage-b',root_map_id:'root-b',title:'統計学',map_ids:['root-b']},
    ],relations:[],candidates:[{id:'candidate-a',name:'積分',category:'related',relation:'応用につながる',reason:'発展先',
      source_map_id:'root-a',source_concept_id:'power',source_concept_name:'基本公式',target_map_id:null}],
  }}):route.fallback());
  await page.route('**/api/understanding-summary/**',route=>route.fulfill({json:{concepts:[]}}));
  await page.goto('/atlas.html');
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await expect(page.locator('.map-connections')).toHaveCount(0);
  await expect(page.locator('.connection-lineage-card')).toHaveCount(2);
  await page.screenshot({path:'test-results/connection-lineage-list.png'});
  await page.locator('[data-lineage-id="lineage-a"]').getByRole('button',{name:'地図を開く'}).click();
  await expect(page.locator('.map-connections')).toHaveAttribute('data-layout','settled');
  await expect(page.locator('.connection-root[data-id="root-a"]')).toBeVisible();
  await expect(page.locator('.connection-root[data-id="root-b"]')).toHaveCount(0);
  await expect(page.locator('.connection-contours path').first()).not.toHaveAttribute('d','');
  const relationEdge=page.locator('.map-connections .react-flow__edge[data-id="candidate-edge-candidate-a"]');
  await expect(relationEdge).toBeVisible();
  await expect(relationEdge.locator('.react-flow__edge-path')).not.toHaveAttribute('d','');
  await page.screenshot({path:'test-results/connection-lineage-contours.png'});
  const root=page.locator('.connection-root').first();
  const before=await root.boundingBox();
  const contourPath=page.locator('.connection-contours path').first();
  const contourBefore=await contourPath.getAttribute('d');
  const contourBounds=await page.locator('.connection-contours').getAttribute('viewBox');
  const neighbor=page.locator('.connection-candidate').first();
  const neighborBefore=await neighbor.getAttribute('style');
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2);
  await page.mouse.down();
  for(let step=1;step<=16;step++){
    await page.mouse.move(before!.x+before!.width/2+step*7,before!.y+before!.height/2-step*23);
    await expect(relationEdge).toBeVisible();
    await expect(relationEdge.locator('.react-flow__edge-path')).not.toHaveAttribute('d','');
  }
  await expect(relationEdge).toBeVisible();
  await expect(relationEdge.locator('.react-flow__edge-path')).not.toHaveAttribute('d','');
  await expect(contourPath).not.toHaveAttribute('d',contourBefore!);
  await expect(neighbor).not.toHaveAttribute('style',neighborBefore!);
  await expect(page.locator('.connection-contours')).toHaveAttribute('viewBox',contourBounds!);
  await page.mouse.up();
  await expect.poll(async()=>{const after=await root.boundingBox();return after?Math.hypot(after.x-before!.x,after.y-before!.y):0;}).toBeGreaterThan(30);
  await expect(page.locator('.connection-contours path').first()).not.toHaveAttribute('d','');
  await expect(relationEdge).toBeVisible();
  await expect(page.locator('.map-connections')).toHaveAttribute('data-layout','settling');
  await expect(page.locator('.map-connections')).toHaveAttribute('data-layout','settled');
  const viewport=page.locator('.map-connections .react-flow__viewport');
  const cameraBefore=await viewport.getAttribute('style');
  const chart=await page.locator('.map-connections').boundingBox();
  await page.mouse.move(chart!.x+250,chart!.y+chart!.height-170);
  await page.mouse.down();
  await page.mouse.move(chart!.x+330,chart!.y+chart!.height-120,{steps:5});
  await page.mouse.up();
  await expect(viewport).not.toHaveAttribute('style',cameraBefore!);
  await expect(relationEdge).toBeVisible();
  await page.getByRole('button',{name:'系統一覧へ'}).click();
  await expect(page.locator('.map-connections')).toHaveCount(0);
  await page.locator('[data-lineage-id="lineage-b"]').getByRole('button',{name:'地図を開く'}).click();
  await expect(page.locator('.connection-root[data-id="root-b"]')).toBeVisible();
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await expect(page.locator('.connection-lineage-card')).toHaveCount(2);
  await expect(page.locator('.map-connections')).toHaveCount(0);
});

test('parallel recorder batches group by task stage and retain their worker count',async({page})=>{
  await page.goto('/atlas.html');
  const result=await page.evaluate(async()=>{
    const {groupRecorderJobs,recorderMessage}=await import('/src/live-map-jobs.ts');
    const jobs=[...Array.from({length:4},(_,index)=>({id:`recorder-route-${index}`,label:'記録係',color:'#aa7655',
      target:'power',source:'chat_structure',state:'work' as const,message:recorderMessage('chat_structure')})),
      {id:'recorder-review',label:'記録係',color:'#aa7655',target:'power',source:'chat_structure_review',
        state:'work' as const,message:recorderMessage('chat_structure_review')}];
    return groupRecorderJobs(jobs).map(({id,count,message})=>({id,count:count??1,message}));
  });
  expect(result).toEqual([
    {id:'recorder-chat_structure-power',count:4,message:'根拠の配置先を照合中'},
    {id:'recorder-review',count:1,message:'配置案を検証中'},
  ]);
});

test('dense map keeps its upper area visible and field agents compact',async({page})=>{
  const sid=await start(page);
  const saved:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  const root=saved.knowledge_tree,template=root.child_nodes[0];
  root.child_nodes.push({...template,concept_id:'extra_density',concept_name:'追加の知識',parent_concept_id:root.concept_id,
    parent_ids:[root.concept_id],child_nodes:[]});
  saved.revision+=100;
  saved.agent_runtime.revision+=100;
  saved.agent_runtime.jobs=[{job_id:'compact-worker',session_id:sid,role:'miner',concept_id:template.concept_id,
    source:'prefetch',status:'running',error:null,retryable:false,updated_at:Date.now()/1000}];
  saved.agent_runtime.counts.miner={capacity:5,running:1,queued:0,idle:4};
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(page.locator('.live-map')).toHaveClass(/dense-map/);
  await expect.poll(()=>page.locator('.atlas-map').evaluate(element=>getComputedStyle(element,'::before').content)).toBe('none');
  await expect(page.locator('[data-agent="miner-compact-worker"]')).toHaveCSS('width','36px');
  await page.screenshot({path:'test-results/atlas-visible-top.png'});
});

test('deleting a branch updates the real API, preserves other nodes and stays deleted after reload',async({page})=>{
  const sid=await start(page);await select(page);
  const before:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  page.once('dialog',dialog=>dialog.accept());
  await requestPage(page).getByRole('button',{name:'この項目と配下を削除'}).click();
  await expect(page.locator('[data-node="power"]')).toHaveCount(0);
  await expect(page.locator('[data-node="meaning"]')).toBeVisible();
  const after:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(after.deleted_concept_ids).toContain('power');
  expect(after.questions_answered).toBe(before.questions_answered);
  await page.reload();
  await expect(page.locator('[data-node="meaning"]')).toBeVisible();
  await expect(page.locator('[data-node="power"]')).toHaveCount(0);
});

test('failed decomposition remains failed and retry expands only that branch',async({page})=>{
  const sid=await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題を飛ばして下位項目を展開'}).click();
  await select(page,'power_identify');
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.error='テスト用の下位項目生成失敗';
  saved.decomposition_statuses.power_identify='failed';
  const url=`**/api/sessions/${sid}/decompose`;
  await page.route(url,route=>route.fulfill({json:saved}));
  await requestPage(page).getByRole('button',{name:/下位項目を展開/}).click();
  await expect(page.locator('.error-banner')).toContainText(saved.error);
  await expect(page.locator('[data-node="power_identify"] [data-decomposition]')).toHaveAttribute('data-decomposition','failed');
  await page.unroute(url);
  await requestPage(page).getByRole('button',{name:/下位項目を展開/}).click();
  await expect(page.locator('[data-node="power_identify"]')).toHaveAttribute('aria-pressed','true');
  await expect.poll(async()=>page.locator('[data-node]').count()).toBeGreaterThan(8);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('120 items and a junction keep unique nodes, searchable labels and server assessments',async({page})=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const sid=await start(page,60000);
  const saved:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  const root=saved.knowledge_tree,template=root.child_nodes[0];
  saved.revision+=100;saved.concept_edges=[];saved.decomposition_statuses={};
  root.child_nodes=[];
  const items:KnowledgeNode[]=[];
  for(let i=0;i<120;i++){
    const parent=i<6?root:items[Math.floor((i-6)/19)];
    const node:KnowledgeNode={...template,concept_id:`large_${i}`,concept_name:`測量項目 ${i+1}`,description:`大規模地図の検証項目 ${i+1}`,
      parent_concept_id:parent.concept_id,parent_ids:[parent.concept_id],depth:i<6?1:2,child_nodes:[],assessment_targets:[],
      child_candidates:[],terminal_confirmed:false,terminal_reason:null,expansion_error:null,merged_sources:[],aliases:[],merged_from_ids:[]};
    parent.child_nodes.push(node);items.push(node);
    saved.learning_states[node.concept_id]={...saved.learning_states[template.concept_id],target_states:{},detected_misconceptions:[]};
    const level=(['high','medium','low','unknown'] as const)[i%4],score=level==='unknown'?null:[.9,.55,.2][i%4];
    saved.understanding_summaries[node.concept_id]={level,score,confidence_level:'unknown',confidence_score:null,source:level==='unknown'?'not_answered':'self_report',assessed:score===null?0:1,total:1,missing:score===null?1:0,question_answers:0,survey_answers:score===null?0:1};
    saved.decomposition_statuses[node.concept_id]='available';
  }
  const junction=items[119];junction.parent_ids.push(items[1].concept_id,items[2].concept_id);
  saved.concept_edges.push(...[items[1],items[2]].map(parent=>({source:parent.concept_id,target:junction.concept_id,relation:'part'})));
  // Include a repeated tree reference as well as edges, as a DAG snapshot may do.
  items[1].child_nodes.push(junction);
  saved.chat!.opened_concept_ids=[root.concept_id,...items.map(item=>item.concept_id)];
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(page.locator('[data-node="large_0"]')).toBeVisible();
  await expect(page.locator('[data-node]')).toHaveCount(121);
  await page.getByRole('checkbox',{name:'低を強調表示'}).uncheck();
  await expect(page.locator('[data-node="large_2"]')).toHaveClass(/filtered-site/);
  await expect(page.locator('[data-node="large_0"]')).not.toHaveClass(/filtered-site/);
  await expect.poll(async()=>page.locator('[data-node="large_2"]').evaluate(node=>getComputedStyle(node).opacity)).toBe('0.22');
  await page.getByRole('checkbox',{name:'低を強調表示'}).check();
  await expect(page.locator('[data-node="large_2"]')).not.toHaveClass(/filtered-site/);
  await expect(page.locator('[data-node="large_119"]')).toHaveCount(1);
  await expect(page.locator('[data-node="large_119"] .junction-tag')).toHaveText('結合 · 3親');
  await expect(page.locator('.atlas-map')).toHaveAttribute('data-layout','settled');
  for(let i=0;i<12&&!(await page.locator('.live-map').getAttribute('class'))?.includes('overview-map');i++){
    await page.getByRole('button',{name:'縮小'}).click();
  }
  await expect(page.locator('.live-map')).toHaveClass(/overview-map/);
  await page.screenshot({path:'test-results/atlas-120-overview.png'});
  await page.getByLabel('知識項目を検索').fill('測量項目 120');
  await page.locator('.live-search-results').getByRole('button',{name:'測量項目 120',exact:true}).click();
  await expect(page.locator('[data-node="large_119"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.live-map')).toHaveClass(/detail-map/);
  await expect(page.locator('[data-node="large_119"] strong')).toBeVisible();
  await page.getByRole('tab',{name:/調査記録/}).click();
  await expect(page.locator('#page-record')).toContainText('複数の項目からつながる知識');
  await expect(page.locator('[data-node="large_0"]')).toHaveAttribute('title',/90%/);
  await page.screenshot({path:'test-results/atlas-120-detail.png'});
  expect(errors).toEqual([]);
});

test('additional question can be cancelled without changing saved assessment evidence',async({page})=>{
  const sid=await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  const question=page.locator('#page-question');
  await question.locator('.choice').first().click();
  await question.getByRole('button',{name:'回答して次へ'}).click();
  await expect(question.locator('.feedback')).toBeVisible();
  const before:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  await page.getByRole('tab',{name:/調査記録/}).click();
  await page.locator('#page-record').getByRole('button',{name:'追加で確認する',exact:true}).click();
  await expect(question.locator('.reassessment-banner')).toBeVisible();
  await question.getByRole('button',{name:'追加確認を中止',exact:true}).click();
  await expect(question.locator('.reassessment-banner')).toHaveCount(0);
  const after:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(after.reassessment_concept_id).toBeNull();
  expect(after.questions_answered).toBe(before.questions_answered);
  expect(after.evidence).toEqual(before.evidence);
  expect(after.self_assessments).toEqual(before.self_assessments);
  expect(after.learning_states.power).toEqual(before.learning_states.power);
});

test('long mathematical question scrolls inside the book and keeps its answer after widening',async({page})=>{
  const sid=await start(page);await select(page);
  await requestPage(page).getByRole('button',{name:'問題で理解度を確認する',exact:true}).click();
  const question=page.locator('#page-question');await expect(question.locator('.choices')).toBeVisible();
  const saved:Diagnosis=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.revision+=1;
  saved.next_question!.question_text='長い問題の表示検証\n\n$$f(x)=x^2,\\quad f\'(x)=2x$$\n\n'+
    Array.from({length:12},(_,i)=>`${i+1}. 条件を整理して、関数の変化率と近似の関係を考えてください。指定された範囲と前提を確認し、その理由を説明してください。`).join('\n\n');
  saved.next_question!.choices!.forEach(choice=>choice.text+='。'+ '式の条件と適用範囲を確認して判断します。'.repeat(7));
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(question.locator('.question-markdown')).toContainText('長い問題の表示検証');
  await expect(question.locator('.katex')).toHaveCount(1);
  const scroll=page.locator('#atlas-notebook .inspector-scroll');
  expect(await scroll.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
  await question.locator('.choice').last().click();
  expect(await scroll.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  await page.getByLabel('調査手帳を広げる').click();
  await expect(question.locator('.choice').last()).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/atlas-long-question.png'});
});

async function openChat(page:Page){
  const closeBook=page.getByLabel('調査手帳を閉じる',{exact:true});
  if(await closeBook.isVisible())await closeBook.click();
  await page.getByLabel('チャットを開く',{exact:true}).click();
}

test('initial decomposition runs with reception open and panels are mutually exclusive',async({page})=>{
  await page.goto('/atlas.html');
  await page.getByRole('button',{name:'このテーマを探索する'}).click();
  const chat=page.locator('#atlas-chat');
  await expect(chat).toBeVisible();
  await expect(chat).toHaveClass(/chat-wide/);
  await expect(chat.getByText('ようこそ、探索受付へ')).toBeVisible();
  await expect(page.locator('#atlas-notebook')).toBeHidden();
  await expect(page.getByLabel('調査手帳を開く',{exact:true})).toBeHidden();
  await expect(page.getByLabel('チャットを開く',{exact:true})).toBeHidden();
  await expect(chat.getByRole('button',{name:'経験したことから話す'})).toBeEnabled();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async()=> (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await expect(chat).toBeVisible();
  await expect(page.locator('#atlas-notebook')).toBeHidden();
  await chat.getByRole('button',{name:'経験したことから話す'}).click();
  await expect(chat.locator('textarea')).toHaveValue('微分で、これまでに取り組んだことは');
  await page.screenshot({path:'test-results/reception-start.png'});
  await page.getByLabel('チャットを閉じる',{exact:true}).click();
  await expect(page.getByLabel('調査手帳を開く',{exact:true})).toBeVisible();
  await expect(page.getByLabel('チャットを開く',{exact:true})).toBeVisible();
  await page.getByLabel('調査手帳を開く',{exact:true}).click();
  await expect(chat).toBeHidden();
  await expect(page.getByLabel('チャットを開く',{exact:true})).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await openChat(page);
  await expect(chat.locator('textarea')).toHaveValue('微分で、これまでに取り組んだことは');
  await chat.locator('textarea').fill('デモ: 係数と指数を分けて計算します。');
  await chat.getByRole('button',{name:'送信',exact:true}).click();
  await expect(chat.locator('.chat-message.assistant')).toContainText('経験と迷っている部分');
  const history=await chat.locator('.chat-messages').boundingBox();
  const bounds=await chat.boundingBox();
  expect(history!.height).toBeGreaterThan(bounds!.height*.5);
  await page.setViewportSize({width:390,height:844});
  const mobile=await chat.boundingBox();
  expect(mobile!.x).toBeGreaterThanOrEqual(0);
  expect(mobile!.x+mobile!.width).toBeLessThanOrEqual(390);
  await expect(chat.getByRole('button',{name:'送信',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/reception-mobile.png'});
});


test('handoffs follow server events without replay and honor reduced motion',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.agent_runtime.revision+=1000;
  saved.agent_runtime.jobs=[
    {job_id:'write',session_id:sid,role:'recorder',concept_id:null,source:'chat_extract',status:'running',updated_at:Date.now()/1000,error:null,retryable:false},
    {job_id:'reply',session_id:sid,role:'reception',concept_id:null,source:'chat_reply',status:'running',updated_at:Date.now()/1000,error:null,retryable:false},
  ];
  saved.agent_runtime.counts.recorder={capacity:5,running:1,queued:0,idle:4};
  saved.agent_runtime.counts.reception={capacity:1,running:1,queued:0,idle:0};
  saved.agent_runtime.handoffs=[];
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  await expect(page.locator('[data-crew="recorder"] .crew-count')).toHaveText('×4');
  await expect(page.locator('[data-crew="reception"]')).toHaveCount(0);
  await expect(page.locator('.reception-toggle')).toHaveClass(/reception-talking/);
  await expect(page.locator('.reception-toggle [data-reception-anchor]')).toBeVisible();
  await expect(page.locator('.reception-toggle .reception-avatar > svg')).toHaveCSS('animation-name','reception-talk');
  await expect(page.locator('[data-agent="recorder-write"]')).toBeVisible();
  await expect(page.locator('[data-agent="recorder-write"] .pixel-recorder')).toHaveClass(/writing/);
  saved.agent_runtime.handoffs=[{event_id:'handoff-test',from_role:'reception',to_role:'recorder',from_job_id:null,to_job_id:'write',concept_id:null,source:'chat_extract',kind:'request',created_at:Date.now()/1000}];
  saved.agent_runtime.revision++;
  const transfer=page.locator('[data-handoff="handoff-test"]');
  await expect(transfer).toBeVisible();
  await expect(transfer.locator(':scope > path')).toHaveAttribute('d',/^M/);
  await expect(page.locator('.agent-handoff-caption')).toContainText('受付係 → 記録係');
  await expect.poll(()=>page.evaluate(()=>{
    const svg=document.querySelector('[data-handoff="handoff-test"]');
    const path=svg?.querySelector(':scope > path')?.getAttribute('d');
    if(!path)return 999;
    const [x,y]=path.slice(1).split(' ')[0].split(',').map(Number);
    const host=svg!.parentElement!.getBoundingClientRect();
    const anchor=document.querySelector('.reception-toggle [data-reception-anchor]')!.getBoundingClientRect();
    return Math.hypot(x-(anchor.left+anchor.width/2-host.left),y-(anchor.top+anchor.height/2-host.top));
  })).toBeLessThan(3);
  await page.screenshot({path:'test-results/agent-handoff.png'});
  await expect(transfer).toHaveCount(0);
  await page.locator('.reception-toggle').click();
  await expect(page.locator('.chat-window-heading [data-reception-anchor]')).toBeVisible();
  await expect(page.locator('.chat-window-heading')).toHaveClass(/reception-talking/);
  saved.agent_runtime.handoffs.push({...saved.agent_runtime.handoffs[0],event_id:'open-handoff',created_at:Date.now()/1000});
  saved.agent_runtime.revision++;
  await expect.poll(()=>page.evaluate(()=>{
    const svg=document.querySelector('[data-handoff="open-handoff"]');
    const path=svg?.querySelector(':scope > path')?.getAttribute('d');
    if(!path)return 999;
    const [x,y]=path.slice(1).split(' ')[0].split(',').map(Number);
    const host=svg!.parentElement!.getBoundingClientRect();
    const anchor=document.querySelector('.chat-window-heading [data-reception-anchor]')!.getBoundingClientRect();
    return Math.hypot(x-(anchor.left+anchor.width/2-host.left),y-(anchor.top+anchor.height/2-host.top));
  })).toBeLessThan(3);
  await expect(page.locator('[data-handoff="open-handoff"]')).toHaveCount(0);
  // Another poll with the same event must not replay it.
  saved.agent_runtime.revision++;
  await page.getByLabel('動きを抑える').check();
  await expect(page.locator('.chat-window-heading .reception-avatar > svg')).toHaveCSS('animation-name','none');
  saved.agent_runtime.handoffs.push({...saved.agent_runtime.handoffs[0],event_id:'quiet-handoff',created_at:Date.now()/1000});
  saved.agent_runtime.revision++;
  const quiet=page.locator('[data-handoff="quiet-handoff"]');
  await expect(quiet).toBeVisible();
  await expect(quiet.locator(':scope > path')).toHaveAttribute('d','');
  await expect(transfer).toHaveCount(0);
  await expect(quiet).toHaveCount(0);
});


test('handoff endpoint follows a field worker when the map zooms',async({page})=>{
  const sid=await start(page);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.agent_runtime.revision+=2000;
  saved.agent_runtime.jobs=[{job_id:'zoom-worker',session_id:sid,role:'miner',concept_id:'power',source:'chat_addition',status:'running',updated_at:Date.now()/1000,error:null,retryable:false}];
  saved.agent_runtime.handoffs=[];
  await page.route(`**/api/sessions/${sid}`,route=>route.fulfill({json:saved}));
  const worker=page.locator('[data-agent="miner-zoom-worker"]');
  await expect(worker).toHaveClass(/work/);
  saved.agent_runtime.handoffs=[{event_id:'zoom-handoff',from_role:'recorder',to_role:'miner',from_job_id:null,to_job_id:'zoom-worker',concept_id:'power',source:'chat_addition',kind:'request',created_at:Date.now()/1000}];
  saved.agent_runtime.revision++;
  await expect(page.locator('[data-handoff="zoom-handoff"] > path')).toHaveAttribute('d',/^M/);
  const previousZoom=await page.locator('.map-controls span').innerText();
  await page.mouse.move(180,450);await page.mouse.wheel(0,-90);
  await expect(page.locator('.map-controls span')).not.toHaveText(previousZoom);
  await expect.poll(()=>page.evaluate(()=>{
    const svg=document.querySelector('[data-handoff="zoom-handoff"]');
    const d=svg?.querySelector(':scope > path')?.getAttribute('d');
    if(!d)return 999;
    const [x,y]=d.split(' ').at(-1)!.split(',').map(Number);
    const host=svg!.parentElement!.getBoundingClientRect();
    const agent=document.querySelector('[data-agent="miner-zoom-worker"]')!.getBoundingClientRect();
    return Math.hypot(x-(agent.left+agent.width/2-host.left),y-(agent.top+agent.height/2-host.top));
  })).toBeLessThan(3);
});
