import { useId, type ReactNode } from 'react';
import { ArrowDownUp, LoaderCircle, Search, SlidersHorizontal, X } from 'lucide-react';

export interface ListCondition {key:string;label:string;onRemove:()=>void}
interface Props {
  searchLabel:string;
  placeholder:string;
  query:string;
  onQueryChange:(query:string)=>void;
  sort:string;
  sortOptions:{value:string;label:string}[];
  onSortChange:(value:string)=>void;
  filters?:ReactNode;
  conditions:ListCondition[];
  onReset:()=>void;
  canReset:boolean;
  resultCount?:number;
  resultLabel:string;
  loading?:boolean;
}

export default function ListToolbar({searchLabel,placeholder,query,onQueryChange,sort,sortOptions,onSortChange,
  filters,conditions,onReset,canReset,resultCount,resultLabel,loading=false}:Props) {
  const id=useId();
  return <section className="panel list-toolbar" aria-label="一覧の検索と表示条件">
    <div className="list-toolbar-main">
      <label className="list-search" htmlFor={`${id}-search`}><span>検索</span><div>
        <Search size={17} aria-hidden="true"/>
        <input id={`${id}-search`} aria-label={searchLabel} type="text" value={query} maxLength={200}
          placeholder={placeholder} onChange={event=>onQueryChange(event.target.value)}/>
        {query && <button type="button" aria-label="検索語をクリア" onClick={()=>onQueryChange('')}><X size={15}/></button>}
      </div></label>
      <label className="list-sort" htmlFor={`${id}-sort`}><span><ArrowDownUp size={13} aria-hidden="true"/>並び順</span>
        <select id={`${id}-sort`} aria-label="並び順" value={sort} onChange={event=>onSortChange(event.target.value)}>
          {sortOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    {filters && <div className="list-toolbar-filters"><span className="list-filter-caption"><SlidersHorizontal size={14} aria-hidden="true"/>絞り込み</span>{filters}</div>}
    <div className="list-toolbar-summary">
      <span className="list-result-count" role="status" aria-live="polite">{loading ? <><LoaderCircle className="spin" size={14}/>検索中…</> : resultCount!==undefined ? <><b>{resultCount.toLocaleString()}</b> 件の{resultLabel}</> : '一覧を読み込み中…'}</span>
      <div className="list-active-conditions" aria-label="指定中の条件">{conditions.map(condition=><button type="button" key={condition.key} title={condition.label}
        aria-label={`${condition.label}の条件を解除`} onClick={condition.onRemove}><span>{condition.label}</span><X size={12}/></button>)}</div>
      {canReset && <button type="button" className="list-reset" onClick={onReset}>条件をクリア</button>}
    </div>
  </section>;
}
