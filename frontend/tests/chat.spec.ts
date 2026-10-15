import {test, expect} from './fixtures';

test('conversation updates the map without surveys and persists across tabs and reloads', async ({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  await page.getByLabel('話したいこと').fill('デモ: 係数と指数を分けて、式の計算手順を説明します。');
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  await expect(page.locator('.chat-message.user')).toHaveCount(1);
  await expect(page.locator('.chat-message.assistant')).toContainText('経験と迷っている部分を分けて考えると整理しやすくなります。');
  await expect(page.locator('.conversation-evidence')).toContainText('係数と指数');
  await expect(page.locator('.react-flow__node[data-id="power"] .graph-dot')).not.toHaveClass(/unanswered/);
  await expect(page.locator('.react-flow__node[data-id="power_identify"]')).toBeVisible();
  const saved=await (await page.request.get(`/api/sessions/${sid}/chat`)).json();
  expect(saved.self_assessments.power).toBeUndefined();
  expect(saved.understanding_summaries.power.question_answers).toBe(0);
  expect(saved.understanding_summaries.power.survey_answers).toBe(0);
  expect(saved.understanding_summaries.power.conversation_answers).toBe(1);
  expect(saved.chat.timings.first_text_ms).toBeGreaterThanOrEqual(saved.chat.timings.assessment_ms);
  await page.getByRole('button',{name:'深堀マップ一覧',exact:true}).click();
  await page.getByRole('button',{name:'深掘り',exact:true}).click();
  await expect(page.locator('.chat-message.user')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.chat-message.user')).toHaveCount(1);
  await expect(page.locator('.chat-message.assistant')).toContainText('経験と迷っている部分を分けて考えると整理しやすくなります。');
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.getByLabel('話したいこと').fill('デモ: 実際には指数の扱いが分からないです。');
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(2);
  await expect(page.locator('.conversation-evidence')).toContainText('実際には指数の扱いが分からないです。');
  await page.getByRole('button',{name:'自己評価・問題',exact:true}).click();
  await expect(page.locator('.self-assessment-panel')).toContainText('任意（会話で確認済み）');
  await page.locator('.self-assessment-panel').getByRole('button',{name:'問題で理解度を確認する'}).click();
  await expect(page.locator('.question-markdown')).toBeVisible();
  expect(errors).toEqual([]);
});

test('chat works on a narrow screen without overflowing', async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  await page.getByLabel('話したいこと').fill('最近取り組んだことについて、どこから整理したらよいでしょうか。');
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('一緒に整理していきましょう。');
  await page.getByLabel('話したいこと').fill('この話題を続けたいです。');
  await expect(page.locator('.chat-composer button')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/chat-mobile.png',fullPage:true});
});

test('normal decomposition evaluates new children from saved chat without another message', async ({page})=>{
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  const statement='デモ: 条件を確認して、係数と指数に合う計算手順を選びます。';
  await page.getByLabel('話したいこと').fill(statement);
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  await expect(page.locator('.conversation-evidence')).toContainText(statement);
  await page.getByRole('button',{name:'自己評価・問題',exact:true}).click();
  await page.locator('.concept-links').getByRole('button',{name:'必要な関数・公式の識別',exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button',{name:'理解している',exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button',{name:'さらに分解',exact:true}).click();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async()=>{
    const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
    const parent=saved.knowledge_tree.child_nodes.find((node:{concept_id:string})=>node.concept_id==='power')
      .child_nodes.find((node:{concept_id:string})=>node.concept_id==='power_identify');
    return parent.child_nodes.length>0 && parent.child_nodes.every((node:{concept_id:string})=>
      saved.chat.observations.some((event:{concept_id:string;citations:{quote:string}[]})=>
        event.concept_id===node.concept_id && event.citations.some(ref=>ref.quote===statement)));
  }).toBe(true);
  await page.locator('.concept-links button').first().click();
  await expect(page.locator('.conversation-evidence')).toContainText(statement);
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(saved.chat.messages.filter((message:{role:string})=>message.role==='user')).toHaveLength(1);
});

test('new conversation starts empty, keeps map evidence, and archives prior conversations', async ({page})=>{
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  const panel=page.getByRole('region',{name:'会話で理解を確認'});
  const oldText='デモ: 係数と指数を分けて、計算の手順を説明します。';
  await page.getByLabel('話したいこと').fill(oldText);
  await panel.getByRole('button',{name:'送信',exact:true}).click();
  await expect(page.locator('.conversation-evidence')).toContainText(oldText);
  await expect(panel.getByRole('button',{name:'新しい会話',exact:true})).toBeEnabled();
  const before=await (await page.request.get(`/api/sessions/${sid}/chat`)).json();
  await panel.getByRole('button',{name:'新しい会話',exact:true}).click();
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  await expect(panel.locator('.chat-welcome')).toBeVisible();
  await expect(panel.locator('.panel-heading')).toContainText('0 発言');
  await expect(page.locator('.conversation-evidence')).toContainText(oldText);
  const after=await (await page.request.get(`/api/sessions/${sid}/chat`)).json();
  expect(after.chat.current_conversation_id).not.toBe(before.chat.current_conversation_id);
  expect(after.chat.conversations).toHaveLength(2);
  expect(after.chat.messages).toHaveLength(2);
  expect(after.chat.observations.length).toBeGreaterThanOrEqual(before.chat.observations.length);
  await panel.getByLabel('会話履歴').selectOption(before.chat.current_conversation_id);
  await expect(panel.locator('.chat-message.user')).toHaveText(`あなた${oldText}`);
  await expect(panel.locator('.chat-composer')).toHaveCount(0);
  await panel.getByRole('button',{name:'現在の会話に戻る'}).click();
  const newText='別の話題について整理したいです。';
  await page.getByLabel('話したいこと').fill(newText);
  await panel.getByRole('button',{name:'送信',exact:true}).click();
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  await expect(panel.locator('.chat-message.assistant')).toContainText('一緒に整理していきましょう。');
  await expect(panel.locator('.chat-message.user')).toContainText(newText);
  await expect(panel.locator('.chat-message.user')).not.toContainText(oldText);
  await page.reload();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  await expect(panel.locator('.chat-message.user')).toHaveCount(1);
  await expect(panel.locator('.chat-message.user')).toContainText(newText);
  await panel.getByLabel('会話履歴').selectOption(before.chat.current_conversation_id);
  await expect(panel.locator('.chat-message.user')).toContainText(oldText);
  await panel.getByRole('button',{name:'現在の会話に戻る'}).click();
  await page.setViewportSize({width:390,height:844});
  await expect(panel.getByRole('button',{name:'新しい会話',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/chat-new-conversation-mobile.png',fullPage:true});
});

test('selected node follows its canonical destination after a background merge', async ({page})=>{
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async()=> (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.concept-links').getByRole('button',{name:'必要な関数・公式の識別',exact:true}).click();
  await page.getByRole('button',{name:'会話で確認',exact:true}).click();
  const saved=await (await page.request.get(`/api/sessions/${sid}`)).json();
  saved.revision+=100;
  saved.decomposition_statuses={};
  saved.chat.background_status='idle';
  const parent=saved.knowledge_tree.child_nodes.find((node:{concept_id:string})=>node.concept_id==='power');
  parent.child_nodes=parent.child_nodes.filter((node:{concept_id:string})=>node.concept_id!=='power_identify');
  const canonical=saved.knowledge_tree.child_nodes.find((node:{concept_id:string})=>node.concept_id==='meaning').child_nodes[0];
  canonical.concept_name='統合先の能力';
  saved.concept_redirects.power_identify=canonical.concept_id;
  await page.route(`**/api/sessions/${sid}/chat`, async route=>{
    if(route.request().method()!=='POST') return route.fallback();
    const request=route.request().postDataJSON();
    expect(request.concept_id).toBe('power_identify');
    await route.fulfill({status:200,contentType:'text/event-stream',body:`event: complete
data: ${JSON.stringify({session:saved})}

`});
  });
  await page.getByLabel('話したいこと').fill('この能力について経験を説明します。');
  await page.locator('.chat-composer').getByRole('button',{name:'送信'}).click();
  await expect(page.locator('.graph-selection strong')).toHaveText('統合先の能力');
  await expect(page.locator('.react-flow__node[data-id="power_identify"]')).toHaveCount(0);
});
