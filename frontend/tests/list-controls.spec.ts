import {test, expect} from './fixtures';

test('maps form one searchable list with sorting and removable conditions', async ({page}) => {
  const maps=[
    {map_id:'alpha',lineage_id:'one',title:'Alpha 基礎',scope:'計算の基礎',updated_at:'2026-10-01T09:00:00Z',origin:null,stats:{explored_concepts:8,diagnosed_concepts:6,weak_concepts:1,question_answers:2,survey_answers:6}},
    {map_id:'beta',lineage_id:'two',title:'Beta 画像',scope:'画像の特徴を理解する',updated_at:'2026-10-03T09:00:00Z',origin:null,stats:{explored_concepts:5,diagnosed_concepts:2,weak_concepts:2,question_answers:0,survey_answers:2}},
    {map_id:'gamma',lineage_id:'one',title:'Gamma 言語',scope:'言語を理解する',updated_at:'2026-10-02T09:00:00Z',origin:null,stats:{explored_concepts:4,diagnosed_concepts:0,weak_concepts:0,question_answers:0,survey_answers:0}},
  ];
  await page.route('**/api/maps',route=>route.fulfill({json:{maps,lineages:[{lineage_id:'one',root_map_id:'alpha',title:'機械学習エンジニア系統',map_ids:['alpha','gamma']},{lineage_id:'two',root_map_id:'beta',title:'別テーマ系統',map_ids:['beta']}],relations:[],candidates:[]}}));
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'深堀マップ一覧',exact:true}).click();
  const titles=page.locator('.map-list-card h3');
  const toolbar=page.getByRole('region',{name:'一覧の検索と表示条件'});
  await expect(titles).toHaveText(['Beta 画像','Gamma 言語','Alpha 基礎']);
  await expect(page.locator('.lineage-group')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'機械学習エンジニア系統'})).toHaveCount(0);
  await expect(toolbar.getByRole('status')).toHaveText('3 件の深掘りマップ');
  await page.getByLabel('並び順').selectOption('name');
  await expect(titles).toHaveText(['Alpha 基礎','Beta 画像','Gamma 言語']);
  await page.getByLabel('並び順').selectOption('diagnosed');
  await expect(titles).toHaveText(['Alpha 基礎','Beta 画像','Gamma 言語']);
  await page.getByLabel('並び順').selectOption('weak');
  await expect(titles).toHaveText(['Beta 画像','Alpha 基礎','Gamma 言語']);
  await page.getByLabel('深掘りマップを検索').fill('理解する');
  await expect(titles).toHaveText(['Beta 画像','Gamma 言語']);
  await page.getByRole('group',{name:'マップの状態で絞り込み'}).getByRole('button',{name:/理解度を確認済み/}).click();
  await expect(titles).toHaveText(['Beta 画像']);
  await expect(toolbar.getByRole('status')).toHaveText('1 件の深掘りマップ');
  await page.getByRole('button',{name:'検索：理解するの条件を解除'}).click();
  await expect(titles).toHaveText(['Beta 画像','Alpha 基礎']);
  await page.getByRole('button',{name:'理解度を確認済みの条件を解除'}).click();
  await expect(titles).toHaveCount(3);
  await toolbar.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await expect(page.getByLabel('並び順')).toHaveValue('recent');
  await page.screenshot({path:'test-results/map-list-desktop.png',fullPage:true});
  await page.setViewportSize({width:3840,height:2160});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/map-list-4k.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('深掘りマップを検索').fill('ないテーマ');
  await expect(page.getByRole('heading',{name:'条件に合うマップがありません'})).toBeVisible();
  await page.locator('.list-no-results').getByRole('button',{name:'条件をクリア'}).click();
  await expect(titles).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/map-list-mobile.png',fullPage:true});
});

test('knowledge filters combine and can be individually removed or reset on mobile', async ({page})=>{
  const started=await page.request.post('/api/sessions',{data:{theme:'微分：一覧フィルター検証',mode:'demo'}});
  expect(started.ok(),await started.text()).toBeTruthy();
  const mapId=(await started.json()).session_id;
  const assessed=await page.request.post(`/api/sessions/${mapId}/self-assessment`,{data:{concept_id:'power',level:'low'}});
  expect(assessed.ok()).toBeTruthy();
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'知識ノード一覧',exact:true}).click();
  await page.getByLabel('深掘りマップ').selectOption(mapId);
  await page.getByRole('group',{name:'理解度で絞り込み'}).getByRole('button',{name:/理解度：低/}).click();
  await page.getByLabel('知識・マップを検索').fill('基本公式');
  await page.getByLabel('並び順').selectOption('name');
  const toolbar=page.getByRole('region',{name:'一覧の検索と表示条件'});
  await expect(toolbar.getByRole('status')).toHaveText('1 件の知識ノード');
  await expect(page.locator('.node-row')).toHaveCount(1);
  await expect(page.getByLabel('指定中の条件').getByRole('button')).toHaveCount(3);
  await page.screenshot({path:'test-results/node-list-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/node-list-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'理解度：低の条件を解除'}).click();
  await expect(page.getByRole('group',{name:'理解度で絞り込み'}).getByRole('button',{name:/すべて/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('深掘りマップ')).toHaveValue(mapId);
  await page.getByLabel('知識・マップを検索').fill('ない項目');
  await expect(page.getByRole('heading',{name:'条件に合う知識ノードがありません'})).toBeVisible();
  await toolbar.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await expect(page.getByLabel('知識・マップを検索')).toHaveValue('');
  await expect(page.getByLabel('深掘りマップ')).toHaveValue('');
  await expect(page.getByLabel('並び順')).toHaveValue('priority');
  await expect(page.getByLabel('指定中の条件').getByRole('button')).toHaveCount(0);
  await expect(page.locator('.node-row').first()).toBeVisible();
});
