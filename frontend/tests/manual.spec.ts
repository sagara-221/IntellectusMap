import { test, expect } from './fixtures';

// Exercise the previous flow for sessions that already use it.
test.beforeEach(async ({page}) => {
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const data = JSON.parse(route.request().postData() ?? '{}');
    await route.fallback({postData: JSON.stringify({...data, manual_flow: 'combined'})});
  });
});

test('choose knowledge, generate both, switch and resume, search and revisit', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error=>errors.push(error.message));
  await page.goto('/legacy.html');
  const syllabus='対象：高校数学II\n第6章 微分法\n・微分係数と導関数\n・べき関数の微分\n除外：積・商・合成関数の微分';
  const syllabusField=page.getByLabel('テーマの詳細情報 任意');
  await expect(syllabusField).toBeVisible();
  await syllabusField.fill(syllabus);
  await expect(page.getByText(`${syllabus.length} / 12,000`)).toBeVisible();
  await expect(page.locator('input[name="exploration-mode"]')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({path:'test-results/manual-setup.png',fullPage:true});
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading',{name:'気になる知識から、はじめよう。'})).toBeVisible();
  const startedSession=await (await page.request.get(`/api/sessions/${await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'))}`)).json();
  expect(startedSession.domain_context).toBe(syllabus);
  await expect(page.locator('.question-body')).toHaveCount(0);
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('基本公式');
  await expect(page.locator('.choice')).toHaveCount(4);
  await expect(page.locator('.graph-dot')).toHaveCount(8);
  const firstText=await page.locator('.question-markdown').textContent();
  await page.getByRole('button',{name:'微分の基本概念の診断詳細',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('微分の基本概念');
  await page.reload();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('微分の基本概念');
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.question-markdown')).toHaveText(firstText!);
  await page.locator('.choice').first().click();
  await page.getByRole('button',{name:'回答して次へ',exact:true}).click();
  await expect(page.locator('.feedback')).toBeVisible();
  await page.getByRole('button',{name:'次の項目を選ぶ',exact:true}).click();
  await expect(page.locator('.selection-prompt')).toBeVisible();
  await expect(page.locator('.question-body')).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="power"] .graph-dot')).not.toHaveClass(/unanswered/);
  await expect(page.locator('.react-flow__node[data-id="meaning"] .graph-dot')).toHaveClass(/unanswered/);
  await page.locator('.selection-prompt').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.choice')).toHaveCount(2);
  await page.getByLabel('知識項目を検索').fill('積の微分');
  await page.locator('.graph-search-results').getByRole('button',{name:/積の微分/}).click();
  await expect(page.locator('.graph-selection strong')).toHaveText('積の微分');
  await page.getByRole('button',{name:'関連のみ',exact:true}).click();
  await expect(page.locator('.graph-dot.dim').first()).toBeAttached();
  await page.getByRole('button',{name:'グラフ全体を表示'}).click();
  await page.screenshot({path:'test-results/manual-graph-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'繋がりMAP一覧',exact:true}).click();
  await page.getByRole('button',{name:'深掘り',exact:true}).click();
  await expect(page.locator('.graph-selection strong')).toHaveText('積の微分');
  await expect(page.getByRole('button',{name:'深掘りを終了',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile graph and choosing a deeper item without answering parent', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.locator('.concept-links').getByRole('button',{name:'基本公式',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('基本公式');
  await page.locator('.concept-links').getByRole('button',{name:'必要な関数・公式の識別',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.concept-breadcrumb')).toHaveText('必要な関数・公式の識別');
  await expect(page.locator('.graph-dot')).toHaveCount(10);
  await expect(page.getByRole('button',{name:'公式の選択の診断詳細',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'グラフ全体を表示'}).click();
  await page.screenshot({path:'test-results/manual-graph-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  const sid=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  const data=await (await page.request.get(`/api/sessions/${sid}`)).json();
  expect(data.questions_answered).toBe(0);
  expect(data.paused_concept_ids).toEqual(['power']);
});

test('graph nodes can be dragged without moving back on selection', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  const node=page.locator('.react-flow__node[data-id="power"]');
  await expect(node).toBeVisible();
  await expect(page.getByRole('button',{name:'配置を整える',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'グラフ全体を表示'}).click();
  const position=()=>node.evaluate(element=>(element as HTMLElement).style.transform);
  const original=await position();
  const ringSize=await node.locator('.drag-ring').boundingBox();
  await node.locator('.drag-ring').hover({position:{x:ringSize!.width/2,y:2}});
  const ring=await node.locator('.drag-ring').boundingBox();
  await page.mouse.move(ring!.x+ring!.width/2,ring!.y+2);
  await page.mouse.down();
  await page.mouse.move(ring!.x+ring!.width/2+60,ring!.y+42,{steps:8});
  await page.mouse.up();
  await expect.poll(position).not.toBe(original);
  const moved=await position();
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await expect.poll(position).toBe(moved);
});

test('AI terminal judgment and its reason are visible', async ({page}) => {
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response=await route.fetch();
    const diagnosis=await response.json();
    const terminal=diagnosis.knowledge_tree.child_nodes[0];
    terminal.granularity='narrow';
    terminal.child_candidates=[];
    terminal.terminal_reason='単一の観測可能な技能まで分解済みのため。';
    await route.fulfill({response,json:diagnosis});
  });
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response=await route.fetch({postData:JSON.stringify({...JSON.parse(route.request().postData() ?? '{}'),mode:'demo',manual_flow:'combined'})});
    const diagnosis=await response.json();
    const terminal=diagnosis.knowledge_tree.child_nodes[0];
    terminal.granularity='narrow';
    terminal.child_candidates=[];
    terminal.terminal_reason='単一の観測可能な技能まで分解済みのため。';
    await route.fulfill({response,json:diagnosis});
  });
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading',{name:'気になる知識から、はじめよう。'})).toBeVisible();
  await page.getByRole('button',{name:'微分の基本概念の診断詳細',exact:true}).click();
  await expect(page.getByText('AIがこれ以上の分解候補はないと判定')).toBeVisible();
  await expect(page.getByText('単一の観測可能な技能まで分解済みのため。')).toBeVisible();
});

test('decomposition failure reason and retry action remain visible on the concept', async ({page}) => {
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response=await route.fetch();
    const diagnosis=await response.json();
    diagnosis.knowledge_tree.child_nodes[0].expansion_error='下位項目の生成に失敗しました。AIの出力形式を検証できませんでした。再試行してください。';
    await route.fulfill({response,json:diagnosis});
  });
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response=await route.fetch({postData:JSON.stringify({...JSON.parse(route.request().postData() ?? '{}'),mode:'demo',manual_flow:'combined'})});
    const diagnosis=await response.json();
    diagnosis.knowledge_tree.child_nodes[0].expansion_error='下位項目の生成に失敗しました。AIの出力形式を検証できませんでした。再試行してください。';
    await route.fulfill({response,json:diagnosis});
  });
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.getByRole('button',{name:'微分の基本概念の診断詳細',exact:true}).click();
  await expect(page.getByText('下位項目を生成できませんでした')).toHaveCount(2);
  await expect(page.getByText(/AIの出力形式を検証できませんでした/)).toHaveCount(2);
  await expect(page.getByRole('button',{name:'項目分解を再試行',exact:true})).toHaveCount(2);
  await expect(page.getByText('末端と判定された状態ではありません。再試行できます。')).toBeVisible();
});

test('generated Markdown, code, and math are rendered instead of shown raw', async ({page}) => {
  await page.route('**/api/sessions/*/select', async route => {
    const response=await route.fetch();
    const diagnosis=await response.json();
    diagnosis.next_question.question_text='**次のコード**を読み、$y=x^2$ のときの出力を選びなさい。\n\n```python\nx = 2\nprint(x ** 2)\n```';
    diagnosis.next_question.question_type='multiple_choice';
    diagnosis.next_question.choices=[
      {choice_id:'A',text:'`4` が出力される'},
      {choice_id:'B',text:'`2` が出力される'},
      {choice_id:'C',text:'`x^2` と表示される'},
      {choice_id:'D',text:'エラーになる'},
    ];
    await route.fulfill({response,json:diagnosis});
  });
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await page.getByRole('button',{name:'基本公式の診断詳細',exact:true}).click();
  await page.locator('.graph-selection').getByRole('button',{name:'この項目を深掘り',exact:true}).click();
  await expect(page.locator('.question-markdown strong')).toHaveText('次のコード');
  await expect(page.locator('.question-markdown pre code')).toContainText('print(x ** 2)');
  await expect(page.locator('.question-markdown .katex')).toBeVisible();
  await expect(page.locator('.choice-markdown code').first()).toHaveText('4');
  await expect(page.getByText('**次のコード**')).toHaveCount(0);
  await page.screenshot({path:'test-results/markdown-question.png',fullPage:true});
});

test('large graph keeps every node expanded while force layout settles', async ({page}) => {
  await page.goto('/legacy.html');
  await page.getByRole('button',{name:'診断をはじめる'}).click();
  await expect(page.getByRole('heading',{name:'気になる知識から、はじめよう。'})).toBeVisible();
  const sessionId=await page.evaluate(()=>sessionStorage.getItem('diagnostic-session'));
  let conceptId='power';
  let diagnosis:any;
  for (let depth=0;depth<4;depth++) {
    diagnosis=await (await page.request.post(`/api/sessions/${sessionId}/select`,{data:{concept_id:conceptId}})).json();
    const stack=[diagnosis.knowledge_tree];
    let selected:any;
    while (stack.length) {
      const node=stack.pop();
      if (node.concept_id===conceptId) selected=node;
      stack.push(...node.child_nodes);
    }
    conceptId=selected.child_nodes[0].concept_id;
  }
  const total=(()=>{const stack=[diagnosis.knowledge_tree];let count=0;while(stack.length){const node=stack.pop();count++;stack.push(...node.child_nodes);}return count;})();
  expect(total).toBeGreaterThan(12);
  await page.reload();
  await expect(page.locator('.graph-dot')).toHaveCount(total);
  await expect(page.locator('.graph-layout-status')).toHaveText(`力学配置 · 全${total-1}項目を表示`,{timeout:10000});
  await expect(page.locator('.collapsed-count')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'全件表示',exact:true})).toHaveCount(0);
  const arrange=page.getByRole('button',{name:'配置を整える',exact:true});
  await expect(arrange).toBeEnabled();
  await arrange.click();
  await expect(page.locator('.graph-layout-status')).toHaveText('配置を計算中…');
  await expect(page.locator('.graph-layout-status')).toHaveText(`力学配置 · 全${total-1}項目を表示`,{timeout:10000});
  await expect(page.locator('.graph-dot')).toHaveCount(total);
  await page.screenshot({path:'test-results/organized-large-graph.png',fullPage:true});
});
