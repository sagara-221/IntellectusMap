import { test, expect } from './fixtures';

test('4K workspace fills the display and the map refits after resizing', async ({page}) => {
  await page.setViewportSize({width:3840, height:2160});
  await page.goto('/legacy.html');
  await page.getByRole('button', {name:'診断をはじめる'}).click();
  await expect(page.locator('.knowledge-graph')).toBeVisible();

  const large = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      main: bounds('main').width,
      map: bounds('.map-panel').width,
      graph: bounds('.flow-wrap').height,
      questionRight: bounds('.question-panel').right,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(large.main).toBe(3840);
  expect(large.map).toBeGreaterThan(2300);
  expect(large.graph).toBeGreaterThan(1200);
  expect(large.questionRight).toBeLessThanOrEqual(3840);
  expect(large.scrollWidth).toBeLessThanOrEqual(3840);

  await page.setViewportSize({width:1440, height:900});
  await expect.poll(async () => page.evaluate(() => {
    const graph = document.querySelector('.knowledge-graph')!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect());
    return nodes.length > 0 && nodes.every(node =>
      node.left >= graph.left && node.right <= graph.right &&
      node.top >= graph.top && node.bottom <= graph.bottom);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});
