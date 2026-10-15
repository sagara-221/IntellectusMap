import type {Diagnosis} from './types';
import MarkdownContent from './MarkdownContent';

export default function ConversationEvidence({session,conceptId}:{session:Diagnosis;conceptId:string}) {
  const observations=session.chat?.observations.filter(item=>item.concept_id===conceptId)??[];
  if(!observations.length)return null;
  return <div className="conversation-evidence"><h4>会話からの根拠 <span>{observations.length}</span></h4>
    {observations.map(item=><details key={item.observation_id}><summary>{item.reason}</summary>
      <p>推定理解度 {Math.round(item.score*100)}% · 確信度 {Math.round(item.confidence*100)}%</p>
      {item.citations.map((citation,i)=><blockquote key={i}><MarkdownContent>{citation.quote}</MarkdownContent></blockquote>)}
      {!!item.demonstrated.length&&<div><b>確認できたこと</b><ul>{item.demonstrated.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
      {!!item.missing.length&&<div><b>確認したいこと</b><ul>{item.missing.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
    </details>)}
  </div>;
}
