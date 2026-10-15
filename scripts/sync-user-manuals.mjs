// Publish the same reviewed documents in Vite's public directory.
import fs from 'node:fs/promises';
await fs.mkdir('frontend/public/manuals',{recursive:true});
for(const [name,slug] of [['簡易ユーザーマニュアル','quick'],['詳細ユーザーマニュアル','detailed']]) {
 for(const ext of ['pdf','html']) {
  let data=await fs.readFile(`output/pdf/IntellectusMap_${name}.${ext}`);
  if(ext==='html')data=Buffer.from(data.toString().replace('</style>', '@media screen and (max-width:800px){.sheet{width:100%;height:auto;min-height:0;padding:20px;margin:0 0 12px}.cards{grid-template-columns:1fr}footer{position:static;margin-top:24px}.flow{flex-wrap:wrap}.flow>div{min-width:110px}} </style>').replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'));
  await fs.writeFile(`frontend/public/manuals/${slug}.${ext}`,data);
 }
}
