import {ArrowRight, Compass, LoaderCircle, Map, Flag} from 'lucide-react';
import PixelTown from './PixelTown';
import Miner from './PixelAgent';

export function AtlasCover({busy=false}:{busy?:boolean}) {
  return <div className="atlas-cover">
    <div className="atlas-cover-title"><span>IntellectusMap</span><Compass size={34}/></div>
    <svg className="atlas-cover-map" viewBox="0 0 560 360" role="img" aria-label="町から未探索の場所へ道が続く、知識の地図のイメージ">
      <defs><pattern id="cover-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#b7b49b" strokeOpacity=".2"/></pattern></defs>
      <rect width="560" height="360" fill="url(#cover-grid)"/>
      <g fill="none" stroke="#b4b297" strokeWidth="1" opacity=".5">
        <path d="M-40 244C-10 41 151-4 240 52S313 171 450 122S619 191 587 319"/>
        <path d="M-20 258C15 63 145 25 222 73S320 199 455 150S591 205 570 315"/>
        <path d="M8 277C36 103 146 44 209 98S313 228 458 178S570 223 548 306"/>
        <path d="M35 294C57 139 143 72 192 123S308 255 463 206S548 250 525 312"/>
      </g>
      <path d="M92 249L192 208L277 234L342 127L466 97" fill="none" stroke="#b2a582" strokeWidth="10" strokeLinejoin="round"/>
      <path d="M92 249L192 208L277 234L342 127L466 97" fill="none" stroke="#f9efd2" strokeWidth="5" strokeDasharray="3 7"/>
      <g transform="translate(153 221) scale(1.35)"><PixelTown/></g>
      <g transform="translate(336 125) scale(.9)"><PixelTown/></g>
      <path d="M404 25C496-15 575 32 576 115S504 196 447 165S356 70 404 25" fill="#faf8eedb"/>
      <circle cx="466" cy="97" r="19" fill="#f7f2e4" stroke="#afa98e" strokeDasharray="3 5"/>
      <text x="466" y="103" textAnchor="middle" fill="#8f927c" fontSize="20">?</text>
      <g fill="#56664e" fontFamily="serif" fontSize="13"><text x="89" y="286">わかっている場所</text><text x="296" y="192">理解をたしかめる</text><text x="414" y="142">まだ見ぬ知識</text></g>
      <g transform="translate(42 36)" stroke="#74866c" fill="none"><path d="M0 12V-12M-12 0H12"/><path d="M0-18L-4-8H4Z" fill="#74866c"/><text x="-4" y="-23" stroke="none" fill="#74866c" fontSize="10">N</text></g>
    </svg>
    <div className="atlas-cover-caption"><Miner state={busy?'walk':'idle'}/><p>{busy?'地図づくりの仲間が、最初の道を調べています。':'知っていることを町に。まだ知らないことを、次の目的地に。'}</p></div>
    <small>地図のイメージ · 実際の理解度は回答から推定します</small>
  </div>;
}

type Props={theme:string;onTheme:(value:string)=>void;syllabus:string;onSyllabus:(value:string)=>void;busy:boolean;ready:boolean;configurationError:string;onStart:()=>void};
export default function AtlasStart({theme,onTheme,syllabus,onSyllabus,busy,ready,configurationError,onStart}:Props){
  return <section className="atlas-departure" aria-labelledby="departure-title">
    <div className="atlas-intro"><span className="atlas-overline">探索の支度</span><h1 id="departure-title">知識の地図をひらく。</h1><p>わかる場所も、迷う場所も。<br/>会話をしながら、自分だけの地図にしていこう。</p><AtlasCover busy={busy}/></div>
    <form className="atlas-departure-form" onSubmit={e=>{e.preventDefault();onStart();}} aria-busy={busy}>
      <div className="atlas-form-heading"><Map size={20}/><div><span>NEW EXPLORATION</span><h2>どこを探索しますか？</h2></div><span className="atlas-sheet-number">01</span></div>
      <label className="atlas-theme-field">探索するテーマ<input value={theme} onChange={e=>onTheme(e.target.value)} maxLength={300} disabled={busy} required placeholder="例：微分、ネットワーク、Attention"/></label>
      <div className="atlas-theme-examples"><span>たとえば</span>{['微分','ネットワーク','Attention'].map(example=><button type="button" key={example} disabled={busy} onClick={()=>onTheme(example)}>{example}</button>)}</div>
      <label className="atlas-range-field">探索範囲のメモ <span>任意</span><textarea value={syllabus} onChange={e=>onSyllabus(e.target.value)} maxLength={12000} disabled={busy} rows={4} placeholder={'例：高校数学の微分。導関数と接線を中心に、\nどこまで理解できているかを確かめたい。'}/></label>
      <p className="atlas-field-hint">学びたい範囲やレベル、今回は扱わない内容を書けます。</p>
      <div className="atlas-departure-note"><Flag size={17}/><p>テーマから最初の知識マップを作ります。<br/>受付で経験や疑問を話すと、関連する項目をさらに追加できます。</p></div>
      <button className="primary atlas-departure-button" disabled={busy||!ready||!theme.trim()}>{busy?<LoaderCircle size={18} className="spin"/>:<Compass size={18}/>} {busy?'地図を準備しています…':'このテーマを探索する'}{!busy&&<ArrowRight size={18}/>}</button>
      <p className="atlas-departure-status" role="status">{busy?'準備ができると、探索受付のチャットをひらきます。':ready?'入力したテーマ・メモ・回答はGeminiに送信されます。':configurationError||'探索の準備を確認しています…'}</p>
    </form>
    <ol className="atlas-journey"><li><span>01</span><div><strong>行き先を決める</strong><p>気になるテーマから地図をつくる</p></div></li><li><span>02</span><div><strong>受付で話す</strong><p>経験や疑問から、地図に項目を増やす</p></div></li><li><span>03</span><div><strong>次の目的地を見つける</strong><p>理解が浅い場所や新しい知識へ進む</p></div></li></ol>
  </section>;
}
