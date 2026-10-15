import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function loadLegacySession(page: Page, mode: 'focused' | 'comprehensive') {
  const response = await page.request.post('/api/sessions', {data:{theme:'微分',mode:'demo',exploration_mode:mode}});
  const session = await response.json();
  await page.evaluate(id => sessionStorage.setItem('diagnostic-session', id), session.session_id);
  await page.reload();
}

test('demo diagnosis, evidence, and reload', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/legacy.html');
  await expect(page.getByRole('heading', {name:'「分からない」の、その先へ。'})).toBeVisible();
  await page.screenshot({path:'test-results/welcome-desktop.png', fullPage:true});
  await loadLegacySession(page, 'focused');
  await expect(page.getByText('QUESTION 01', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'A 接線の傾き'}).click();
  await page.getByRole('button', {name:'回答して次へ', exact:true}).click();
  await expect(page.getByRole('heading', {name:'正解です', exact:true})).toBeVisible();
  await page.getByRole('button', {name:'次へ進む', exact:true}).click();
  await expect(page.getByText('QUESTION 02', {exact:true})).toBeVisible();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('微分の基本概念');
  await page.getByRole('button', {name:'微分の基本概念の診断詳細', exact:true}).click();
  await expect(page.getByRole('heading', {name:'微分の基本概念', exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/diagnosis-desktop.png', fullPage:true});
  await page.reload();
  await expect(page.getByText('QUESTION 02', {exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile layout and submitting an unknown answer', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/legacy.html');
  await loadLegacySession(page, 'focused');
  for (const choice of ['A 接線の傾き', '× いいえ', 'C 正']) {
    await expect(page.locator('.concept-breadcrumb')).toHaveText('微分の基本概念');
    await page.getByRole('button', {name:choice, exact:true}).click();
    await page.getByRole('button', {name:'回答して次へ', exact:true}).click();
    await expect(page.getByRole('heading', {name:'正解です', exact:true})).toBeVisible();
    await page.getByRole('button', {name:'次へ進む', exact:true}).click();
  }
  await expect(page.locator('.concept-breadcrumb')).toHaveText('基本公式');
  await expect(page.locator('.graph-dot.covered .graph-node-button')).toHaveCount(2);
  await page.locator('.graph-dot.covered .graph-node-button').first().click();
  await expect(page.locator('.covered-explanation')).toBeVisible();
  await expect(page.locator('.covered-explanation')).toContainText('出題を省略した項目です');
  await page.screenshot({path:'test-results/display-only-detail-mobile.png', fullPage:true});
  await page.getByRole('button', {name:'今は分からない', exact:true}).click();
  await expect(page.getByRole('heading', {name:'確認したい点が見つかりました', exact:true})).toBeVisible();
  await page.getByRole('button', {name:'次へ進む', exact:true}).click();
  await page.screenshot({path:'test-results/diagnosis-mobile.png', fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('review checkpoint, consent to deepen, satisfied completion, and export', async ({page}) => {
  await page.goto('/legacy.html');
  await loadLegacySession(page, 'focused');
  async function reachCheckpoint() {
    for (let i = 0; i < 80; i++) {
      if (await page.locator('.review-body').count()) return;
      const unknown = page.getByRole('button', {name:'今は分からない', exact:true});
      if (await unknown.count()) {
        await unknown.click();
      } else {
        await page.locator('.choice').last().click();
        await page.getByRole('button', {name:'回答して次へ', exact:true}).click();
      }
      await expect(page.locator('.feedback')).toBeVisible();
      const reviewButton = page.getByRole('button', {name:'分析結果を確認する', exact:true});
      if (await reviewButton.count()) { await reviewButton.click(); return; }
      await page.getByRole('button', {name:'次へ進む', exact:true}).click();
    }
    throw new Error('No review checkpoint');
  }
  await reachCheckpoint();
  await expect(page.getByRole('heading', {name:'何が分からないか、見えてきましたか？'})).toBeVisible();
  await expect(page.getByText('FINDINGS / 第3層', {exact:true})).toBeVisible();
  const firstReview = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  const initial = await (await page.request.get(`/api/sessions/${firstReview}`)).json();
  await page.screenshot({path:'test-results/review-desktop.png', fullPage:true});
  await page.reload();
  await expect(page.getByRole('heading', {name:'何が分からないか、見えてきましたか？'})).toBeVisible();
  const afterReload = await (await page.request.get(`/api/sessions/${firstReview}`)).json();
  expect(afterReload.pending_review.review_id).toBe(initial.pending_review.review_id);
  expect(afterReload.next_question).toBeNull();
  await page.getByRole('button', {name:'まだ分からない · 次の層へ進む', exact:true}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  await reachCheckpoint();
  await expect(page.getByText('FINDINGS / 第4層', {exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/review-mobile.png', fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button', {name:'分からない箇所が分かった · 終了する', exact:true}).click();
  await expect(page.getByRole('heading', {name:'分からない箇所を整理できました。'})).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name:'診断記録を保存', exact:true}).click();
  expect((await download).suggestedFilename()).toMatch(/^diagnostic-sess_.*\.json$/);
  await page.screenshot({path:'test-results/diagnosis-complete.png', fullPage:true});
});

test('new setup offers only Gemini and no exploration-mode selector', async ({page}) => {
  await page.goto('/legacy.html');
  await expect(page.getByLabel('診断モード')).toHaveCount(0);
  await expect(page.getByText('デモ教材 · 微分')).toHaveCount(0);
  await expect(page.getByText('関心のある項目を選ぶ')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'診断をはじめる'})).toBeEnabled();
});

test('comprehensive choice persists and satisfaction continues remaining branches', async ({page}) => {
  await page.goto('/legacy.html');
  await loadLegacySession(page, 'comprehensive');
  await expect(page.getByText('全項目を網羅')).toHaveCount(0);
  const sid = await page.evaluate(() => sessionStorage.getItem('diagnostic-session'));
  let data = await (await page.request.get(`/api/sessions/${sid}`)).json();
  for (let i=0; i<100 && !data.pending_review; i++) {
    const q = data.next_question;
    data = await (await page.request.post(`/api/sessions/${sid}/answers`, {data:{question_id:q.question_id, answer:q.choices?.length ? q.choices[q.choices.length-1].choice_id : 'わからない'}})).json();
  }
  expect(data.pending_review).toBeTruthy();
  const first = data.pending_review.concept_id;
  await page.reload();
  await expect(page.getByText('全項目を網羅')).toHaveCount(0);
  await page.getByRole('button', {name:'この項目は分かった · 残りの項目へ', exact:true}).click();
  await expect(page.locator('.summary')).toHaveCount(0);
  const after = await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(after.complete).toBe(false);
  expect(after.review_history.at(-1).review.concept_id).toBe(first);
  expect(after.pending_review?.concept_id ?? after.next_question?.concept_id).not.toBe(first);
  await page.screenshot({path:'test-results/comprehensive-remaining.png', fullPage:true});
});
