import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

async function expectThemeAtCenter(page:Page, rootId:string) {
  const graph=page.locator('.map-connections');
  const root=graph.locator(`.connection-root[data-id="${rootId}"]`);
  await expect(root).toBeVisible();
  await expect.poll(async()=>{
    const area=await graph.boundingBox(),node=await root.boundingBox();
    if(!area || !node)return Infinity;
    return Math.hypot(node.x+node.width/2-area.x-area.width/2,node.y+node.height/2-area.y-area.height/2);
  }).toBeLessThan(4);
}
async function openLineage(page:Page, lineageId:string){
  const card=page.locator(`.connection-lineage-card[data-lineage-id="${lineageId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button',{name:'地図を開く'}).click();
  await expect(page.locator('.map-connections')).toBeVisible();
}


test('divergence, map management, and connection graph', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('diagnostic-session'))).not.toBeNull();
  const rootId = await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-page h1')).toContainText('繋がりMAP');
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(page.getByRole('dialog',{name:/知識を広げる/})).toHaveCount(0);
  await expectThemeAtCenter(page,rootId!);
  const rootBox=(await page.locator(`.connection-root[data-id="${rootId}"]`).boundingBox())!;
  const candidateCenters=await page.locator('.connection-candidate').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};}));
  expect(candidateCenters.some(point=>point.x<rootBox.x)).toBe(true);
  expect(candidateCenters.some(point=>point.x>rootBox.x+rootBox.width)).toBe(true);
  expect(candidateCenters.some(point=>point.y<rootBox.y)).toBe(true);
  expect(candidateCenters.some(point=>point.y>rootBox.y+rootBox.height)).toBe(true);
  const before = await (await page.request.get('/api/maps')).json();
  const candidate=before.candidates.find((item:{source_map_id:string})=>item.source_map_id===rootId);
  await page.locator(`.map-connections .react-flow__node[data-id="${candidate.id}"]`).click();
  expect((await (await page.request.get('/api/maps')).json()).maps.length).toBe(before.maps.length);
  await expect(page.locator('.connection-origin')).toContainText(candidate.reason);
  await page.getByRole('button',{name:'このテーマで深掘りを始める'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const newId = await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  expect(newId).not.toBe(rootId);
  const created = await (await page.request.get(`/api/maps/${newId}`)).json();
  expect(created.lineage_id).toBe(rootId);
  expect(created.origin.source_map_id).toBe(rootId);
  // Widening a derived map adds an outer branch while retaining the original theme at the center.
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5);
  await expectThemeAtCenter(page,rootId!);
  await expect(page.locator(`.react-flow__node[data-id="${newId}"]`)).not.toHaveClass(/connection-root/);
  const derivedListing=await (await page.request.get('/api/maps')).json();
  const branch=derivedListing.candidates.find((item:{source_map_id:string})=>item.source_map_id===newId);
  const branchBox=(await page.locator(`.react-flow__node[data-id="${branch.id}"]`).boundingBox())!;
  const originalBox=(await page.locator(`.connection-root[data-id="${rootId}"]`).boundingBox())!;
  const derivedBox=(await page.locator(`.react-flow__node[data-id="${newId}"]`).boundingBox())!;
  const distance=(box:typeof originalBox)=>Math.hypot(box.x+box.width/2-originalBox.x-originalBox.width/2,box.y+box.height/2-originalBox.y-originalBox.height/2);
  expect(distance(branchBox)).toBeGreaterThan(distance(derivedBox));
  await page.screenshot({path:'test-results/connection-radial-branches.png',fullPage:true});
  await page.getByRole('button',{name:'深堀マップ一覧',exact:true}).click();
  await expect(page.locator(`.map-list-card[data-map-id="${newId}"]`)).toBeVisible();
  await page.locator(`.map-list-card[data-map-id="${newId}"]`).getByRole('button',{name:'詳細'}).click();
  await page.locator('.map-detail').getByRole('button',{name:'編集'}).click();
  await page.getByLabel('マップ名').fill('編集した知識マップ');
  await page.locator('.map-detail').getByRole('button',{name:'保存'}).click();
  await expect(page.locator('.map-detail h2')).toHaveText('編集した知識マップ');
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await openLineage(page,rootId!);
  await expect(page.locator(`.map-connections .react-flow__node[data-id="${rootId}"]`)).toBeVisible();
  await expect(page.locator(`.map-connections .react-flow__node[data-id="${newId}"]`)).toBeVisible();
  await page.locator(`.map-connections .react-flow__node[data-id="${newId}"]`).click();
  await expect(page.locator('.connection-detail h2')).toHaveText('編集した知識マップ');
  await expect(page.locator('.connection-origin')).toContainText(created.origin.reason);
  await expect(page.locator('.concept-summary-list button').first()).toBeVisible();
  await page.getByRole('button',{name:'深堀マップ一覧',exact:true}).click();
  await page.locator(`.map-list-card[data-map-id="${newId}"]`).getByRole('button',{name:'詳細'}).click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.map-detail').getByRole('button',{name:'削除'}).click();
  await expect(page.locator(`.map-list-card[data-map-id="${newId}"]`)).toHaveCount(0);
  expect((await page.request.get(`/api/maps/${newId}`)).status()).toBe(404);
});

test('shared evidence is identified as coming from another map', async ({page}) => {
  const response = await page.request.post('/api/sessions', {data:{theme:'微分',mode:'demo'}});
  expect(response.ok()).toBeTruthy();
  const sid = (await response.json()).session_id as string;
  await page.addInitScript(id=>sessionStorage.setItem('diagnostic-session',id),sid);
  await page.route(`**/api/sessions/${sid}`, async route => {
    const fetched = await route.fetch();
    const diagnosis = await fetched.json();
    diagnosis.canonical_refs.power.other_map_titles=['別の学習テーマ'];
    diagnosis.evidence.push({evidence_id:'shared_evidence',question_id:'shared_question',
      concept_id:'power',correctness:'correct',score:1,evaluation_confidence:.9,
      user_answer:'A',demonstrated_knowledge:[],missing_knowledge:[],
      grading_method:'fixture',origin_map_id:'another_map'});
    await route.fulfill({response:fetched,json:diagnosis});
  });
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await expect(page.getByText(/別の深掘りマップで確認済み/)).toBeVisible();
  await expect(page.getByText(/別の学習テーマ/)).toBeVisible();
});

test('all widening candidates persist in connections and regenerated candidates are new', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const sid = await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-page h1')).toContainText('繋がりMAP');
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  const first = await page.locator('.connection-new-candidate strong').allTextContents();
  await page.getByRole('button',{name:'別の候補を探す'}).click();
  await expect(page.locator('.connection-new-candidate strong').first()).not.toHaveText(first[0]);
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5);
  const second = await page.locator('.connection-new-candidate strong').allTextContents();
  expect(second.some(name=>first.includes(name))).toBe(false);
  await expect(page.locator('.connection-candidate')).toHaveCount(10);
  await page.getByRole('button',{name:'探索',exact:true}).click();
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-page h1')).toContainText('繋がりMAP');
  await expect(page.locator('.connection-new-candidate strong').first()).not.toHaveText(second[0]);
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5);
  const third = await page.locator('.connection-new-candidate strong').allTextContents();
  expect(third.some(name=>[...first,...second].includes(name))).toBe(false);
  await expect(page.locator('.connection-candidate')).toHaveCount(15);
  await expectThemeAtCenter(page,sid!);
  const cards=await page.locator('.map-connections .react-flow__node').evaluateAll(nodes=>nodes.map(node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};}));
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++) {
    expect(cards[i].right<=cards[j].left || cards[j].right<=cards[i].left || cards[i].bottom<=cards[j].top || cards[j].bottom<=cards[i].top).toBe(true);
  }
  const listing = await (await page.request.get('/api/maps')).json();
  const candidates = listing.candidates.filter((item:{source_map_id:string})=>item.source_map_id===sid);
  expect(candidates).toHaveLength(15);
  expect(listing.maps.filter((item:{lineage_id:string})=>item.lineage_id===sid)).toHaveLength(1);
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await openLineage(page,sid!);
  await expect(page.locator('.map-connections .connection-candidate')).toHaveCount(15);
  await expect(page.locator('.connection-toolbar')).toContainText('候補 15件');
  for (const candidate of candidates) {
    await expect(page.locator(`.map-connections .react-flow__node[data-id="${candidate.id}"]`)).toContainText(candidate.name);
  }
  await page.reload();
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await openLineage(page,sid!);
  const chosen = candidates[0];
  await page.locator(`.map-connections .react-flow__node[data-id="${chosen.id}"]`).click();
  await expect(page.locator('.connection-detail h2')).toHaveText(chosen.name);
  await expect(page.locator('.connection-origin')).toContainText(chosen.reason);
  await page.getByRole('button',{name:'このテーマで深掘りを始める'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  const newId = await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  expect(newId).not.toBe(sid);
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await openLineage(page,sid!);
  await expect(page.locator('.map-connections .connection-candidate')).toHaveCount(14);
  await expect(page.locator(`.map-connections .react-flow__node[data-id="${newId}"]`)).toContainText(chosen.name);
  await expect(page.locator(`.map-connections .react-flow__node[data-id="${chosen.id}"]`)).toHaveCount(0);
  await page.screenshot({path:'test-results/widening-connections.png',fullPage:true});
});

test('widening navigates before generation finishes and survives tab changes without duplicate calls', async ({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  await page.route('**/api/maps/*/concepts/*/divergence',async route=>{
    calls++;
    await gate;
    await route.continue();
  });
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('diagnostic-session'))).not.toBeNull();
  const sid=(await page.evaluate(()=>sessionStorage.getItem('diagnostic-session')))!;
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-page h1')).toContainText('繋がりMAP');
  await expect(page.locator('.connection-generation')).toContainText('基本公式');
  await expect(page.locator('.connection-generation [role="status"]')).toContainText('候補を探しています');
  await expect(page.getByRole('button',{name:'別の候補を探す'})).toBeDisabled();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(0);
  await page.getByRole('button',{name:'探索',exact:true}).click();
  await expect(page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'})).toBeDisabled();
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await expect(page.locator('.connection-generation')).toContainText('候補を探しています');
  release();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  await expect(page.locator('.connection-generation')).toContainText('新しい候補 5件');
  await expect(page.locator(`.connection-lineage-card[data-lineage-id="${sid}"]`)).toHaveCount(0);
  await expect(page.locator('.connection-detail .eyebrow')).toHaveText('未探索の候補');
  expect(calls).toBe(1);
  const listing=await (await page.request.get('/api/maps')).json();
  expect(listing.candidates.filter((item:{source_map_id:string})=>item.source_map_id===sid)).toHaveLength(5);
  expect(listing.maps.filter((item:{lineage_id:string})=>item.lineage_id===sid)).toHaveLength(1);
  await expectThemeAtCenter(page,sid!);
  await page.screenshot({path:'test-results/widen-navigation-desktop.png',fullPage:true});
  await page.setViewportSize({width:3840,height:2160});
  await expectThemeAtCenter(page,sid!);
  await page.locator('.map-connections').getByRole('button',{name:'Zoom In',exact:true}).click();
  await page.locator('.map-connections').getByRole('button',{name:'Fit View',exact:true}).click();
  await expectThemeAtCenter(page,sid!);
  await page.screenshot({path:'test-results/connection-radial-4k.png',fullPage:true});
});

test('generation failure can be retried from connections and candidates fit on mobile', async ({page})=>{
  let calls=0;
  await page.route('**/api/maps/*/concepts/*/divergence',async route=>{
    calls++;
    if(calls===1) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'候補生成の通信に失敗しました。'})});
    await route.continue();
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.locator('.session-bar')).toBeVisible();
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.locator('.detail-actions').getByRole('button',{name:'知識を広げる'}).click();
  await expect(page.locator('.connection-page h1')).toContainText('繋がりMAP');
  await expect(page.locator('.connection-generation [role="alert"]')).toHaveText('候補生成の通信に失敗しました。');
  await page.getByRole('button',{name:'候補の生成を再試行'}).click();
  await expect(page.locator('.connection-new-candidate')).toHaveCount(5,{timeout:30000});
  expect(calls).toBe(2);
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  await expectThemeAtCenter(page,sid!);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/widen-navigation-mobile.png',fullPage:true});
});
