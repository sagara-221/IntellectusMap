import { test, expect } from './fixtures';

test('initial second layer is displayed automatically without self-assessments or chat', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  await expect(page.locator('.graph-dot')).toHaveCount(16);
  await expect(page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細',exact:true})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  const saved = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(saved.initial_visible_depth).toBe(2);
  expect(saved.initial_generation_complete).toBe(true);
  expect(saved.self_assessments).toEqual({});
  expect(saved.chat.messages).toEqual([]);
  expect(saved.question_history).toEqual([]);
  await page.reload();
  await expect(page.locator('.graph-dot')).toHaveCount(16);
  await expect(page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細',exact:true})).toBeVisible();
});

test('graph can hide unjudged concepts and restore the full map', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  const filter = page.getByRole('button', {name:'未判定を隠す'});
  const revision = (await (await page.request.get(`/api/sessions/${sid}`)).json()).revision;

  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-dot')).toHaveCount(1);
  await expect(page.locator('.graph-layout-status')).toContainText('判定済み 0 /');
  expect((await (await page.request.get(`/api/sessions/${sid}`)).json()).revision).toBe(revision);

  await filter.click();
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await filter.click();
  await expect(page.locator('.graph-dot')).toHaveCount(1);
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await expect(page.locator('.graph-dot')).toHaveCount(2);
  await expect(page.getByRole('button', {name:'基本公式の診断詳細', exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'微分の基本概念の診断詳細', exact:true})).toHaveCount(0);
  await expect(page.locator('.graph-dot:not(.root).unknown')).toHaveCount(0);

  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', {name:'微分の基本概念の診断詳細', exact:true})).toBeVisible();
});

test('self-assessments persist while moving between tabs without ending exploration', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await expect(page.locator('.self-assessment-panel')).toContainText('必須');
  await expect(page.locator('.detail-panel .survey-options')).toHaveCount(0);
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await expect(page.locator('.self-assessment-panel .survey-options')).toHaveCount(0);
  await expect(page.locator('.self-assessment-panel .survey-result')).toContainText('理解している');
  await expect(page.locator('.detail-panel .score-pair > div').nth(1)).toContainText('判定の信頼度低');
  await expect(page.locator('.detail-panel .score-pair > div').nth(2)).toContainText(/問題の回答\s*0\s*問/);
  await expect(page.locator('.detail-panel .score-pair > div').nth(3)).toContainText(/アンケートの回答\s*1\s*件/);
  await page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細', exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await expect(page.locator('.detail-panel .score-pair > div').nth(1)).toContainText('判定の信頼度低');
  await expect(page.getByRole('button', {name:/深掘りを終了/})).toHaveCount(0);
  await page.getByRole('button', {name:'繋がりMAP一覧', exact:true}).click();
  await page.getByRole('button', {name:'深掘り', exact:true}).click();
  await expect(page.locator('.session-bar')).toContainText('微分');
  await expect(page.locator('.map-footer')).toContainText('自己評価 2 /');
  expect((await (await page.request.get(`/api/sessions/${sid}`)).json()).complete).toBe(false);

  const data = await (await page.request.get(`/api/sessions/${sid}`)).json();
  const remaining: string[] = [];
  const collect = (node: any) => { if (node.depth > 0 && !data.self_assessments[node.concept_id]) remaining.push(node.concept_id); node.child_nodes.forEach(collect); };
  collect(data.knowledge_tree);
  for (const concept_id of remaining) {
    const response = await page.request.post(`/api/sessions/${sid}/self-assessment`, {data:{concept_id,level:'medium'}});
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await page.reload();
  await expect(page.locator('.map-footer')).toContainText(`自己評価 ${remaining.length + 2} / ${remaining.length + 2} 件`);
  expect((await (await page.request.get(`/api/sessions/${sid}`)).json()).complete).toBe(false);
});

test('unsure self-assessment opens a question and keeps the answer as evidence', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button', {name:/自分では判断できない/}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  await expect(page.locator('.self-assessment-panel')).toBeVisible();
  await page.getByRole('button', {name:'微分の基本概念の診断詳細', exact:true}).click();
  await expect(page.locator('.self-assessment-panel')).toContainText('微分の基本概念');
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  const before = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(before.self_assessments.power.level).toBe('unsure');
  expect(before.understanding_summaries.power.level).toBe('unknown');
  if (await page.locator('.choice').count()) await page.locator('.choice').first().click();
  else await page.locator('.question-body textarea').fill('わからない');
  await page.getByRole('button', {name:'回答して次へ'}).click();
  await expect(page.locator('.feedback')).toBeVisible();
  const after = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(after.understanding_summaries.power.source).toBe('question');
  expect(after.evidence.some((e:{concept_id:string}) => e.concept_id === 'power')).toBeTruthy();
});

test('a survey answer can be checked with an optional question', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細', exact:true}).click();

  const panel = page.locator('.self-assessment-panel');
  await expect(panel.getByRole('button', {name:'問題で理解度を確認する'})).toHaveCount(0);
  await panel.getByRole('button', {name:'あいまい'}).click();
  await expect(panel.locator('.survey-options')).toHaveCount(0);
  await expect(panel.locator('.survey-result')).toContainText('あいまい');
  await panel.getByRole('button', {name:'回答を変更'}).click();
  await expect(panel.locator('.survey-options')).toBeVisible();
  await panel.getByRole('button', {name:'分からない', exact:true}).click();
  await expect(panel.locator('.survey-result')).toContainText('分からない');
  await expect(panel.locator('.survey-options')).toHaveCount(0);
  await expect(panel.getByRole('button', {name:'問題で理解度を確認する'})).toBeEnabled();
  await panel.getByRole('button', {name:'問題で理解度を確認する'}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  await expect(panel.getByRole('button', {name:'表示中の問題に回答する'})).toBeDisabled();
  const pending = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(pending.next_question.concept_id).toBe('power_identify');
  expect(pending.questions_answered).toBe(0);
  await page.locator('.choice').first().click();
  await page.getByRole('button', {name:'回答して次へ'}).click();
  await expect(page.locator('.feedback')).toBeVisible();
  const answered = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(answered.understanding_summaries.power_identify.source).toBe('question');
});

test('knowledge branches expand without questions, then the chosen item is assessed', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name: '診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name: '気になる知識から、はじめよう。'})).toBeVisible();

  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  expect(sid).toBeTruthy();
  const initial = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(initial.manual_flow).toBe('decomposition_first');
  expect(initial.decomposition_max_depth).toBeNull();
  expect(initial.initial_visible_depth).toBe(2);
  expect(initial.decomposition_depth_reason).toBeNull();
  expect(initial.questions_answered).toBe(0);
  expect(initial.next_question).toBeNull();
  await expect(page.locator('.decomposition-plan')).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  await page.getByRole('button', {name: '基本公式の診断詳細', exact: true}).click();
  await expect(page.locator('.concept-links').getByRole('button', {name: '必要な関数・公式の識別'})).toBeVisible();
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await expect(page.locator('.concept-links').getByRole('button', {name: '必要な関数・公式の識別'})).toBeVisible();
  await expect(page.locator('.question-body')).toHaveCount(0);
  const expanded = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(expanded.questions_answered).toBe(0);
  expect(expanded.next_question).toBeNull();
  expect(expanded.question_history).toHaveLength(0);
  expect(expanded.knowledge_tree.child_nodes[0].child_nodes).toHaveLength(2);

  await page.locator('.concept-links').getByRole('button', {name: '必要な関数・公式の識別'}).click();
  await page.locator('.self-assessment-panel').getByRole('button', {name:/自分では判断できない/}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  await expect(page.locator('.self-assessment-panel')).toBeVisible();
  await expect(page.locator('.question-body .concept-breadcrumb')).toHaveText('必要な関数・公式の識別');
  const assessed = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(assessed.knowledge_tree.child_nodes[1].child_nodes[0].child_nodes).toHaveLength(0);
  expect(assessed.next_question.concept_id).toBe('power_identify');
  expect(assessed.next_question.expected_answer).toBeUndefined();

  await page.locator('.choice').first().click();
  await page.getByRole('button', {name: '回答して次へ'}).click();
  await expect(page.locator('.feedback')).toBeVisible();
  const answered = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(answered.questions_answered).toBe(1);
  expect(answered.learning_states.power.questions_answered).toBe(0);
  expect(answered.learning_states.power_identify.questions_answered).toBe(1);
});

test('generating node unlocks its decomposition button when prefetch is ready', async ({page}) => {
  let showGenerating = true;
  await page.route('**/api/sessions/*', async route => {
    if (!['GET', 'POST'].includes(route.request().method())) return route.continue();
    const response = await route.fetch();
    const session = await response.json();
    if (session.knowledge_tree.child_nodes[1]?.child_nodes.length) {
      session.decomposition_statuses.power_identify = showGenerating ? 'generating' : 'ready';
    }
    await route.fulfill({response, json:session});
  });

  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).decomposition_statuses?.power_identify).toBe('ready');
  await page.getByRole('button', {name:'基本公式の診断詳細', exact:true}).click();
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細'}).click();
  await expect(page.locator('.self-assessment-panel .survey-followups').getByRole('button', {name:'さらに分解'})).toBeDisabled();
  await page.locator('.self-assessment-panel').getByRole('button', {name:'理解している'}).click();
  await page.reload();
  await page.getByTestId('rf__node-power_identify').getByRole('button', {name:'必要な関数・公式の識別の診断詳細'}).click();
  await expect(page.locator('.graph-selection .decomposition-generating')).toContainText('生成中');
  await expect(page.locator('.self-assessment-panel .survey-followups').getByRole('button', {name:'生成中…'})).toBeDisabled();
  await expect(page.getByTestId('rf__node-power_identify').locator('.graph-dot.generating')).toBeVisible();

  showGenerating = false;
  await expect(page.locator('.self-assessment-panel .survey-followups').getByRole('button', {name:'さらに分解'})).toBeEnabled();
  await page.locator('.self-assessment-panel .survey-followups').getByRole('button', {name:'さらに分解'}).click();
  await expect(page.locator('.concept-links').getByRole('button', {name:'公式の選択'})).toBeVisible();
});

test('manual node addition and subtree deletion actions are unavailable', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name: '診断をはじめる'}).click();
  await page.getByRole('button', {name: '基本公式の診断詳細', exact: true}).click();
  await expect(page.locator('.concept-links button').first()).toBeVisible();
  await expect(page.getByRole('button', {name: '不足している項目を追加', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'この項目と配下を削除', exact: true})).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', {name: '基本公式の診断詳細', exact: true}).click();
  await expect(page.locator('.add-concept-form')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'この項目と配下を削除', exact: true})).toHaveCount(0);
});

test('equivalent concepts from two branches share one visible graph node', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button', {name: '診断をはじめる'}).click();
  await expect(page.getByRole('heading', {name: '気になる知識から、はじめよう。'})).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  expect(sid).toBeTruthy();
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).initial_generation_complete).toBe(true);
  for (const concept_id of ['power', 'chain']) {
    const response = await page.request.post(`/api/sessions/${sid}/decompose`, {data:{concept_id}});
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  // Render a persisted shared concept; its creation no longer uses manual APIs.
  await page.route(`**/api/sessions/${sid}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response=await route.fetch();
    const saved=await response.json();
    const shared=saved.knowledge_tree.child_nodes.find((node:{concept_id:string})=>node.concept_id==='power').child_nodes[0];
    shared.concept_name='連鎖律';
    shared.aliases=['チェーンルール'];
    shared.parent_ids=['power','chain'];
    saved.concept_edges=[{source:'chain',target:shared.concept_id,relation:'part'}];
    await route.fulfill({response,json:saved});
  });
  for (const concept_id of ['power', 'chain']) {
    const response = await page.request.post(`/api/sessions/${sid}/self-assessment`, {data:{concept_id, level:'high'}});
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await page.reload();
  await expect(page.getByRole('button', {name:'連鎖律の診断詳細', exact:true})).toHaveCount(1);
  await page.getByRole('button', {name:'合成関数の微分の診断詳細', exact:true}).click();
  await expect(page.locator('.concept-links').getByRole('button', {name:'連鎖律'})).toBeVisible();
  await page.locator('.concept-links').getByRole('button', {name:'連鎖律'}).click();
  await expect(page.locator('.detail-panel')).toContainText('別名：チェーンルール');
  await expect(page.locator('.detail-panel')).toContainText('複数の項目からつながる知識');
});
