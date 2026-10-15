import {test, expect} from './fixtures';

test('knowledge node list searches, sorts, and opens map-specific answer history', async ({page}) => {
  const started = await page.request.post('/api/sessions', {data:{theme:'微分',mode:'demo'}});
  expect(started.ok(), await started.text()).toBeTruthy();
  const mapId = (await started.json()).session_id;
  const assessed = await page.request.post(`/api/sessions/${mapId}/self-assessment`, {
    data:{concept_id:'power',level:'high'},
  });
  expect(assessed.ok(), await assessed.text()).toBeTruthy();
  const selected = await page.request.post(`/api/sessions/${mapId}/select`, {
    data:{concept_id:'power'},
  });
  expect(selected.ok(), await selected.text()).toBeTruthy();
  const question = (await selected.json()).next_question;
  expect(question?.choices?.length).toBeGreaterThan(0);
  const answered = await page.request.post(`/api/sessions/${mapId}/answers`, {
    data:{question_id:question.question_id,answer:question.choices[0].choice_id},
  });
  expect(answered.ok(), await answered.text()).toBeTruthy();

  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'知識ノード一覧'}).click();
  await expect(page.getByRole('heading', {name:'知識ノード一覧'})).toBeVisible();
  await expect(page.locator('.node-row').first()).toBeVisible();
  await expect(page.locator('.node-list-heading')).toContainText('知識ノード');
  await page.getByLabel('深掘りマップ').selectOption(mapId);
  await expect(page.locator('.node-row')).toHaveCount(1);
  await expect(page.locator('.node-row .level-unknown')).toHaveCount(0);
  await expect(page.locator('.node-level-filters')).not.toContainText('未判定');
  await page.getByLabel('並び順').selectOption('questions');
  await expect(page.locator('.node-row').first()).toContainText('基本公式');
  await page.getByLabel('知識・マップを検索').fill('基本公式');
  await expect(page.locator('.node-row')).toHaveCount(1);
  await expect(page.locator('.node-row').first()).toContainText('1 問');
  await page.locator('.node-row').first().click();
  await expect(page.locator('.node-inspector')).toContainText('マップごとの結果');
  await expect(page.locator('.node-map-results button')).toHaveCount(1);
  await expect(page.locator('.node-question-history article')).toHaveCount(1);
  await expect(page.locator('.node-question-history article')).toContainText('あなたの回答');
  await expect(page.locator('.node-question-history article')).toContainText('正答');
  await page.locator('.node-inspector-detail').getByRole('button', {name:'このマップで開く'}).click();
  await expect(page.locator('.session-bar')).toContainText('微分');
  await expect(page.locator('.exploration-stage')).toContainText('基本公式');
});
