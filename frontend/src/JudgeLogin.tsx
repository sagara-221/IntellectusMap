import {useState} from 'react';
import {API_PREFIX} from './config';
import {setAuthToken,type UserProfile} from './auth';

export default function JudgeLogin({onLogin}:{onLogin:(user:UserProfile)=>void}) {
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  return <form className="judge-login" onSubmit={async event=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const response=await fetch(`${API_PREFIX}/auth/judge-login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.trim(),password})});
      const data=await response.json();
      if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'ログインできませんでした。');
      sessionStorage.removeItem('diagnostic-session');
      setAuthToken(data.token);setPassword('');onLogin(data.user);
    }catch(e){setError(e instanceof Error?e.message:'接続できませんでした。');}finally{setBusy(false);}
  }}>
    <h3>審査員ログイン</h3>
    <p>提出資料に記載されたID・パスワードをご利用ください。Googleアカウントやメール受信は不要です。</p>
    <label>審査員ID<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required maxLength={128} disabled={busy}/></label>
    <label>パスワード<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required maxLength={256} disabled={busy}/></label>
    {error&&<p role="alert">{error}</p>}
    <button className="primary" disabled={busy||!username.trim()||!password}>{busy?'ログイン中…':'審査員としてログイン'}</button>
  </form>;
}
