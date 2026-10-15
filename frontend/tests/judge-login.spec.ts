import {test,expect} from './fixtures';

test('reviewer can log in without Google and log out',async({page})=>{
  await page.addInitScript(()=>localStorage.removeItem('kgm_id_token'));
  await page.route('https://accounts.google.com/**',r=>r.abort());
  await page.route('**/api/sessions',route=>route.request().method()==='GET'?route.fulfill({json:[]}):route.fallback());
  await page.route('**/api/auth/judge-login',async route=>{
    const body=route.request().postDataJSON();
    if(body.password!=='review-pass')return route.fulfill({status:401,json:{detail:'IDまたはパスワードが正しくありません。'}});
    const exp=Math.floor(Date.now()/1000)+3600;
    await route.fulfill({json:{token:`judge.${exp}.${'a'.repeat(32)}.${'b'.repeat(64)}`,user:{sub:'reviewer:intellectusmap',name:'審査員',exp}}});
  });
  await page.goto('/');
  await page.getByLabel('審査員ID',{exact:true}).fill('reviewer');
  await page.getByLabel('パスワード',{exact:true}).fill('wrong');
  await page.getByRole('button',{name:'審査員としてログイン'}).click();
  await expect(page.getByRole('alert')).toHaveText('IDまたはパスワードが正しくありません。');
  await page.getByLabel('パスワード',{exact:true}).fill('review-pass');
  await page.getByRole('button',{name:'審査員としてログイン'}).click();
  await expect(page.locator('.user-name')).toHaveText('審査員');
  await expect(page.getByRole('button',{name:'このテーマを探索する'})).toBeVisible();
  await page.getByRole('button',{name:'ログアウト'}).click();
  await expect(page.getByLabel('審査員ID',{exact:true})).toBeVisible();
});
