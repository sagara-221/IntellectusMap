import {test,expect} from './fixtures';

// Exercise additional assessment in sessions created with the previous flow.
test.beforeEach(async ({page}) => {
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const data = JSON.parse(route.request().postData() ?? '{}');
    await route.fallback({postData: JSON.stringify({...data, manual_flow: 'combined'})});
  });
});

test('new setup fixes both allowed question formats',async({page})=>{
  let submitted: {mode:string; allowed_question_types:string[]; exploration_mode:string} | null = null;
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted = JSON.parse(route.request().postData() ?? '{}');
    await route.fallback();
  });
  await page.goto('/legacy.html');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText('確認問題は4択・正誤判断から内容に合う形式で出題します。')).toBeVisible();
  await expect(page.getByLabel('診断モード')).toHaveCount(0);
  await page.screenshot({path:'test-results/fixed-question-formats.png',fullPage:true});
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  expect(submitted).toMatchObject({mode:'gemini', exploration_mode:'manual', allowed_question_types:['multiple_choice','yes_no']});
  await page.locator('.concept-links').getByRole('button',{name:'基本公式',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.choice')).toHaveCount(4);
  await page.reload();
  await expect(page.locator('.choice')).toHaveCount(4);
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  const data=await(await page.request.get(`/api/sessions/${sid}`)).json();
  expect(data.allowed_question_types).toEqual(['multiple_choice','yes_no']);
});

test('answered item generates an extra question and retains evidence after completion',async({page})=>{
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const data = JSON.parse(route.request().postData() ?? '{}');
    await route.fallback({postData: JSON.stringify({...data, allowed_question_types:['multiple_choice']})});
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.locator('.concept-links').getByRole('button',{name:'微分の基本概念',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  for(const choice of ['A 接線の傾き','D 微分係数','C 正']){
    await page.getByRole('button',{name:choice,exact:true}).click();
    await page.getByRole('button',{name:'回答して次へ',exact:true}).click();
    await expect(page.locator('.feedback')).toBeVisible();
    await page.getByRole('button',{name:'次の項目を選ぶ',exact:true}).click();
    if(choice !== 'C 正') await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  }
  await expect(page.locator('.selection-prompt')).toBeVisible();
  await page.getByRole('button',{name:'追加で確認する',exact:true}).click();
  await expect(page.locator('.reassessment-banner')).toBeVisible();
  await page.reload();
  await expect(page.locator('.reassessment-banner')).toBeVisible();
  await page.getByRole('button',{name:'B 微分係数',exact:true}).click();
  await page.getByRole('button',{name:'回答して次へ',exact:true}).click();
  await expect(page.locator('.feedback')).toBeVisible();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  const result=await(await page.request.get(`/api/sessions/${sid}`)).json();
  expect(result.questions_answered).toBe(4);
  expect(result.learning_states.meaning.questions_answered).toBe(4);
  expect(result.reassessment_concept_id).toBeNull();
  await page.getByRole('button',{name:'次の項目を選ぶ',exact:true}).click();
  const stop=await page.request.post(`/api/sessions/${sid}/stop`);
  expect(stop.ok(),await stop.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator('.summary')).toBeVisible();
  await page.getByRole('button',{name:'微分の基本概念の診断詳細',exact:true}).click();
  await page.getByRole('button',{name:'追加で確認する',exact:true}).click();
  await expect(page.locator('.question-body')).toBeVisible();
  await page.screenshot({path:'test-results/reassessment-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'追加確認を中止',exact:true}).click();
  await expect(page.locator('.summary')).toBeVisible();
});
